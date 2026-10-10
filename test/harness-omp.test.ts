import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOmpHarness, type OmpTiming } from "../src/harness/omp";
import { type HarnessEvent, PROGRESS_SERVER, type ProgressSink, type SpawnOptions } from "../src/harness/types";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tapocalypse-fake-omp-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

/**
 * A stand-in for `omp --mode rpc`: answers the RPC commands the adapter sends and plays one scripted turn.
 * A prompt containing "FAIL" makes the turn fail.
 */
const FAKE_OMP = `#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
out({ type: "ready" });
const runDir = path.dirname(process.argv[process.argv.indexOf("--session-dir") + 1]);
fs.writeFileSync(path.join(runDir, "argv.json"), JSON.stringify(process.argv.slice(2)));
const fake = JSON.parse(fs.readFileSync(path.join(runDir, "fake.json"), "utf8"));
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => setTimeout(() => process.exit(0), fake.exitDelayMs ?? 0));
let failing = false;
function respond(cmd, data) { out({ type: "response", id: cmd.id, success: true, data }); }
function handle(cmd) {
  if (cmd.type === "get_state") return respond(cmd, { systemPrompt: "MCP Tool Routes: xd://mcp__tpc_mobile_mcp_mobile_list_elements_on_screen" });
  if (cmd.type === "set_host_tools") return respond(cmd, {});
  if (cmd.type === "get_session_stats") return respond(cmd, { tokens: { input: 5, output: 6 }, cost: 0.25, toolCalls: 2 });
  if (cmd.type === "export_html") { fs.writeFileSync(cmd.outputPath, "<html></html>"); return respond(cmd, {}); }
  if (cmd.type === "abort") return respond(cmd, {});
  if (cmd.type === "prompt") {
    failing = cmd.message.includes("FAIL");
    respond(cmd, {});
    out({ type: "tool_execution_start", toolCallId: "h1", toolName: "qa_plan", args: { checks: [{ id: "C1", title: "x" }] } });
    out({ type: "host_tool_call", id: "ht1", toolName: "qa_plan", arguments: { checks: [{ id: "C1", title: "x" }] } });
    return;
  }
}
process.stdin.on("data", (chunk) => {
  for (const line of String(chunk).split("\\n")) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.type !== "host_tool_result") continue;
    out({ type: "tool_execution_end", toolCallId: "h1", toolName: "qa_plan", isError: msg.isError === true, result: msg.result });
    out({ type: "message_end", message: { role: "assistant", model: "m", provider: "p", content: [{ type: "text", text: "done" }], usage: { input: 5, output: 6, cost: { total: 0.25 } } } });
    if (failing) out({ type: "prompt_result", status: "error", error: { message: "overloaded" } });
    out({ type: "session_settled" });
  }
});
`;

const fakeBin = path.join(root, "omp");
fs.writeFileSync(fakeBin, FAKE_OMP, { mode: 0o755 });

interface Started {
  events: HarnessEvent[];
  raw: object[];
  progress: { tool: string; args: unknown }[];
  stderr: string[];
  opts: SpawnOptions;
  /** Resolves when the adapter emits `turn_end`. */
  turnEnded: Promise<void>;
}

function spawn(over: Partial<SpawnOptions> = {}, timing: Partial<OmpTiming> = {}, fake: { exitDelayMs?: number } = {}) {
  const runDir = fs.mkdtempSync(path.join(root, "run-"));
  fs.writeFileSync(path.join(runDir, "persona.md"), "persona");
  fs.writeFileSync(path.join(runDir, "fake.json"), JSON.stringify(fake));
  const { promise: turnEnded, resolve: markTurnEnded } = Promise.withResolvers<void>();
  const state: Started = { events: [], raw: [], progress: [], stderr: [], opts: undefined as never, turnEnded };
  const sink: ProgressSink = {
    record: async (tool, args) => {
      state.progress.push({ tool, args });
      return "recorded";
    },
  };
  const opts: SpawnOptions = {
    runId: "r1",
    cwd: root,
    runDir,
    persona: "persona",
    personaFile: path.join(runDir, "persona.md"),
    model: null,
    effort: null,
    mcpServers: [],
    limits: { maxTime: "60s", maxTurns: null, maxBudgetUsd: null },
    settings: { bin: fakeBin },
    onEvent: (e) => {
      state.events.push(e);
      if (e.type === "turn_end") markTurnEnded();
    },
    onRaw: (f) => state.raw.push(f),
    onStderr: (t) => state.stderr.push(t),
    onProgress: sink,
    ...over,
  };
  state.opts = opts;
  return { session: createOmpHarness(timing).spawn(opts), state };
}

describe("omp adapter against a fake omp process", () => {
  test("mounts the device tools, routes host-tool calls to the progress sink, reports usage and releases the session", async () => {
    const { session, state } = spawn();
    const info = await session.ready();
    expect(info.mcp).toEqual([{ name: "mobile_mcp", ok: true }]);
    expect(state.events).toContainEqual(expect.objectContaining({ type: "notice", level: "info" }));
    expect(session.toolName("mobile_mcp", "mobile_click")).toBe("mcp__tpc_mobile_mcp_mobile_click");
    expect(session.toolName(PROGRESS_SERVER, "qa_plan")).toBe("qa_plan");

    await session.send("go");
    await state.turnEnded;

    expect(state.progress).toEqual([{ tool: "qa_plan", args: { checks: [{ id: "C1", title: "x" }] } }]);
    expect(state.events.find((e) => e.type === "turn_end")).toEqual({ type: "turn_end", ok: true, error: null, limit: null });
    expect(state.events).toContainEqual({ type: "tool_call", callId: "h1", tool: "qa_plan", server: null, args: { checks: [{ id: "C1", title: "x" }] } });
    expect(state.events).toContainEqual(expect.objectContaining({ type: "usage", cumulative: true, usage: expect.objectContaining({ tokensIn: 5, tokensOut: 6, cost: 0.25 }) }));
    expect(state.raw.map((f) => (f as { type: string }).type)).toContain("tool_execution_start");

    expect(await session.usage()).toEqual({ cost: 0.25, tokensIn: 5, tokensOut: 6, cacheRead: 0, cacheWrite: 0, toolCalls: 2, model: null });
    const transcript = path.join(state.opts.runDir, "transcript.html");
    expect(await session.exportTranscript?.(transcript)).toBe(true);
    expect(fs.existsSync(transcript)).toBe(true);

    await session.abort();
    expect(await session.exited).toMatchObject({ code: 0, settled: true, started: true, limit: null, error: null });
  });

  test("a failed prompt is reported as a failed turn and as the exit error", async () => {
    const { session, state } = spawn();
    await session.ready();
    await session.send("go FAIL");
    await state.turnEnded;
    expect(state.events.find((e) => e.type === "turn_end")).toEqual({ type: "turn_end", ok: false, error: "overloaded", limit: null });
    await session.abort();
    expect(await session.exited).toMatchObject({ settled: true, error: "overloaded" });
  });

  test("kill before the process answered still ends the session", async () => {
    const { session } = spawn();
    session.kill();
    expect(await session.exited).toMatchObject({ settled: false });
  });

  test("a binary that cannot be spawned is a session that never ran, reported through exited and ready", async () => {
    const { session } = spawn({ settings: { bin: path.join(root, "no-such-omp") } });
    await expect(session.ready()).rejects.toThrow();
    expect(await session.exited).toMatchObject({ started: false, settled: false, error: expect.any(String) });
  });

  test("rawStats returns the get_session_stats payload for Run.stats", async () => {
    const { session } = spawn();
    await session.ready();
    expect(await session.rawStats?.()).toEqual({ tokens: { input: 5, output: 6 }, cost: 0.25, toolCalls: 2 });
    session.kill();
    await session.exited;
  });

  test("--max-time is the configured string, not a recomputed one", async () => {
    const { session, state } = spawn({ limits: { maxTime: "90m", maxTurns: null, maxBudgetUsd: null } });
    await session.ready();
    const argv = JSON.parse(fs.readFileSync(path.join(state.opts.runDir, "argv.json"), "utf8")) as string[];
    expect(argv[argv.indexOf("--max-time") + 1]).toBe("90m");
    session.kill();
    await session.exited;
  });

  // Real processes with a slow exit: the grace periods are what is under test.
  test("after the turn settled omp gets the long drain to exit by itself; an aborted turn only the short grace", async () => {
    const timing = { abortGraceMs: 100, drainGraceMs: 3_000 };
    const settled = spawn({}, timing, { exitDelayMs: 600 });
    await settled.session.ready();
    await settled.session.send("go");
    await settled.state.turnEnded;
    await settled.session.abort();
    expect(await settled.session.exited).toMatchObject({ code: 0, settled: true, started: true });

    const running = spawn({}, timing, { exitDelayMs: 600 });
    await running.session.ready();
    await running.session.abort();
    expect((await running.session.exited).code).not.toBe(0);
  });
});
