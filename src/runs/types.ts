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

export interface Check {
  id: string;
  title: string;
  status: CheckStatus;
  note?: string;
  /** Relative to the project repoPath. */
  screenshot?: string;
  updatedAt: string;
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
}

export interface Activity {
  ts: string;
  kind: "tool" | "say" | "warn" | "info" | "user" | "error";
  text: string;
}
