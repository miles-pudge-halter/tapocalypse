import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { RunUsage } from "../../runs/types";
import { failedSession } from "../failed";
import type { HarnessEvent, HarnessExit, HarnessSession, McpServerSpec, SessionInfo, SpawnOptions } from "../types";
import { StreamMapper, parseFrame } from "./events";

/** The slice of a child process the session needs; `Bun.spawn(..., {stdin:"pipe", stdout:"pipe", stderr:"pipe"})` satisfies it. */
export interface ClaudeProcess {
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  readonly stdin: { write(data: string): unknown; end(): unknown };
  readonly exited: Promise<number>;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): void;
}

export type SpawnFn = (cmd: string[], opts: { cwd: string; env: Record<string, string | undefined> }) => ClaudeProcess;

/** The one place that knows how Claude Code names an MCP tool for the model (`mcp__<server>__<tool>`). */
export const claudeToolName = (server: string, tool: string): string => `mcp__${server}__${tool}`;

export interface ClaudeDeps {
  spawn: SpawnFn;
  /** How long `abort` waits for the interrupted turn to end before closing stdin. */
  interruptWaitMs: number;
  /** How long after stdin closes before SIGTERM. */
  graceMs: number;
  /** How long after SIGTERM before SIGKILL. */
  killGraceMs: number;
  /** How long `ready` waits for MCP servers to leave `pending`. */
  readyTimeoutMs: number;
  /** How long a single control request (`mcp_status`) may go unanswered before `ready` fails. */
  controlTimeoutMs: number;
  mcpPollMs: number;
}

const bunSpawn: SpawnFn = (cmd, o) => Bun.spawn(cmd, { cwd: o.cwd, env: o.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });

export const DEFAULT_DEPS: ClaudeDeps = {
  spawn: bunSpawn,
  interruptWaitMs: 3_000,
  graceMs: 5_000,
  killGraceMs: 2_000,
  readyTimeoutMs: 60_000,
  controlTimeoutMs: 10_000,
  mcpPollMs: 500,
};

interface McpStatus {
  name: string;
  status?: string;
  error?: string;
}

interface ControlResponse {
  ok: boolean;
  response: unknown;
  error: string | null;
}

/** `config.agent.harnesses.claude`, as far as this adapter reads it. */
const settingsSchema = z.object({
  bin: z.string().min(1).optional(),
  permissions: z.enum(["bypass", "allowlist"]).default("bypass"),
});

/** `dontAsk` denies everything outside this list; the mounted MCP servers are added per run. */
const ALLOWLIST_TOOLS = ["Bash(adb *)", "Bash(xcrun simctl *)", "Read", "Write", "Edit"];

function mcpConfig(servers: McpServerSpec[]): object {
  const entries = servers.map((s) => [
    s.name,
    // `alwaysLoad` keeps the tools out of Claude's tool-search deferral: the QA agent calls them constantly.
    s.transport === "http"
      ? { type: "http", url: s.url, headers: s.headers, alwaysLoad: true }
      : { type: "stdio", command: s.command, args: s.args, ...(s.env ? { env: s.env } : {}), alwaysLoad: true },
  ]);
  return { mcpServers: Object.fromEntries(entries) };
}

/** Writes `<runDir>/mcp.json` (owner-only: it carries the run token) and returns the argv for this run. */
export function prepareClaude(opts: SpawnOptions): string[] {
  const settings = settingsSchema.parse(opts.settings);
  mkdirSync(opts.runDir, { recursive: true });
  const mcpFile = path.join(opts.runDir, "mcp.json");
  writeFileSync(mcpFile, JSON.stringify(mcpConfig(opts.mcpServers), null, 2), { mode: 0o600 });
  chmodSync(mcpFile, 0o600);

  const argv = [
    settings.bin ?? "claude",
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--mcp-config",
    mcpFile,
    "--append-system-prompt-file",
    opts.personaFile,
    "--disallowedTools",
    "Agent",
    "AskUserQuestion",
  ];
  if (settings.permissions === "allowlist") {
    // The run folder (screenshots, report) is outside the repo the agent works in.
    argv.push("--add-dir", opts.runDir, "--permission-mode", "dontAsk", "--allowedTools", ...opts.mcpServers.map((s) => `mcp__${s.name}__*`), ...ALLOWLIST_TOOLS);
  } else {
    argv.push("--permission-mode", "bypassPermissions");
  }
  if (opts.model) argv.push("--model", opts.model);
  if (opts.effort) argv.push("--effort", opts.effort);
  if (opts.limits.maxTurns !== null) argv.push("--max-turns", String(opts.limits.maxTurns));
  if (opts.limits.maxBudgetUsd !== null) argv.push("--max-budget-usd", String(opts.limits.maxBudgetUsd));
  return argv;
}

export class ClaudeSession implements HarnessSession {
  readonly exited: Promise<HarnessExit>;
  private readonly proc: ClaudeProcess;
  private readonly mapper = new StreamMapper();
  private readonly pending = new Map<string, (r: ControlResponse | null) => void>();
  private nextControlId = 0;
  private stdinClosed = false;
  private processExited = false;
  private settled = false;
  private readyPromise: Promise<SessionInfo> | null = null;

  constructor(
    argv: string[],
    private readonly opts: SpawnOptions,
    private readonly deps: ClaudeDeps,
  ) {
    const proc = deps.spawn(argv, { cwd: opts.cwd, env: { ...process.env } });
    this.proc = proc;

    const stdout = this.pump(proc.stdout, (line) => this.onLine(line));
    const stderr = this.pump(proc.stderr, (line) => this.guarded("onStderr", () => opts.onStderr(`${line}\n`)));
    this.exited = (async (): Promise<HarnessExit> => {
      const code = await proc.exited;
      this.processExited = true;
      await Promise.allSettled([stdout, stderr]);
      for (const resolve of this.pending.values()) resolve(null);
      this.pending.clear();
      const last = this.mapper.lastResult;
      return { code, signal: proc.signalCode, settled: this.settled, started: true, limit: last?.limit ?? null, error: last?.error ?? null };
    })();
  }

  toolName(server: string, tool: string): string {
    return claudeToolName(server, tool);
  }

  ready(): Promise<SessionInfo> {
    this.readyPromise ??= this.awaitMcp();
    return this.readyPromise;
  }

  async send(prompt: string): Promise<void> {
    this.writeUser(prompt);
  }

  async steer(message: string): Promise<void> {
    this.writeUser(message);
  }

  async abort(): Promise<void> {
    if (this.processExited) return;
    this.write({ type: "control_request", request_id: `tpc-${++this.nextControlId}`, request: { subtype: "interrupt" } });
    await Promise.race([this.exited, Bun.sleep(this.deps.interruptWaitMs)]);
    this.closeStdin();
    await this.escalate();
  }

  kill(): void {
    if (this.processExited) return;
    this.closeStdin();
    void this.escalate(0);
  }

  async usage(): Promise<RunUsage | null> {
    return this.mapper.finalUsage ?? this.mapper.liveUsage();
  }

  /** Waits for exit; SIGTERM after `graceMs`, SIGKILL after another `killGraceMs`. */
  private async escalate(graceMs = this.deps.graceMs): Promise<void> {
    if (await this.exitsWithin(graceMs)) return;
    this.proc.kill("SIGTERM");
    if (await this.exitsWithin(this.deps.killGraceMs)) return;
    this.proc.kill("SIGKILL");
    await this.exited;
  }

  private async exitsWithin(ms: number): Promise<boolean> {
    if (this.processExited) return true;
    await Promise.race([this.exited, Bun.sleep(ms)]);
    return this.processExited;
  }

  /** Polls `mcp_status` until no server is `pending`; MCP connects before the first turn, but init only follows a user message. */
  private async awaitMcp(): Promise<SessionInfo> {
    const deadline = Date.now() + this.deps.readyTimeoutMs;
    let servers: McpStatus[] | null = null;
    for (;;) {
      const r = await this.control("mcp_status");
      if (!r) throw new Error("claude exited before its MCP servers were ready");
      servers = r.ok ? mcpServers(r.response) : null;
      if (!servers || !servers.some((s) => s.status === "pending") || Date.now() >= deadline) break;
      await Bun.sleep(this.deps.mcpPollMs);
    }
    const mcp = this.opts.mcpServers.map(({ name }) => {
      // An old claude without `mcp_status` is trusted here; `system/init` warns about servers that did not connect.
      if (!servers) return { name, ok: true };
      const s = servers.find((x) => x.name === name);
      if (s?.status === "connected") return { name, ok: true };
      return { name, ok: false, error: s?.error ?? (s ? `status ${s.status ?? "unknown"}` : "not reported by claude") };
    });
    return { sessionId: null, model: null, mcp };
  }

  /** Sends a control request and resolves with its response; null when the process exits first, rejects when it never answers. */
  private control(subtype: string): Promise<ControlResponse | null> {
    if (this.processExited) return Promise.resolve(null);
    const id = `tpc-${++this.nextControlId}`;
    const { promise, resolve, reject } = Promise.withResolvers<ControlResponse | null>();
    const timer = setTimeout(() => {
      this.pending.delete(id);
      reject(new Error(`claude did not answer ${subtype} (timed out after ${this.deps.controlTimeoutMs / 1000}s)`));
    }, this.deps.controlTimeoutMs);
    this.pending.set(id, (r) => {
      clearTimeout(timer);
      resolve(r);
    });
    this.write({ type: "control_request", request_id: id, request: { subtype } });
    return promise;
  }

  private writeUser(text: string): void {
    if (this.stdinClosed) throw new Error("claude session has already ended");
    this.write({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
  }

  private write(msg: object): void {
    if (this.stdinClosed) return;
    try {
      this.proc.stdin.write(`${JSON.stringify(msg)}\n`);
    } catch {
      // The process is gone; `exited` reports it.
    }
  }

  private closeStdin(): void {
    if (this.stdinClosed) return;
    this.stdinClosed = true;
    try {
      this.proc.stdin.end();
    } catch {
      // Already closed.
    }
  }

  private async pump(stream: AsyncIterable<Uint8Array>, onLine: (line: string) => void): Promise<void> {
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of stream) {
      buf += decoder.decode(chunk, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) onLine(line);
      }
    }
    buf += decoder.decode();
    if (buf.trim()) onLine(buf);
  }

  private onLine(line: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      this.guarded("onRaw", () => this.opts.onRaw({ type: "_raw", line }));
      return;
    }
    const parsed = parseFrame(frame);
    if (!parsed) {
      this.guarded("onRaw", () => this.opts.onRaw({ type: "_raw", line }));
      return;
    }
    // Control responses answer our requests; they echo MCP configs (headers, tokens) and are not part of the transcript.
    if (parsed.type === "control_response") {
      this.onControlResponse(parsed);
      return;
    }
    this.guarded("onRaw", () => this.opts.onRaw(parsed));
    this.guarded("translate", () => {
      for (const event of this.mapper.map(parsed)) this.emit(event);
    });
    if (parsed.type === "result") {
      this.settled = true;
      // One process emits one `result` per turn; closing stdin is what lets it exit.
      this.closeStdin();
    }
  }

  private onControlResponse(frame: Record<string, unknown>): void {
    const body = frame.response as { subtype?: unknown; request_id?: unknown; response?: unknown; error?: unknown } | undefined;
    const id = typeof body?.request_id === "string" ? body.request_id : null;
    const resolve = id ? this.pending.get(id) : undefined;
    if (!id || !resolve) return;
    this.pending.delete(id);
    resolve({ ok: body?.subtype === "success", response: body?.response, error: typeof body?.error === "string" ? body.error : null });
  }

  private emit(event: HarnessEvent): void {
    this.guarded(`onEvent(${event.type})`, () => this.opts.onEvent(event));
  }

  /** Runs an adapter callback; a throwing listener (disk error, SSE subscriber) must never stop the stdout/stderr pumps. */
  private guarded(what: string, fn: () => void): void {
    try {
      fn();
    } catch (e) {
      console.error(`claude ${what} failed:`, e);
    }
  }
}

/** Starts claude; a spawn or settings failure yields a session that never ran (infra, retriable) instead of throwing. */
export function startSession(opts: SpawnOptions, deps: ClaudeDeps): HarnessSession {
  try {
    return new ClaudeSession(prepareClaude(opts), opts, deps);
  } catch (e) {
    return failedSession(e instanceof z.ZodError ? `invalid claude settings: ${z.prettifyError(e)}` : `claude could not start: ${(e as Error).message}`, claudeToolName);
  }
}

function mcpServers(response: unknown): McpStatus[] | null {
  const list = (response as { mcpServers?: unknown } | null)?.mcpServers;
  if (!Array.isArray(list)) return null;
  return list.flatMap((s): McpStatus[] => {
    const name = (s as { name?: unknown } | null)?.name;
    if (typeof name !== "string") return [];
    const { status, error } = s as { status?: unknown; error?: unknown };
    return [{ name, status: typeof status === "string" ? status : undefined, error: typeof error === "string" ? error : undefined }];
  });
}
