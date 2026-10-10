import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExecResult } from "../src/devices/devices";
import { type CodexProcess, type CodexSpawn, createCodexHarness, harness as realHarness } from "../src/harness/codex";
import type { HarnessEvent, McpServerSpec, ReplayContext, SpawnOptions } from "../src/harness/types";

const fixture = (name: string) => Bun.file(path.join(import.meta.dir, "fixtures", name)).text();
const lines = (text: string) => text.split("\n").filter(Boolean);

/** A scripted stand-in for the `codex exec` child process. */
class FakeProc implements CodexProcess {
  signals: string[] = [];
  written: string[] = [];
  stdinClosed = false;
  signalCode: string | null = null;
  /** Called once stdin is closed, i.e. when the real codex would start working on the prompt. */
  onStdinClosed: (p: FakeProc) => void = () => {};
  /** Signals that make the process exit. */
  diesOn: string[] = [];
  exited: Promise<number>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  private outCtl!: ReadableStreamDefaultController<Uint8Array>;
  private errCtl!: ReadableStreamDefaultController<Uint8Array>;
  private resolveExit!: (code: number) => void;
  private done = false;
  private enc = new TextEncoder();
  stdin = {
    write: (data: string | Uint8Array) => {
      this.written.push(typeof data === "string" ? data : new TextDecoder().decode(data));
      return 0;
    },
    end: () => {
      this.stdinClosed = true;
      this.onStdinClosed(this);
    },
  };

  constructor() {
    this.stdout = new ReadableStream({ start: (c) => void (this.outCtl = c) });
    this.stderr = new ReadableStream({ start: (c) => void (this.errCtl = c) });
    const { promise, resolve } = Promise.withResolvers<number>();
    this.exited = promise;
    this.resolveExit = resolve;
  }

  emit(line: string): void {
    this.outCtl.enqueue(this.enc.encode(`${line}\n`));
  }

  emitBytes(bytes: Uint8Array): void {
    this.outCtl.enqueue(bytes);
  }

  emitStderr(text: string): void {
    this.errCtl.enqueue(this.enc.encode(text));
  }

  finish(code: number, signal: string | null = null): void {
    if (this.done) return;
    this.done = true;
    this.signalCode = signal;
    this.outCtl.close();
    this.errCtl.close();
    this.resolveExit(code);
  }

  kill(signal?: string): void {
    this.signals.push(signal ?? "SIGTERM");
    if (this.diesOn.includes(signal ?? "SIGTERM")) this.finish(130, signal ?? "SIGTERM");
  }
}

/** Runs `fn` with CODEX_BIN set to `value` (undefined = unset); the test preload points it at a missing binary. */
function withCodexBin<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env.CODEX_BIN;
  if (value === undefined) delete process.env.CODEX_BIN;
  else process.env.CODEX_BIN = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = prev;
  }
}

interface SpawnCall {
  cmd: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  proc: FakeProc;
}

function fakeSpawn(configure: (p: FakeProc) => void = () => {}): { spawn: CodexSpawn; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const spawn: CodexSpawn = (cmd, opts) => {
    const proc = new FakeProc();
    configure(proc);
    calls.push({ cmd, cwd: opts.cwd, env: opts.env, proc });
    return proc;
  };
  return { spawn, calls };
}

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});
function tempRunDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "tpc-codex-"));
  tempDirs.push(dir);
  return dir;
}

const TPC: McpServerSpec = {
  name: "tpc",
  transport: "http",
  url: "http://127.0.0.1:4310/mcp/runs/run1",
  headers: { Authorization: "Bearer s3cret-token" },
};
const MOBILE: McpServerSpec = {
  name: "mobile_mcp",
  transport: "stdio",
  command: "npx",
  args: ["-y", "@mobilenext/mobile-mcp@latest"],
  env: { ANDROID_HOME: "/sdk" },
};

function makeOpts(over: Partial<SpawnOptions> = {}) {
  const events: HarnessEvent[] = [];
  const raw: object[] = [];
  const stderr: string[] = [];
  const opts: SpawnOptions = {
    runId: "run1",
    cwd: "/repo",
    runDir: tempRunDir(),
    persona: "You are a QA agent.",
    personaFile: "/data/runs/run1/persona.md",
    model: null,
    effort: null,
    mcpServers: [TPC, MOBILE],
    limits: { maxTime: null, maxTurns: null, maxBudgetUsd: null },
    settings: {},
    onEvent: (e) => events.push(e),
    onRaw: (f) => raw.push(f),
    onStderr: (t) => stderr.push(t),
    ...over,
  };
  return { opts, events, raw, stderr };
}

/** Plays `frames` once the prompt has been sent and stdin is closed, then exits with `code`. */
function playOnClose(frames: string[], code = 0): (p: FakeProc) => void {
  return (p) =>
    queueMicrotask(() => {
      for (const f of frames) p.emit(f);
      p.finish(code);
    });
}

describe("codex session stream", () => {
  test("maps the exec stream to normalized events in order and settles", async () => {
    const frames = lines(await fixture("codex-exec.jsonl"));
    const { spawn } = fakeSpawn((p) => (p.onStdinClosed = playOnClose(frames)));
    const h = createCodexHarness({ spawn });
    const { opts, events, raw } = makeOpts({ model: "gpt-5.5" });
    const session = h.spawn(opts);
    await session.ready();
    await session.send("do the QA");
    const exit = await session.exited;

    expect(exit).toEqual({ code: 0, signal: null, settled: true, started: true, limit: null, error: null });
    expect(raw).toHaveLength(frames.length);
    expect(events[0]).toEqual({ type: "session", sessionId: "0199a213-81c0-7800-8aa1-bbab2a035a53", model: "gpt-5.5" });

    const calls = events.filter((e) => e.type === "tool_call");
    expect(calls.map((c) => [c.callId, c.tool, c.server])).toEqual([
      ["item_1", "qa_plan", "tpc"],
      ["item_3", "mcp__mobile_mcp_mobile_list_elements_on_screen", "mobile_mcp"],
      ["item_4", "bash", null],
      ["item_5", "bash", null],
      ["item_6", "edit", null],
      ["item_7", "qa_check", "tpc"],
      ["item_8", "search", null],
      ["item_10", "qa_finish", "tpc"],
    ]);
    expect(calls.find((c) => c.callId === "item_4")?.args).toEqual({ command: "/bin/zsh -lc 'adb devices'" });
    expect(calls.find((c) => c.callId === "item_6")?.args).toEqual({
      path: "reports/QA-REPORT-demo.md",
      paths: ["reports/QA-REPORT-demo.md", "reports/notes.md"],
    });
    expect(calls.find((c) => c.callId === "item_8")?.args).toEqual({ query: "flutter semantics label" });

    const results = events.filter((e) => e.type === "tool_result");
    expect(results.map((r) => [r.callId, r.ok])).toEqual([
      ["item_1", true],
      ["item_3", true],
      ["item_4", true],
      ["item_5", false],
      ["item_6", true],
      ["item_7", false],
      ["item_8", true],
      ["item_10", true],
    ]);
    expect(results.find((r) => r.callId === "item_3")?.text).toBe('[{"text":"Sign in"}]');
    expect(results.find((r) => r.callId === "item_4")?.text).toContain("emulator-5554");
    expect(results.find((r) => r.callId === "item_7")?.text).toBe("unknown check C9");

    // every call is answered after it was made
    for (const c of calls) {
      const iCall = events.indexOf(c);
      const iRes = events.findIndex((e) => e.type === "tool_result" && e.callId === c.callId);
      expect(iRes).toBeGreaterThan(iCall);
    }

    expect(events.filter((e) => e.type === "text")).toEqual([{ type: "text", text: "All checks passed. Report written." }]);
    expect(events.filter((e) => e.type === "notice")).toEqual([
      { type: "notice", level: "warn", text: "Unknown configuration key `request_max_retries` ignored" },
    ]);
    expect(events.at(-1)).toEqual({ type: "turn_end", ok: true, error: null, limit: null });
    expect(events.at(-2)).toEqual({
      type: "usage",
      usage: { tokensIn: 4000, tokensOut: 540, cacheRead: 8000, cacheWrite: 300, toolCalls: 8 },
      cumulative: false,
    });
  });

  test("usage() reports tokens with null cost once the turn completed", async () => {
    const frames = lines(await fixture("codex-exec.jsonl"));
    const { spawn } = fakeSpawn((p) => (p.onStdinClosed = playOnClose(frames)));
    const session = createCodexHarness({ spawn }).spawn(makeOpts({ model: "gpt-5.5" }).opts);
    expect(await session.usage()).toBeNull();
    await session.send("go");
    await session.exited;
    expect(await session.usage()).toEqual({
      cost: null,
      tokensIn: 4000,
      tokensOut: 540,
      cacheRead: 8000,
      cacheWrite: 300,
      toolCalls: 8,
      model: "gpt-5.5",
    });
  });

  test("a failed turn ends not ok with the error text and one copy of repeated warnings", async () => {
    const frames = lines(await fixture("codex-exec-failed.jsonl"));
    const { spawn } = fakeSpawn((p) => (p.onStdinClosed = playOnClose(frames, 1)));
    const { opts, events } = makeOpts();
    const session = createCodexHarness({ spawn }).spawn(opts);
    await session.send("go");
    const exit = await session.exited;

    const msg = "stream disconnected before completion: error sending request for url";
    expect(events.at(-1)).toEqual({ type: "turn_end", ok: false, error: msg, limit: null });
    expect(exit).toEqual({ code: 1, signal: null, settled: true, started: true, limit: null, error: msg });
    expect(events.filter((e) => e.type === "notice").map((e) => e.text)).toEqual([
      "Reconnecting... 1/5 (stream disconnected before completion)",
      "Reconnecting... 2/5 (stream disconnected before completion)",
    ]);
    expect(await session.usage()).toBeNull();
  });

  test("an exit with no terminal event is unsettled and names the MCP server whose startup failed", async () => {
    const frames = [
      '{"type":"error","message":"MCP client for `tpc` failed to start: connection refused"}',
      "not json at all",
    ];
    const { spawn } = fakeSpawn((p) => (p.onStdinClosed = playOnClose(frames, 1)));
    const { opts, raw } = makeOpts();
    const session = createCodexHarness({ spawn }).spawn(opts);
    await session.send("go");
    const exit = await session.exited;
    expect(exit.settled).toBe(false);
    expect(exit.started).toBe(false); // the CLI failed during startup: infra, retriable
    expect(exit.code).toBe(1);
    expect(exit.error).toContain("tpc");
    expect(exit.error).toContain("connection refused");
    expect(raw).toContainEqual({ type: "_raw", line: "not json at all" });
  });

  test("a frame split across stdout chunks is still one frame", async () => {
    const { spawn } = fakeSpawn((p) => {
      p.onStdinClosed = () =>
        queueMicrotask(() => {
          const enc = new TextEncoder();
          const full = '{"type":"item.completed","item":{"id":"i","type":"agent_message","text":"héllo ✅"}}\n';
          const bytes = enc.encode(full);
          // split inside a multi-byte character
          const cut = bytes.indexOf(0xe2) + 1;
          p.emitBytes(bytes.slice(0, cut));
          p.emitBytes(bytes.slice(cut));
          p.finish(0);
        });
    });
    const { opts, events } = makeOpts();
    const session = createCodexHarness({ spawn }).spawn(opts);
    await session.send("go");
    await session.exited;
    expect(events).toEqual([{ type: "text", text: "héllo ✅" }]);
  });

  test("stderr text is forwarded", async () => {
    const { spawn } = fakeSpawn((p) => {
      p.onStdinClosed = () =>
        queueMicrotask(() => {
          p.emitStderr("Reading additional input from stdin...\n");
          p.finish(0);
        });
    });
    const { opts, stderr } = makeOpts();
    const session = createCodexHarness({ spawn }).spawn(opts);
    await session.send("go");
    await session.exited;
    expect(stderr.join("")).toBe("Reading additional input from stdin...\n");
  });

  test("a throwing onRaw/onStderr or a malformed item never stops the pump: later frames still arrive and the exit resolves", async () => {
    const frames = [
      '{"type":"item.completed","item":{"type":"agent_message","text":"no id"}}', // fails the strict item parse
      '{"type":"item.completed","item":{"id":"m1","type":"agent_message","text":"still delivered"}}',
    ];
    const { spawn } = fakeSpawn((p) => {
      p.onStdinClosed = () =>
        queueMicrotask(() => {
          p.emitStderr("warming up\n");
          for (const f of frames) p.emit(f);
          p.finish(0);
        });
    });
    const { opts, events } = makeOpts({
      onRaw: () => {
        throw new Error("disk full");
      },
      onStderr: () => {
        throw new Error("listener blew up");
      },
    });
    opts.onEvent = (e) => events.push(e);
    const session = createCodexHarness({ spawn }).spawn(opts);
    await session.send("go");
    expect(await session.exited).toMatchObject({ code: 0, started: true });
    expect(events).toContainEqual({ type: "text", text: "still delivered" });
  });
});

describe("codex spawn", () => {
  test("builds the exec argv with per-session MCP, persona in config and the progress server as a stdio bridge that reads its credentials from a file", async () => {
    const { spawn, calls } = fakeSpawn();
    const runDir = tempRunDir();
    const { opts } = makeOpts({
      runDir,
      model: "gpt-5.5",
      effort: "high",
      persona: 'Line one\nSay "hi" \\ done',
    });
    withCodexBin(undefined, () => createCodexHarness({ spawn }).spawn(opts));
    const call = calls[0];
    const bridge = path.resolve(import.meta.dir, "../src/mcp/stdio-bridge.ts");
    const credentials = path.join(runDir, "tpc-mcp.json");
    expect(call.cmd).toEqual([
      "codex",
      "exec",
      "--json",
      "--skip-git-repo-check",
      "-C",
      "/repo",
      "--sandbox",
      "danger-full-access",
      "-c",
      'approval_policy="never"',
      "-c",
      'developer_instructions="Line one\\nSay \\"hi\\" \\\\ done"',
      "-c",
      `mcp_servers.tpc.command=${JSON.stringify(process.execPath)}`,
      "-c",
      `mcp_servers.tpc.args=[${JSON.stringify(bridge)},${JSON.stringify(credentials)}]`,
      "-c",
      "mcp_servers.tpc.required=true",
      "-c",
      'mcp_servers.tpc.default_tools_approval_mode="auto"',
      "-c",
      "mcp_servers.tpc.tool_timeout_sec=300",
      "-c",
      "mcp_servers.tpc.startup_timeout_sec=60",
      "-c",
      'mcp_servers.mobile_mcp.command="npx"',
      "-c",
      'mcp_servers.mobile_mcp.args=["-y","@mobilenext/mobile-mcp@latest"]',
      "-c",
      'mcp_servers.mobile_mcp.env={ ANDROID_HOME = "/sdk" }',
      "-c",
      "mcp_servers.mobile_mcp.required=true",
      "-c",
      'mcp_servers.mobile_mcp.default_tools_approval_mode="auto"',
      "-c",
      "mcp_servers.mobile_mcp.tool_timeout_sec=300",
      "-c",
      "mcp_servers.mobile_mcp.startup_timeout_sec=60",
      "-m",
      "gpt-5.5",
      "-c",
      'model_reasoning_effort="high"',
      "-",
    ]);
    expect(call.cwd).toBe("/repo");
    expect(call.cmd.join(" ")).not.toContain("s3cret-token");
    expect(call.cmd.join(" ")).not.toContain("mcp_servers.tpc.url");
    expect(path.isAbsolute(bridge) && await Bun.file(bridge).exists()).toBe(true);
  });

  test("the progress server's url and token go to an owner-only credentials file in the run dir", async () => {
    const { spawn } = fakeSpawn();
    const runDir = tempRunDir();
    createCodexHarness({ spawn }).spawn(makeOpts({ runDir }).opts);
    const file = path.join(runDir, "tpc-mcp.json");
    expect(await Bun.file(file).json()).toEqual({ url: "http://127.0.0.1:4310/mcp/runs/run1", token: "s3cret-token" });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("an http server without a bearer token fails the session instead of starting an unauthenticated bridge", async () => {
    const { spawn, calls } = fakeSpawn();
    const server: McpServerSpec = { name: "tpc", transport: "http", url: "http://x/mcp", headers: { "X-Run": "abc123" } };
    const session = createCodexHarness({ spawn }).spawn(makeOpts({ runDir: tempRunDir(), mcpServers: [server] }).opts);
    expect(calls).toHaveLength(0);
    await expect(session.ready()).rejects.toThrow(/Bearer/);
  });

  test("settings choose the binary and sandbox (the adapter ignores CODEX_BIN: the runner resolves it into settings.bin); workspace-write gets network access", () => {
    const { spawn, calls } = fakeSpawn();
    const opts = makeOpts({ settings: { bin: "/opt/codex", sandbox: "workspace-write" } }).opts;
    withCodexBin("/env/codex", () => createCodexHarness({ spawn }).spawn(opts));
    withCodexBin("", () => createCodexHarness({ spawn }).spawn(makeOpts().opts));
    expect(calls[0].cmd[0]).toBe("/opt/codex");
    expect(calls[1].cmd[0]).toBe("codex");
    const cmd = calls[0].cmd;
    expect(cmd[cmd.indexOf("--sandbox") + 1]).toBe("workspace-write");
    expect(cmd).toContain("sandbox_workspace_write.network_access=true");
  });

  test("workspace-write makes the run's screenshots folder writable; the default sandbox adds no writable roots", () => {
    const { spawn, calls } = fakeSpawn();
    const restricted = makeOpts({ settings: { sandbox: "workspace-write" } }).opts;
    createCodexHarness({ spawn }).spawn(restricted);
    createCodexHarness({ spawn }).spawn(makeOpts().opts);
    expect(calls[0].cmd).toContain(`sandbox_workspace_write.writable_roots=[${JSON.stringify(path.join(restricted.runDir, "screenshots"))}]`);
    expect(calls[1].cmd.some((a) => a.startsWith("sandbox_workspace_write."))).toBe(false);
  });

  test("an unknown sandbox setting fails the session instead of widening access", async () => {
    const { spawn, calls } = fakeSpawn();
    const session = createCodexHarness({ spawn }).spawn(makeOpts({ settings: { sandbox: "yolo" } }).opts);
    expect(calls).toHaveLength(0);
    await expect(session.ready()).rejects.toThrow(/sandbox/);
    expect(await session.exited).toMatchObject({ started: false, error: expect.stringContaining("sandbox") });
  });

  test("a binary that cannot be started fails ready and exits 127", async () => {
    const spawn: CodexSpawn = () => {
      throw new Error("ENOENT: codex not found");
    };
    const session = createCodexHarness({ spawn }).spawn(makeOpts().opts);
    await expect(session.ready()).rejects.toThrow(/ENOENT/);
    const exit = await session.exited;
    expect(exit).toMatchObject({ code: 127, started: false });
    expect(exit.error).toContain("ENOENT");
  });

  test("persona text stays a valid TOML basic string for control characters and lone surrogates", () => {
    const { spawn, calls } = fakeSpawn();
    createCodexHarness({ spawn }).spawn(makeOpts({ persona: "tab\there\u007f\u0001 \ud800 end" }).opts);
    const value = calls[0].cmd.find((a) => a.startsWith("developer_instructions="))?.slice("developer_instructions=".length);
    expect(value).toBe('"tab\\there\\u007F\\u0001 \uFFFD end"');
  });

  test("ready resolves without waiting for the prompt, every requested server ok", async () => {
    const { spawn } = fakeSpawn();
    const session = createCodexHarness({ spawn }).spawn(makeOpts().opts);
    // codex blocks on stdin before starting, so nothing has been sent yet
    const info = await session.ready();
    expect(info.mcp).toEqual([
      { name: "tpc", ok: true },
      { name: "mobile_mcp", ok: true },
    ]);
  });

  test("send writes the prompt once, closes stdin, and refuses a second prompt", async () => {
    const { spawn, calls } = fakeSpawn();
    const session = createCodexHarness({ spawn }).spawn(makeOpts().opts);
    await session.send("the whole prompt\nwith lines");
    const proc = calls[0].proc;
    expect(proc.written.join("")).toBe("the whole prompt\nwith lines");
    expect(proc.stdinClosed).toBe(true);
    await expect(session.send("again")).rejects.toThrow();
    proc.finish(0);
    await session.exited;
  });

  test("the session has no steer and the capabilities say so", () => {
    const { spawn } = fakeSpawn();
    const session = createCodexHarness({ spawn }).spawn(makeOpts().opts);
    expect(session.steer).toBeUndefined();
    expect(session.exportTranscript).toBeUndefined();
    expect(realHarness.capabilities.steer).toBe(false);
    expect(realHarness.capabilities.interrupt).toBe(false);
    expect(realHarness.capabilities.appendSystemPrompt).toBe(true);
  });

  test("tool names are mcp__<server>__<tool>", () => {
    const { spawn } = fakeSpawn();
    const session = createCodexHarness({ spawn }).spawn(makeOpts().opts);
    expect(session.toolName("tpc", "qa_plan")).toBe("mcp__tpc__qa_plan");
    expect(session.toolName("mobile_mcp", "mobile_list_apps")).toBe("mcp__mobile_mcp__mobile_list_apps");
  });
});

describe("codex abort", () => {
  const timing = { sigintGraceMs: 20, termGraceMs: 20 };

  test("stops after SIGINT when the process exits on it", async () => {
    const { spawn, calls } = fakeSpawn((p) => (p.diesOn = ["SIGINT"]));
    const session = createCodexHarness({ spawn, ...timing }).spawn(makeOpts().opts);
    await session.send("go");
    await session.abort();
    expect(calls[0].proc.signals).toEqual(["SIGINT"]);
    expect((await session.exited).signal).toBe("SIGINT");
  });

  test("escalates SIGINT, then SIGTERM, then SIGKILL until the process is gone", async () => {
    const { spawn, calls } = fakeSpawn((p) => (p.diesOn = ["SIGKILL"]));
    const session = createCodexHarness({ spawn, ...timing }).spawn(makeOpts().opts);
    await session.send("go");
    await session.abort();
    expect(calls[0].proc.signals).toEqual(["SIGINT", "SIGTERM", "SIGKILL"]);
  });

  test("abort after exit signals nothing and resolves", async () => {
    const { spawn, calls } = fakeSpawn();
    const session = createCodexHarness({ spawn, ...timing }).spawn(makeOpts().opts);
    await session.send("go");
    calls[0].proc.finish(0);
    await session.exited;
    await session.abort();
    expect(calls[0].proc.signals).toEqual([]);
  });

  test("kill terminates the process immediately", async () => {
    const { spawn, calls } = fakeSpawn((p) => (p.diesOn = ["SIGTERM"]));
    const session = createCodexHarness({ spawn, ...timing }).spawn(makeOpts().opts);
    session.kill();
    await session.exited;
    expect(calls[0].proc.signals).toEqual(["SIGTERM"]);
  });
});

describe("codex toActivity", () => {
  async function replay(name: string) {
    const frames = lines(await fixture(name)).map((l, i) => ({ ...JSON.parse(l), _ts: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() }));
    const starts: ReplayContext["starts"] = new Map();
    return frames.map((f, seq) => realHarness.toActivity(f, { seq, starts }));
  }

  test("shows device, shell, edit and search calls with durations, and hides progress calls", async () => {
    const out = (await replay("codex-exec.jsonl")).filter((a) => a !== null);
    expect(out.map((a) => [a.kind, a.tool, a.ok])).toEqual([
      // the config warning is a `notice` event, so the runner's own feed line is its only copy
      ["tool", "mcp__mobile_mcp_mobile_list_elements_on_screen", undefined],
      ["tool_end", "mcp__mobile_mcp_mobile_list_elements_on_screen", true],
      ["tool", "bash", undefined],
      ["tool_end", "bash", true],
      ["tool", "bash", undefined],
      ["tool_end", "bash", false],
      ["tool", "edit", undefined], // file_change arrives completed only
      ["tool_end", "qa_check", false], // a rejected progress call stays visible
      ["tool", "search", undefined],
      ["tool_end", "search", true],
      ["say", undefined, undefined],
    ]);
    const bash = out.find((a) => a.kind === "tool" && a.tool === "bash");
    expect(bash?.args).toEqual({ command: "/bin/zsh -lc 'adb devices'" });
    expect(bash?.callId).toBe("item_4");
    const end = out.find((a) => a.kind === "tool_end" && a.callId === "item_5");
    expect(end?.text).toMatch(/^bash failed \(\d/);
    expect(out.find((a) => a.kind === "say")?.text).toBe("All checks passed. Report written.");
    expect(out.find((a) => a.kind === "tool_end" && a.callId === "item_3")?.durationMs).toBe(1000);
  });

  test("a failed turn becomes an error line; warnings are notices, not replayed a second time", async () => {
    const out = (await replay("codex-exec-failed.jsonl")).filter((a) => a !== null);
    expect(out.map((a) => a.kind)).toEqual(["error"]);
    expect(out[0]?.text).toContain("stream disconnected");
  });

  test("tapocalypse's own MCP tools are flagged as violations, device tools are plain tool lines", () => {
    const starts: ReplayContext["starts"] = new Map();
    const call = (id: string, server: string, tool: string) =>
      realHarness.toActivity(
        { type: "item.started", item: { id, type: "mcp_tool_call", server, tool, arguments: {}, status: "in_progress" } },
        { seq: 0, starts },
      );
    expect(call("a", "tapocalypse", "qa_start_run")?.kind).toBe("warn");
    expect(call("d", "mobile_mcp", "mobile_list_apps")?.kind).toBe("tool");
  });

  test("Tapocalypse's own _activity lines and unknown frames replay sanely", () => {
    const ctx = { seq: 3, starts: new Map() } as const;
    expect(realHarness.toActivity({ type: "_activity", kind: "info", text: "hello", _ts: "2026-01-01T00:00:00.000Z" }, ctx)).toEqual({
      ts: "2026-01-01T00:00:00.000Z",
      seq: 3,
      kind: "info",
      text: "hello",
    });
    expect(realHarness.toActivity({ type: "turn.started" }, ctx)).toBeNull();
    expect(realHarness.toActivity({ type: "something.else" }, ctx)).toBeNull();
    expect(realHarness.toActivity("nope", ctx)).toBeNull();
    expect(realHarness.toActivity({ type: "_raw", line: "x" }, ctx)).toBeNull();
  });
});

describe("codex doctor and models", () => {
  const ok = (text: string, code = 0): ExecResult => ({ code, stdout: new Uint8Array(), text, stderr: "" });
  function runner(map: Record<string, ExecResult>) {
    const seen: string[][] = [];
    const run = async (cmd: string[]) => {
      seen.push(cmd);
      return map[cmd.slice(1).join(" ")] ?? { code: 127, stdout: new Uint8Array(), text: "", stderr: "not found" };
    };
    return { run, seen };
  }

  test("reports installed and signed in", async () => {
    const { run, seen } = runner({ "--version": ok("codex-cli 0.162.0\n"), "login status": ok("Logged in using ChatGPT\n") });
    const checks = await realHarness.doctor({ bin: "codex", platform: "darwin", run, selected: true });
    expect(checks.map((c) => [c.id, c.status, c.required])).toEqual([
      ["codex", "ok", true],
      ["codex-auth", "ok", true],
    ]);
    expect(checks[0].detail).toBe("codex-cli 0.162.0");
    expect(seen).toEqual([
      ["codex", "--version"],
      ["codex", "login", "status"],
    ]);
  });

  test("a missing binary warns unless Codex is the selected harness, carries an install fix and skips the auth check", async () => {
    const { run, seen } = runner({});
    const checks = await realHarness.doctor({ bin: "codex", platform: "darwin", run, selected: false });
    expect(checks.map((c) => [c.id, c.status, c.required])).toEqual([
      ["codex", "warn", false],
      ["codex-auth", "skip", false],
    ]);
    expect(checks[0].fix).toContain("@openai/codex");
    expect(seen).toEqual([["codex", "--version"]]);
    expect((await realHarness.doctor({ bin: "codex", platform: "darwin", run, selected: true }))[0]?.status).toBe("error");
  });

  test("not signed in is an error naming `codex login`", async () => {
    const { run } = runner({ "--version": ok("codex-cli 0.162.0"), "login status": ok("Not logged in", 1) });
    const [, auth] = await realHarness.doctor({ bin: "/x/codex", platform: "linux", run, selected: true });
    expect(auth.status).toBe("error");
    expect(auth.fix).toContain("codex login");
    expect(auth.required).toBe(true);
  });

  test("a probe that times out only warns", async () => {
    const { run } = runner({ "--version": ok("codex-cli 0.162.0"), "login status": ok("", 124) });
    const [, auth] = await realHarness.doctor({ bin: "codex", platform: "linux", run, selected: true });
    expect(auth.status).toBe("warn");
  });

  test("lists a short static model list", async () => {
    const models = await realHarness.listModels({ bin: "codex", run: async () => ok("") });
    expect(models).toContain("gpt-5.5");
    expect(new Set(models).size).toBe(models.length);
  });
});
