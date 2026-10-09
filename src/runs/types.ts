import type { HarnessId } from "../harness/types";

export type Backend = "mobile-mcp" | "artemis";
export type Platform = "android" | "ios";
export type RunStatus =
  | "queued"
  | "preflight"
  | "running"
  | "finishing"
  | "done"
  | "error"
  | "cancelled"
  | "interrupted";
export const ACTIVE: RunStatus[] = ["queued", "preflight", "running", "finishing"];
export type Verdict = "PASS" | "FAIL" | "PASS WITH ISSUES" | "BLOCKED" | "PARTIAL";
export const VERDICTS: Verdict[] = ["PASS", "FAIL", "PASS WITH ISSUES", "BLOCKED", "PARTIAL"];
export type CheckStatus = "pending" | "running" | "pass" | "fail" | "blocked" | "skipped";

export type ErrorKind = "infra" | "agent" | "timeout" | "cancelled";
export type VerdictSource = "agent" | "derived";

export interface Check {
  id: string;
  title: string;
  status: CheckStatus;
  note?: string;
  /** Relative to the project repoPath. */
  screenshot?: string;
  updatedAt: string;
  /** First time the check reported "running". */
  startedAt?: string;
  /** First time the check reached a terminal status. */
  endedAt?: string;
}

/** Normalized per harness (omp `get_session_stats`, Claude `result`, Codex `turn.completed`); null `cost` when the harness reports none. */
export interface RunUsage {
  cost: number | null;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  toolCalls: number;
  model: string | null;
}

/** App binary to install on the assigned device before the run: absolute .apk (android) or .app/.ipa (ios simulator). */
export interface InstallRequest {
  path: string;
}

export interface DeviceRequest {
  serial?: string;
  platform: Platform;
}

export interface PullRequestInfo {
  number: number;
  title: string | null;
  url: string | null;
  state: string | null;
  baseBranch: string | null;
  isDraft: boolean | null;
  author: string | null;
}

export type PrStatus = "pending" | "found" | "none" | "error" | "provided";

export interface RunSource {
  /** Absolute dir git data was read from (project repoPath or one of its worktrees). */
  path: string;
  /** Null when detached / not a git repo. */
  branch: string | null;
  /** Full sha. */
  commit: string | null;
  commitSubject: string | null;
  /** Working tree has uncommitted changes. */
  dirty: boolean | null;
  /** Origin normalized to https://host/owner/repo (no .git). */
  remoteUrl: string | null;
  pr: PullRequestInfo | null;
  prStatus: PrStatus;
  /** E.g. ["ABC-123"], deduped, first-seen order. */
  tickets: string[];
  /** Free-form requester metadata (flavor, epic, build id...). */
  labels: Record<string, string>;
}

export interface BuildInfo {
  packageId: string;
  versionName: string | null;
  versionCode: string | null;
  capturedAt: string;
}

export interface Run {
  id: string;
  projectId: string;
  title: string;
  brief: string;
  requestedBy: string;
  deviceRequest: DeviceRequest;
  deviceSerial: string | null;
  /** Friendly name of the assigned device (`Device.name`), kept after the device is gone. Set at preflight. */
  deviceName: string | null;
  /** The id mobile-mcp tools must be given for the assigned device (AVD name for emulators, UDID for simulators, serial otherwise). Set at preflight for the mobile-mcp backend. */
  deviceLabel?: string | null;
  bootedByRun: boolean;
  backend: Backend;
  packageId: string;
  status: RunStatus;
  verdict: Verdict | null;
  summary: string | null;
  /** Relative to the project repoPath. */
  reportPath: string | null;
  checks: Check[];
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  stats: unknown | null;
  transcriptHtml: boolean;
  source: RunSource | null;
  build: BuildInfo | null;
  batchId: string | null;
  suiteId: string | null;
  /** Id/title pairs the agent must use in qa_plan (set from the suite). */
  suiteChecks: { id: string; title: string }[] | null;
  /** Agent CLI that runs this run; runs persisted before harnesses existed are omp. */
  harness: HarnessId;
  /** Model actually passed to the harness (harness-native string). */
  model: string | null;
  /** Reasoning level for omp (`--thinking`); other harnesses mirror it in `effort`. */
  thinking: string | null;
  /** Reasoning effort actually passed to the harness; alias of `thinking` for omp. */
  effort: string | null;
  errorKind: ErrorKind | null;
  verdictSource: VerdictSource | null;
  usage: RunUsage | null;
  attempt: number;
  /** Previous attempt's id (infra auto-retry). */
  retryOf: string | null;
  /** Next attempt's id. */
  retriedBy: string | null;
  /** Run this one was re-run from. */
  rerunOf: string | null;
  install: InstallRequest | null;
}

export interface Activity {
  ts: string;
  /** 0-based line index of the source frame in events.jsonl; cursor for pagination. */
  seq: number;
  kind: "tool" | "tool_end" | "say" | "warn" | "info" | "user" | "error" | "check";
  /** Human one-liner. */
  text: string;
  /** Tool call id; pairs `tool` with `tool_end`. */
  callId?: string;
  /** Resolved tool name (an xd:// write is attributed to the MCP tool it calls). */
  tool?: string;
  /** Tool arguments; JSON truncated to 2 KB (a string once truncated). */
  args?: unknown;
  ok?: boolean;
  durationMs?: number;
  checkId?: string;
  checkStatus?: CheckStatus;
}
