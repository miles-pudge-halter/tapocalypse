import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { fetchHandler } from "../src/api";
import { scheduler } from "../src/app";
import { config, DATA_DIR, MAX_STEER_CHARS } from "../src/config";
import { gateway } from "../src/devices/gateway";
import { deviceOwner, grantAgent, grantRun, releaseRun, revoke } from "../src/devices/leases";
import { HARNESS_IDS } from "../src/harness/types";
import { getProject } from "../src/projects/registry";
import { appendStderr, runDir } from "../src/runs/store";
import type { Run } from "../src/runs/types";
import { cleanupRuns as cleanupKeyedRuns, makeRun as makeKeyedRun, uniqueTest, updateRun as updateKeyedRun } from "./support/regression";

const HOST = `127.0.0.1:${config.port}`;
/** Smallest valid PNG header bytes; enough for the magic-byte checks. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const project = getProject("test-proj")!;

// The gateway's tool cache is read lazily from the data dir. Writing it before any request keeps `/mcp` tools/list from probing a real
// mobile-mcp, and makes it poisoned on purpose: a Tapocalypse tool name, a cloud tool and a schema the MCP SDK cannot compile sit next to a good tool.
const GATEWAY_CACHE = path.join(DATA_DIR, "gateway-tools.json");
const emptyObject = { type: "object", properties: {} };
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.writeFileSync(
  GATEWAY_CACHE,
  JSON.stringify({
    version: 1,
    mobileMcpVersion: "9.9.9-api-test",
    tools: [
      { name: "qa_doctor", inputSchema: emptyObject },
      { name: "mobile_allocate_remote_device", inputSchema: emptyObject },
      { name: "mobile_uncompilable", inputSchema: { type: "object", properties: { x: { type: "nonsense" } } } },
      {
        name: "mobile_peek",
        title: "Peek at the screen",
        description: "Look",
        annotations: { readOnlyHint: true, destructiveHint: false },
        inputSchema: { type: "object", properties: { device: { type: "string" } }, required: ["device"] },
      },
    ],
  }),
);
afterAll(() => fs.rmSync(GATEWAY_CACHE, { force: true }));

function call(pathname: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
  const { json, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (!headers.has("host")) headers.set("host", HOST);
  if (json !== undefined) headers.set("content-type", "application/json");
  return fetchHandler(new Request(`http://${HOST}${pathname}`, { ...rest, headers, body: json === undefined ? rest.body : JSON.stringify(json) }));
}

let counter = 0;
/** Queues a run on the stopped scheduler (nothing ever starts) and optionally marks it finished. */
async function makeRun(extra: Partial<Run> & { token?: string } = {}): Promise<Run> {
  const { token, ...fields } = extra;
  const run = await scheduler.enqueueRun({
    projectId: "test-proj",
    title: `${token ?? "api"} run ${++counter}`,
    brief: "api test brief",
  });
  Object.assign(run, fields);
  scheduler.update(run);
  return run;
}

beforeAll(() => {
  // Routes enqueue on the real scheduler; stopping it keeps the tests from touching real devices or emulators.
  scheduler.stop();
});

describe("request guards", () => {
  test("foreign Host, foreign Origin and non-JSON writes are refused", async () => {
    expect((await call("/api/runs", { headers: { host: "evil.example" } })).status).toBe(403);
    const origin = await call("/api/batches", { method: "POST", json: {}, headers: { origin: "http://evil.example" } });
    expect(origin.status).toBe(403);
    const plain = await call("/api/batches", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
    expect(plain.status).toBe(415);
    const rerun = await call("/api/runs/x/rerun", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
    expect(rerun.status).toBe(415);
    const suites = await call("/api/projects/test-proj/suites", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
    expect(suites.status).toBe(415);
    const boot = await call("/api/devices/boot", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
    expect(boot.status).toBe(415);
  });
});

describe("encoded paths and framing", () => {
  test("an encoded route spelling cannot skip the content-type check", async () => {
    const res = await call("/api/%72uns", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
    expect(res.status).toBe(415);
    const trailing = await call("/mcp/", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
    expect(trailing.status).toBe(415);
  });

  test("every response forbids framing, and an existing CSP is extended", async () => {
    const ok = await call("/api/projects");
    expect(ok.headers.get("x-frame-options")).toBe("DENY");
    expect(ok.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    const refused = await call("/api/runs", { headers: { host: "evil.example" } });
    expect(refused.headers.get("x-frame-options")).toBe("DENY");

    const run = await makeRun();
    fs.writeFileSync(path.join(runDir(run.id), "transcript.html"), "<p>t</p>");
    const transcript = await call(`/api/runs/${run.id}/transcript`);
    expect(transcript.headers.get("content-security-policy")).toBe("sandbox; frame-ancestors 'none'");
  });

  test("steer messages over the cap are refused", async () => {
    const run = await makeRun();
    const res = await call(`/api/runs/${run.id}/steer`, { method: "POST", json: { message: "x".repeat(MAX_STEER_CHARS + 1) } });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/runs", () => {
  test("pages newest-first with a hasMore flag and a createdAt cursor", async () => {
    const token = `page${Date.now()}`;
    const [a, b, c] = [await makeRun({ token }), await makeRun({ token }), await makeRun({ token })];
    const first = (await (await call(`/api/runs?q=${token}&limit=2`)).json()) as { runs: Run[]; hasMore: boolean };
    expect(first.runs.map((r) => r.id)).toEqual([c.id, b.id]);
    expect(first.hasMore).toBe(true);

    const second = (await (await call(`/api/runs?q=${token}&limit=2&before=${encodeURIComponent(first.runs[1]!.createdAt)}`)).json()) as {
      runs: Run[];
      hasMore: boolean;
    };
    expect(second.runs.map((r) => r.id)).toEqual([a.id]);
    expect(second.hasMore).toBe(false);
  });

  test("filters by status, verdict (including none) and batch; every row carries the view fields", async () => {
    const token = `filter${Date.now()}`;
    const pass = await makeRun({ token, status: "done", verdict: "PASS", startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:01:00.000Z" });
    const fail = await makeRun({ token, status: "done", verdict: "FAIL" });
    const queued = await makeRun({ token, batchId: "b-20260101-000000-abcd" });
    const ids = async (query: string) =>
      ((await (await call(`/api/runs?q=${token}&${query}`)).json()) as { runs: Run[] }).runs.map((r) => r.id).sort();

    expect(await ids("status=done")).toEqual([pass.id, fail.id].sort());
    expect(await ids("status=queued")).toEqual([queued.id]);
    expect(await ids("verdict=FAIL,PASS")).toEqual([pass.id, fail.id].sort());
    expect(await ids("verdict=none")).toEqual([queued.id]);
    expect(await ids("batch=b-20260101-000000-abcd")).toEqual([queued.id]);

    const rows = ((await (await call(`/api/runs?q=${token}`)).json()) as { runs: (Run & { durationMs: number | null; queuePosition: number | null })[] }).runs;
    expect(rows.find((r) => r.id === pass.id)?.durationMs).toBe(60_000);
    expect(rows.find((r) => r.id === queued.id)?.queuePosition).not.toBeNull();
  });

  test("a non-integer pr is a 400", async () => {
    expect((await call("/api/runs?pr=abc")).status).toBe(400);
  });
});

describe("run resources", () => {
  test("DELETE refuses active runs and removes finished ones", async () => {
    const active = await makeRun();
    expect((await call(`/api/runs/${active.id}`, { method: "DELETE" })).status).toBe(409);
    const done = await makeRun({ status: "done", verdict: "PASS" });
    expect((await call(`/api/runs/${done.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await call(`/api/runs/${done.id}`)).status).toBe(404);
  });

  test("stderr returns the tail as text and 404s when there is none", async () => {
    const run = await makeRun({ status: "done" });
    expect((await call(`/api/runs/${run.id}/stderr`)).status).toBe(404);
    appendStderr(run.id, "one\ntwo\nthree\n");
    const res = await call(`/api/runs/${run.id}/stderr?tail=2`);
    expect(res.headers.get("content-type")).toStartWith("text/plain");
    expect(await res.text()).toBe("two\nthree");
  });

  test("activity pages with a cursor and rejects a malformed one", async () => {
    const run = await makeRun({ status: "done" });
    expect(await (await call(`/api/runs/${run.id}/activity?limit=10`)).json()).toEqual({ items: [], hasMore: false });
    expect((await call(`/api/runs/${run.id}/activity?before=x`)).status).toBe(400);
  });

  test("screenshots lists run files and check images, linking each to its check", async () => {
    const run = await makeRun({ status: "done", storage: "repo" });
    const dir = path.join(project.repoPath, "qa", "screenshots", run.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "01-home.png"), PNG);
    fs.writeFileSync(path.join(dir, "notes.md"), "not an image");
    fs.mkdirSync(path.join(project.repoPath, "qa", "extra"), { recursive: true });
    fs.writeFileSync(path.join(project.repoPath, "qa", "extra", "proof.png"), PNG);
    run.checks = [
      { id: "C1", title: "Home", status: "pass", screenshot: `qa/screenshots/${run.id}/01-home.png`, updatedAt: "t" },
      { id: "C2", title: "Proof", status: "pass", screenshot: "qa/extra/proof.png", updatedAt: "t" },
      { id: "C3", title: "Missing", status: "fail", screenshot: "qa/missing.png", updatedAt: "t" },
      { id: "C4", title: "Outside", status: "fail", screenshot: "../outside.png", updatedAt: "t" },
    ];
    scheduler.update(run);

    const shots = (await (await call(`/api/runs/${run.id}/screenshots`)).json()) as {
      path: string;
      url: string;
      name: string;
      checkId: string | null;
    }[];
    expect(shots.map((s) => [s.path, s.url, s.checkId]).sort()).toEqual(
      [
        [`qa/screenshots/${run.id}/01-home.png`, `/files/test-proj/screenshots/${run.id}/01-home.png`, "C1"],
        ["qa/extra/proof.png", "/files/test-proj/extra/proof.png", "C2"],
      ].sort(),
    );
    const legacy = await call(shots[0]!.url);
    expect(legacy.status).toBe(200);
    expect(legacy.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("the SSE snapshot reports whether older activity exists", async () => {
    const run = await makeRun({ status: "done" });
    const res = await call(`/api/runs/${run.id}/events`);
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    await reader.cancel();
    const text = new TextDecoder().decode(value);
    expect(text).toStartWith("event: snapshot\n");
    const data = JSON.parse(text.split("\n")[1]!.slice("data: ".length)) as { run: { id: string }; activity: unknown[]; hasMoreActivity: boolean };
    expect(data).toMatchObject({ run: { id: run.id }, activity: [], hasMoreActivity: false });
  });
});

/** A finished run whose artefacts live in the data dir: report.md plus screenshots/01-home.png. */
async function makeDataRun(extra: Partial<Run> = {}): Promise<Run> {
  const run = await makeRun({ status: "done", storage: "data", reportPath: "report.md", ...extra });
  fs.mkdirSync(path.join(runDir(run.id), "screenshots"), { recursive: true });
  fs.writeFileSync(path.join(runDir(run.id), "report.md"), `# QA report ${run.id}\n\n![home](screenshots/01-home.png)\n`);
  fs.writeFileSync(path.join(runDir(run.id), "screenshots", "01-home.png"), PNG);
  fs.writeFileSync(path.join(runDir(run.id), "screenshots", "notes.md"), "not an image");
  run.checks = [{ id: "C1", title: "Home", status: "pass", screenshot: "screenshots/01-home.png", updatedAt: "t" }];
  scheduler.update(run);
  return run;
}

describe("data-dir artefact routes", () => {
  test("GET /api/runs/:id/files serves a stored screenshot and refuses everything else", async () => {
    const run = await makeDataRun();
    const ok = await call(`/api/runs/${run.id}/files/screenshots/01-home.png`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await ok.arrayBuffer())).toEqual(PNG);
    expect((await call(`/api/runs/${run.id}/files/screenshots/notes.md`)).status).toBe(404);
    expect((await call(`/api/runs/${run.id}/files/report.md`)).status).toBe(404);
    expect((await call(`/api/runs/${run.id}/files/screenshots/missing.png`)).status).toBe(404);
    expect((await call(`/api/runs/${run.id}/files/screenshots%2F..%2F..%2Frun.json`)).status).toBe(404);
    expect((await call(`/api/runs/nope-${run.id}/files/screenshots/01-home.png`)).status).toBe(404);
  });

  test("a data run's screenshots list links each image to its file route", async () => {
    const run = await makeDataRun();
    const shots = (await (await call(`/api/runs/${run.id}/screenshots`)).json()) as { path: string; url: string; checkId: string | null }[];
    expect(shots.map((s) => [s.path, s.url, s.checkId])).toEqual([["screenshots/01-home.png", `/api/runs/${run.id}/files/screenshots/01-home.png`, "C1"]]);
    expect((await call(shots[0]!.url)).status).toBe(200);
  });

  test("GET /api/runs/:id/report returns the markdown, 404 without one", async () => {
    const run = await makeDataRun();
    expect(await (await call(`/api/runs/${run.id}/report`)).json()).toEqual({ markdown: `# QA report ${run.id}\n\n![home](screenshots/01-home.png)\n` });
    const bare = await makeRun({ status: "done", storage: "data" });
    expect((await call(`/api/runs/${bare.id}/report`)).status).toBe(404);
    expect((await call(`/api/runs/nope-${run.id}/report`)).status).toBe(404);
  });

  test("GET /api/runs/:id/report still reads a legacy repo report", async () => {
    const run = await makeRun({ status: "done", storage: "repo", reportPath: `qa/LEGACY-REPORT-${counter}.md` });
    fs.writeFileSync(path.join(project.repoPath, run.reportPath!), "# legacy\n");
    expect(await (await call(`/api/runs/${run.id}/report`)).json()).toEqual({ markdown: "# legacy\n" });
  });

  test("the run view carries the absolute report file", async () => {
    const run = await makeDataRun();
    const view = (await (await call(`/api/runs/${run.id}`)).json()) as { reportFile: string | null };
    expect(view.reportFile).toBe(path.join(runDir(run.id), "report.md"));
    const bare = await makeRun({ status: "done", storage: "data" });
    expect(((await (await call(`/api/runs/${bare.id}`)).json()) as { reportFile: string | null }).reportFile).toBeNull();
  });

  test("POST /api/runs/:id/export copies the report and screenshots into an absolute directory", async () => {
    const run = await makeDataRun();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tapocalypse-export-"));
    try {
      const res = await call(`/api/runs/${run.id}/export`, { method: "POST", json: { dir } });
      expect(res.status).toBe(200);
      const out = (await res.json()) as { report: string | null; screenshots: string[] };
      expect(out.report).toBe(path.join(dir, `QA-REPORT-${run.id}.md`));
      expect(fs.existsSync(out.report!)).toBe(true);
      expect(out.screenshots).toContain(path.join(dir, "screenshots", "01-home.png"));
      expect(fs.existsSync(path.join(dir, "screenshots", "01-home.png"))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("export rejects a relative or missing dir, a non-JSON body, and an unknown run", async () => {
    const run = await makeDataRun();
    expect((await call(`/api/runs/${run.id}/export`, { method: "POST", json: { dir: "relative/out" } })).status).toBe(400);
    expect((await call(`/api/runs/${run.id}/export`, { method: "POST", json: { dir: `${os.tmpdir()}/out\u0000x` } })).status).toBe(400);
    expect((await call(`/api/runs/${run.id}/export`, { method: "POST", json: {} })).status).toBe(400);
    const plain = await call(`/api/runs/${run.id}/export`, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
    expect(plain.status).toBe(415);
    expect((await call(`/api/runs/nope-${run.id}/export`, { method: "POST", json: { dir: os.tmpdir() } })).status).toBe(404);
  });

  test("the project reports routes list and render a data run by its id", async () => {
    const run = await makeDataRun();
    const list = (await (await call("/api/projects/test-proj/reports")).json()) as { name: string }[];
    expect(list.map((r) => r.name)).toContain(run.id);
    const rendered = (await (await call(`/api/projects/test-proj/reports/${run.id}`)).json()) as { html: string };
    expect(rendered.html).toContain(`/api/runs/${run.id}/files/screenshots/01-home.png`);
  });
});

describe("rerun route", () => {
  test("201 with the new run, 400 for an unknown mode or when nothing failed", async () => {
    const failed = await makeRun({
      status: "done",
      verdict: "FAIL",
      checks: [{ id: "C1", title: "Pay", status: "fail", updatedAt: "t" }],
    });
    const ok = await call(`/api/runs/${failed.id}/rerun`, { method: "POST", json: { only: "failed" } });
    expect(ok.status).toBe(201);
    expect(await ok.json()).toMatchObject({ rerunOf: failed.id, status: "queued" });
    expect((await call(`/api/runs/${failed.id}/rerun`, { method: "POST", json: { only: "some" } })).status).toBe(400);
    const passed = await makeRun({ status: "done", verdict: "PASS", checks: [{ id: "C1", title: "ok", status: "pass", updatedAt: "t" }] });
    expect((await call(`/api/runs/${passed.id}/rerun`, { method: "POST", json: { only: "failed" } })).status).toBe(400);
  });
});

describe("batches", () => {
  test("POST validates before queueing and GET 404s for unknown ids", async () => {
    const before = scheduler.queue.length;
    const res = await call("/api/batches", { method: "POST", json: { projectId: "test-proj", title: "t", brief: "b", devices: [] } });
    expect(res.status).toBe(400);
    expect(scheduler.queue.length).toBe(before);
    expect((await call("/api/batches/b-20200101-000000-0000")).status).toBe(404);
  });

  test("a created batch is readable with its runs", async () => {
    const res = await call("/api/batches", {
      method: "POST",
      json: { projectId: "test-proj", title: "Fan", brief: "b", devices: [{ platform: "android" }, { platform: "android" }] },
    });
    expect(res.status).toBe(201);
    const { batchId, runs } = (await res.json()) as { batchId: string; runs: Run[] };
    expect(runs).toHaveLength(2);
    const view = (await (await call(`/api/batches/${batchId}`)).json()) as { id: string; status: string; verdict: null; runs: Run[] };
    expect(view).toMatchObject({ id: batchId, status: "active", verdict: null });
    expect(view.runs).toHaveLength(2);
  });

  test("a client cannot attach a run to a batch through POST /api/runs", async () => {
    const res = await call("/api/runs", {
      method: "POST",
      json: { projectId: "test-proj", title: "sneaky", brief: "b", batchId: "b-20260101-000000-abcd" },
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as Run).batchId).toBeNull();
  });
});

describe("suites, templates, stats, mcp status", () => {
  test("POST saves a suite (id derived from the title), GET lists it, a repeat is a 409", async () => {
    const title = `Api suite ${Date.now()}`;
    const res = await call("/api/projects/test-proj/suites", {
      method: "POST",
      json: { title, brief: "Do it.", checks: [{ id: "C1", title: "One" }], platforms: ["android"] },
    });
    expect(res.status).toBe(201);
    const saved = (await res.json()) as { id: string };
    expect(saved.id).toMatch(/^api-suite-\d+$/);
    const list = (await (await call("/api/projects/test-proj/suites")).json()) as { id: string }[];
    expect(list.map((s) => s.id)).toContain(saved.id);
    const again = await call("/api/projects/test-proj/suites", { method: "POST", json: { id: saved.id, title, brief: "Do it." } });
    expect(again.status).toBe(409);
    expect((await call("/api/projects/test-proj/suites", { method: "POST", json: { title: 5, brief: "x" } })).status).toBe(400);
  });

  test("stats validates days and returns one bucket per day", async () => {
    expect((await call("/api/stats?days=0")).status).toBe(400);
    expect((await call("/api/stats?days=x")).status).toBe(400);
    const stats = (await (await call("/api/stats?days=3&project=test-proj")).json()) as { days: number; byDay: unknown[] };
    expect(stats.days).toBe(3);
    expect(stats.byDay).toHaveLength(3);
  });

  test("templates is an array", async () => {
    expect(Array.isArray(await (await call("/api/templates")).json())).toBe(true);
  });

  test("the MCP status records the newest tools/call and its requester", async () => {
    const rpc = (name: string, args: Record<string, unknown>) =>
      call("/mcp", {
        method: "POST",
        headers: { accept: "application/json, text/event-stream" },
        json: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
      });
    const res = await rpc("qa_list_suites", { projectId: "test-proj", requester: "omp-test" });
    expect(res.status).toBe(200);
    expect(await (await call("/api/mcp/status")).json()).toMatchObject({
      url: `http://127.0.0.1:${config.port}/mcp`,
      lastTool: "qa_list_suites",
      lastRequester: "omp-test",
    });
  });
});

describe("run-management MCP artefact tools", () => {
  const Rpc = z.object({ result: z.object({ isError: z.boolean().optional(), content: z.array(z.object({ text: z.string() })).optional(), tools: z.array(z.looseObject({ name: z.string() })).optional() }).optional() });
  type RpcResult = NonNullable<z.infer<typeof Rpc>["result"]>;

  async function rpc(method: string, params?: Record<string, unknown>): Promise<RpcResult> {
    const res = await call("/mcp", {
      method: "POST",
      headers: { accept: "application/json, text/event-stream" },
      json: { jsonrpc: "2.0", id: 1, method, params },
    });
    const text = await res.text();
    const body = text.startsWith("event:") ? text.split("\n").find((l) => l.startsWith("data: "))!.slice("data: ".length) : text;
    // A JSON-RPC protocol error (unknown tool, bad arguments) has no `result`.
    return Rpc.parse(JSON.parse(body)).result ?? { isError: true };
  }
  const callTool = async (name: string, args: Record<string, unknown>) => {
    const result = await rpc("tools/call", { name, arguments: args });
    return { isError: result.isError === true, text: result.content?.[0]?.text ?? "" };
  };

  test("tools/list offers qa_get_screenshots and qa_export, and project tools no longer take reportsDir", async () => {
    const list = await rpc("tools/list");
    const names = list.tools!.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["qa_get_report", "qa_get_screenshots", "qa_export", "qa_get_run"]));
    const full = JSON.stringify(list.tools);
    expect(full).not.toContain("reportsDir");
  });

  test("a poisoned gateway tool cache takes none of the Tapocalypse tools down and keeps the hints of the gated ones", async () => {
    // Other test files share this process's gateway and may have read (or failed to probe) before our file was planted.
    gateway.reload();
    const list = await rpc("tools/list");
    const names = list.tools!.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["qa_doctor", "qa_get_run", "device_acquire", "mobile_peek"]));
    expect(names.filter((n) => n === "qa_doctor")).toHaveLength(1);
    expect(names).not.toContain("mobile_allocate_remote_device");
    expect(names).not.toContain("mobile_uncompilable");
    const peek = list.tools!.find((t) => t.name === "mobile_peek")!;
    expect(peek).toMatchObject({ title: "Peek at the screen", annotations: { readOnlyHint: true, destructiveHint: false } });
    expect(JSON.stringify(peek.inputSchema)).toContain("leaseId");
  });

  test("no tool offers a driver backend or mentions Artemis", async () => {
    const full = JSON.stringify((await rpc("tools/list")).tools).toLowerCase();
    expect(full).not.toContain("artemis");
    expect(full).not.toContain("backend");
  });

  test("qa_get_run reports absolute report and screenshot paths in the data dir that share one resolved root", async () => {
    const run = await makeDataRun();
    const out = JSON.parse((await callTool("qa_get_run", { runId: run.id })).text) as { reportPath: string | null; screenshotsDir: string | null };
    const real = fs.realpathSync(runDir(run.id));
    expect(out.reportPath).toBe(path.join(real, "report.md"));
    expect(out.screenshotsDir).toBe(path.join(real, "screenshots"));
  });

  test("qa_get_report reads a data run's report and errors for a run without one", async () => {
    const run = await makeDataRun();
    expect((await callTool("qa_get_report", { runId: run.id })).text).toContain(`# QA report ${run.id}`);
    const bare = await makeRun({ status: "done", storage: "data" });
    expect(await callTool("qa_get_report", { runId: bare.id })).toMatchObject({ isError: true });
  });

  test("qa_get_screenshots lists absolute paths with their check and url", async () => {
    const run = await makeDataRun();
    const out = JSON.parse((await callTool("qa_get_screenshots", { runId: run.id })).text) as { checkId: string | null; name: string; path: string; url: string }[];
    expect(out).toEqual([
      {
        checkId: "C1",
        name: "01-home.png",
        path: fs.realpathSync(path.join(runDir(run.id), "screenshots", "01-home.png")),
        url: `/api/runs/${run.id}/files/screenshots/01-home.png`,
      },
    ]);
    expect((await callTool("qa_get_screenshots", { runId: `nope-${run.id}` })).isError).toBe(true);
  });

  test("qa_export copies the artefacts into an absolute directory and refuses a relative one", async () => {
    const run = await makeDataRun();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tapocalypse-mcp-export-"));
    try {
      const ok = await callTool("qa_export", { runId: run.id, dir });
      expect(ok.isError).toBe(false);
      const out = JSON.parse(ok.text) as { report: string | null; screenshots: string[] };
      expect(out.report).toBe(path.join(dir, `QA-REPORT-${run.id}.md`));
      expect(fs.existsSync(path.join(dir, "screenshots", "01-home.png"))).toBe(true);
      expect((await callTool("qa_export", { runId: run.id, dir: "relative/out" })).isError).toBe(true);
      const nul = await callTool("qa_export", { runId: run.id, dir: `${dir}/x\u0000y` });
      expect(nul.isError).toBe(true);
      expect(nul.text).toContain("NUL");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("harnesses", () => {
  test("GET /api/harnesses lists every harness with install state and capabilities", async () => {
    const res = await call("/api/harnesses");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { default: string; harnesses: { id: string; label: string; installed: boolean; capabilities: { steer: boolean } }[] };
    expect(body.harnesses.map((h) => h.id)).toEqual([...HARNESS_IDS]);
    expect(HARNESS_IDS as readonly string[]).toContain(body.default);
    for (const h of body.harnesses) {
      expect(h.label).toBeTruthy();
      // The test preload points every harness binary at a path that does not exist.
      expect(h.installed).toBe(false);
      expect(typeof h.capabilities.steer).toBe("boolean");
    }
  });

  test("GET /api/models answers per harness and rejects an unknown one", async () => {
    for (const id of HARNESS_IDS) {
      const res = await call(`/api/models?harness=${id}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(((await res.json()) as { models: unknown }).models)).toBe(true);
    }
    expect((await call("/api/models?harness=gemini")).status).toBe(400);
    expect((await call("/api/models")).status).toBe(200);
  });

  test("run, batch and rerun requests reject an unknown harness before queueing", async () => {
    const body = { projectId: "test-proj", title: "t", brief: "b", harness: "gemini" };
    const run = await call("/api/runs", { method: "POST", json: body });
    expect(run.status).toBe(400);
    expect(((await run.json()) as { error: string }).error).toContain("harness");
    expect((await call("/api/batches", { method: "POST", json: { ...body, devices: [{ platform: "android" }] } })).status).toBe(400);
    const done = await makeRun({ status: "done", verdict: "PASS" });
    expect((await call(`/api/runs/${done.id}/rerun`, { method: "POST", json: { only: "all", harness: "gemini" } })).status).toBe(400);
  });

  test("a run request can pick a harness, and a rerun can switch it", async () => {
    const created = await call("/api/runs", { method: "POST", json: { projectId: "test-proj", title: "t", brief: "b", harness: "codex" } });
    expect(created.status).toBe(201);
    const run = (await created.json()) as { id: string; harness: string };
    expect(run.harness).toBe("codex");
    Object.assign(scheduler.getLive(run.id)!, { status: "done", verdict: "PASS" });
    scheduler.update(scheduler.getLive(run.id)!);
    const rerun = await call(`/api/runs/${run.id}/rerun`, { method: "POST", json: { only: "all", harness: "claude" } });
    expect(rerun.status).toBe(201);
    expect(((await rerun.json()) as { harness: string }).harness).toBe("claude");
  });
});

describe("run-scoped MCP endpoint", () => {
  const rpc = { jsonrpc: "2.0", id: 1, method: "tools/list" };
  const mcpHeaders = { accept: "application/json, text/event-stream" };

  test("refuses a foreign Host and a non-JSON body", async () => {
    const host = await call("/mcp/runs/abc", { method: "POST", json: rpc, headers: { host: "evil.example", ...mcpHeaders } });
    expect(host.status).toBe(403);
    const plain = await call("/mcp/runs/abc", { method: "POST", headers: { "content-type": "text/plain", ...mcpHeaders }, body: JSON.stringify(rpc) });
    expect(plain.status).toBe(415);
  });

  test("only POST is routed, and an unknown run is refused without leaking whether it exists", async () => {
    expect((await call("/mcp/runs/abc", { headers: mcpHeaders })).status).toBe(405);
    const unknown = await call("/mcp/runs/does-not-exist", { method: "POST", json: rpc, headers: { authorization: "Bearer nope", ...mcpHeaders } });
    expect(unknown.status).toBe(401);
    const noToken = await call("/mcp/runs/another-id", { method: "POST", json: rpc, headers: mcpHeaders });
    expect(noToken.status).toBe(401);
    expect(await noToken.text()).toBe(await unknown.text());
  });
});

// The preload points ADB_BIN at a path that does not exist. A fake adb there, installed for the whole process (every test file
// shares the path, so it must not appear and vanish mid-run), lists one ready emulator for the lease tests below.
const LEASE_SERIAL = "emulator-5590";
const adbBin = process.env.ADB_BIN!;
fs.writeFileSync(
  adbBin,
  [
    "#!/bin/sh",
    'case "$*" in',
    `  "devices -l") printf 'List of devices attached\\n${LEASE_SERIAL} device product:sdk model:sdk_test transport_id:1\\n\\n';;`,
    '  *"emu avd name"*) printf "LEASE_AVD\\nOK\\n";;',
    '  *"wm size"*) printf "Physical size: 1080x2400\\n";;',
    '  *getprop*) printf "14\\nemulator,nosdcard\\n\\n";;',
    "esac",
    "",
  ].join("\n"),
  { mode: 0o755 },
);
afterAll(() => fs.rmSync(adbBin, { force: true }));

describe("device leases", () => {
  const SERIAL = LEASE_SERIAL;
  const HOLDER = "api-test · leases";

  afterEach(() => {
    const owner = deviceOwner(SERIAL);
    if (owner?.kind === "run") releaseRun(owner.lease.runId!);
    else if (owner?.kind === "agent") revoke(SERIAL, owner.lease.ref);
  });

  /** An agent lease made straight in the store (the scheduler of this file is stopped, so acquire cannot grant). */
  const lease = (extra: Partial<Parameters<typeof grantAgent>[0]> = {}) =>
    grantAgent({ serial: SERIAL, platform: "android", avdName: "LEASE_AVD", holder: HOLDER, reason: "api test", ...extra });
  const post = (pathname: string, json: unknown) => call(pathname, { method: "POST", json });

  test("every lease route is a JSON-body route", async () => {
    for (const pathname of ["/api/leases", "/api/leases/renew", "/api/leases/release", `/api/devices/${SERIAL}/release`]) {
      const res = await call(pathname, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
      expect(res.status).toBe(415);
    }
  });

  test("lists and device views show the lease without its secret", async () => {
    const held = lease();
    const listed = await (await call("/api/leases")).text();
    expect((JSON.parse(listed) as { serial: string; holder: string }[]).find((v) => v.serial === SERIAL)).toMatchObject({ holder: HOLDER });
    expect(listed).not.toContain(held.leaseId);

    const devices = await (await call("/api/devices")).text();
    expect((JSON.parse(devices) as { serial: string; lease: { holder: string } | null }[]).find((d) => d.serial === SERIAL)?.lease?.holder).toBe(HOLDER);
    expect(devices).not.toContain(held.leaseId);
  });

  test("acquire arguments are validated before the scheduler sees them", async () => {
    const neither = await post("/api/leases", { holder: HOLDER });
    expect(neither.status).toBe(400);
    expect(await neither.json()).toMatchObject({ code: "invalid_argument" });
    expect((await post("/api/leases", { holder: HOLDER, serial: SERIAL, platform: "android" })).status).toBe(400);
    expect((await post("/api/leases", { serial: SERIAL })).status).toBe(400);
    expect((await post("/api/leases", { serial: SERIAL, holder: HOLDER, waitSeconds: 111 })).status).toBe(400);
    expect((await post("/api/leases", { serial: SERIAL, holder: HOLDER, ttlMinutes: 4 })).status).toBe(400);
    const unknown = await post("/api/leases", { serial: "emulator-5001", holder: HOLDER });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ code: "device_not_found" });
  });

  test("renew and release work with the leaseId; a wrong or spent id is a 404 lease_not_found", async () => {
    const held = lease({ ttlMinutes: 10 });
    const renewed = await post("/api/leases/renew", { leaseId: held.leaseId, ttlMinutes: 60 });
    expect(renewed.status).toBe(200);
    const body = (await renewed.json()) as { serial: string; expiresAt: string };
    expect(body.serial).toBe(SERIAL);
    // The 10-minute lease now runs for the 60 minutes asked at renewal.
    expect(Date.parse(body.expiresAt) - Date.now()).toBeGreaterThan(55 * 60_000);

    const wrong = await post("/api/leases/renew", { leaseId: "not-a-lease" });
    expect(wrong.status).toBe(404);
    expect(await wrong.json()).toMatchObject({ code: "lease_not_found" });
    expect((await post("/api/leases/renew", { leaseId: held.leaseId, ttlMinutes: 1 })).status).toBe(400);

    const released = await post("/api/leases/release", { leaseId: held.leaseId });
    expect(await released.json()).toEqual({ released: true, serial: SERIAL });
    expect(deviceOwner(SERIAL)).toBeNull();
    const again = await post("/api/leases/release", { leaseId: held.leaseId });
    expect(again.status).toBe(404);
    expect(await again.json()).toMatchObject({ code: "lease_not_found" });
  });

  test("force release needs the current ref: 204, 404 without a lease, 409 on a stale ref or a run's lease", async () => {
    const release = (ref: string) => post(`/api/devices/${SERIAL}/release`, { ref });
    expect((await release("deadbeef")).status).toBe(404);
    expect((await post(`/api/devices/${SERIAL}/release`, {})).status).toBe(400);

    const held = lease();
    const stale = await release("00000000");
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "ref_mismatch", lease: { ref: held.ref, holder: HOLDER } });
    expect(deviceOwner(SERIAL)?.kind).toBe("agent");

    expect((await release(held.ref)).status).toBe(204);
    expect(deviceOwner(SERIAL)).toBeNull();

    grantRun(SERIAL, { id: "api-test-run", platform: "android" }, { avdName: "LEASE_AVD" });
    const forRun = await release("anything");
    expect(forRun.status).toBe(409);
    expect(await forRun.json()).toMatchObject({ code: "held_by_run" });
    expect(deviceOwner(SERIAL)?.kind).toBe("run");
  });

  test("a leased device cannot be shut down", async () => {
    lease();
    const res = await call(`/api/devices/${SERIAL}/shutdown`, { method: "POST" });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain(HOLDER);
    expect(deviceOwner(SERIAL)?.kind).toBe("agent");
  });

  test("the global event stream carries lease changes without the secret", async () => {
    const res = await call("/api/events");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = decoder.decode((await reader.read()).value);
    expect(text).toContain("event: hello");
    const held = lease();
    while (!text.includes("event: lease")) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    await reader.cancel();
    const frame = text.split("\n\n").find((f) => f.startsWith("event: lease"))!;
    const event = JSON.parse(frame.split("\n")[1]!.slice("data: ".length)) as { serial: string; change: string; lease: { holder: string } | null };
    expect(event).toMatchObject({ serial: SERIAL, change: "acquired", lease: { holder: HOLDER } });
    expect(frame).not.toContain(held.leaseId);
  });

  test("a stale driver backend in a run request is ignored and not stored", async () => {
    const res = await post("/api/runs", { projectId: "test-proj", title: "t", brief: "b", backend: "artemis" });
    expect(res.status).toBe(201);
    expect(await res.json()).not.toHaveProperty("backend");
  });

  describe("over MCP", () => {
    async function tool(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
      const res = await call("/mcp", {
        method: "POST",
        headers: { accept: "application/json, text/event-stream" },
        json: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
      });
      const text = await res.text();
      const raw = text.startsWith("event:") ? text.split("\n").find((l) => l.startsWith("data: "))!.slice("data: ".length) : text;
      const result = (JSON.parse(raw) as { result?: { isError?: boolean; content?: { text: string }[] } }).result;
      return { isError: result?.isError === true, text: result?.content?.[0]?.text ?? "" };
    }

    test("renew and release take the leaseId; qa_list_devices shows the lease without it", async () => {
      const held = lease();
      const listed = await tool("qa_list_devices", {});
      expect((JSON.parse(listed.text) as { serial: string; lease: { holder: string } | null }[]).find((d) => d.serial === SERIAL)?.lease?.holder).toBe(HOLDER);
      expect(listed.text).not.toContain(held.leaseId);

      expect(JSON.parse((await tool("device_renew", { leaseId: held.leaseId, ttlMinutes: 45 })).text)).toMatchObject({ serial: SERIAL });
      expect(JSON.parse((await tool("device_release", { leaseId: held.leaseId })).text)).toEqual({ released: true, serial: SERIAL });
      expect(deviceOwner(SERIAL)).toBeNull();
    });

    test("errors read '<code>: <message>'", async () => {
      const missing = await tool("device_renew", { leaseId: "nope" });
      expect(missing.isError).toBe(true);
      expect(missing.text).toStartWith("lease_not_found: ");
      expect((await tool("device_release", { leaseId: "nope" })).text).toStartWith("lease_not_found: ");
      const neither = await tool("device_acquire", { holder: HOLDER });
      expect(neither.isError).toBe(true);
      expect(neither.text).toStartWith("invalid_argument: ");
      expect((await tool("device_acquire", { serial: "emulator-5001", holder: HOLDER })).text).toStartWith("device_not_found: ");
    });
  });
});

/** A persisted, keyed, finished run of the test `testKey` (see test/support/regression.ts). */
function keyedRun(testKey: string, at: number, status: "pass" | "fail", over: Partial<Parameters<typeof makeKeyedRun>[0]> = {}): Run {
  return makeKeyedRun({
    testKey,
    at,
    verdict: status === "pass" ? "PASS" : "FAIL",
    checks: [{ id: "C1", title: "Checkout total updates", status, ...(status === "fail" ? { note: "total stayed 0" } : {}) }],
    ...over,
  });
}

/** Adds a screenshot file to the run's C1 check and returns its absolute (symlink-resolved, as the API reports it) path. */
function withScreenshot(run: Run): string {
  const file = path.join(runDir(run.id), "screenshots", "01-total.png");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, PNG);
  updateKeyedRun(run, (r) => {
    r.checks[0]!.screenshot = "screenshots/01-total.png";
  });
  return fs.realpathSync(file);
}

afterAll(() => cleanupKeyedRuns());

describe("regression routes", () => {
  const getJson = async (pathname: string) => {
    const res = await call(pathname);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  type Compare = {
    comparison: { pairs: { transition: string; checkKey: string | null; baseline: { runId: string } | null; current: { note: string | null } | null }[] } | null;
    reason: string | null;
  };

  test("compare against an explicit baseline reports the newly failing check", async () => {
    const test = uniqueTest();
    const base = keyedRun(test, 1, "pass");
    const head = keyedRun(test, 2, "fail");
    const res = await getJson(`/api/runs/${head.id}/compare?baseline=${base.id}`);
    expect(res.status).toBe(200);
    const body = res.body as unknown as Compare;
    expect(body.reason).toBeNull();
    expect(body.comparison?.pairs).toHaveLength(1);
    expect(body.comparison?.pairs[0]).toMatchObject({ transition: "newly_failing", baseline: { runId: base.id }, current: { note: "total stayed 0" } });
  });

  test("a run with nothing to compare with answers 200 with the reason; the run itself and another project's run are 400 with the reason in the body", async () => {
    const test = uniqueTest();
    const solo = keyedRun(test, 1, "pass");
    const none = await getJson(`/api/runs/${solo.id}/compare`);
    expect(none.status).toBe(200);
    expect(none.body).toMatchObject({ comparison: null, reason: "no_baseline" });

    const same = await getJson(`/api/runs/${solo.id}/compare?baseline=${solo.id}`);
    expect(same.status).toBe(400);
    expect(same.body).toMatchObject({ comparison: null, reason: "same_run" });
    expect(typeof same.body.reasonText).toBe("string");
    expect(typeof same.body.error).toBe("string");

    const foreign = keyedRun(test, 2, "pass", { projectId: "other-proj" });
    const other = await getJson(`/api/runs/${solo.id}/compare?baseline=${foreign.id}`);
    expect(other.status).toBe(400);
    expect(other.body).toMatchObject({ comparison: null, reason: "different_project" });
    expect(typeof other.body.reasonText).toBe("string");
  });

  test("compare rejects an unknown run or baseline (404) and a malformed includeFlaky (400)", async () => {
    const solo = keyedRun(uniqueTest(), 1, "pass");
    expect((await call("/api/runs/nope-run/compare")).status).toBe(404);
    expect((await call(`/api/runs/${solo.id}/compare?baseline=nope-run`)).status).toBe(404);
    expect((await call(`/api/runs/${solo.id}/compare?includeFlaky=maybe`)).status).toBe(400);
    expect((await call(`/api/runs/${solo.id}/compare?includeFlaky=1`)).status).toBe(200);
  });

  test("GET /api/runs?regressed=1 lists only runs with newly failing checks and rejects other values", async () => {
    const token = `rg${Date.now()}`;
    const test = uniqueTest();
    const base = keyedRun(test, 1, "pass", { title: `${token} base` });
    const head = keyedRun(test, 2, "fail", { title: `${token} head` });
    const fine = keyedRun(uniqueTest(), 3, "pass", { title: `${token} fine` });
    const ids = async (query: string) => ((await (await call(`/api/runs?${query}`)).json()) as { runs: { id: string }[] }).runs.map((r) => r.id);
    expect(await ids(`q=${token}&regressed=1`)).toEqual([head.id]);
    expect((await ids(`q=${token}`)).sort()).toEqual([base.id, head.id, fine.id].sort());
    expect(await ids(`q=${token}&regressed=0`)).toContain(fine.id);
    expect((await call("/api/runs?regressed=maybe")).status).toBe(400);
  });

  test("baseline candidates, check history and flaky list validate their input and 404 on unknown ids", async () => {
    const test = uniqueTest();
    const base = keyedRun(test, 1, "pass");
    const head = keyedRun(test, 2, "fail");
    const candidates = await getJson(`/api/runs/${head.id}/baseline-candidates?limit=5`);
    expect(candidates.status).toBe(200);
    expect((candidates.body.candidates as { run: { id: string } }[]).map((c) => c.run.id)).toContain(base.id);
    expect((await call(`/api/runs/${head.id}/baseline-candidates?limit=0`)).status).toBe(400);
    expect((await call(`/api/runs/${head.id}/baseline-candidates?limit=101`)).status).toBe(400);
    expect((await call("/api/runs/nope-run/baseline-candidates")).status).toBe(404);

    const history = await getJson(`/api/runs/${head.id}/checks/C1/history`);
    expect(history.status).toBe(200);
    const checkKey = history.body.checkKey as string;
    expect(history.body.projectId).toBe("test-proj");
    expect((history.body.entries as { runId: string; status: string }[]).map((e) => [e.runId, e.status])).toEqual([
      [head.id, "fail"],
      [base.id, "pass"],
    ]);
    const byKey = await getJson(`/api/projects/test-proj/checks/${encodeURIComponent(checkKey)}/history?limit=1`);
    expect(byKey.status).toBe(200);
    expect((byKey.body.entries as unknown[]).length).toBe(1);
    expect(byKey.body.hasMore).toBe(true);
    expect((await call("/api/projects/test-proj/checks/no-such-key/history")).status).toBe(404);
    expect((await call(`/api/runs/${head.id}/checks/C9/history`)).status).toBe(404);
    expect((await call(`/api/runs/${head.id}/checks/C1/history?platform=windows`)).status).toBe(400);
    expect((await call(`/api/runs/${head.id}/checks/C1/history?limit=201`)).status).toBe(400);

    const flaky = await getJson("/api/projects/test-proj/flaky?window=20");
    expect(flaky.status).toBe(200);
    expect(Array.isArray(flaky.body.checks)).toBe(true);
    expect((await call("/api/projects/test-proj/flaky?window=3")).status).toBe(400);
    expect((await call("/api/projects/nope-proj/flaky")).status).toBe(404);
  });
});

describe("check links", () => {
  const link = (method: "POST" | "DELETE", json: unknown) => call("/api/check-links", { method, json });
  const side = (runId: string, checkId = "C1") => ({ runId, checkId });

  test("a non-JSON write is 415, a malformed body 400, an unknown project or run 404", async () => {
    for (const method of ["POST", "DELETE"] as const) {
      expect((await call("/api/check-links", { method, headers: { "content-type": "text/plain" }, body: "{}" })).status).toBe(415);
      expect((await link(method, { projectId: "test-proj" })).status).toBe(400);
    }
    const a = keyedRun(uniqueTest(), 1, "pass");
    expect((await link("POST", { projectId: "nope-proj", a: side(a.id), b: side(a.id) })).status).toBe(404);
    expect((await link("POST", { projectId: "test-proj", a: side(a.id), b: side("nope-run") })).status).toBe(404);
    expect((await link("DELETE", { projectId: "test-proj", b: side("nope-run") })).status).toBe(404);
  });

  test("linking a renamed check puts both on one history, unlinking splits them again", async () => {
    const test = uniqueTest();
    const older = keyedRun(test, 1, "pass", { checks: [{ id: "C1", title: "Checkout total updates", status: "pass", key: `${test}/old` }] });
    const newer = keyedRun(test, 2, "pass", { checks: [{ id: "C1", title: "Order summary shows the new total", status: "pass", key: `${test}/new` }] });
    const keyOf = async (runId: string) => ((await (await call(`/api/runs/${runId}/checks/C1/history`)).json()) as { checkKey: string }).checkKey;
    expect(await keyOf(older.id)).not.toBe(await keyOf(newer.id));

    expect((await link("POST", { projectId: "test-proj", a: side(older.id), b: side(newer.id) })).status).toBe(204);
    expect(await keyOf(newer.id)).toBe(await keyOf(older.id));

    expect((await link("DELETE", { projectId: "test-proj", a: side(older.id), b: side(newer.id) })).status).toBe(204);
    expect(await keyOf(newer.id)).not.toBe(await keyOf(older.id));
  });

  test("confirming a likely match makes the next compare report it as exact", async () => {
    const test = uniqueTest();
    const key = `${test}/total`;
    const older = keyedRun(test, 1, "pass", { checks: [{ id: "C1", title: "Checkout total updates", status: "pass", key, keyKind: "title" }] });
    const newer = keyedRun(test, 2, "pass", { checks: [{ id: "C1", title: "Order summary shows the new total", status: "pass", key, keyKind: "inferred" }] });
    const confidence = async () => {
      const body = (await (await call(`/api/runs/${newer.id}/compare?baseline=${older.id}`)).json()) as { comparison: { pairs: { confidence: string | null }[] } };
      return body.comparison.pairs.map((p) => p.confidence);
    };
    expect(await confidence()).toEqual(["inferred"]);
    expect((await link("POST", { projectId: "test-proj", a: side(older.id), b: side(newer.id) })).status).toBe(204);
    expect(await confidence()).toEqual(["exact"]);
  });

  test("linking a check to itself, or two checks of one run, is refused with 400 and changes nothing", async () => {
    const test = uniqueTest();
    const run = keyedRun(test, 1, "pass", {
      checks: [
        { id: "C1", title: "Checkout total updates", status: "pass", key: `${test}/one` },
        { id: "C2", title: "Order summary shows the new total", status: "pass", key: `${test}/two` },
      ],
    });
    const keyOf = async (checkId: string) => ((await (await call(`/api/runs/${run.id}/checks/${checkId}/history`)).json()) as { checkKey: string }).checkKey;
    const before = [await keyOf("C1"), await keyOf("C2")];
    expect((await link("POST", { projectId: "test-proj", a: side(run.id, "C1"), b: side(run.id, "C1") })).status).toBe(400);
    expect((await link("POST", { projectId: "test-proj", a: side(run.id, "C1"), b: side(run.id, "C2") })).status).toBe(400);
    expect([await keyOf("C1"), await keyOf("C2")]).toEqual(before);
  });

  test("linking checks whose keys already co-exist in one run is refused with 400", async () => {
    const test = uniqueTest();
    const older = keyedRun(test, 1, "pass", {
      checks: [
        { id: "C1", title: "Checkout total updates", status: "pass", key: `${test}/one` },
        { id: "C2", title: "Order summary shows the new total", status: "pass", key: `${test}/two` },
      ],
    });
    const newer = keyedRun(test, 2, "pass", { checks: [{ id: "C1", title: "Checkout total updates", status: "pass", key: `${test}/one` }] });
    expect((await link("POST", { projectId: "test-proj", a: side(newer.id, "C1"), b: side(older.id, "C2") })).status).toBe(400);
  });
});

describe("reuseChecks on start routes", () => {
  test("a non-boolean value is a 400 on runs and batches; a boolean is accepted", async () => {
    const run = { projectId: "test-proj", title: "reuse", brief: "reuse ok" };
    expect((await call("/api/runs", { method: "POST", json: { ...run, reuseChecks: "yes" } })).status).toBe(400);
    expect((await call("/api/batches", { method: "POST", json: { ...run, devices: [{ platform: "android" }], reuseChecks: 1 } })).status).toBe(400);
    expect((await call("/api/runs", { method: "POST", json: { ...run, reuseChecks: true } })).status).toBe(201);
  });
});

describe("regression MCP tools", () => {
  async function mcpRpc(method: string, params?: Record<string, unknown>) {
    const res = await call("/mcp", {
      method: "POST",
      headers: { accept: "application/json, text/event-stream" },
      json: { jsonrpc: "2.0", id: 1, method, params },
    });
    const text = await res.text();
    const raw = text.startsWith("event:") ? text.split("\n").find((l) => l.startsWith("data: "))!.slice("data: ".length) : text;
    return (JSON.parse(raw) as { result: { isError?: boolean; content?: { text: string }[]; tools?: { name: string; inputSchema: { properties: Record<string, unknown> } }[] } }).result;
  }
  const mcpTool = async (name: string, args: Record<string, unknown>) => {
    const result = await mcpRpc("tools/call", { name, arguments: args });
    return { isError: result.isError === true, text: result.content?.[0]?.text ?? "" };
  };
  const mcpJson = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
    const res = await mcpTool(name, args);
    expect(res.isError).toBe(false);
    return JSON.parse(res.text) as T;
  };

  test("the tools are listed, and the start and project tools take the new options", async () => {
    const tools = (await mcpRpc("tools/list")).tools!;
    const props = (name: string) => Object.keys(tools.find((t) => t.name === name)?.inputSchema.properties ?? {});
    for (const name of ["qa_compare_runs", "qa_check_history", "qa_find_regressions"]) expect(tools.some((t) => t.name === name)).toBe(true);
    for (const name of ["qa_start_run", "qa_start_batch"]) expect(props(name)).toContain("reuseChecks");
    for (const name of ["qa_create_project", "qa_update_project"]) expect(props(name)).toContain("defaultBranch");
  });

  test("qa_compare_runs returns changed rows with absolute screenshot paths; includeUnchanged adds the rest", async () => {
    const test = uniqueTest();
    const checks = (status: "pass" | "fail") => [
      { id: "C1", title: "Checkout total updates", status, ...(status === "fail" ? { note: "total stayed 0" } : {}) },
      { id: "C2", title: "Launch screen shows", status: "pass" as const },
    ];
    const base = keyedRun(test, 1, "pass", { checks: checks("pass"), branch: "main" });
    const head = keyedRun(test, 2, "fail", { checks: checks("fail"), branch: "feat-x" });
    const baseShot = withScreenshot(base);
    const headShot = withScreenshot(head);
    type Slim = { transition: string; checkKey: string | null; baseline: { runId: string; screenshotPath: string | null } | null; current: { runId: string; note: string | null; screenshotPath: string | null; screenshotUrl?: unknown } | null };
    const out = await mcpJson<{ baseline: { primaryRunId: string }; counts: Record<string, number>; pairs: Slim[] }>("qa_compare_runs", { runId: head.id, baselineRunId: base.id });
    expect(out.baseline.primaryRunId).toBe(base.id);
    expect(out.counts.newly_failing).toBe(1);
    expect(out.pairs).toHaveLength(1);
    const changed = out.pairs[0]!;
    expect(changed).toMatchObject({ transition: "newly_failing", current: { runId: head.id, note: "total stayed 0" }, baseline: { runId: base.id } });
    expect(changed.checkKey).toEqual(expect.any(String));
    expect(changed.current!.screenshotPath).toBe(headShot);
    expect(changed.baseline!.screenshotPath).toBe(baseShot);
    expect("screenshotUrl" in changed.current!).toBe(false);

    const all = await mcpJson<{ pairs: Slim[] }>("qa_compare_runs", { runId: head.id, baselineRunId: base.id, includeUnchanged: true });
    expect(all.pairs.map((p) => p.transition).sort()).toEqual(["newly_failing", "unchanged"]);

    const auto = await mcpJson<{ baseline: { primaryRunId: string } }>("qa_compare_runs", { runId: head.id });
    expect(auto.baseline.primaryRunId).toBe(base.id);
    expect((await mcpTool("qa_compare_runs", { runId: "nope-run" })).isError).toBe(true);
    const same = await mcpTool("qa_compare_runs", { runId: head.id, baselineRunId: head.id });
    expect(same.isError).toBe(true);
    expect(same.text).toStartWith("same_run: ");
  });

  test("qa_compare_runs says so when there is no baseline", async () => {
    const solo = keyedRun(uniqueTest(), 1, "pass");
    const res = await mcpTool("qa_compare_runs", { runId: solo.id });
    expect(res.isError).toBe(false);
    expect(JSON.parse(res.text)).toMatchObject({ comparison: null, reason: "no_baseline" });
  });

  test("qa_check_history needs projectId+checkKey or runId+checkId and returns absolute screenshot paths", async () => {
    const test = uniqueTest();
    const base = keyedRun(test, 1, "pass");
    const head = keyedRun(test, 2, "fail");
    withScreenshot(base);
    const headShot = withScreenshot(head);
    for (const args of [{}, { projectId: "test-proj" }, { runId: head.id }, { projectId: "test-proj", checkId: "C1" }]) {
      const res = await mcpTool("qa_check_history", args);
      expect(res.isError).toBe(true);
      expect(res.text).toStartWith("invalid_argument: ");
    }
    type History = { checkKey: string; entries: { runId: string; status: string; screenshotPath: string | null; screenshotUrl?: unknown }[] };
    const byRun = await mcpJson<History>("qa_check_history", { runId: head.id, checkId: "C1" });
    expect(byRun.entries.map((e) => [e.runId, e.status])).toEqual([
      [head.id, "fail"],
      [base.id, "pass"],
    ]);
    expect(byRun.entries[0]!.screenshotPath).toBe(headShot);
    expect("screenshotUrl" in byRun.entries[0]!).toBe(false);
    const byKey = await mcpJson<History>("qa_check_history", { projectId: "test-proj", checkKey: byRun.checkKey, limit: 1 });
    expect(byKey.entries).toHaveLength(1);
    expect((await mcpTool("qa_check_history", { projectId: "test-proj", checkKey: "no-such-key" })).isError).toBe(true);
  });

  test("qa_find_regressions needs a source filter, reports a newly failing check with its paths, and says no_runs otherwise", async () => {
    const test = uniqueTest();
    const none = await mcpTool("qa_find_regressions", { projectId: "test-proj" });
    expect(none.isError).toBe(true);
    expect(none.text).toStartWith("invalid_argument: ");

    const branch = `feat-${test.slice(5)}`;
    const base = keyedRun(test, 1, "pass", { branch: "main" });
    const head = keyedRun(test, 2, "fail", { branch });
    const headShot = withScreenshot(head);
    type Found = { status: string; summary: string; tests: { headRunIds: string[]; newlyFailing: { checkKey: string; current: { runId: string; screenshotPath: string | null }; baseline: { runId: string } | null }[] }[] };
    const found = await mcpJson<Found>("qa_find_regressions", { projectId: "test-proj", branch });
    expect(found.status).toBe("regressions");
    expect(found.summary.length).toBeGreaterThan(0);
    expect(found.tests).toHaveLength(1);
    expect(found.tests[0]!.headRunIds).toEqual([head.id]);
    expect(found.tests[0]!.newlyFailing[0]).toMatchObject({ current: { runId: head.id, screenshotPath: headShot }, baseline: { runId: base.id } });

    expect((await mcpJson<Found>("qa_find_regressions", { projectId: "test-proj", branch: `nobody-${branch}` })).status).toBe("no_runs");
    expect((await mcpTool("qa_find_regressions", { projectId: "nope-proj", branch: "main" })).isError).toBe(true);
  });
});
