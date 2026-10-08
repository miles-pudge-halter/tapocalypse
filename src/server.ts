import { readFileSync } from "node:fs";
import path from "node:path";
import { devicesView, findRun, init, runner, runView, scheduler } from "./app";
import index from "../web/index.html";
import { config, HttpError } from "./config";
import { runDoctor } from "./doctor";
import { connectedAndroidSerials, exec, screencap } from "./devices/devices";
import { activeRunIds, handleMcp } from "./mcp/server";
import { detectProject } from "./projects/detect";
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  projectEvents,
  type Project,
  updateProject,
  validateProject,
} from "./projects/registry";
import { listReports, renderReport, reportFilePath } from "./reports/reports";
import { frameToActivity } from "./runs/prompt";
import { runMatches } from "./runs/source";
import { listRuns, runDir } from "./runs/store";
import type { Activity, Run } from "./runs/types";

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
};
const PING_MS = 15_000;
const EVENTS_TAIL_LINES = 2000;
const SCREEN_LOOKUP_TTL_MS = 2000;

interface ConnectedSerials {
  android: Set<string>;
  ios: Set<string>;
}
/** Shared by concurrent thumbnail requests so each screen.png does not re-probe every device. */
let screenLookup: { at: number; serials: Promise<ConnectedSerials> } | null = null;

async function probeSerials(): Promise<ConnectedSerials> {
  const [android, simctl] = await Promise.all([
    connectedAndroidSerials(),
    exec(["xcrun", "simctl", "list", "devices", "booted", "-j"], { timeoutMs: 10_000 }),
  ]);
  const ios = new Set<string>();
  if (simctl.code === 0) {
    try {
      const data = JSON.parse(simctl.text) as { devices: Record<string, { udid: string }[]> };
      for (const sims of Object.values(data.devices)) for (const s of sims) ios.add(s.udid);
    } catch {
      // unparseable simctl output: treat as no simulators
    }
  }
  return { android: new Set(android), ios };
}

function connectedSerials(): Promise<ConnectedSerials> {
  if (!screenLookup || Date.now() - screenLookup.at > SCREEN_LOOKUP_TTL_MS) {
    screenLookup = { at: Date.now(), serials: probeSerials() };
  }
  return screenLookup.serials;
}

/** Blocks DNS rebinding (Host) and cross-site writes (Origin, Content-Type); Origin-less clients such as curl stay allowed. */
function guardRequest(req: Request, pathname: string): void {
  const hosts = [`127.0.0.1:${config.port}`, `localhost:${config.port}`];
  const host = req.headers.get("host");
  if (!host || !hosts.includes(host)) throw new HttpError(403, "forbidden host");
  if (req.method === "GET" || req.method === "HEAD") return;
  const origin = req.headers.get("origin");
  if (origin !== null && !hosts.some((h) => origin === `http://${h}`)) throw new HttpError(403, "forbidden origin");
  const hasBody =
    (req.method === "POST" &&
      (pathname === "/mcp" ||
        pathname === "/api/runs" ||
        pathname === "/api/projects" ||
        pathname === "/api/projects/validate" ||
        pathname === "/api/projects/detect" ||
        /^\/api\/runs\/[^/]+\/steer$/.test(pathname))) ||
    (req.method === "PUT" && /^\/api\/projects\/[^/]+$/.test(pathname));
  if (hasBody && !req.headers.get("content-type")?.startsWith("application/json")) {
    throw new HttpError(415, "content-type must be application/json");
  }
}

function json(data: unknown, status = 200, headers?: Record<string, string>): Response {
  return Response.json(data, { status, headers });
}

function project(pid: string): Project {
  const p = getProject(pid);
  if (!p) throw new HttpError(404, `unknown project ${pid}`);
  return p;
}

function run(id: string): Run {
  const r = findRun(id);
  if (!r) throw new HttpError(404, `unknown run ${id}`);
  return r;
}

async function readJsonObject(req: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "JSON body must be an object");
  return body as Record<string, unknown>;
}

/** SSE stream: `subscribe` wires listeners and returns their unsubscribe; ping + cleanup are handled here. */
function sse(
  req: Request,
  subscribe: (send: (event: string, data: unknown) => void) => () => void,
  initial?: [string, unknown],
): Response {
  const encoder = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let unsubscribe = () => {};
      const ping = setInterval(() => write(": ping\n\n"), PING_MS);
      cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(ping);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // already closed by cancel
        }
      };
      const write = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          cleanup();
        }
      };
      const send = (event: string, data: unknown) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      if (initial) send(initial[0], initial[1]);
      if (!closed) unsubscribe = subscribe(send);
      if (req.signal.aborted) cleanup();
      else req.signal.addEventListener("abort", () => cleanup(), { once: true });
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
}

/** Last `limit` frames of events.jsonl; only the tail is JSON-parsed. */
function readEventsTail(id: string, limit: number): unknown[] {
  let text: string;
  try {
    text = readFileSync(path.join(runDir(id), "events.jsonl"), "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter(Boolean)
    .slice(-limit)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as unknown];
      } catch {
        return [];
      }
    });
}

function runEvents(req: Request, id: string): Response {
  const r = run(id);
  const activity = readEventsTail(id, EVENTS_TAIL_LINES)
    .map((f) => frameToActivity(f, r.backend))
    .filter((a): a is Activity => a !== null)
    .slice(-200);
  return sse(
    req,
    (send) => {
      const onRun = (updated: Run) => {
        if (updated.id === id) send("run", runView(updated));
      };
      const onActivity = (a: Activity & { runId: string }) => {
        if (a.runId === id) send("activity", { ts: a.ts, kind: a.kind, text: a.text });
      };
      scheduler.bus.on("run", onRun);
      scheduler.bus.on("activity", onActivity);
      return () => {
        scheduler.bus.off("run", onRun);
        scheduler.bus.off("activity", onActivity);
      };
    },
    ["snapshot", { run: runView(r), activity }],
  );
}

function globalEvents(req: Request): Response {
  return sse(req, (send) => {
    const onRun = (updated: Run) => send("run", runView(updated));
    const onProjects = () => send("projects", listProjects());
    scheduler.bus.on("run", onRun);
    projectEvents.on("change", onProjects);
    return () => {
      scheduler.bus.off("run", onRun);
      projectEvents.off("change", onProjects);
    };
  });
}

async function route(req: Request, url: URL): Promise<Response> {
  const { pathname } = url;
  const method = req.method;
  guardRequest(req, pathname);
  const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);

  if (pathname === "/mcp") {
    if (method !== "POST") return json({ error: "method not allowed" }, 405, { Allow: "POST" });
    return handleMcp(req);
  }

  if (method === "GET" && parts[0] === "files" && parts.length >= 3) {
    const p = project(parts[1]);
    const abs = reportFilePath(p, parts.slice(2).join("/"));
    const file = abs ? Bun.file(abs) : null;
    if (!file || !(await file.exists())) throw new HttpError(404, "not found");
    return new Response(file);
  }

  if (parts[0] !== "api") throw new HttpError(404, "not found");

  if (parts[1] === "projects") {
    if (parts.length === 2) {
      if (method === "GET") return json(listProjects());
      if (method === "POST") return json(createProject(await readJsonObject(req)), 201);
    }
    if (parts.length === 3 && method === "POST" && parts[2] === "validate") {
      const { input, mode, existingId } = await readJsonObject(req);
      if (mode !== "create" && mode !== "update") throw new HttpError(400, "mode must be create or update");
      if (existingId !== undefined && typeof existingId !== "string") throw new HttpError(400, "existingId must be a string");
      return json(validateProject(input, mode, existingId));
    }
    if (parts.length === 3 && method === "POST" && parts[2] === "detect") {
      const { repoPath } = await readJsonObject(req);
      if (typeof repoPath !== "string" || !repoPath.trim()) throw new HttpError(400, "repoPath is required");
      return json(await detectProject(repoPath.trim()));
    }
    if (parts.length === 3 && method === "PUT") return json(updateProject(parts[2], await readJsonObject(req)));
    if (parts.length === 3 && method === "DELETE") {
      deleteProject(parts[2], activeRunIds(parts[2]));
      return new Response(null, { status: 204 });
    }
    if (method === "GET" && parts[3] === "reports") {
      const p = project(parts[2]);
      if (parts.length === 4) return json(listReports(p));
      if (parts.length === 5) return json(renderReport(p, parts[4]));
    }
  }

  if (parts[1] === "devices" && method === "GET") {
    if (parts.length === 2) return json(await devicesView());
    if (parts.length === 4 && parts[3] === "screen.png") {
      const serial = parts[2];
      const { android, ios } = await connectedSerials();
      const platform = android.has(serial) ? "android" : ios.has(serial) ? "ios" : null;
      if (!platform) throw new HttpError(404, `device ${serial} not connected`);
      let png: Uint8Array;
      try {
        png = await screencap({ serial, platform });
      } catch (e) {
        // Device went away between the connectivity probe and the capture: not a server fault.
        return json({ error: e instanceof Error ? e.message : String(e) }, 502);
      }
      return new Response(new Uint8Array(png), {
        headers: { "Content-Type": "image/png", "Cache-Control": "no-store" },
      });
    }
  }

  if (pathname === "/api/doctor" && method === "GET") {
    return json(await runDoctor({ fresh: url.searchParams.get("fresh") === "1" }));
  }

  if (pathname === "/api/events" && method === "GET") return globalEvents(req);

  if (parts[1] === "runs") {
    if (parts.length === 2) {
      if (method === "GET") {
        const projectId = url.searchParams.get("project") || undefined;
        const statuses = url.searchParams.get("status")?.split(",").filter(Boolean);
        const prParam = url.searchParams.get("pr");
        const pr = prParam ? Number(prParam) : undefined;
        if (pr !== undefined && !Number.isInteger(pr)) throw new HttpError(400, "pr must be an integer");
        const filter = {
          branch: url.searchParams.get("branch") || undefined,
          pr,
          ticket: url.searchParams.get("ticket") || undefined,
          commit: url.searchParams.get("commit") || undefined,
        };
        const bySource = Object.values(filter).some((v) => v !== undefined);
        const runs = listRuns({ projectId })
          .filter((r) => !statuses?.length || statuses.includes(r.status))
          .map((r) => scheduler.getLive(r.id) ?? r)
          .filter((r) => !bySource || runMatches(r, filter));
        return json(runs.map(runView));
      }
      if (method === "POST") {
        const body = await readJsonObject(req);
        const created = await scheduler.enqueueRun({
          ...body,
          requestedBy: typeof body.requestedBy === "string" && body.requestedBy ? body.requestedBy : "web",
        });
        return json(runView(created), 201);
      }
    } else {
      const id = parts[2];
      const action = parts[3];
      if (parts.length === 3 && method === "GET") return json(runView(run(id)));
      if (parts.length === 4) {
        if (action === "events" && method === "GET") return runEvents(req, id);
        if (action === "cancel" && method === "POST") {
          run(id);
          return json(runView(await scheduler.cancelRun(id)));
        }
        if (action === "steer" && method === "POST") {
          run(id);
          const { message } = await readJsonObject(req);
          if (typeof message !== "string" || !message.trim()) throw new HttpError(400, "message is required");
          await runner.steerRun(id, message.trim());
          return json({ ok: true });
        }
        if (action === "transcript" && method === "GET") {
          run(id);
          const file = Bun.file(path.join(runDir(id), "transcript.html"));
          if (!(await file.exists())) throw new HttpError(404, "transcript not available");
          return new Response(file, {
            headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "sandbox" },
          });
        }
      }
    }
  }

  throw new HttpError(404, "not found");
}

async function fetchHandler(req: Request): Promise<Response> {
  try {
    return await route(req, new URL(req.url));
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status);
    if (err instanceof URIError) return json({ error: "malformed URL" }, 400);
    console.error(err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
}

init();

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: config.port,
  idleTimeout: 0,
  routes: { "/": index },
  development: process.env.NODE_ENV !== "production" && { hmr: true, console: true },
  fetch: fetchHandler,
});

console.log(`tapocalypse listening on http://127.0.0.1:${server.port}`);

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    // Stop scheduling first so exiting omp processes cannot free a slot that starts the next queued run.
    scheduler.stop();
    runner.killAll();
    await Bun.sleep(500);
    process.exit(0);
  });
}
