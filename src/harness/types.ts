/**
 * Harness adapters: Tapocalypse drives any headless coding-agent CLI ("harness") through this interface. The runner owns
 * the run lifecycle (device, prompt, time budget, verdict); an adapter owns how one CLI is spawned, how its event stream is
 * normalized, how progress tools reach it (omp host tools or the run-scoped MCP endpoint), and how it is probed by doctor.
 */
import { z } from "zod";
import type { ExecResult } from "../devices/devices";
import type { DoctorCheck } from "../doctor";
import type { Activity, Platform, RunUsage } from "../runs/types";

export const HARNESS_IDS = ["omp", "claude", "codex"] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];
export const HarnessIdSchema = z.enum(HARNESS_IDS);

/** Short name of the run-scoped progress MCP server (`qa_plan` / `qa_check` / `qa_finish`). Short because omp truncates long tool names. */
export const PROGRESS_SERVER = "tpc";
/** Server names an adapter mounts for the device driver; `toolName(server, tool)` resolves them to the harness's callable name. */
export const MOBILE_MCP_SERVER = "mobile_mcp";
/** npm package of the mobile-mcp device driver every harness mounts through `npx`. */
export const MOBILE_MCP_PACKAGE = "@mobilenext/mobile-mcp";
/**
 * The mobile-mcp release every child runs. Exact on purpose: `@latest` would run whatever npm serves at that moment, with the
 * server's environment and the lease's device, so an update (or a hijacked publish) would take effect on the next call. Bump it
 * deliberately, after checking the tools the gateway serves (`DROPPED_TOOLS`, `servableTools`) still match.
 */
export const MOBILE_MCP_VERSION = "1.0.11";

export type McpServerSpec =
  | { name: string; transport: "stdio"; command: string; args: string[]; env?: Record<string, string> }
  | { name: string; transport: "http"; url: string; headers: Record<string, string> };

export interface HarnessCapabilities {
  /** Inject a message while a turn runs (omp `steer`, Claude stream-json stdin). */
  steer: boolean;
  /** Graceful turn abort without killing the process (omp `abort`, Claude `control_request`). */
  interrupt: boolean;
  /** Persona can be appended to the system prompt; otherwise the runner prepends it to the user prompt. */
  appendSystemPrompt: boolean;
  /** Progress tools are registered natively (omp host tools) instead of through the run MCP endpoint. */
  nativeProgressTools: boolean;
  /** Reports a monetary cost; otherwise `RunUsage.cost` stays null. */
  costReported: boolean;
  /** Which limits the harness enforces itself; Tapocalypse always enforces the time budget by killing at the deadline. */
  limits: { maxTime: boolean; maxTurns: boolean; maxBudgetUsd: boolean };
  /** Can write an HTML transcript of the session (omp `export_html`). */
  transcriptExport: boolean;
}

export interface SpawnOptions {
  runId: string;
  /** Project repo (or worktree); the agent's working directory. */
  cwd: string;
  /** `<data>/runs/<id>`: session files and per-run temp configs go here. */
  runDir: string;
  /** Persona body, frontmatter stripped. Already written to `<runDir>/persona.md` by the runner. */
  persona: string;
  personaFile: string;
  /** The device this run drives: its adb serial or simulator UDID, and platform. Adapters that restrict shell access scope it to this device. */
  device: { serial: string; platform: Platform };
  /** Harness-native model id (omp `provider/model`, Claude alias or id, Codex `gpt-…`); null = the harness default. */
  model: string | null;
  /** Harness-native reasoning level (omp thinking, Claude/Codex effort); null = default. */
  effort: string | null;
  /** Device driver + progress servers to mount for this session only. Never touches the user's own config. */
  mcpServers: McpServerSpec[];
  /** Raw `config.runMaxTime` (e.g. `60m`) for harnesses that enforce the limit themselves (omp `--max-time`); null = none. */
  limits: { maxTime: string | null; maxTurns: number | null; maxBudgetUsd: number | null };
  /** Per-harness settings from `config.agent.harnesses[id]` (bin, permissions, sandbox…); adapters validate what they read. */
  settings: Record<string, unknown>;
  onEvent: (e: HarnessEvent) => void;
  /** Every raw frame of the harness stream, persisted verbatim to events.jsonl (replayed by `toActivity`). */
  onRaw: (frame: object) => void;
  onStderr: (text: string) => void;
  /** Present only when `capabilities.nativeProgressTools`: host-tool calls are routed here. */
  onProgress?: ProgressSink;
}

export interface SessionInfo {
  sessionId: string | null;
  /** Model as reported by the harness, when it says. */
  model: string | null;
  /** Mount status per requested MCP server; the runner fails the run early when mobile-mcp or `tpc` is not ok. */
  mcp: { name: string; ok: boolean; error?: string }[];
}

export interface HarnessExit {
  code: number;
  signal: string | null;
  /** The harness emitted its terminal event (omp `session_settled`, Claude final `result`, Codex `turn.completed`). */
  settled: boolean;
  /** False when the session never ran (spawn failure, launch-plan error, MCP startup failure): classified as infra and retried. */
  started: boolean;
  /** A harness-enforced limit ended the session. */
  limit: "turns" | "budget" | "time" | null;
  /** Terminal error text from the stream (Claude `result.errors`, Codex `turn.failed`, omp `prompt_result.error`). */
  error: string | null;
}

export interface HarnessSession {
  /** Resolves once the MCP tools are mounted and callable (omp: prefix polling; Claude: `system/init`; Codex: `required=true`). */
  ready(): Promise<SessionInfo>;
  /** The exact callable name the model sees for `server`/`tool`; used in prompt text and activity matching. */
  toolName(server: string, tool: string): string;
  /** Sends the single QA prompt. */
  send(prompt: string): Promise<void>;
  /** Present iff `capabilities.steer`. */
  steer?(message: string): Promise<void>;
  /** Graceful stop: interrupt → close stdin → grace → SIGTERM → SIGKILL. Resolves when the process has exited. */
  abort(): Promise<void>;
  kill(): void;
  /** Best-effort final usage (omp session stats, Claude `result`); the runner falls back to what `onEvent` accumulated. */
  usage(): Promise<RunUsage | null>;
  /** Present iff the harness has a raw stats payload worth keeping (omp `get_session_stats`); stored as `Run.stats`. */
  rawStats?(): Promise<unknown>;
  /** Present iff `capabilities.transcriptExport`; resolves true when the file was written. */
  exportTranscript?(file: string): Promise<boolean>;
  readonly exited: Promise<HarnessExit>;
}

/** Normalized stream every adapter emits; the runner turns these into activity, usage and settle state. */
export type HarnessEvent =
  | { type: "session"; sessionId: string | null; model: string | null }
  | { type: "tool_call"; callId: string; tool: string; server: string | null; args: unknown }
  | { type: "tool_result"; callId: string; ok: boolean; text: string }
  | { type: "text"; text: string }
  | { type: "usage"; usage: Partial<RunUsage>; cumulative: boolean }
  | { type: "notice"; level: "info" | "warn"; text: string }
  | { type: "turn_end"; ok: boolean; error: string | null; limit: HarnessExit["limit"] };

/**
 * Canonical tool names in `HarnessEvent.tool` / `Activity.tool`, so the UI, `backendViolation` and `humanise` work for every
 * harness: MCP tools are `mcp__<server>_<tool>` with `server` one of the constants above (adapters strip their own prefixes
 * and plugin namespaces); progress tools are bare `qa_plan` / `qa_check` / `qa_finish`; built-in tools map to
 * `bash` {command}, `read` {path}, `write` {path}, `edit` {path}, `eval` {language}, `search` {query}, else the harness's
 * own lowercased name. `server` carries the canonical server name for MCP tools, null otherwise.
 */
export const CANONICAL_TOOL_PREFIX = "mcp__";

export interface ProgressSink {
  /** Records qa_plan / qa_check / qa_finish; resolves the text returned to the agent, throws on invalid input. */
  record(tool: "qa_plan" | "qa_check" | "qa_finish", args: unknown): Promise<string>;
}

/**
 * Replay context for `toActivity`: tool starts seen so far in this events.jsonl, so results resolve tool and duration.
 * `toActivity` runs more than once per frame (store scan pass, then the page pass), so it must be idempotent: an adapter
 * that dedupes repeated frames records the frame's `seq` in the entry and only skips a frame whose `seq` differs.
 */
export interface ReplayContext {
  seq: number;
  /** `Run.gated` of the run being replayed: only a gated run's own `mobile_mcp` calls are backend violations. */
  gated: boolean;
  starts: Map<string, { ts: number; tool: string; seq?: number }>;
}

export interface HarnessDoctorEnv {
  /** Binary for this harness (`config.agent.harnesses[id].bin`, env `<ID>_BIN`, or the default name). */
  bin: string;
  platform: NodeJS.Platform;
  /** Runs a probe to completion; never throws (missing binary = exit 127). Never a paid model call. */
  run: (cmd: string[]) => Promise<ExecResult>;
  /** Whether this harness is the configured default; only then are its checks `required`. */
  selected: boolean;
}

export interface Harness {
  id: HarnessId;
  label: string;
  capabilities: HarnessCapabilities;
  spawn(opts: SpawnOptions): HarnessSession;
  /** Maps one persisted raw frame to a feed line (used by `store.readActivity`, keyed by `run.harness`). */
  toActivity(frame: unknown, ctx: ReplayContext): Activity | null;
  /** Install + auth checks; ids `<id>` and `<id>-auth`. */
  doctor(env: HarnessDoctorEnv): Promise<DoctorCheck[]>;
  /** Model ids to offer in the picker (free text stays allowed). */
  listModels(env: { bin: string; run: (cmd: string[]) => Promise<ExecResult> }): Promise<string[]>;
}
