import { mkdirSync } from "node:fs";
import path from "node:path";
import type { DoctorCheck } from "../../doctor";
import type { ExecResult } from "../../devices/devices";
import type { RunUsage } from "../../runs/types";
import {
  ARTEMIS_SERVER,
  type Harness,
  type HarnessDoctorEnv,
  type HarnessEvent,
  type HarnessExit,
  type HarnessSession,
  MOBILE_MCP_SERVER,
  PROGRESS_SERVER,
  type SessionInfo,
  type SpawnOptions,
} from "../types";
import { PROGRESS_TOOL_NAMES, PROGRESS_TOOLS, type ProgressToolName } from "../../runs/progress";
import { resolveCall, resultText, serverOf, toActivity } from "./activity";
import { type LaunchPlan, mcpLaunchArgs, missingToolsMessage, resolveToolPrefixes, type ToolPrefixes } from "./provision";
import { type Frame, OmpRpc } from "./rpc";
import { normalizeUsage, UsageAccumulator } from "./usage";

const OMP_URL = "https://github.com/can1357/oh-my-pi";
/** After `prompt_result`/`agent_end`, how long to wait for `session_settled` before treating the turn as over anyway. */
const SETTLE_FALLBACK_MS = 30_000;

export interface OmpTiming {
  /** How long an aborted (unsettled) omp may take to exit before it is killed. */
  abortGraceMs: number;
  /** How long a settled omp may take to flush and exit after its stdin closed before it is killed. */
  drainGraceMs: number;
}

const DEFAULT_TIMING: OmpTiming = { abortGraceMs: 10_000, drainGraceMs: 60_000 };

function promptResultError(frame: Frame): string | null {
  const err = frame.error;
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return null;
}

class OmpSession implements HarnessSession {
  readonly exited: Promise<HarnessExit>;
  private readonly resolveExit: (exit: HarnessExit) => void;
  private rpc: OmpRpc | null = null;
  private launch: LaunchPlan | null = null;
  private prefixes: ToolPrefixes = { mobileMcp: null, artemis: null };
  private readonly started: Promise<OmpRpc>;
  private readonly usageFrames = new UsageAccumulator();
  private promptResult: { status: string; error: string | null } | null = null;
  private settled = false;
  private model: string | null;
  private fallbackTimer: NodeJS.Timeout | undefined;
  private killed = false;

  constructor(
    private readonly opts: SpawnOptions,
    private readonly timing: OmpTiming,
  ) {
    const { promise, resolve } = Promise.withResolvers<HarnessExit>();
    this.exited = promise;
    this.resolveExit = resolve;
    this.model = opts.model;
    this.started = this.start();
    // A failed start surfaces through ready(); the exit is reported here so the runner never waits on a session that never ran.
    this.started.catch((e: unknown) =>
      resolve({ code: 1, signal: null, settled: false, started: false, limit: null, error: e instanceof Error ? e.message : String(e) }),
    );
  }

  private async start(): Promise<OmpRpc> {
    const { opts } = this;
    const launch = await mcpLaunchArgs({ repoPath: opts.cwd }, opts.backend);
    if (this.killed) throw new Error("killed before omp started");
    this.launch = launch;
    const sessionDir = path.join(opts.runDir, "session");
    mkdirSync(sessionDir, { recursive: true });
    const bin = typeof opts.settings.bin === "string" ? opts.settings.bin : undefined;
    const rpc = new OmpRpc({
      bin,
      cwd: opts.cwd,
      args: [
        ...launch.args,
        ...(opts.model ? ["--model", opts.model] : []),
        ...(opts.effort ? ["--thinking", opts.effort] : []),
        "--append-system-prompt",
        opts.personaFile,
        "--session-dir",
        sessionDir,
        "--auto-approve",
        ...(opts.limits.maxTime !== null ? ["--max-time", opts.limits.maxTime] : []),
        "--no-title",
      ],
      onFrame: (f) => this.onFrame(f),
      onExit: (code) => this.onExit(code),
    });
    this.rpc = rpc;
    rpc.setHostToolHandler(async (name, args) => {
      if (!opts.onProgress || !PROGRESS_TOOL_NAMES.includes(name as ProgressToolName)) throw new Error(`unknown host tool ${name}`);
      return opts.onProgress.record(name as ProgressToolName, args);
    });
    return rpc;
  }

  private emit(e: HarnessEvent): void {
    this.opts.onEvent(e);
  }

  private onFrame(frame: Frame): void {
    if (frame.type === "_stderr") {
      this.opts.onStderr(typeof frame.text === "string" ? frame.text : "");
      return;
    }
    if (frame.type !== "message_update") this.opts.onRaw(frame);
    this.usageFrames.add(frame);
    this.translate(frame);

    if (frame.type === "prompt_result") {
      this.promptResult = { status: typeof frame.status === "string" ? frame.status : "", error: promptResultError(frame) };
    }
    const settled = frame.type === "session_settled" || (frame.type === "prompt_result" && frame.sessionSettled === true);
    if (settled) {
      this.settle();
    } else if ((frame.type === "prompt_result" || frame.type === "agent_end") && !this.fallbackTimer && !this.settled) {
      // Safety net: some sessions never emit session_settled; don't leave the run hanging.
      this.fallbackTimer = setTimeout(() => this.settle(), SETTLE_FALLBACK_MS);
    }
  }

  private translate(frame: Frame): void {
    if (frame.type === "tool_execution_start" && typeof frame.toolName === "string") {
      const { tool, args } = resolveCall(frame.toolName, frame.args);
      this.emit({
        type: "tool_call",
        callId: typeof frame.toolCallId === "string" ? frame.toolCallId : "",
        tool,
        server: serverOf(tool),
        args,
      });
    } else if (frame.type === "tool_execution_end") {
      this.emit({
        type: "tool_result",
        callId: typeof frame.toolCallId === "string" ? frame.toolCallId : "",
        ok: frame.isError !== true,
        text: resultText(frame.result),
      });
    } else if (frame.type === "message_end") {
      const msg = frame.message as { role?: string; content?: unknown } | undefined;
      if (msg?.role !== "assistant") return;
      const usage = this.usageFrames.snapshot(null);
      if (usage) this.emit({ type: "usage", usage, cumulative: true });
      if (Array.isArray(msg.content)) {
        const text = msg.content
          .filter((c): c is { type: "text"; text: string } => c?.type === "text" && typeof c.text === "string")
          .map((c) => c.text)
          .join("\n");
        if (text) this.emit({ type: "text", text });
      }
    }
  }

  private settle(): void {
    if (this.settled) return;
    this.settled = true;
    clearTimeout(this.fallbackTimer);
    const failed = this.promptResult?.status === "error";
    this.emit({ type: "turn_end", ok: !failed, error: failed ? this.exitError() : null, limit: null });
  }

  private exitError(): string | null {
    if (this.promptResult?.status !== "error") return null;
    return this.promptResult.error ?? "agent run failed";
  }

  private onExit(code: number): void {
    clearTimeout(this.fallbackTimer);
    this.resolveExit({ code, signal: null, settled: this.settled, started: true, limit: null, error: this.exitError() });
  }

  async ready(): Promise<SessionInfo> {
    const rpc = await this.started;
    const launch = this.launch!;
    const { opts } = this;
    await rpc.ready();
    // MCP servers connect in the background; prompting before they are up makes the agent fail with "No such tool".
    this.prefixes = await resolveToolPrefixes(rpc, opts.backend, { expectedMobileMcp: launch.expectedMobileMcp });
    const server = opts.backend === "mobile-mcp" ? MOBILE_MCP_SERVER : ARTEMIS_SERVER;
    const prefix = opts.backend === "mobile-mcp" ? this.prefixes.mobileMcp : this.prefixes.artemis;
    const mcp: SessionInfo["mcp"] = [prefix ? { name: server, ok: true } : { name: server, ok: false, error: missingToolsMessage(opts.backend, launch) }];
    if (prefix) {
      this.emit({ type: "notice", level: "info", text: `${opts.backend} tools: ${prefix}*${launch.pluginDir ? " (provisioned by Tapocalypse)" : ""}` });
      await rpc.send({ type: "set_host_tools", tools: PROGRESS_TOOLS });
    }
    return { sessionId: null, model: this.model, mcp };
  }

  toolName(server: string, tool: string): string {
    if (server === PROGRESS_SERVER) return tool;
    if (server === ARTEMIS_SERVER) return `${this.prefixes.artemis ?? "mcp__artemis_"}${tool}`;
    return `${this.prefixes.mobileMcp ?? "mcp__mobile_mcp_"}${tool}`;
  }

  async send(prompt: string): Promise<void> {
    await (await this.started).send({ type: "prompt", message: prompt });
  }

  async steer(message: string): Promise<void> {
    await (await this.started).send({ type: "steer", message });
  }

  async abort(): Promise<void> {
    const rpc = this.rpc;
    if (!rpc) {
      this.kill();
      await this.exited;
      return;
    }
    // After settle there is nothing to abort: closing stdin lets omp drain (flush, post-process) and exit on its own.
    if (!this.settled) rpc.send({ type: "abort" }).catch(() => {});
    rpc.closeStdin();
    const graceMs = this.settled ? this.timing.drainGraceMs : this.timing.abortGraceMs;
    const exited = await Promise.race([this.exited.then(() => true), Bun.sleep(graceMs).then(() => false)]);
    if (!exited) {
      rpc.kill();
      await this.exited;
    }
  }

  kill(): void {
    this.killed = true;
    this.rpc?.kill();
    if (!this.rpc) this.resolveExit({ code: 143, signal: "SIGTERM", settled: false, started: false, limit: null, error: null });
  }

  async usage(): Promise<RunUsage | null> {
    return normalizeUsage(await this.rawStats(), this.model);
  }

  async rawStats(): Promise<unknown> {
    return (await this.started).send({ type: "get_session_stats" });
  }

  async exportTranscript(file: string): Promise<boolean> {
    await (await this.started).send({ type: "export_html", outputPath: file });
    return true;
  }
}

const firstLine = (s: string) => s.split(/\r?\n/).find((l) => l.trim())?.trim() ?? "";
const lastLines = (s: string, n = 3) => s.trim().split(/\r?\n/).slice(-n).join(" ").trim();

async function doctor(env: HarnessDoctorEnv): Promise<DoctorCheck[]> {
  const install = await installCheck(env);
  return [install, await authCheck(env, install)];
}

async function installCheck(env: HarnessDoctorEnv): Promise<DoctorCheck> {
  const base = { id: "omp", label: "omp (agent runtime)", required: env.selected };
  // A missing runtime only blocks runs when it is the one in use.
  const missing = env.selected ? "error" : "warn";
  const r = await env.run([env.bin, "--version"]);
  if (r.code === 127) {
    return { ...base, status: missing, detail: `\`${env.bin}\` not found on PATH`, fix: `Install omp: ${OMP_URL}, then make sure \`omp\` is on your PATH (or set OMP_BIN)` };
  }
  if (r.code !== 0) {
    return { ...base, status: missing, detail: `\`${env.bin} --version\` failed: ${lastLines(r.stderr || r.text)}`, fix: `Reinstall omp: ${OMP_URL}` };
  }
  return { ...base, status: "ok", detail: firstLine(r.text) || "installed" };
}

/** `omp models --json` lists only providers the user is signed in to; it is local/cached and never calls a paid model API. */
async function authCheck(env: HarnessDoctorEnv, install: DoctorCheck): Promise<DoctorCheck> {
  const base = { id: "omp-auth", label: "omp signed in (model access)", required: env.selected };
  if (install.status !== "ok") return { ...base, status: "skip", detail: "Needs omp installed first" };
  const r = await env.run([env.bin, "models", "--json"]);
  const fix = "Run `omp login` and sign in to a model provider (or export its API key), then re-check";
  if (r.code !== 0) {
    const reason = r.code === 143 || r.code === 124 ? "timed out" : lastLines(r.stderr || r.text) || `exit ${r.code}`;
    return { ...base, status: "warn", detail: `Could not list omp models (${reason}); cannot confirm you are signed in`, fix };
  }
  let count = 0;
  try {
    const parsed = JSON.parse(r.text) as { models?: unknown };
    count = Array.isArray(parsed.models) ? parsed.models.length : 0;
  } catch {
    return { ...base, status: "warn", detail: "Unexpected output from `omp models --json`; cannot confirm you are signed in", fix };
  }
  return count > 0
    ? { ...base, status: "ok", detail: `${count} model(s) available` }
    : { ...base, status: env.selected ? "error" : "warn", detail: "omp is not signed in to any model provider; runs cannot start", fix };
}

/** Parses the table `omp models` prints: `provider (n)` header lines followed by `│ model │ …` rows. */
export function parseOmpModels(output: string): string[] {
  const models: string[] = [];
  let provider: string | null = null;
  for (const line of output.split("\n")) {
    const header = /^(\S+) \(\d+\)\s*$/.exec(line);
    if (header) {
      provider = header[1]!;
      continue;
    }
    const row = /^│\s*([^│\s]+)\s*│/.exec(line);
    if (row && provider && row[1] !== "model") models.push(`${provider}/${row[1]}`);
  }
  return models;
}

export function createOmpHarness(timing: Partial<OmpTiming> = {}): Harness {
  const t: OmpTiming = { ...DEFAULT_TIMING, ...timing };
  return {
    id: "omp",
    label: "omp",
    capabilities: {
      steer: true,
      interrupt: true,
      appendSystemPrompt: true,
      nativeProgressTools: true,
      costReported: true,
      limits: { maxTime: true, maxTurns: false, maxBudgetUsd: false },
      transcriptExport: true,
      backends: ["mobile-mcp", "artemis"],
    },
    spawn: (opts) => new OmpSession(opts, t),
    toActivity,
    doctor,
    async listModels(env: { bin: string; run: (cmd: string[]) => Promise<ExecResult> }) {
      const r = await env.run([env.bin, "models"]);
      return r.code === 0 ? parseOmpModels(r.text) : [];
    },
  };
}

export const harness: Harness = createOmpHarness();
