import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { ProgressSink } from "../src/harness/types";
import { Gateway, type GatewayClient, stopOnLeaseEnd, type ToolDef, type ToolResult } from "../src/devices/gateway";
import { LeaseStore } from "../src/devices/leases";
import { handleRunMcp, type RunGatewayDeps, type RunLookup } from "../src/mcp/run-server";
import { PROGRESS_TOOLS, type ProgressRecorderOptions, type ProgressRun, ProgressRecorder, QaCheckArgs, QaFinishArgs, QaPlanArgs } from "../src/runs/progress";
import type { CheckStatus } from "../src/runs/types";

let repo: string;
let outside: string;
let runsRoot: string;
let runCounter = 0;
const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("pixels")]);

beforeAll(() => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tpc-progress-")));
  repo = path.join(root, "repo");
  outside = path.join(root, "outside");
  fs.mkdirSync(path.join(repo, "qa", "shots"), { recursive: true });
  runsRoot = path.join(root, "runs");
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(repo, "escape"));
});

afterAll(() => fs.rmSync(path.dirname(repo), { recursive: true, force: true }));

interface Logged {
  kind: string;
  text: string;
  extra?: { checkId?: string; checkStatus?: CheckStatus };
}

function fixture(status: ProgressRun["status"] = "running") {
  const run: ProgressRun = { status, checks: [], verdict: null, verdictSource: null, summary: null, reportPath: null };
  const runDir = path.join(runsRoot, `run-${++runCounter}`);
  const logged: Logged[] = [];
  let updates = 0;
  const options: ProgressRecorderOptions = {
    getRun: () => run,
    update: (mutator) => {
      updates++;
      mutator(run);
    },
    log: (kind, text, extra) => logged.push({ kind, text, extra }),
    repoPath: repo,
    runDir,
  };
  return { run, runDir, logged, recorder: new ProgressRecorder(options), updates: () => updates };
}

describe("ProgressRecorder", () => {
  test("qa_plan declares pending checks and logs one check line", async () => {
    const { run, logged, recorder } = fixture();
    const out = await recorder.record("qa_plan", { checks: [{ id: "C1", title: "Login" }, { id: "C2", title: "Logout" }] });
    expect(out).toBe("recorded");
    expect(run.checks.map((c) => [c.id, c.title, c.status])).toEqual([
      ["C1", "Login", "pending"],
      ["C2", "Logout", "pending"],
    ]);
    expect(logged).toEqual([{ kind: "check", text: "Test plan: 2 checks", extra: undefined }]);
  });

  test("qa_check updates status, timestamps and note, and logs it", async () => {
    const { run, logged, recorder } = fixture();
    await recorder.record("qa_plan", { checks: [{ id: "C1", title: "Login" }] });
    await recorder.record("qa_check", { id: "C1", status: "running" });
    expect(run.checks[0]!.startedAt).toBeDefined();
    expect(run.checks[0]!.endedAt).toBeUndefined();
    await recorder.record("qa_check", { id: "C1", status: "pass", note: "ok" });
    const c = run.checks[0]!;
    expect(c).toMatchObject({ status: "pass", note: "ok", title: "Login" });
    expect(c.screenshot).toBeUndefined();
    expect(c.endedAt).toBeDefined();
    expect(logged.at(-1)).toEqual({ kind: "check", text: "C1: pass — ok", extra: { checkId: "C1", checkStatus: "pass" } });
  });

  test("qa_check copies a repo-relative screenshot into the run's screenshots folder and tells the agent its stored name", async () => {
    const { run, runDir, recorder } = fixture();
    fs.writeFileSync(path.join(repo, "qa", "shots", "01 home!.png"), PNG);
    const out = await recorder.record("qa_check", { id: "C1", status: "pass", screenshot: "qa/./shots/../shots/01 home!.png" });
    expect(run.checks[0]!.screenshot).toBe("screenshots/01_home_.png");
    expect(out).toBe("recorded C1 pass; screenshot stored as screenshots/01_home_.png (reference it in the report as screenshots/01_home_.png)");
    expect(fs.readFileSync(path.join(runDir, "screenshots", "01_home_.png"))).toEqual(PNG);
    expect(fs.existsSync(path.join(repo, "qa", "shots", "01 home!.png"))).toBe(true);
  });

  test("qa_check for an undeclared id adds the check", async () => {
    const { run, recorder } = fixture();
    await recorder.record("qa_check", { id: "X", status: "fail" });
    expect(run.checks.map((c) => [c.id, c.title, c.status])).toEqual([["X", "X", "fail"]]);
  });

  test("qa_check rejects a screenshot outside the repo, including through a symlink, and records nothing", async () => {
    const { run, logged, recorder, updates } = fixture();
    await expect(recorder.record("qa_check", { id: "C1", status: "pass", screenshot: "../outside/a.png" })).rejects.toThrow(
      "screenshot path must be inside the repo",
    );
    await expect(recorder.record("qa_check", { id: "C1", status: "pass", screenshot: "escape/a.png" })).rejects.toThrow(
      "screenshot path must be inside the repo",
    );
    expect(run.checks).toEqual([]);
    expect(logged).toEqual([]);
    expect(updates()).toBe(0);
  });

  test("qa_check dedupes colliding names, reuses an identical re-attached image and accepts absolute paths", async () => {
    const { run, runDir, recorder } = fixture();
    fs.mkdirSync(path.join(repo, "qa", "other"), { recursive: true });
    const other = Buffer.concat([PNG, Buffer.from("different")]);
    fs.writeFileSync(path.join(repo, "qa", "shots", "a.png"), PNG);
    fs.writeFileSync(path.join(repo, "qa", "other", "a.png"), other);
    await recorder.record("qa_check", { id: "C1", status: "running", screenshot: "qa/shots/a.png" });
    await recorder.record("qa_check", { id: "C1", status: "pass", screenshot: "qa/shots/a.png" });
    expect(run.checks[0]!.screenshot).toBe("screenshots/a.png");
    const out = await recorder.record("qa_check", { id: "C2", status: "pass", screenshot: path.join(repo, "qa", "other", "a.png") });
    expect(run.checks[1]!.screenshot).toBe("screenshots/a-2.png");
    expect(out).toContain("screenshots/a-2.png");
    expect(fs.readdirSync(path.join(runDir, "screenshots")).sort()).toEqual(["a-2.png", "a.png"]);
    expect(fs.readFileSync(path.join(runDir, "screenshots", "a-2.png"))).toEqual(other);
  });

  test("qa_check does not copy an image the agent already saved into the screenshots folder", async () => {
    const { run, runDir, recorder } = fixture();
    fs.mkdirSync(path.join(runDir, "screenshots"), { recursive: true });
    fs.writeFileSync(path.join(runDir, "screenshots", "01-launch.png"), PNG);
    const out = await recorder.record("qa_check", { id: "C1", status: "pass", screenshot: path.join(runDir, "screenshots", "01-launch.png") });
    expect(run.checks[0]!.screenshot).toBe("screenshots/01-launch.png");
    expect(out).toContain("screenshot stored as screenshots/01-launch.png");
    expect(fs.readdirSync(path.join(runDir, "screenshots"))).toEqual(["01-launch.png"]);
  });

  test("qa_check rejects missing files, non-image content and non-image extensions, and records nothing", async () => {
    const { run, logged, runDir, recorder, updates } = fixture();
    fs.writeFileSync(path.join(repo, "qa", "shots", "fake.png"), "<html>not an image</html>");
    fs.writeFileSync(path.join(repo, "qa", "shots", "notes.txt"), PNG);
    fs.writeFileSync(path.join(repo, "qa", "shots", "tiny.png"), "");
    await expect(recorder.record("qa_check", { id: "C1", status: "pass", screenshot: "qa/shots/none.png" })).rejects.toThrow("not found");
    await expect(recorder.record("qa_check", { id: "C1", status: "pass", screenshot: "/definitely/not/here.png" })).rejects.toThrow("not found");
    await expect(recorder.record("qa_check", { id: "C1", status: "pass", screenshot: "qa/shots/fake.png" })).rejects.toThrow("not a valid image");
    await expect(recorder.record("qa_check", { id: "C1", status: "pass", screenshot: "qa/shots/tiny.png" })).rejects.toThrow("not a valid image");
    await expect(recorder.record("qa_check", { id: "C1", status: "pass", screenshot: "qa/shots/notes.txt" })).rejects.toThrow("must be a");
    expect(run.checks).toEqual([]);
    expect(logged).toEqual([]);
    expect(updates()).toBe(0);
    expect(fs.existsSync(path.join(runDir, "screenshots", "fake.png"))).toBe(false);
  });

  test("qa_check recognises every supported image format by its magic bytes", async () => {
    const { run, recorder } = fixture();
    const formats: [string, Buffer][] = [
      ["jpeg-shot.jpg", Buffer.from("ffd8ffe000104a464946", "hex")],
      ["gif-shot.gif", Buffer.from("GIF89a....")],
      ["webp-shot.webp", Buffer.concat([Buffer.from("RIFF"), Buffer.from([1, 2, 3, 4]), Buffer.from("WEBPVP8 ")])],
    ];
    for (const [i, [name, bytes]] of formats.entries()) {
      fs.writeFileSync(path.join(repo, "qa", "shots", name), bytes);
      await recorder.record("qa_check", { id: `F${i}`, status: "pass", screenshot: `qa/shots/${name}` });
    }
    expect(run.checks.map((c) => c.screenshot)).toEqual(["screenshots/jpeg-shot.jpg", "screenshots/gif-shot.gif", "screenshots/webp-shot.webp"]);
    fs.writeFileSync(path.join(repo, "qa", "shots", "riff.webp"), Buffer.concat([Buffer.from("RIFF"), Buffer.from([1, 2, 3, 4]), Buffer.from("WAVEfmt ")]));
    await expect(recorder.record("qa_check", { id: "W", status: "pass", screenshot: "qa/shots/riff.webp" })).rejects.toThrow("not a valid image");
  });

  test("invalid arguments throw a message naming the tool", async () => {
    const { recorder } = fixture();
    await expect(recorder.record("qa_check", { id: "C1", status: "great" })).rejects.toThrow(/invalid qa_check arguments/);
    await expect(recorder.record("qa_plan", { checks: [] })).rejects.toThrow(/invalid qa_plan arguments/);
  });

  test("qa_finish stores reportMarkdown as the run's report.md, moves running to finishing and is accepted only once", async () => {
    const { run, runDir, logged, recorder } = fixture();
    const out = await recorder.record("qa_finish", { verdict: "PASS WITH ISSUES", summary: "fine", reportMarkdown: "# Report\n\n![a](screenshots/a.png)\n" });
    expect(out).toBe("recorded");
    expect(run).toMatchObject({ verdict: "PASS WITH ISSUES", verdictSource: "agent", summary: "fine", reportPath: "report.md", status: "finishing" });
    expect(fs.readFileSync(path.join(runDir, "report.md"), "utf8")).toBe("# Report\n\n![a](screenshots/a.png)\n");
    expect(logged.at(-1)!.text).toBe("Finished: PASS WITH ISSUES");
    await expect(recorder.record("qa_finish", { verdict: "FAIL", summary: "again", reportMarkdown: "# Other" })).rejects.toThrow("qa_finish already recorded");
    expect(run.verdict).toBe("PASS WITH ISSUES");
    expect(fs.readFileSync(path.join(runDir, "report.md"), "utf8")).toStartWith("# Report");
  });

  test("qa_finish with reportPath reads the file the agent wrote and leaves it untouched", async () => {
    const { run, runDir, recorder } = fixture();
    fs.writeFileSync(path.join(repo, "qa", "mine.md"), "# From a file\n");
    await recorder.record("qa_finish", { verdict: "PASS", summary: "s", reportPath: "qa/mine.md" });
    expect(run.reportPath).toBe("report.md");
    expect(fs.readFileSync(path.join(runDir, "report.md"), "utf8")).toBe("# From a file\n");
    expect(fs.readFileSync(path.join(repo, "qa", "mine.md"), "utf8")).toBe("# From a file\n");

    const second = fixture();
    const abs = path.join(outside, "abs-report.md");
    fs.writeFileSync(abs, "# Absolute\n");
    await second.recorder.record("qa_finish", { verdict: "PASS", summary: "s", reportPath: abs });
    expect(fs.readFileSync(path.join(second.runDir, "report.md"), "utf8")).toBe("# Absolute\n");
  });

  test("qa_finish needs exactly one of reportMarkdown and reportPath and records nothing otherwise", async () => {
    const { run, runDir, logged, recorder, updates } = fixture();
    fs.writeFileSync(path.join(repo, "qa", "both.md"), "# both\n");
    await expect(recorder.record("qa_finish", { verdict: "PASS", summary: "s" })).rejects.toThrow("exactly one of reportMarkdown or reportPath");
    await expect(
      recorder.record("qa_finish", { verdict: "PASS", summary: "s", reportMarkdown: "# x", reportPath: "qa/both.md" }),
    ).rejects.toThrow("exactly one of reportMarkdown or reportPath");
    await expect(recorder.record("qa_finish", { verdict: "PASS", summary: "s", reportPath: "qa/missing.md" })).rejects.toThrow("not found");
    expect(run.verdict).toBeNull();
    expect(run.reportPath).toBeNull();
    expect(fs.existsSync(path.join(runDir, "report.md"))).toBe(false);
    expect(logged).toEqual([]);
    expect(updates()).toBe(0);
  });

  test("qa_finish rejects a relative report path outside the repo and an oversized report, keeping the status", async () => {
    const { run, recorder } = fixture("finishing");
    await expect(recorder.record("qa_finish", { verdict: "PASS", summary: "s", reportPath: "../outside/r.md" })).rejects.toThrow(
      "reportPath must be inside the repo",
    );
    await expect(
      recorder.record("qa_finish", { verdict: "PASS", summary: "s", reportMarkdown: "x".repeat(2 * 1024 * 1024 + 1) }),
    ).rejects.toThrow("report is larger than 2 MB");
    expect(run.verdict).toBeNull();
    await recorder.record("qa_finish", { verdict: "PASS", summary: "s", reportMarkdown: "# ok" });
    expect(run.status).toBe("finishing");
  });
});

const TOKEN = "a".repeat(64);
const URL_ = "http://127.0.0.1:4399/mcp/runs/run-1";

function lookupFor(sink: ProgressSink) {
  return (id: string) => (id === "run-1" ? { token: TOKEN, sink } : null);
}

function rpc(body: unknown, token: string | null = TOKEN): Request {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return new Request(URL_, { method: "POST", headers, body: JSON.stringify(body) });
}

const ToolResult = z.object({ isError: z.boolean().optional(), content: z.array(z.object({ text: z.string() })) });
const ToolsList = z.object({
  tools: z.array(z.object({ name: z.string(), inputSchema: z.object({ required: z.array(z.string()).optional(), properties: z.record(z.string(), z.unknown()).optional() }) })),
});
const Init = z.object({ serverInfo: z.object({ name: z.string() }), capabilities: z.record(z.string(), z.unknown()) });
const rpcResult = async <S extends z.ZodType>(res: Response, schema: S): Promise<z.infer<S>> =>
  schema.parse(z.object({ result: z.unknown() }).parse(await res.json()).result);

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
};

describe("handleRunMcp", () => {
  test("rejects unknown run, wrong token, missing token and a finished run identically", async () => {
    const { recorder } = fixture();
    const lookup = lookupFor(recorder);
    const ok = await handleRunMcp(rpc(INIT), "run-1", lookup);
    expect(ok.status).toBe(200);
    const denied = [
      await handleRunMcp(rpc(INIT, "b".repeat(64)), "run-1", lookup),
      await handleRunMcp(rpc(INIT, null), "run-1", lookup),
      await handleRunMcp(rpc(INIT), "run-2", lookup),
      await handleRunMcp(rpc(INIT, "short"), "run-1", lookup),
    ];
    const bodies = await Promise.all(denied.map(async (r) => ({ status: r.status, body: await r.text() })));
    for (const b of bodies) {
      expect(b.status).toBe(401);
      expect(JSON.parse(b.body)).toMatchObject({ jsonrpc: "2.0", error: { code: expect.any(Number) } });
    }
    expect(new Set(bodies.map((b) => b.body)).size).toBe(1);
  });

  test("initialize → tools/list → tools/call qa_plan reaches the sink", async () => {
    const { run, recorder } = fixture();
    const lookup = lookupFor(recorder);

    const init = await handleRunMcp(rpc(INIT), "run-1", lookup);
    expect(init.status).toBe(200);
    expect((await rpcResult(init, Init)).serverInfo.name).toBe("tpc");

    // A gateway with nothing to offer: this test is about the qa_* protocol, not the device tools.
    const noDevices: RunGatewayDeps = { gateway: new Gateway({ cacheFile: null, spawnClient: async () => { throw new Error("no child"); } }), deviceOf: () => null, cwdOf: () => os.tmpdir() };
    const list = await handleRunMcp(rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }), "run-1", lookup, noDevices);
    const { tools } = await rpcResult(list, ToolsList);
    expect(tools.map((t) => t.name).sort()).toEqual(["qa_check", "qa_finish", "qa_plan"]);
    expect(tools.find((t) => t.name === "qa_finish")!.inputSchema.required).toEqual(["verdict", "summary"]);

    const call = await handleRunMcp(
      rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "qa_plan", arguments: { checks: [{ id: "C1", title: "Login" }] } } }),
      "run-1",
      lookup,
    );
    const result = await rpcResult(call, ToolResult);
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toBe("recorded");
    expect(run.checks.map((c) => c.id)).toEqual(["C1"]);
  });

  test("sink and schema failures come back as tool errors the agent can read", async () => {
    const { run, recorder } = fixture();
    const lookup = lookupFor(recorder);
    const callTool = async (name: string, args: unknown) => {
      const res = await handleRunMcp(rpc({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name, arguments: args } }), "run-1", lookup);
      expect(res.status).toBe(200);
      return rpcResult(res, ToolResult);
    };

    const bad = await callTool("qa_check", { id: "C1", status: "great" });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toContain("status");

    const escape = await callTool("qa_check", { id: "C1", status: "pass", screenshot: "../outside/a.png" });
    expect(escape.isError).toBe(true);
    expect(escape.content[0]!.text).toContain("must be inside the repo");

    const finish = { verdict: "PASS", summary: "ok", reportMarkdown: "# ok" };
    expect((await callTool("qa_finish", finish)).isError).toBeUndefined();
    const dup = await callTool("qa_finish", finish);
    expect(dup.isError).toBe(true);
    expect(dup.content[0]!.text).toBe("qa_finish already recorded");
    expect(run.checks).toEqual([]);
  });
});

const SHOT_TOOL: ToolDef = {
  name: "mobile_take_screenshot",
  description: "Take a screenshot",
  inputSchema: { type: "object", properties: { device: { type: "string" } }, required: ["device"] },
};
const TAP_TOOL: ToolDef = {
  name: "mobile_click_on_screen_at_coordinates",
  description: "Click",
  inputSchema: { type: "object", properties: { device: { type: "string" }, x: { type: "number" }, y: { type: "number" } }, required: ["device", "x", "y"] },
};

class FakeChild implements GatewayClient {
  readonly calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  closed = false;
  private exit = Promise.withResolvers<void>();
  readonly exited = this.exit.promise;
  constructor(readonly cwd: string) {}
  async listTools(): Promise<ToolDef[]> {
    return [SHOT_TOOL, TAP_TOOL];
  }
  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    this.calls.push({ name, args });
    return { content: [{ type: "text", text: `did ${name}` }] };
  }
  async close(): Promise<void> {
    this.closed = true;
    this.exit.resolve();
  }
}

describe("handleRunMcp device tools", () => {
  function gatewayFixture(device: string | null = "Pixel_8") {
    const children: FakeChild[] = [];
    // Memory-only cache: the data dir is shared across test files and api.test.ts plants its own gateway-tools.json there.
    const gateway = new Gateway({
      cacheFile: null,
      spawnClient: async (cwd) => {
        const child = new FakeChild(cwd);
        children.push(child);
        return child;
      },
    });
    const deps = { gateway, deviceOf: (id: string) => (id === "run-1" ? device : null), cwdOf: () => os.tmpdir() };
    return { gateway, children, deps };
  }
  const listTools = async (lookup: RunLookup, deps: RunGatewayDeps) => {
    const res = await handleRunMcp(rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }), "run-1", lookup, deps);
    return rpcResult(res, ToolsList);
  };
  const callTool = async (lookup: RunLookup, deps: RunGatewayDeps, name: string, args: unknown) => {
    const res = await handleRunMcp(rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: args } }), "run-1", lookup, deps);
    return rpcResult(res, ToolResult);
  };

  test("lists the device tools next to qa_*, without a device or leaseId argument", async () => {
    const { gateway, deps } = gatewayFixture();
    const { tools } = await listTools(lookupFor(fixture().recorder), deps);
    expect(tools.map((t) => t.name).sort()).toEqual(["mobile_click_on_screen_at_coordinates", "mobile_take_screenshot", "qa_check", "qa_finish", "qa_plan"]);
    const tap = tools.find((t) => t.name === "mobile_click_on_screen_at_coordinates")!;
    expect(tap.inputSchema.required).toEqual(["x", "y"]);
    expect(Object.keys(tap.inputSchema.properties ?? {})).toEqual(["x", "y"]);
    await gateway.stopAll();
  });

  test("initialize advertises the tools capability even for a native-progress harness, so a client lists tools instead of assuming none", async () => {
    // The stdio bridge (and any SDK client) skips tools/list when initialize says the server has no tools; omp then drops the server.
    const { gateway, deps } = gatewayFixture();
    const lookup = (id: string) => (id === "run-1" ? { token: TOKEN, sink: fixture().recorder, nativeProgress: true } : null);
    const res = await handleRunMcp(rpc(INIT), "run-1", lookup, deps);
    const init = await rpcResult(res, Init);
    expect(init.capabilities).toMatchObject({ tools: {} });
    await gateway.stopAll();
  });

  test("a harness with native progress tools gets the device tools only", async () => {
    const { gateway, deps } = gatewayFixture();
    const lookup = (id: string) => (id === "run-1" ? { token: TOKEN, sink: fixture().recorder, nativeProgress: true } : null);
    const { tools } = await listTools(lookup, deps);
    expect(tools.map((t) => t.name).sort()).toEqual(["mobile_click_on_screen_at_coordinates", "mobile_take_screenshot"]);
    await gateway.stopAll();
  });

  test("a call runs on the run's own device whatever the agent passes, in one child per run that survives between calls", async () => {
    const { gateway, children, deps } = gatewayFixture("Pixel_8");
    const lookup = lookupFor(fixture().recorder);
    const first = await callTool(lookup, deps, "mobile_click_on_screen_at_coordinates", { x: 1, y: 2, device: "someone-elses", leaseId: "x" });
    expect(first).toEqual({ content: [{ text: "did mobile_click_on_screen_at_coordinates" }] });
    await callTool(lookup, deps, "mobile_take_screenshot", {});
    const worker = children.filter((c) => c.calls.length > 0);
    expect(worker).toHaveLength(1);
    expect(worker[0]!.cwd).toBe(os.tmpdir());
    expect(worker[0]!.calls).toEqual([
      { name: "mobile_click_on_screen_at_coordinates", args: { x: 1, y: 2, device: "Pixel_8" } },
      { name: "mobile_take_screenshot", args: { device: "Pixel_8" } },
    ]);
    // the run lease ending stops the run's child through the key the lease store announces
    await gateway.stop("run-1");
    expect(worker[0]!.closed).toBe(true);
    await gateway.stopAll();
  });

  test("a run whose device lease is gone gets an error and nothing is sent to a child", async () => {
    const { gateway, children, deps } = gatewayFixture(null);
    const result = await callTool(lookupFor(fixture().recorder), deps, "mobile_take_screenshot", {});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("device");
    expect(children.every((c) => c.calls.length === 0)).toBe(true);
    await gateway.stopAll();
  });

  test("the run's child is stopped when its run lease ends, and the run's tools then refuse", async () => {
    const { gateway, children } = gatewayFixture();
    const store = new LeaseStore({ now: () => Date.parse("2026-01-01T12:00:00.000Z") });
    stopOnLeaseEnd(store.ends, gateway);
    store.grantRun("emulator-5554", { id: "run-1", platform: "android" }, { avdName: "Pixel_8" });
    const deps: RunGatewayDeps = { gateway, deviceOf: (id) => store.runLease(id)?.mobileDeviceId ?? null, cwdOf: () => os.tmpdir() };
    const lookup = lookupFor(fixture().recorder);

    expect((await callTool(lookup, deps, "mobile_take_screenshot", {})).isError).toBeUndefined();
    const worker = children.find((c) => c.calls.length > 0)!;
    expect(worker.calls[0]!.args).toEqual({ device: "Pixel_8" });
    expect(worker.closed).toBe(false);

    store.releaseRun("run-1");
    await Bun.sleep(5);
    expect(worker.closed).toBe(true);
    const after = await callTool(lookup, deps, "mobile_take_screenshot", {});
    expect(after.isError).toBe(true);
    expect(worker.calls).toHaveLength(1);
    await gateway.stopAll();
  });

  test("qa_* keep working when the device tools are listed", async () => {
    const { run, recorder } = fixture();
    const { gateway, deps } = gatewayFixture();
    const result = await callTool(lookupFor(recorder), deps, "qa_plan", { checks: [{ id: "C1", title: "Login" }] });
    expect(result.content[0]!.text).toBe("recorded");
    expect(run.checks.map((c) => c.id)).toEqual(["C1"]);
    await gateway.stopAll();
  });
});

describe("omp host tool schemas", () => {
  test("mirror the zod argument schemas the MCP endpoint serves (same fields, same required set)", () => {
    const zodByTool = { qa_plan: QaPlanArgs, qa_check: QaCheckArgs, qa_finish: QaFinishArgs };
    for (const tool of PROGRESS_TOOLS) {
      const fromZod = z.toJSONSchema(zodByTool[tool.name], { io: "input" }) as { properties: Record<string, unknown>; required?: string[] };
      const required: readonly string[] = tool.parameters.required;
      expect(Object.keys(tool.parameters.properties).sort()).toEqual(Object.keys(fromZod.properties).sort());
      expect([...required].sort()).toEqual([...(fromZod.required ?? [])].sort());
    }
  });
});

describe("ProgressRecorder file confinement", () => {
  const repoRoot = path.resolve(import.meta.dir, "..");
  const elsewhereImage = path.join(repoRoot, "docs", "images", "runs-dark.png");
  const elsewhereReport = path.join(repoRoot, "README.md");

  test("absolute paths outside the repo, the run folder and the temp folder are rejected for screenshots and reports", async () => {
    const { run, runDir, logged, recorder, updates } = fixture();
    await expect(recorder.record("qa_check", { id: "C1", status: "pass", screenshot: elsewhereImage })).rejects.toThrow("must be inside");
    await expect(recorder.record("qa_finish", { verdict: "PASS", summary: "s", reportPath: elsewhereReport })).rejects.toThrow("must be inside");
    expect(fs.existsSync(path.join(runDir, "screenshots"))).toBe(false);
    expect(fs.existsSync(path.join(runDir, "report.md"))).toBe(false);
    expect([run.checks, run.verdict, logged, updates()]).toEqual([[], null, [], 0]);
  });

  test("absolute paths in the temp folder and in the run folder are accepted", async () => {
    const { run, runDir, recorder } = fixture();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tpc-progress-tmp-"));
    try {
      fs.writeFileSync(path.join(tmp, "shot.png"), PNG);
      fs.writeFileSync(path.join(tmp, "report.md"), "# From tmp\n");
      await recorder.record("qa_check", { id: "C1", status: "pass", screenshot: path.join(tmp, "shot.png") });
      await recorder.record("qa_finish", { verdict: "PASS", summary: "s", reportPath: path.join(tmp, "report.md") });
      expect(run.checks[0]!.screenshot).toBe("screenshots/shot.png");
      expect(fs.readFileSync(path.join(runDir, "report.md"), "utf8")).toBe("# From tmp\n");

      const second = fixture();
      fs.mkdirSync(second.runDir, { recursive: true });
      fs.writeFileSync(path.join(second.runDir, "mine.md"), "# In the run folder\n");
      await second.recorder.record("qa_finish", { verdict: "PASS", summary: "s", reportPath: path.join(second.runDir, "mine.md") });
      expect(fs.readFileSync(path.join(second.runDir, "report.md"), "utf8")).toBe("# In the run folder\n");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a reportPath must be a markdown or text file", async () => {
    const { run, recorder } = fixture();
    fs.writeFileSync(path.join(repo, "qa", "secrets.env"), "KEY=value\n");
    fs.writeFileSync(path.join(repo, "qa", "plain.txt"), "plain report\n");
    await expect(recorder.record("qa_finish", { verdict: "PASS", summary: "s", reportPath: "qa/secrets.env" })).rejects.toThrow(".md");
    expect(run.verdict).toBeNull();
    await recorder.record("qa_finish", { verdict: "PASS", summary: "s", reportPath: "qa/plain.txt" });
    expect(run.reportPath).toBe("report.md");
  });

  test("an oversized reportPath is rejected from its size, before any read", async () => {
    const { run, recorder } = fixture();
    const huge = path.join(repo, "qa", "huge.md");
    fs.writeFileSync(huge, "");
    fs.truncateSync(huge, 1024 * 1024 * 1024); // sparse: a full read would allocate 1 GB
    const started = performance.now();
    await expect(recorder.record("qa_finish", { verdict: "PASS", summary: "s", reportPath: "qa/huge.md" })).rejects.toThrow("report is larger than 2 MB");
    expect(performance.now() - started).toBeLessThan(500);
    expect(run.verdict).toBeNull();
  });

  test("an oversized screenshot is rejected from its size and the tool description names the cap", async () => {
    const { run, runDir, recorder } = fixture();
    const big = path.join(repo, "qa", "shots", "big.png");
    fs.writeFileSync(big, PNG);
    fs.truncateSync(big, 25 * 1024 * 1024 + 1);
    await expect(recorder.record("qa_check", { id: "C1", status: "pass", screenshot: "qa/shots/big.png" })).rejects.toThrow("25 MB");
    expect(run.checks).toEqual([]);
    expect(fs.existsSync(path.join(runDir, "screenshots", "big.png"))).toBe(false);
    const check = PROGRESS_TOOLS.find((t) => t.name === "qa_check")!;
    expect(check.parameters.properties.screenshot.description).toContain("25 MB");
  });

  test("same-sized but different images under one name get separate stored copies; the identical one is reused", async () => {
    const { run, recorder } = fixture();
    fs.mkdirSync(path.join(repo, "qa", "same"), { recursive: true });
    const a = Buffer.concat([PNG, Buffer.from("aaaa")]);
    const b = Buffer.concat([PNG, Buffer.from("bbbb")]);
    fs.writeFileSync(path.join(repo, "qa", "shots", "same.png"), a);
    fs.writeFileSync(path.join(repo, "qa", "same", "same.png"), b);
    await recorder.record("qa_check", { id: "C1", status: "pass", screenshot: "qa/shots/same.png" });
    await recorder.record("qa_check", { id: "C2", status: "pass", screenshot: "qa/same/same.png" });
    await recorder.record("qa_check", { id: "C3", status: "pass", screenshot: "qa/same/same.png" });
    expect(run.checks.map((c) => c.screenshot)).toEqual(["screenshots/same.png", "screenshots/same-2.png", "screenshots/same-2.png"]);
  });

  test("a report written with the old screenshots/<run id>/ layout gets working image links", async () => {
    const { run, runDir, recorder } = fixture();
    const runId = path.basename(runDir);
    fs.writeFileSync(
      path.join(repo, "qa", "old-layout.md"),
      `# Old\n\n![home](screenshots/${runId}/02-home.png)\n![other](screenshots/other-run/x.png)\n`,
    );
    await recorder.record("qa_finish", { verdict: "PASS", summary: "s", reportPath: "qa/old-layout.md" });
    expect(run.reportPath).toBe("report.md");
    expect(fs.readFileSync(path.join(runDir, "report.md"), "utf8")).toBe("# Old\n\n![home](screenshots/02-home.png)\n![other](screenshots/other-run/x.png)\n");
  });
});

describe("qa_plan `was`", () => {
  const hints = { fromRunIds: ["earlier"], checks: [{ id: "W1", title: "Login", checkKey: "t:one" }, { id: "W2", title: "Cart", checkKey: "t:two" }] };

  test("is optional, kept on the check, and absent when the agent gave none", async () => {
    const { run, recorder } = fixture();
    await recorder.record("qa_plan", { checks: [{ id: "C1", title: "Login", was: "W1" }, { id: "C2", title: "New" }] });
    expect(run.checks[0]!.was).toBe("W1");
    expect("was" in run.checks[1]!).toBe(false);
    await expect(recorder.record("qa_plan", { checks: [{ id: "C1", title: "Login", was: 3 }] })).rejects.toThrow("invalid qa_plan arguments");
  });

  test("the omp host tool describes it as an optional string on each check, like the MCP schema", () => {
    const plan = PROGRESS_TOOLS.find((t) => t.name === "qa_plan")!;
    const items = plan.parameters.properties.checks.items;
    const ItemSchema = z.object({
      properties: z.object({ checks: z.object({ items: z.object({ properties: z.record(z.string(), z.unknown()), required: z.array(z.string()) }) }) }),
    });
    const fromZod = ItemSchema.parse(z.toJSONSchema(QaPlanArgs, { io: "input" })).properties.checks.items;
    expect(Object.keys(items.properties).sort()).toEqual(Object.keys(fromZod.properties).sort());
    expect(Object.keys(items.properties)).toContain("was");
    const required: readonly string[] = items.required;
    expect([...required].sort()).toEqual([...fromZod.required].sort());
    expect(required).not.toContain("was");
  });

  test("a claim of an unknown id or of an already-claimed hint is kept on the check and logged as info; a valid claim is not", async () => {
    const { run, logged, recorder } = fixture();
    run.checkHints = hints;
    await recorder.record("qa_plan", {
      checks: [
        { id: "C1", title: "a", was: "W1" },
        { id: "C2", title: "b", was: "W1" },
        { id: "C3", title: "c", was: "W9" },
        { id: "C4", title: "d" },
      ],
    });
    expect(run.checks.map((c) => c.was)).toEqual(["W1", "W1", "W9", undefined]);
    const info = logged.filter((l) => l.kind === "info").map((l) => l.text);
    expect(info).toHaveLength(2);
    expect(info[0]).toContain("C2");
    expect(info[0]).toContain("W1");
    expect(info[1]).toContain("C3");
    expect(info[1]).toContain("W9");
  });

  test("a run that was shown no hints logs nothing for a stray `was`", async () => {
    const { logged, recorder } = fixture();
    await recorder.record("qa_plan", { checks: [{ id: "C1", title: "a", was: "W1" }] });
    expect(logged.filter((l) => l.kind === "info")).toEqual([]);
  });
});
