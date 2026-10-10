import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  batchView,
  devicesView,
  findRun,
  queryRuns,
  runner,
  runScreenshots,
  runView,
  scheduler,
} from "./app";
import { config, HttpError, MAX_STEER_CHARS, XCRUN_BIN } from "./config";
import { runDoctor } from "./doctor";
import { connectedAndroidSerials, exec, listDevices, screencap } from "./devices/devices";
import { bootTarget, isBootedByTapocalypse, poolView, shutdownDevice } from "./devices/pool";
import { harnesses, defaultHarness, detectInstalled } from "./harness";
import { HARNESS_IDS, HarnessIdSchema, type HarnessId } from "./harness/types";
import { handleRunMcp } from "./mcp/run-server";
import { activeRunIds, handleMcp, mcpStatus } from "./mcp/server";
import { listModels } from "./models";
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
import { suggestProjectFolders } from "./projects/suggest";
import { listReports, renderReport, reportFilePath } from "./reports/reports";
import { exportRun, reportFile, screenshotFile } from "./runs/artefacts";
import { readActivity, listRuns, runDir } from "./runs/store";
import type { Activity, Platform, Run } from "./runs/types";
import { computeStats } from "./stats";
import { listSuites, listTemplates, saveSuite } from "./suites";

const NOSNIFF = { "X-Content-Type-Options": "nosniff" };

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
};
const PING_MS = 15_000;
const SNAPSHOT_ACTIVITY = 200;
const SCREEN_LOOKUP_TTL_MS = 2000;
const DEFAULT_ACTIVITY_LIMIT = 200;
const MAX_ACTIVITY_LIMIT = 500;
const DEFAULT_STDERR_TAIL = 200;
const MAX_STDERR_TAIL = 5000;
const MAX_STATS_DAYS = 90;

interface ConnectedSerials {
  android: Set<string>;
  ios: Set<string>;
}
/** Shared by concurrent thumbnail requests so each screen.png does not re-probe every device. */
let screenLookup: { at: number; serials: Promise<ConnectedSerials> } | null = null;

async function probeSerials(): Promise<ConnectedSerials> {
  const [android, simctl] = await Promise.all([
    connectedAndroidSerials(),
    exec([XCRUN_BIN, "simctl", "list", "devices", "booted", "-j"], { timeoutMs: 10_000 }),
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

/**
 * POST/PUT routes that read a JSON body; the others take none. Matches the decoded path segments, the same ones `route`
 * dispatches on, so an encoded spelling (`/api/%72uns`) cannot skip the content-type check.
 */
function hasJsonBody(method: string, parts: string[]): boolean {
  const [root, a, b, c] = parts;
  if (method === "PUT") return parts.length === 3 && root === "api" && a === "projects";
  if (method !== "POST") return false;
  if (root === "mcp") return parts.length === 1 || (parts.length === 3 && a === "runs");
  if (root !== "api") return false;
  if (parts.length === 2) return a === "runs" || a === "batches" || a === "projects";
  if (parts.length === 3) {
    return (a === "projects" && (b === "validate" || b === "detect")) || (a === "devices" && b === "boot");
  }
  if (parts.length === 4) return (a === "projects" && c === "suites") || (a === "runs" && (c === "steer" || c === "rerun" || c === "export"));
  return false;
}

/** Blocks DNS rebinding (Host) and cross-site writes (Origin, Content-Type); Origin-less clients such as curl stay allowed. */
function guardRequest(req: Request, parts: string[]): void {
  const hosts = [`127.0.0.1:${config.port}`, `localhost:${config.port}`];
  const host = req.headers.get("host");
  if (!host || !hosts.includes(host)) throw new HttpError(403, "forbidden host");
  if (req.method === "GET" || req.method === "HEAD") return;
  const origin = req.headers.get("origin");
  if (origin !== null && !hosts.some((h) => origin === `http://${h}`)) throw new HttpError(403, "forbidden origin");
  if (hasJsonBody(req.method, parts) && !req.headers.get("content-type")?.startsWith("application/json")) {
    throw new HttpError(415, "content-type must be application/json");
  }
}



/** Optional `harness` value; 400 when present but not a known harness id. */
function harnessParam(value: unknown): HarnessId | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = HarnessIdSchema.safeParse(value);
  if (!parsed.success) throw new HttpError(400, `harness must be one of ${HARNESS_IDS.join(", ")}`);
  return parsed.data;
}

/** `GET /api/harnesses`: what the New run picker offers and what the run page may show (steer, transcript). */
async function harnessesView() {
  const [installed, selected] = await Promise.all([detectInstalled(), defaultHarness()]);
  return {
    default: selected,
    harnesses: HARNESS_IDS.map((id) => ({
      id,
      label: harnesses[id].label,
      installed: installed[id],
      capabilities: harnesses[id].capabilities,
    })),
  };
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

/** Optional integer query parameter; 400 when present but not an integer. */
function intParam(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new HttpError(400, `${name} must be an integer`);
  return n;
}

function csvParam(url: URL, name: string): string[] | undefined {
  const values = url.searchParams.get(name)?.split(",").filter(Boolean);
  return values?.length ? values : undefined;
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

function runEvents(req: Request, id: string): Response {
  const r = run(id);
  const { items, hasMore } = readActivity(id, { limit: SNAPSHOT_ACTIVITY });
  return sse(
    req,
    (send) => {
      const onRun = (updated: Run) => {
        if (updated.id === id) send("run", runView(updated));
      };
      const onActivity = ({ runId, ...activity }: Activity & { runId: string }) => {
        if (runId === id) send("activity", activity);
      };
      scheduler.bus.on("run", onRun);
      scheduler.bus.on("activity", onActivity);
      return () => {
        scheduler.bus.off("run", onRun);
        scheduler.bus.off("activity", onActivity);
      };
    },
    ["snapshot", { run: runView(r), activity: items, hasMoreActivity: hasMore }],
  );
}

function globalEvents(req: Request): Response {
  // The initial frame makes Bun flush the headers immediately, so EventSource reports "open" without waiting for a ping.
  return sse(
    req,
    (send) => {
      const onRun = (updated: Run) => send("run", runView(updated));
      const onProjects = () => send("projects", listProjects());
      scheduler.bus.on("run", onRun);
      projectEvents.on("change", onProjects);
      return () => {
        scheduler.bus.off("run", onRun);
        projectEvents.off("change", onProjects);
      };
    },
    ["hello", {}],
  );
}

const SuiteBodySchema = z.object({
  id: z.string().max(64).optional(),
  title: z.string().max(200),
  brief: z.string().max(20_000),
  checks: z.array(z.object({ id: z.string().max(32), title: z.string().max(200) })).max(50).optional(),
  platforms: z.array(z.enum(["android", "ios"])).optional(),
  model: z.string().max(200).optional(),
  overwrite: z.boolean().optional(),
});

function slug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "suite";
}

function saveSuiteFromBody(p: Project, body: Record<string, unknown>): Response {
  const parsed = SuiteBodySchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new HttpError(400, `${issue.path.map(String).join(".") || "body"}: ${issue.message}`);
  }
  const { id, ...rest } = parsed.data;
  return json(saveSuite(p, { id: id ?? slug(rest.title), ...rest }), 201);
}

const BootBodySchema = z.object({ platform: z.enum(["android", "ios"]), target: z.string().min(1) });
const ExportBodySchema = z.object({
  dir: z
    .string()
    .min(1)
    .refine((d) => !d.includes("\0"), "dir must not contain a NUL byte")
    .refine((d) => path.isAbsolute(d), "dir must be an absolute path"),
});

/** Starts a pool boot; configuration/limit errors surface immediately, the long boot itself continues detached. */
async function startBoot(platform: Platform, target: string): Promise<void> {
  const boot = bootTarget(platform, target);
  const early = await Promise.race([
    boot.then(
      () => null,
      (e: unknown) => e,
    ),
    Bun.sleep(0).then(() => null),
  ]);
  if (early) throw early;
  void boot.catch((e: unknown) => console.error(`boot ${target} failed:`, e instanceof Error ? e.message : e));
}

async function route(req: Request, url: URL): Promise<Response> {
  const { pathname } = url;
  const method = req.method;
  const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  guardRequest(req, parts);

  if (parts[0] === "mcp" && (parts.length === 1 || (parts.length === 3 && parts[1] === "runs"))) {
    if (method !== "POST") return json({ error: "method not allowed" }, 405, { Allow: "POST" });
    return parts.length === 1 ? handleMcp(req) : handleRunMcp(req, parts[2], (id) => runner.progressLookup(id));
  }

  if (method === "GET" && parts[0] === "files" && parts.length >= 3) {
    const p = project(parts[1]);
    const abs = reportFilePath(p, parts.slice(2).join("/"));
    const file = abs ? Bun.file(abs) : null;
    if (!file || !(await file.exists())) throw new HttpError(404, "not found");
    return new Response(file, { headers: NOSNIFF });
  }

  if (parts[0] !== "api") throw new HttpError(404, "not found");

  if (parts[1] === "projects") {
    if (parts.length === 2) {
      if (method === "GET") return json(listProjects());
      if (method === "POST") return json(createProject(await readJsonObject(req)), 201);
    }
    if (parts.length === 3 && method === "GET" && parts[2] === "suggestions") return json(await suggestProjectFolders());
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
    if (parts[3] === "reports" && method === "GET") {
      const p = project(parts[2]);
      if (parts.length === 4) return json(listReports(p));
      if (parts.length === 5) return json(renderReport(p, parts[4]));
    }
    if (parts[3] === "suites" && parts.length === 4) {
      const p = project(parts[2]);
      if (method === "GET") return json(listSuites(p));
      if (method === "POST") return saveSuiteFromBody(p, await readJsonObject(req));
    }
  }

  if (parts[1] === "devices") {
    if (method === "GET" && parts.length === 2) return json(await devicesView());
    if (method === "GET" && parts.length === 3 && parts[2] === "pool") {
      await listDevices();
      return json(poolView(scheduler.activeCount()));
    }
    if (method === "POST" && parts.length === 3 && parts[2] === "boot") {
      const parsed = BootBodySchema.safeParse(await readJsonObject(req));
      if (!parsed.success) throw new HttpError(400, "platform (android|ios) and target are required");
      await startBoot(parsed.data.platform, parsed.data.target);
      return json({ ok: true }, 202);
    }
    if (method === "POST" && parts.length === 4 && parts[3] === "shutdown") {
      const serial = parts[2];
      if (scheduler.assigned.has(serial)) throw new HttpError(409, `${serial} is in use by a run`);
      if (!isBootedByTapocalypse(serial)) throw new HttpError(409, `${serial} was not booted by Tapocalypse`);
      await shutdownDevice(serial);
      return new Response(null, { status: 204 });
    }
    if (method === "GET" && parts.length === 4 && parts[3] === "screen.png") {
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

  if (method === "GET") {
    if (pathname === "/api/doctor") return json(await runDoctor({ fresh: url.searchParams.get("fresh") === "1" }));
    if (pathname === "/api/events") return globalEvents(req);
    if (pathname === "/api/harnesses") return json(await harnessesView());
    if (pathname === "/api/models") {
      const harness = harnessParam(url.searchParams.get("harness")) ?? (await defaultHarness());
      return json({ models: await listModels(harness) });
    }
    if (pathname === "/api/templates") return json(listTemplates());
    if (pathname === "/api/mcp/status") return json(mcpStatus());
    if (pathname === "/api/stats") {
      const days = intParam(url, "days") ?? 7;
      if (days < 1 || days > MAX_STATS_DAYS) throw new HttpError(400, `days must be between 1 and ${MAX_STATS_DAYS}`);
      const projectId = url.searchParams.get("project") || undefined;
      const runs = listRuns({ projectId }).map((r) => scheduler.getLive(r.id) ?? r);
      return json(computeStats(runs, days));
    }
  }

  if (parts[1] === "batches") {
    if (parts.length === 2 && method === "POST") {
      const body = await readJsonObject(req);
      harnessParam(body.harness);
      const { runs, batchId } = await scheduler.enqueueBatch(body);
      return json({ batchId, runs: runs.map(runView) }, 201);
    }
    if (parts.length === 3 && method === "GET") {
      const batch = batchView(parts[2]);
      if (!batch) throw new HttpError(404, `unknown batch ${parts[2]}`);
      return json(batch);
    }
  }

  if (parts[1] === "runs") {
    if (parts.length === 2) {
      if (method === "GET") {
        return json(
          queryRuns({
            project: url.searchParams.get("project") || undefined,
            status: csvParam(url, "status"),
            verdict: csvParam(url, "verdict"),
            q: url.searchParams.get("q") || undefined,
            batch: url.searchParams.get("batch") || undefined,
            branch: url.searchParams.get("branch") || undefined,
            pr: intParam(url, "pr"),
            ticket: url.searchParams.get("ticket") || undefined,
            commit: url.searchParams.get("commit") || undefined,
            limit: intParam(url, "limit"),
            before: url.searchParams.get("before") || undefined,
          }),
        );
      }
      if (method === "POST") {
        const body = await readJsonObject(req);
        // batchId is assigned by POST /api/batches only.
        delete body.batchId;
        harnessParam(body.harness);
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
      if (parts.length === 3 && method === "DELETE") {
        scheduler.removeRun(id);
        return new Response(null, { status: 204 });
      }
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
          if (message.length > MAX_STEER_CHARS) throw new HttpError(400, `message must be at most ${MAX_STEER_CHARS} characters`);
          await runner.steerRun(id, message.trim());
          return json({ ok: true });
        }
        if (action === "rerun" && method === "POST") {
          const { only, device, requestedBy, harness } = await readJsonObject(req);
          if (only !== "failed" && only !== "all") throw new HttpError(400, "only must be failed or all");
          if (device !== undefined && (typeof device !== "object" || device === null || Array.isArray(device))) {
            throw new HttpError(400, "device must be an object");
          }
          const created = await scheduler.rerun(id, {
            only,
            device: device as { serial?: string; platform?: Platform } | undefined,
            requestedBy: typeof requestedBy === "string" && requestedBy ? requestedBy : "web",
            harness: harnessParam(harness),
          });
          return json(runView(created), 201);
        }
        if (action === "activity" && method === "GET") {
          run(id);
          const limit = Math.min(MAX_ACTIVITY_LIMIT, Math.max(1, intParam(url, "limit") ?? DEFAULT_ACTIVITY_LIMIT));
          return json(readActivity(id, { before: intParam(url, "before"), limit }));
        }
        if (action === "stderr" && method === "GET") {
          run(id);
          const tail = Math.min(MAX_STDERR_TAIL, Math.max(1, intParam(url, "tail") ?? DEFAULT_STDERR_TAIL));
          const file = path.join(runDir(id), "stderr.log");
          if (!existsSync(file)) throw new HttpError(404, "no stderr for this run");
          const lines = readFileSync(file, "utf8").split("\n");
          if (lines.at(-1) === "") lines.pop();
          return new Response(lines.slice(-tail).join("\n"), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
        }
        if (action === "screenshots" && method === "GET") return json(runScreenshots(run(id)));
        if (action === "report" && method === "GET") {
          const r = run(id);
          const file = reportFile(r, getProject(r.projectId) ?? null);
          if (!file || !existsSync(file)) throw new HttpError(404, `run ${id} has no report`);
          return json({ markdown: readFileSync(file, "utf8") });
        }
        if (action === "export" && method === "POST") {
          const r = run(id);
          const parsed = ExportBodySchema.safeParse(await readJsonObject(req));
          if (!parsed.success) throw new HttpError(400, "dir (an absolute path) is required");
          return json(await exportRun(r, getProject(r.projectId) ?? null, parsed.data.dir));
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
      if (parts.length >= 5 && action === "files" && method === "GET") {
        const r = run(id);
        const abs = screenshotFile(r, getProject(r.projectId) ?? null, parts.slice(4).join("/"));
        const file = abs ? Bun.file(abs) : null;
        if (!file || !(await file.exists())) throw new HttpError(404, "not found");
        return new Response(file, { headers: NOSNIFF });
      }
    }
  }

  throw new HttpError(404, "not found");
}

/**
 * Clickjacking guard for everything this handler returns. The UI document itself (`/`) is an HTMLBundle route that Bun serves
 * without calling `fetch`, so it cannot carry these headers; it relies on the `<meta>` CSP in web/index.html (where
 * `frame-ancestors` is ignored) plus the frame guard script loaded by that page. Headers still protect every API and file response,
 * and an existing CSP (the transcript's `sandbox`) is extended rather than replaced.
 */
function withFramingHeaders(res: Response): Response {
  res.headers.set("X-Frame-Options", "DENY");
  const csp = res.headers.get("Content-Security-Policy");
  res.headers.set("Content-Security-Policy", csp ? `${csp}; frame-ancestors 'none'` : "frame-ancestors 'none'");
  return res;
}

export async function fetchHandler(req: Request): Promise<Response> {
  try {
    return withFramingHeaders(await route(req, new URL(req.url)));
  } catch (err) {
    if (err instanceof HttpError) return withFramingHeaders(json({ error: err.message }, err.status));
    if (err instanceof URIError) return withFramingHeaders(json({ error: "malformed URL" }, 400));
    console.error(err);
    return withFramingHeaders(json({ error: err instanceof Error ? err.message : String(err) }, 500));
  }
}
