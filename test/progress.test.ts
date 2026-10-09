import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { ProgressSink } from "../src/harness/types";
import { handleRunMcp } from "../src/mcp/run-server";
import { type ProgressRecorderOptions, type ProgressRun, ProgressRecorder } from "../src/runs/progress";
import type { CheckStatus } from "../src/runs/types";

let repo: string;
let outside: string;

beforeAll(() => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tpc-progress-")));
  repo = path.join(root, "repo");
  outside = path.join(root, "outside");
  fs.mkdirSync(path.join(repo, "qa"), { recursive: true });
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
  };
  return { run, logged, recorder: new ProgressRecorder(options), updates: () => updates };
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

  test("qa_check updates status, timestamps, note and a repo-relative screenshot, and logs it", async () => {
    const { run, logged, recorder } = fixture();
    await recorder.record("qa_plan", { checks: [{ id: "C1", title: "Login" }] });
    await recorder.record("qa_check", { id: "C1", status: "running" });
    expect(run.checks[0]!.startedAt).toBeDefined();
    expect(run.checks[0]!.endedAt).toBeUndefined();
    await recorder.record("qa_check", { id: "C1", status: "pass", note: "ok", screenshot: "qa/./shots/../shot.png" });
    const c = run.checks[0]!;
    expect(c).toMatchObject({ status: "pass", note: "ok", screenshot: "qa/shot.png", title: "Login" });
    expect(c.endedAt).toBeDefined();
    expect(logged.at(-1)).toEqual({ kind: "check", text: "C1: pass — ok", extra: { checkId: "C1", checkStatus: "pass" } });
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

  test("invalid arguments throw a message naming the tool", async () => {
    const { recorder } = fixture();
    await expect(recorder.record("qa_check", { id: "C1", status: "great" })).rejects.toThrow(/invalid qa_check arguments/);
    await expect(recorder.record("qa_plan", { checks: [] })).rejects.toThrow(/invalid qa_plan arguments/);
  });

  test("qa_finish stores the verdict, moves running to finishing and is accepted only once", async () => {
    const { run, logged, recorder } = fixture();
    await recorder.record("qa_finish", { verdict: "PASS WITH ISSUES", summary: "fine", reportPath: "qa/QA-REPORT-1.md" });
    expect(run).toMatchObject({ verdict: "PASS WITH ISSUES", verdictSource: "agent", summary: "fine", reportPath: "qa/QA-REPORT-1.md", status: "finishing" });
    expect(logged.at(-1)!.text).toBe("Finished: PASS WITH ISSUES");
    await expect(recorder.record("qa_finish", { verdict: "FAIL", summary: "again", reportPath: "qa/x.md" })).rejects.toThrow("qa_finish already recorded");
    expect(run.verdict).toBe("PASS WITH ISSUES");
  });

  test("qa_finish keeps a non-running status and rejects a report path outside the repo", async () => {
    const { run, recorder } = fixture("finishing");
    await expect(recorder.record("qa_finish", { verdict: "PASS", summary: "s", reportPath: "../outside/r.md" })).rejects.toThrow(
      "reportPath must be inside the repo",
    );
    expect(run.verdict).toBeNull();
    await recorder.record("qa_finish", { verdict: "PASS", summary: "s", reportPath: "qa/r.md" });
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
  tools: z.array(z.object({ name: z.string(), inputSchema: z.object({ required: z.array(z.string()).optional() }) })),
});
const Init = z.object({ serverInfo: z.object({ name: z.string() }) });
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

    const list = await handleRunMcp(rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }), "run-1", lookup);
    const { tools } = await rpcResult(list, ToolsList);
    expect(tools.map((t) => t.name).sort()).toEqual(["qa_check", "qa_finish", "qa_plan"]);
    expect(tools.find((t) => t.name === "qa_finish")!.inputSchema.required).toEqual(["verdict", "summary", "reportPath"]);

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

    const finish = { verdict: "PASS", summary: "ok", reportPath: "qa/r.md" };
    expect((await callTool("qa_finish", finish)).isError).toBeUndefined();
    const dup = await callTool("qa_finish", finish);
    expect(dup.isError).toBe(true);
    expect(dup.content[0]!.text).toBe("qa_finish already recorded");
    expect(run.checks).toEqual([]);
  });
});
