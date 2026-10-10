import { beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { fetchHandler } from "../src/api";
import { scheduler } from "../src/app";
import { config, MAX_STEER_CHARS } from "../src/config";
import { HARNESS_IDS } from "../src/harness/types";
import { getProject } from "../src/projects/registry";
import { appendStderr, runDir } from "../src/runs/store";
import type { Run } from "../src/runs/types";

const HOST = `127.0.0.1:${config.port}`;
/** Smallest valid PNG header bytes; enough for the magic-byte checks. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const project = getProject("test-proj")!;

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
  const Rpc = z.object({ result: z.object({ isError: z.boolean().optional(), content: z.array(z.object({ text: z.string() })).optional(), tools: z.array(z.object({ name: z.string() })).optional() }).optional() });
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
    const body = (await res.json()) as { default: string; harnesses: { id: string; label: string; installed: boolean; capabilities: { steer: boolean; backends: string[] } }[] };
    expect(body.harnesses.map((h) => h.id)).toEqual([...HARNESS_IDS]);
    expect(HARNESS_IDS as readonly string[]).toContain(body.default);
    for (const h of body.harnesses) {
      expect(h.label).toBeTruthy();
      // The test preload points every harness binary at a path that does not exist.
      expect(h.installed).toBe(false);
      expect(typeof h.capabilities.steer).toBe("boolean");
      expect(h.capabilities.backends).toContain("mobile-mcp");
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
