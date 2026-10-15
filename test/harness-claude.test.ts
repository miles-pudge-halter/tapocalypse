import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExecResult } from "../src/devices/devices";
import { createClaudeHarness } from "../src/harness/claude";
import type { ClaudeProcess } from "../src/harness/claude/session";
import type { Activity } from "../src/runs/types";
import type { HarnessEvent, HarnessSession, McpServerSpec, ReplayContext, SpawnOptions } from "../src/harness/types";

const fixtureFrames = (name: string): Record<string, unknown>[] =>
  fs
    .readFileSync(path.join(import.meta.dir, "fixtures", name), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

const streamFrames = fixtureFrames("claude-stream.jsonl");
const errorFrames = fixtureFrames("claude-stream-error.jsonl");

const encoder = new TextEncoder();

/** A scripted stand-in for `claude -p --input-format stream-json`: records stdin, plays frames when a user message arrives. */
class FakeClaude implements ClaudeProcess {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  private out!: ReadableStreamDefaultController<Uint8Array>;
  private err!: ReadableStreamDefaultController<Uint8Array>;
  private done = Promise.withResolvers<number>();
  readonly exited = this.done.promise;
  signalCode: NodeJS.Signals | null = null;
  /** Every stdin line, parsed. */
  readonly written: Record<string, unknown>[] = [];
  stdinClosed = false;
  /** Signals received, in order. */
  readonly signals: string[] = [];
  /** MCP statuses answered to `mcp_status`; each call shifts one entry, the last repeats. */
  mcpStatuses: { name: string; status: string; error?: string }[][] = [
    [
      { name: "tpc", status: "connected" },
      { name: "mobile_mcp", status: "connected" },
    ],
  ];
  /** Frames to emit when the first user message arrives. */
  script: Record<string, unknown>[] = [];
  /** Exit when stdin closes (a real claude does); disable to test escalation. */
  exitOnStdinEnd = true;
  /** Signals that terminate the process. */
  diesOn: NodeJS.Signals[] = ["SIGTERM", "SIGKILL"];
  /** Stop answering control requests (a wedged process). */
  silent = false;
  private closed = false;

  constructor() {
    this.stdout = new ReadableStream({ start: (c) => void (this.out = c) });
    this.stderr = new ReadableStream({ start: (c) => void (this.err = c) });
  }

  readonly stdin = {
    write: (data: string | Uint8Array) => {
      const text = typeof data === "string" ? data : new TextDecoder().decode(data);
      for (const line of text.split("\n").filter(Boolean)) this.receive(JSON.parse(line));
      return text.length;
    },
    end: () => {
      this.stdinClosed = true;
      if (this.exitOnStdinEnd) queueMicrotask(() => this.exit(0));
    },
  };

  private receive(msg: Record<string, unknown>): void {
    this.written.push(msg);
    if (msg.type === "control_request") {
      const request = msg.request as { subtype?: string };
      if (request.subtype === "mcp_status" && !this.silent) {
        const servers = this.mcpStatuses.length > 1 ? this.mcpStatuses.shift() : this.mcpStatuses[0];
        this.emit({
          type: "control_response",
          response: { subtype: "success", request_id: msg.request_id, response: { mcpServers: servers } },
        });
      }
    } else if (msg.type === "user" && this.written.filter((w) => w.type === "user").length === 1) {
      for (const frame of this.script) this.emit(frame);
    }
  }

  emit(frame: Record<string, unknown> | string): void {
    if (this.closed) return;
    this.out.enqueue(encoder.encode(`${typeof frame === "string" ? frame : JSON.stringify(frame)}\n`));
  }

  emitStderr(text: string): void {
    this.err.enqueue(encoder.encode(text));
  }

  exit(code: number, signal: NodeJS.Signals | null = null): void {
    if (this.closed) return;
    this.closed = true;
    this.signalCode = signal;
    this.out.close();
    this.err.close();
    this.done.resolve(code);
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    this.signals.push(signal);
    if (this.diesOn.includes(signal)) this.exit(signal === "SIGKILL" ? 137 : 143, signal);
  }

  get userMessages(): Record<string, unknown>[] {
    return this.written.filter((w) => w.type === "user");
  }
}

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const progressServer: McpServerSpec = {
  name: "tpc",
  transport: "http",
  url: "http://127.0.0.1:4310/mcp/runs/r1",
  headers: { Authorization: "Bearer SECRET-RUN-TOKEN" },
};
const mobileServer: McpServerSpec = {
  name: "mobile_mcp",
  transport: "stdio",
  command: "npx",
  args: ["-y", "@mobilenext/mobile-mcp@latest"],
  env: { MOBILE_FLAG: "1" },
};

interface Rig {
  fake: FakeClaude;
  session: HarnessSession;
  events: HarnessEvent[];
  raw: object[];
  stderr: string[];
  spawned: { cmd: string[]; cwd: string; env: Record<string, string | undefined> }[];
  runDir: string;
  opts: SpawnOptions;
}

function rig(
  over: Partial<SpawnOptions> = {},
  timing: { interruptWaitMs?: number; graceMs?: number; killGraceMs?: number; readyTimeoutMs?: number; controlTimeoutMs?: number } = {},
): Rig {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "tpc-claude-"));
  tmpDirs.push(runDir);
  const personaFile = path.join(runDir, "persona.md");
  fs.writeFileSync(personaFile, "You are a QA agent.");
  const fake = new FakeClaude();
  fake.script = streamFrames;
  const events: HarnessEvent[] = [];
  const raw: object[] = [];
  const stderr: string[] = [];
  const spawned: Rig["spawned"] = [];
  const harness = createClaudeHarness({
    spawn: (cmd, o) => {
      spawned.push({ cmd, cwd: o.cwd, env: o.env });
      return fake;
    },
    interruptWaitMs: timing.interruptWaitMs ?? 20,
    graceMs: timing.graceMs ?? 20,
    killGraceMs: timing.killGraceMs ?? 20,
    readyTimeoutMs: timing.readyTimeoutMs ?? 500,
    controlTimeoutMs: timing.controlTimeoutMs ?? 500,
    mcpPollMs: 5,
  });
  const opts: SpawnOptions = {
    runId: "r1",
    cwd: "/work/app",
    runDir,
    persona: "You are a QA agent.",
    personaFile,
    device: { serial: "emulator-5554", platform: "android" },
    model: null,
    effort: null,
    mcpServers: [progressServer, mobileServer],
    limits: { maxTime: null, maxTurns: null, maxBudgetUsd: null },
    settings: {},
    onEvent: (e) => events.push(e),
    onRaw: (f) => raw.push(f),
    onStderr: (t) => stderr.push(t),
    ...over,
  };
  return { fake, session: harness.spawn(opts), events, raw, stderr, spawned, runDir, opts };
}

const brief = (e: HarnessEvent): string => {
  switch (e.type) {
    case "session":
      return `session ${e.sessionId} ${e.model}`;
    case "tool_call":
      return `call ${e.tool}${e.server ? ` @${e.server}` : ""}`;
    case "tool_result":
      return `result ${e.callId} ${e.ok ? "ok" : "fail"}`;
    case "text":
      return `text ${e.text}`;
    case "notice":
      return `notice ${e.level}`;
    case "turn_end":
      return `turn_end ${e.ok ? "ok" : "fail"}${e.limit ? ` ${e.limit}` : ""}`;
    case "usage":
      return `usage ${e.cumulative ? "total" : "delta"}`;
  }
};

describe("claude session event stream", () => {
  test("plays a full QA stream as normalized events, canonical tool names and persisted raw frames", async () => {
    const r = rig();
    const info = await r.session.ready();
    expect(info.mcp).toEqual([
      { name: "tpc", ok: true },
      { name: "mobile_mcp", ok: true },
    ]);
    await r.session.send("Run the QA brief.");
    const exit = await r.session.exited;

    expect(r.events.filter((e) => e.type !== "usage").map(brief)).toEqual([
      "session sess-1 claude-sonnet-5-5",
      "text Starting the QA run.",
      "call qa_plan @tpc",
      "result toolu_plan ok",
      "call bash",
      "result toolu_bash ok",
      "notice warn",
      "call qa_check @tpc",
      "result toolu_chk ok",
      "call mcp__mobile_mcp_mobile_take_screenshot @mobile_mcp",
      "result toolu_shot ok",
      "notice warn",
      "call write",
      "result toolu_write fail",
      "call qa_finish @tpc",
      "result toolu_fin ok",
      "text Done.",
      "turn_end ok",
    ]);
    // raw frames are persisted verbatim and in order (control responses are not part of the stream)
    expect(r.raw).toEqual(streamFrames);
    expect(exit).toEqual({ code: 0, signal: null, settled: true, started: true, limit: null, error: null });
  });
});

describe("claude spawn and callback failures", () => {
  test("a spawn that throws yields a session that never ran (infra), not an exception", async () => {
    const { opts } = rig();
    const harness = createClaudeHarness({
      spawn: () => {
        throw new Error("spawn claude ENOENT");
      },
    });
    const session = harness.spawn(opts);
    await expect(session.ready()).rejects.toThrow(/ENOENT/);
    expect(await session.exited).toMatchObject({ started: false, settled: false, error: expect.stringContaining("ENOENT") });
  });

  test("invalid settings also produce a session that never ran", async () => {
    const { opts } = rig();
    const session = createClaudeHarness().spawn({ ...opts, settings: { permissions: "yolo" } });
    expect(await session.exited).toMatchObject({ started: false, error: expect.stringContaining("settings") });
  });

  test("a throwing onRaw/onStderr never stops the stream: later frames still arrive and the session settles", async () => {
    let raws = 0;
    const r = rig({
      onRaw: () => {
        raws++;
        throw new Error("disk full");
      },
      onStderr: () => {
        throw new Error("listener blew up");
      },
    });
    await r.session.ready();
    await r.session.send("go");
    r.fake.emitStderr("noise\n");
    const exit = await r.session.exited;
    expect(exit).toMatchObject({ settled: true, started: true });
    expect(raws).toBe(streamFrames.length);
    expect(r.events.at(-1)).toMatchObject({ type: "turn_end", ok: true });
  });
});

const sumUsage = (events: HarnessEvent[]) => {
  const total = { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, toolCalls: 0 };
  for (const e of events) {
    if (e.type !== "usage" || e.cumulative) continue;
    for (const k of Object.keys(total) as (keyof typeof total)[]) total[k] += e.usage[k] ?? 0;
  }
  return total;
};

describe("claude usage", () => {
  test("final usage comes from the result frame: cost, tokens, tool calls and the model", async () => {
    const r = rig();
    await r.session.ready();
    await r.session.send("go");
    await r.session.exited;
    expect(await r.session.usage()).toEqual({
      cost: 0.1234,
      tokensIn: 225,
      tokensOut: 135,
      cacheRead: 4500,
      cacheWrite: 500,
      toolCalls: 6,
      model: "claude-sonnet-5-5",
    });
    // live deltas (counted once per assistant message id) add up to the same totals
    const total = r.events.findLast((e) => e.type === "usage" && e.cumulative);
    expect(total?.type === "usage" && total.usage.cost).toBe(0.1234);
    expect(sumUsage(r.events)).toEqual({ tokensIn: 225, tokensOut: 135, cacheRead: 4500, cacheWrite: 500, toolCalls: 6 });
  });

  test("a session that dies before its result still reports the tokens seen so far", async () => {
    const r = rig();
    r.fake.script = streamFrames.slice(0, 5);
    r.fake.exitOnStdinEnd = false;
    await r.session.ready();
    await r.session.send("go");
    await Bun.sleep(10);
    r.fake.exit(137, "SIGKILL");
    const exit = await r.session.exited;
    expect(exit.settled).toBe(false);
    expect(await r.session.usage()).toMatchObject({ cost: null, tokensIn: 150, tokensOut: 45, cacheWrite: 500, toolCalls: 2, model: "claude-sonnet-5-5" });
  });
});

const resultFrame = (over: Record<string, unknown>): Record<string, unknown> => ({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "",
  session_id: "s",
  total_cost_usd: 0.5,
  usage: { input_tokens: 1, output_tokens: 1 },
  modelUsage: {},
  ...over,
});

async function runToEnd(frames: Record<string, unknown>[]) {
  const r = rig();
  r.fake.script = frames;
  await r.session.ready();
  await r.session.send("go");
  const exit = await r.session.exited;
  return { exit, turn: r.events.find((e) => e.type === "turn_end"), events: r.events };
}

describe("claude result classification", () => {
  test("is_error with subtype success is a failed turn named by the result text (the API-failure trap)", async () => {
    const { exit, turn } = await runToEnd(errorFrames);
    expect(turn).toEqual({ type: "turn_end", ok: false, error: "API Error: Connection refused", limit: null });
    expect(exit).toMatchObject({ settled: true, limit: null, error: "API Error: Connection refused" });
  });

  test("error_max_turns ends the session at the turn limit, with the error texts from the result", async () => {
    const { exit, turn } = await runToEnd([
      resultFrame({ subtype: "error_max_turns", is_error: true, terminal_reason: "max_turns", errors: ["Reached maximum number of turns (3)"] }),
    ]);
    expect(turn).toEqual({ type: "turn_end", ok: false, error: "Reached maximum number of turns (3)", limit: "turns" });
    expect(exit).toMatchObject({ limit: "turns", error: "Reached maximum number of turns (3)" });
  });

  test("error_max_budget_usd ends the session at the budget limit", async () => {
    const { exit, turn } = await runToEnd([resultFrame({ subtype: "error_max_budget_usd", is_error: true })]);
    expect(turn).toMatchObject({ ok: false, limit: "budget" });
    expect(exit.limit).toBe("budget");
    expect(exit.error).toContain("budget");
  });

  test("a limit named only by terminal_reason is still a limit", async () => {
    const { turn } = await runToEnd([resultFrame({ subtype: "success", is_error: true, terminal_reason: "budget_exhausted", result: "stopped" })]);
    expect(turn).toEqual({ type: "turn_end", ok: false, error: "stopped", limit: "budget" });
  });

  test("a clean result is ok whatever else it carries", async () => {
    const { exit, turn } = await runToEnd([resultFrame({ terminal_reason: "completed", result: "All good" })]);
    expect(turn).toEqual({ type: "turn_end", ok: true, error: null, limit: null });
    expect(exit).toMatchObject({ settled: true, error: null, limit: null });
  });
});

const userText = (m: Record<string, unknown>): unknown => ((m.message as { content: { text: string }[] }).content[0]).text;

describe("claude steer and abort", () => {
  test("send and steer are stream-json user messages on stdin, in order", async () => {
    const r = rig();
    r.fake.script = [];
    await r.session.ready();
    await r.session.send("Run the QA brief.");
    await r.session.steer?.("Wrap up now.");
    expect(r.fake.userMessages.map(userText)).toEqual(["Run the QA brief.", "Wrap up now."]);
    expect(r.fake.userMessages[0]).toMatchObject({ type: "user", message: { role: "user" } });
    expect(r.fake.stdinClosed).toBe(false);
    r.session.kill();
    await r.session.exited;
  });

  test("stdin is closed once the final result arrives, and steering after that is rejected", async () => {
    const r = rig();
    await r.session.ready();
    await r.session.send("go");
    await r.session.exited;
    expect(r.fake.stdinClosed).toBe(true);
    await expect(Promise.resolve().then(() => r.session.steer?.("too late"))).rejects.toThrow();
  });

  test("abort interrupts the turn through a control_request, then closes stdin and waits for exit", async () => {
    const r = rig();
    r.fake.script = [];
    await r.session.ready();
    await r.session.send("go");
    const aborted = r.session.abort();
    await aborted;
    const interrupt = r.fake.written.findIndex((w) => w.type === "control_request" && (w.request as { subtype: string }).subtype === "interrupt");
    expect(interrupt).toBeGreaterThan(0);
    expect(r.fake.written.length - 1).toBe(interrupt);
    expect(r.fake.stdinClosed).toBe(true);
    expect(r.fake.signals).toEqual([]);
    expect((await r.session.exited).code).toBe(0);
  });

  test("abort escalates to SIGTERM, then SIGKILL, when the process ignores stdin close", async () => {
    const r = rig();
    r.fake.script = [];
    r.fake.exitOnStdinEnd = false;
    r.fake.diesOn = ["SIGKILL"];
    await r.session.ready();
    await r.session.abort();
    expect(r.fake.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(await r.session.exited).toMatchObject({ code: 137, signal: "SIGKILL", settled: false });
  });

  test("abort stops at SIGTERM when that is enough", async () => {
    const r = rig();
    r.fake.script = [];
    r.fake.exitOnStdinEnd = false;
    await r.session.ready();
    await r.session.abort();
    expect(r.fake.signals).toEqual(["SIGTERM"]);
  });

  test("kill terminates the process without a model-visible interrupt", async () => {
    const r = rig();
    r.fake.script = [];
    r.fake.exitOnStdinEnd = false;
    await r.session.ready();
    r.session.kill();
    expect((await r.session.exited).signal).toBe("SIGTERM");
    expect(r.fake.written.some((w) => w.type === "control_request" && (w.request as { subtype: string }).subtype === "interrupt")).toBe(false);
  });
});

describe("claude spawn configuration", () => {
  test("the agent does not inherit the team hub's upload token or proxy headers", () => {
    process.env.TAPOCALYPSE_HUB_TOKEN = "tpu_secret";
    process.env.TAPOCALYPSE_HUB_HEADERS = '{"X-Proxy":"secret"}';
    try {
      const { env } = rig().spawned[0];
      expect(Object.keys(env).filter((k) => k.startsWith("TAPOCALYPSE_HUB_"))).toEqual([]);
      expect(env.PATH).toBe(process.env.PATH);
    } finally {
      delete process.env.TAPOCALYPSE_HUB_TOKEN;
      delete process.env.TAPOCALYPSE_HUB_HEADERS;
    }
  });

  test("argv: stream-json in/out, isolated MCP and persona files, bypass permissions, native model/effort/limits; the token stays out", () => {
    const r = rig({
      model: "opus",
      effort: "high",
      limits: { maxTime: "10m", maxTurns: 40, maxBudgetUsd: 5 },
    });
    expect(r.spawned).toHaveLength(1);
    expect(r.spawned[0].cwd).toBe("/work/app");
    expect(r.spawned[0].cmd).toEqual([
      "claude",
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--no-session-persistence",
      "--strict-mcp-config",
      "--mcp-config",
      path.join(r.runDir, "mcp.json"),
      "--append-system-prompt-file",
      r.opts.personaFile,
      "--disallowedTools",
      "Agent",
      "AskUserQuestion",
      "--permission-mode",
      "bypassPermissions",
      "--model",
      "opus",
      "--effort",
      "high",
      "--max-turns",
      "40",
      "--max-budget-usd",
      "5",
    ]);
    expect(JSON.stringify(r.spawned[0].cmd)).not.toContain("SECRET-RUN-TOKEN");
  });

  test("optional flags are omitted when unset", () => {
    const argv = rig().spawned[0].cmd;
    for (const flag of ["--model", "--effort", "--max-turns", "--max-budget-usd", "--allowedTools"]) expect(argv).not.toContain(flag);
  });

  // Claude Code permission rules: https://code.claude.com/docs/en/permissions#permission-rule-syntax
  const flagValues = (argv: string[], flag: string): string[] => {
    const at = argv.indexOf(flag);
    if (at < 0) return [];
    const end = argv.findIndex((a, i) => i > at && a.startsWith("--"));
    return argv.slice(at + 1, end < 0 ? undefined : end);
  };
  /** `//` + path without its leading slash is how a rule anchors at the filesystem root. */
  const absRule = (tool: string, dir: string): string => `${tool}(/${dir}/**)`;

  describe("permissions: allowlist", () => {
    const allow = (over: Partial<SpawnOptions> = {}) => {
      const r = rig({ settings: { permissions: "allowlist" }, ...over });
      const argv = r.spawned[0].cmd;
      return { r, argv, allowed: flagValues(argv, "--allowedTools"), denied: flagValues(argv, "--disallowedTools") };
    };

    test("swaps bypass for dontAsk and allows the mounted MCP servers", () => {
      const { argv, allowed } = allow();
      expect(argv).not.toContain("bypassPermissions");
      expect(argv.slice(argv.indexOf("--permission-mode"), argv.indexOf("--permission-mode") + 2)).toEqual(["--permission-mode", "dontAsk"]);
      expect(allowed.slice(0, 2)).toEqual(["mcp__tpc__*", "mcp__mobile_mcp__*"]);
    });

    test("every file rule is scoped to an absolute path: no bare Read/Write/Edit, no Write path rules (Claude only consults Read and Edit rules)", () => {
      const { allowed } = allow();
      for (const bare of ["Read", "Write", "Edit", "Bash", "Bash(*)"]) expect(allowed).not.toContain(bare);
      expect(allowed.filter((a) => a.startsWith("Write"))).toEqual([]);
      for (const rule of allowed.filter((a) => /^(Read|Edit)/.test(a))) expect(rule).toMatch(/^(Read|Edit)\(\/\/[^*]+\/\*\*\)$/);
    });

    test("reads only the repo, the run folder and the system temp dir; edits and writes only the run folder", () => {
      const { r, allowed } = allow();
      const reads = allowed.filter((a) => a.startsWith("Read("));
      const edits = allowed.filter((a) => a.startsWith("Edit("));
      expect(reads).toContain(absRule("Read", "/work/app"));
      expect(reads).toContain(absRule("Read", r.runDir));
      expect(reads).toContain(absRule("Read", os.tmpdir()));
      expect(reads).toHaveLength(new Set(reads).size);
      expect(edits).toContain(absRule("Edit", r.runDir));
      for (const edit of edits) expect([r.runDir, fs.realpathSync(r.runDir)].some((dir) => edit === absRule("Edit", dir))).toBe(true);
      expect(edits).not.toContain(absRule("Edit", "/work/app"));
    });

    test("a symlinked repo or run folder is allowed under its real path as well", () => {
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tpc-link-")));
      tmpDirs.push(root);
      fs.mkdirSync(path.join(root, "real"));
      fs.symlinkSync(path.join(root, "real"), path.join(root, "link"));
      const { allowed } = allow({ cwd: path.join(root, "link") });
      expect(allowed).toContain(absRule("Read", path.join(root, "link")));
      expect(allowed).toContain(absRule("Read", path.join(root, "real")));
    });

    test("glob characters in a path are escaped so the rule cannot widen", () => {
      const { allowed } = allow({ cwd: "/work/app[1]*" });
      expect(allowed).toContain("Read(//work/app\\[1\\]\\*/**)");
    });

    test("Android: Bash is an enumerated list of `adb -s <this serial>` subcommands, never a blanket `adb -s X *`; push, pull, install and uninstall stay denied", () => {
      const { allowed, denied } = allow();
      const bash = allowed.filter((a) => a.startsWith("Bash"));
      expect(bash).toEqual([
        "Bash(adb -s emulator-5554 shell *)",
        "Bash(adb -s emulator-5554 exec-out *)",
        "Bash(adb -s emulator-5554 logcat *)",
        "Bash(adb -s emulator-5554 get-state)",
        "Bash(adb -s emulator-5554 wait-for-device)",
      ]);
      // A global option in front of the subcommand (`adb -s X -P 5037 push`) matches none of these.
      for (const blanket of ["Bash(adb -s emulator-5554 *)", "Bash(adb *)"]) expect(bash).not.toContain(blanket);
      for (const sub of ["bugreport", "backup", "sideload", "forward", "reverse", "sync", "tcpip", "root"]) expect(bash.some((b) => b.includes(` ${sub}`))).toBe(false);
      for (const sub of ["push", "pull", "install", "install-multiple", "uninstall"]) expect(denied).toContain(`Bash(adb -s emulator-5554 ${sub} *)`);
      expect(denied).toContain("Bash(adb -s emulator-5554 shell pm install *)");
      expect(denied).toContain("Bash(adb -s emulator-5554 shell pm uninstall *)");
      expect(denied.slice(0, 2)).toEqual(["Agent", "AskUserQuestion"]);
      expect(allowed.some((a) => a.startsWith("Bash(xcrun"))).toBe(false);
    });

    test("iOS: Bash is simctl on this UDID only; `spawn` is limited to `log`, screenshots go only into the run folder, install and uninstall are denied", () => {
      const udid = "A1B2C3D4-0000-4000-8000-ABCDEF012345";
      const { r, allowed, denied } = allow({ device: { serial: udid, platform: "ios" } });
      const bash = allowed.filter((a) => a.startsWith("Bash"));
      for (const sub of ["launch", "terminate", "openurl", "privacy", "get_app_container"]) expect(bash).toContain(`Bash(xcrun simctl ${sub} ${udid} *)`);
      expect(bash).toContain(`Bash(xcrun simctl spawn ${udid} log *)`);
      expect(bash).not.toContain(`Bash(xcrun simctl spawn ${udid} *)`);
      expect(bash).toContain("Bash(xcrun simctl list *)");
      expect(bash).toContain(`Bash(xcrun simctl io ${udid} screenshot ${r.runDir}/*)`);
      expect(bash.filter((b) => b.includes("screenshot") && !b.includes(r.runDir))).toEqual([]);
      expect(bash.some((b) => b.startsWith("Bash(adb") || b === "Bash(xcrun simctl *)")).toBe(false);
      for (const sub of ["install", "uninstall"]) expect(denied).toContain(`Bash(xcrun simctl ${sub} *)`);
      expect(denied).toContain("Bash(xcrun simctl io * screenshot *..*)");
    });

    test("iOS runs may read the user's simulator crash reports (the persona prescribes them); Android runs may not", () => {
      const crashDir = path.join(os.homedir(), "Library", "Logs", "DiagnosticReports");
      const ios = allow({ device: { serial: "A1B2C3D4-0000-4000-8000-ABCDEF012345", platform: "ios" } });
      expect(ios.allowed).toContain(absRule("Read", crashDir));
      expect(ios.allowed.filter((a) => a.startsWith("Edit("))).not.toContain(absRule("Edit", crashDir));
      expect(allow().allowed).not.toContain(absRule("Read", crashDir));
    });

    test("a device id that would change the meaning of a rule never starts claude", () => {
      for (const serial of ["emulator-5554 *", "x) Bash(*", "emu*", "a b", "../x", ""]) {
        expect(rig({ settings: { permissions: "allowlist" }, device: { serial, platform: "android" } }).spawned).toEqual([]);
      }
      for (const serial of ["emulator-5554", "192.168.1.20:5555", "R58M12ABCDE", "A1B2C3D4-0000-4000-8000-ABCDEF012345"]) {
        expect(rig({ settings: { permissions: "allowlist" }, device: { serial, platform: "android" } }).spawned).toHaveLength(1);
      }
    });

    test("bypass mode carries no allow or deny rules beyond the always-denied Agent and AskUserQuestion", () => {
      const argv = rig().spawned[0].cmd;
      expect(flagValues(argv, "--disallowedTools")).toEqual(["Agent", "AskUserQuestion"]);
      expect(argv).not.toContain("--allowedTools");
    });
  });

  test("permissions: allowlist lets the agent write into the run folder (screenshots live there); bypass adds no directories", () => {
    const allow = rig({ settings: { permissions: "allowlist" } });
    const argv = allow.spawned[0].cmd;
    expect(argv.slice(argv.indexOf("--add-dir"), argv.indexOf("--add-dir") + 2)).toEqual(["--add-dir", allow.runDir]);
    expect(rig().spawned[0].cmd).not.toContain("--add-dir");
  });

  test("settings.bin selects the executable; unknown permission modes never start claude", () => {
    expect(rig({ settings: { bin: "/opt/bin/claude-x" } }).spawned[0].cmd[0]).toBe("/opt/bin/claude-x");
    expect(rig({ settings: { permissions: "yolo" } }).spawned).toEqual([]);
  });

  test("mcp.json mounts every requested server (progress server always loaded, bearer header intact) and is private to the owner", () => {
    const r = rig();
    const file = path.join(r.runDir, "mcp.json");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
      mcpServers: {
        tpc: {
          type: "http",
          url: "http://127.0.0.1:4310/mcp/runs/r1",
          headers: { Authorization: "Bearer SECRET-RUN-TOKEN" },
          alwaysLoad: true,
        },
        mobile_mcp: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@mobilenext/mobile-mcp@latest"],
          env: { MOBILE_FLAG: "1" },
          alwaysLoad: true,
        },
      },
    });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  test("toolName is the mcp__<server>__<tool> form the model sees", () => {
    expect(rig().session.toolName("mobile_mcp", "mobile_take_screenshot")).toBe("mcp__mobile_mcp__mobile_take_screenshot");
    expect(rig().session.toolName("tpc", "qa_check")).toBe("mcp__tpc__qa_check");
  });
});

describe("claude ready", () => {
  test("reports servers that failed to mount, with Claude's reason, and servers it never mentioned", async () => {
    const r = rig();
    r.fake.mcpStatuses = [[{ name: "tpc", status: "failed", error: "ECONNREFUSED: Unable to connect" }]];
    const info = await r.session.ready();
    expect(info.mcp).toEqual([
      { name: "tpc", ok: false, error: "ECONNREFUSED: Unable to connect" },
      { name: "mobile_mcp", ok: false, error: "not reported by claude" },
    ]);
    r.session.kill();
    await r.session.exited;
  });

  test("waits while a server is still pending, then reports it connected", async () => {
    const r = rig();
    r.fake.mcpStatuses = [
      [
        { name: "tpc", status: "connected" },
        { name: "mobile_mcp", status: "pending" },
      ],
      [
        { name: "tpc", status: "connected" },
        { name: "mobile_mcp", status: "connected" },
      ],
    ];
    const info = await r.session.ready();
    expect(info.mcp.every((m) => m.ok)).toBe(true);
    expect(r.fake.written.filter((w) => (w.request as { subtype?: string } | undefined)?.subtype === "mcp_status")).toHaveLength(2);
    r.session.kill();
    await r.session.exited;
  });

  test("a server that stays pending past the deadline is not ok", async () => {
    const r = rig({}, { readyTimeoutMs: 30 });
    r.fake.mcpStatuses = [[{ name: "tpc", status: "connected" }, { name: "mobile_mcp", status: "pending" }]];
    const info = await r.session.ready();
    expect(info.mcp).toEqual([
      { name: "tpc", ok: true },
      { name: "mobile_mcp", ok: false, error: "status pending" },
    ]);
    r.session.kill();
    await r.session.exited;
  });

  test("rejects when claude exits before answering", async () => {
    const r = rig();
    r.fake.silent = true;
    const ready = r.session.ready();
    r.fake.exit(1);
    await expect(ready).rejects.toThrow(/exited/);
  });

  test("a control request nobody answers times out instead of hanging ready", async () => {
    const r = rig({}, { controlTimeoutMs: 30 });
    r.fake.silent = true;
    await expect(r.session.ready()).rejects.toThrow(/timed out/);
    r.session.kill();
    await r.session.exited;
  });

  test("a system/init that lists a failed server becomes a warning notice", async () => {
    const r = rig();
    r.fake.script = [
      { type: "system", subtype: "init", session_id: "s", model: "m", mcp_servers: [{ name: "tpc", status: "failed" }] },
      resultFrame({}),
    ];
    await r.session.ready();
    await r.session.send("go");
    await r.session.exited;
    expect(r.events.filter((e) => e.type === "notice")).toEqual([{ type: "notice", level: "warn", text: "MCP server tpc is failed" }]);
  });
});


const BASE_TS = Date.parse("2026-10-09T10:00:00.000Z");

/** Replays frames the way `store.readActivity` does: one shared ReplayContext, seq = line index, `_ts` stamped by the runner. */
function replay(frames: Record<string, unknown>[], gated = true): (Activity | null)[] {
  const ctx: ReplayContext = { seq: 0, gated, starts: new Map() };
  return frames.map((f, i) => {
    ctx.seq = i;
    return createClaudeHarness().toActivity({ ...f, _ts: new Date(BASE_TS + i * 1000).toISOString() }, ctx);
  });
}

const iso = (i: number) => new Date(BASE_TS + i * 1000).toISOString();

describe("claude toActivity (replay of persisted frames)", () => {
  test("turns the captured stream into feed lines; progress tools are left to the server-side recorder", () => {
    const a = replay(streamFrames);
    expect(a.map((x) => x && `${x.kind}: ${x.text}`)).toEqual([
      null, // system/init
      "say: Starting the QA run.",
      null, // qa_plan call
      null, // qa_plan result
      'tool: bash {"command":"adb devices"}',
      "tool_end: bash ok (1.0s)",
      null, // api_retry notice: the runner's own warn line is its only copy
      null, // qa_check call
      null, // qa_check result
      'tool: mcp__mobile_mcp_mobile_take_screenshot {"device":"emulator-5554"}',
      "tool_end: mcp__mobile_mcp_mobile_take_screenshot ok (1.0s)",
      null, // permission_denied notice: the runner's own warn line is its only copy
      'tool: write {"path":"/work/app/qa/QA-REPORT.md"}',
      "tool_end: write failed (1.0s): Permission to use Write has been denied.",
      null, // qa_finish call
      null, // qa_finish result
      "say: Done.",
      null, // clean result
    ]);
    expect(a[4]).toEqual({
      ts: iso(4),
      seq: 4,
      kind: "tool",
      text: 'bash {"command":"adb devices"}',
      callId: "toolu_bash",
      tool: "bash",
      args: { command: "adb devices" },
    });
    expect(a[5]).toMatchObject({ kind: "tool_end", callId: "toolu_bash", tool: "bash", ok: true, durationMs: 1000 });
    expect(a[13]).toMatchObject({ kind: "tool_end", tool: "write", ok: false });
  });
});

const toolUse = (id: string, name: string, input: unknown): Record<string, unknown> => ({
  type: "assistant",
  message: { id: `m-${id}`, role: "assistant", content: [{ type: "tool_use", id, name, input }] },
});

describe("claude canonical tool names", () => {
  test("built-in tools and MCP servers (hyphenated, plugin-namespaced, progress) map to the shared canonical form", async () => {
    const { events } = await runToEnd([
      toolUse("t1", "Read", { file_path: "/work/app/a.md", limit: 10 }),
      toolUse("t2", "Write", { file_path: "/work/app/b.md", content: "x".repeat(5000) }),
      toolUse("t3", "Edit", { file_path: "/work/app/c.md", old_string: "a", new_string: "b" }),
      toolUse("t4", "MultiEdit", { file_path: "/work/app/d.md", edits: [] }),
      toolUse("t5", "WebSearch", { query: "flutter semantics" }),
      toolUse("t6", "Bash", { command: "adb devices", timeout: 5000 }),
      toolUse("t7", "Glob", { pattern: "**/*.md" }),
      toolUse("t8", "mcp__tpc__mobile_list_apps", { device: "x" }),
      toolUse("t9", "mcp__plugin_tpc_tpc__mobile_click", { x: 1 }),
      toolUse("t10", "mcp__tpc__qa_check", { id: "C1", status: "pass" }),
      resultFrame({}),
    ]);
    expect(events.filter((e) => e.type === "tool_call").map((e) => (e.type === "tool_call" ? [e.tool, e.server, e.args] : null))).toEqual([
      ["read", null, { path: "/work/app/a.md" }],
      ["write", null, { path: "/work/app/b.md" }],
      ["edit", null, { path: "/work/app/c.md" }],
      ["edit", null, { path: "/work/app/d.md" }],
      ["search", null, { query: "flutter semantics" }],
      ["bash", null, { command: "adb devices" }],
      ["glob", null, { pattern: "**/*.md" }],
      ["mcp__mobile_mcp_mobile_list_apps", "mobile_mcp", { device: "x" }],
      ["mcp__mobile_mcp_mobile_click", "mobile_mcp", { x: 1 }],
      ["qa_check", "tpc", { id: "C1", status: "pass" }],
    ]);
  });
});

describe("claude toActivity details", () => {
  const userResult = (id: string, isError: boolean, content: unknown): Record<string, unknown> => ({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content }] },
  });

  test("the user's own Tapocalypse MCP is flagged as a violation; gateway device tools are plain tool lines", () => {
    const frames = [toolUse("a", "mcp__tapocalypse__qa_start_run", {}), toolUse("b", "mcp__tpc__mobile_click", {})];
    expect(replay(frames).map((x) => x && [x.kind, x.text])).toEqual([
      ["warn", "backend violation: mcp__tapocalypse_qa_start_run"],
      ["tool", "mcp__mobile_mcp_mobile_click {}"],
    ]);
  });

  test("on a gated run a mobile-mcp the agent mounted itself keeps its raw name and is flagged", () => {
    const frames = [toolUse("a", "mcp__mobile_mcp__mobile_click", {}), toolUse("b", "mcp__mobile-mcp__mobile_list_apps", {})];
    expect(replay(frames).map((x) => x && [x.kind, x.text])).toEqual([
      ["warn", "backend violation: mcp__mobile_mcp__mobile_click"],
      ["warn", "backend violation: mcp__mobile-mcp__mobile_list_apps"],
    ]);
  });

  test("a run from before the gateway replays its own mobile-mcp calls as plain tool lines under the canonical name", () => {
    const frames = [toolUse("a", "mcp__mobile_mcp__mobile_click", { x: 1 }), toolUse("b", "mcp__tapocalypse__qa_start_run", {})];
    expect(replay(frames, false).map((x) => x && [x.kind, x.text])).toEqual([
      ["tool", 'mcp__mobile_mcp_mobile_click {"x":1}'],
      ["warn", "backend violation: mcp__tapocalypse_qa_start_run"],
    ]);
  });

  test("a plugin-namespaced Tapocalypse MCP is flagged like the plain one", () => {
    expect(replay([toolUse("a", "mcp__plugin_x_tapocalypse__qa_start_run", {})]).map((x) => x && [x.kind, x.text])).toEqual([
      ["warn", "backend violation: mcp__tapocalypse_qa_start_run"],
    ]);
  });

  test("a rejected progress call stays visible while an accepted one is silent", () => {
    const a = replay([
      toolUse("p1", "mcp__tpc__qa_check", { id: "C1" }),
      userResult("p1", true, "Invalid input: status required"),
      toolUse("p2", "mcp__tpc__qa_check", { id: "C1", status: "pass" }),
      userResult("p2", false, "recorded"),
    ]);
    expect(a[0]).toBeNull();
    expect(a[1]).toMatchObject({ kind: "tool_end", tool: "qa_check", ok: false, text: "qa_check failed (1.0s): Invalid input: status required" });
    expect(a[2]).toBeNull();
    expect(a[3]).toBeNull();
  });

  test("an error result is a feed error; a clean one is silent", () => {
    const a = replay([...errorFrames, resultFrame({})]);
    expect(a[2]).toMatchObject({ kind: "error", text: "API Error: Connection refused", seq: 2 });
    expect(a[3]).toBeNull();
  });

  test("a frame with text and a tool call shows the call; Tapocalypse _activity lines pass through", () => {
    const mixed = {
      type: "assistant",
      message: {
        id: "m",
        role: "assistant",
        content: [
          { type: "text", text: "Checking devices." },
          { type: "tool_use", id: "x", name: "Bash", input: { command: "adb devices" } },
        ],
      },
    };
    const [a, b] = replay([mixed, { type: "_activity", kind: "info", text: "Steered: wrap up" }]);
    expect(a).toMatchObject({ kind: "tool", tool: "bash" });
    expect(b).toMatchObject({ kind: "info", text: "Steered: wrap up" });
  });

  test("raw non-JSON lines, control frames and garbage are ignored", () => {
    const a = replay([{ type: "_raw", line: "oops" }, { type: "stream_event" }, { type: "system", subtype: "status" }, {}]);
    expect(a).toEqual([null, null, null, null]);
    expect(createClaudeHarness().toActivity("nope", { seq: 0, gated: true, starts: new Map() })).toBeNull();
  });
});


const exec = (code: number, text = "", stderr = ""): ExecResult => ({ code, text, stderr, stdout: new TextEncoder().encode(text) });

/** Fake probe runner: answers by joined command, records every call, 127 for unknown commands (a missing binary). */
function probes(answers: Record<string, ExecResult>) {
  const calls: string[][] = [];
  const run = async (cmd: string[]) => {
    calls.push(cmd);
    return answers[cmd.join(" ")] ?? exec(127, "", "not found");
  };
  return { calls, run };
}

const doctorEnv = (run: (cmd: string[]) => Promise<ExecResult>, selected: boolean) => ({ bin: "claude", platform: "darwin" as const, run, selected });

describe("claude doctor", () => {
  const signedIn = exec(0, JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" }));

  test("installed and signed in: two ok rows, only version and auth probes (never a model call)", async () => {
    const p = probes({ "claude --version": exec(0, "2.1.291 (Claude Code)\n"), "claude auth status --json": signedIn });
    const checks = await createClaudeHarness().doctor(doctorEnv(p.run, true));
    expect(checks).toMatchObject([
      { id: "claude", status: "ok", detail: "2.1.291 (Claude Code)", required: true },
      { id: "claude-auth", status: "ok", required: true },
    ]);
    expect(checks[1].detail).toContain("claude.ai");
    expect(p.calls).toEqual([
      ["claude", "--version"],
      ["claude", "auth", "status", "--json"],
    ]);
  });

  test("missing binary: an error with an install fix when it is the selected harness, a warning otherwise; auth is skipped", async () => {
    const selected = await createClaudeHarness().doctor(doctorEnv(probes({}).run, true));
    expect(selected).toMatchObject([
      { id: "claude", status: "error", required: true },
      { id: "claude-auth", status: "skip", required: true },
    ]);
    expect(selected[0].fix).toBeTruthy();
    const optional = await createClaudeHarness().doctor(doctorEnv(probes({}).run, false));
    expect(optional).toMatchObject([
      { id: "claude", status: "warn", required: false },
      { id: "claude-auth", status: "skip", required: false },
    ]);
  });

  test("not signed in is flagged with the login command", async () => {
    const p = probes({
      "claude --version": exec(0, "2.1.291 (Claude Code)"),
      "claude auth status --json": exec(1, JSON.stringify({ loggedIn: false, authMethod: "none" })),
    });
    const [, auth] = await createClaudeHarness().doctor(doctorEnv(p.run, true));
    expect(auth).toMatchObject({ id: "claude-auth", status: "error" });
    expect(auth.fix).toContain("claude auth login");
  });

  test("an old Claude Code is a warning (MCP servers must be awaited before the first turn)", async () => {
    const p = probes({ "claude --version": exec(0, "2.1.100 (Claude Code)"), "claude auth status --json": signedIn });
    const [version] = await createClaudeHarness().doctor(doctorEnv(p.run, true));
    expect(version).toMatchObject({ id: "claude", status: "warn" });
    expect(version.fix).toContain("claude update");
  });

  test("model picker offers Claude's aliases", async () => {
    expect(await createClaudeHarness().listModels({ bin: "claude", run: probes({}).run })).toEqual(["opus", "sonnet", "haiku"]);
  });
});
