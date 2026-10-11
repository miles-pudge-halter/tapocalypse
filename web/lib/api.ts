import type { Activity, CheckStatus, KeyKind, Platform, Run, RunStatus, Verdict } from "../../src/runs/types";

export type {
  Activity,
  BuildInfo,
  Check,
  CheckStatus,
  ErrorKind,
  InstallRequest,
  Platform,
  PrStatus,
  PullRequestInfo,
  KeyKind,
  Run,
  RunSource,
  RunStatus,
  RunUsage,
  Verdict,
  VerdictSource,
} from "../../src/runs/types";
export type { Device, DeviceWaiter } from "../../src/devices/devices";
export type { LeaseEvent, LeaseView } from "../../src/devices/leases";
export type { DoctorCheck, DoctorReport } from "../../src/doctor";
export type { Detection, Framework } from "../../src/projects/detect";
export type { Project, ProjectInput, ProjectStatus, ValidationResult } from "../../src/projects/registry";
import type { Device } from "../../src/devices/devices";
import type { LeaseView } from "../../src/devices/leases";
import type { Detection, Framework } from "../../src/projects/detect";
import type { ProjectInput, ProjectStatus, ValidationResult } from "../../src/projects/registry";
import type { DoctorReport } from "../../src/doctor";
import type { HarnessCapabilities, HarnessId } from "../../src/harness/types";

export type { HarnessCapabilities, HarnessId };

/** `GET /api/harnesses` entry: one supported agent CLI, whether it is installed, and what it can do. */
export interface HarnessInfo {
  id: HarnessId;
  label: string;
  installed: boolean;
  capabilities: HarnessCapabilities;
}

export interface HarnessList {
  /** The harness a run uses when the request names none. */
  default: HarnessId;
  harnesses: HarnessInfo[];
}

/** A queued run's wait on an agent lease (`RunView.queueHold`). */
export interface QueueHold {
  serial: string;
  deviceName: string;
  holder: string;
  reason: string | null;
  expiresAt: string;
}

export type RunView = Run & {
  queuePosition: number | null;
  durationMs: number | null;
  queueReason: string | null;
  /** Set while a queued run waits for a device an agent holds (for "any": the lease that ends first). */
  queueHold?: QueueHold | null;
  /** Absolute path of the report on disk (both storages); null when the run has none. */
  reportFile: string | null;
  /** Absolute artefact folder of the run in Tapocalypse's data dir (report + screenshots). */
  runDir: string;
  /** Auto-baseline comparison summary; terminal runs only, null when there is no baseline or no checks. */
  regression?: RunRegression | null;
};

export interface BatchView {
  id: string;
  projectId: string;
  title: string;
  runs: RunView[];
  status: "active" | "done";
  /** Worst verdict across runs (FAIL > BLOCKED > PARTIAL > PASS WITH ISSUES > PASS); null while any run has none. */
  verdict: Verdict | null;
  cost: number | null;
  startedAt: string | null;
  endedAt: string | null;
}

export interface RunStats {
  days: number;
  runs: number;
  pass: number;
  fail: number;
  issues: number;
  other: number;
  cost: number | null;
  medianDurationMs: number | null;
  byDay: { date: string; runs: number; pass: number; fail: number; cost: number | null }[];
}

// --- regression intelligence (mirrors src/regression/types.ts; `RunView` here is the wire type) ---

export type Transition =
  | "newly_failing"
  | "fixed"
  | "flaky"
  | "still_failing"
  | "unchanged"
  | "changed"
  | "new"
  | "removed"
  | "pending";
export type BaselineTier = "explicit" | "pr-base" | "default-branch" | "same-branch" | "any";

export interface Baseline {
  auto: boolean;
  tier: BaselineTier;
  kind: "run" | "snapshot";
  primaryRunId: string;
  /** Primary first. */
  runIds: string[];
  branch: string | null;
  commit: string | null;
  reason: string;
  platformMismatch: boolean;
  deviceChanged: boolean;
  harnessChanged: boolean;
  modelChanged: boolean;
  buildChanged: boolean;
  sameCommit: boolean;
}

export interface CompareSide {
  runId: string;
  checkId: string;
  title: string;
  status: CheckStatus;
  note: string | null;
  screenshotUrl: string | null;
  durationMs: number | null;
  createdAt: string;
}

export interface ComparePair {
  /** Stable row id: the current check id, or `b:<baselineRunId>:<checkId>` for removed rows. */
  key: string;
  checkKey: string | null;
  transition: Transition;
  match: KeyKind | null;
  confidence: "exact" | "inferred" | null;
  flaky: boolean;
  lostCoverage: boolean;
  notReached: boolean;
  baseline: CompareSide | null;
  current: CompareSide | null;
  suggestion: { runId: string; checkId: string; title: string; similarity: number } | null;
}

export interface RunComparison {
  current: RunView;
  baselineRun: RunView;
  baseline: Baseline;
  verdict: { baseline: Verdict | null; current: Verdict | null; direction: "better" | "worse" | "same" | "unknown" };
  counts: Record<Transition, number>;
  durationMs: { baseline: number | null; current: number | null; delta: number | null };
  cost: { baseline: number | null; current: number | null; delta: number | null; comparable: boolean };
  pairs: ComparePair[];
}

export type CompareReason = "no_baseline" | "no_checks" | "different_project" | "same_run";

/** `GET /api/runs/:id/compare`. */
export interface CompareResponse {
  comparison: RunComparison | null;
  reason: CompareReason | null;
  reasonText: string | null;
}

export interface BaselineCandidate {
  run: RunView;
  suggested: boolean;
  group: "suggested" | "branch" | "base" | "test" | "other";
  platformMismatch: boolean;
  reason: string | null;
}

export interface CheckHistoryEntry {
  runId: string;
  runTitle: string;
  checkId: string;
  title: string;
  status: CheckStatus;
  note: string | null;
  screenshotUrl: string | null;
  createdAt: string;
  platform: Platform;
  deviceName: string | null;
  commit: string | null;
  dirty: boolean | null;
  branch: string | null;
  build: string | null;
  harness: HarnessId;
  model: string | null;
  verdict: Verdict | null;
  keyKind: KeyKind | null;
  flip: boolean;
  flippedOnSameCode: boolean;
}

export interface CheckHistory {
  projectId: string;
  checkKey: string;
  keyKind: KeyKind;
  title: string;
  flaky: "flaky" | "suspect" | null;
  deviceSensitive: boolean;
  unstable: boolean;
  flips: number;
  window: number;
  passRate: number | null;
  /** Newest first. */
  entries: CheckHistoryEntry[];
  hasMore: boolean;
}

export interface FlakyCheck {
  checkKey: string;
  keyKind: KeyKind;
  title: string;
  confidence: "flaky" | "suspect";
  flips: number;
  window: number;
  passRate: number | null;
  /** Oldest → newest. */
  recent: (CheckStatus | null)[];
  lastFlipAt: string;
  lastFlipBranch: string | null;
}

export interface FlakyResponse {
  checks: FlakyCheck[];
  trackedKeys: number;
  repeatedKeys: number;
}

export interface RunRegression {
  baselineId: string;
  baselineTitle: string;
  baselineBranch: string | null;
  baselineCreatedAt: string;
  newlyFailing: number;
  fixed: number;
  flaky: number;
}

export interface CheckRef {
  runId: string;
  checkId: string;
}

export interface HistoryQuery {
  limit?: number;
  before?: string;
  branch?: string;
  platform?: Platform;
}

export interface RunScreenshot {
  path: string;
  url: string;
  name: string;
  mtime: string;
  checkId: string | null;
}

export interface Template {
  id: string;
  title: string;
  description: string;
  brief: string;
}

export interface SuiteCheck {
  id: string;
  title: string;
}
export interface Suite {
  id: string;
  title: string;
  brief: string;
  checks?: SuiteCheck[];
  platforms?: Platform[];
  model?: string;
}
export interface SaveSuiteInput extends Suite {
  overwrite?: boolean;
}

export interface McpStatus {
  url: string;
  lastCallAt: string | null;
  lastTool: string | null;
  lastRequester: string | null;
}

export interface ProjectSuggestion {
  path: string;
  name: string;
  framework: Framework;
  alreadyAdded: boolean;
}

export interface BootableDevice {
  platform: Platform;
  target: string;
  name: string;
}
export interface PoolView {
  maxConcurrentRuns: number;
  activeRuns: number;
  maxBooted: number;
  bootedCount: number;
  bootable: BootableDevice[];
  idle: { serial: string; shutdownAt: string }[];
  /** Agents and queued runs waiting for "any <platform>" (nothing free); absent on an older server. */
  waiting?: { platform: Platform; holders: string[]; runIds: string[] }[];
}

export interface ReportEntry {
  name: string;
  title: string;
  verdict: Verdict | null;
  mtime: string;
  runId: string | null;
  /** Absolute path of the markdown file on disk. */
  path: string;
}
export interface ReportHeading {
  level: 2 | 3;
  id: string;
  text: string;
}
export interface ReportImage {
  src: string;
  alt: string;
}
export interface ReportDoc {
  name: string;
  title: string;
  verdict: Verdict | null;
  html: string;
  runId: string | null;
  headings: ReportHeading[];
  images: ReportImage[];
}

/** Requester-supplied source metadata; all fields optional (see `POST /api/runs`). */
export interface StartRunSource {
  path?: string;
  prNumber?: number;
}
export interface DeviceTarget {
  platform: Platform;
  serial?: string;
}
export interface StartRunInput {
  projectId: string;
  /** Optional when `suiteId` is set (defaults to the suite title). */
  title?: string;
  /** Optional when `suiteId` is set (the suite body becomes the brief). */
  brief?: string;
  device: DeviceTarget;
  packageId: string;
  source?: StartRunSource;
  model?: string;
  harness?: HarnessId;
  thinking?: string;
  /** false = the agent writes a fresh plan instead of getting the previous checks of this test as hints (default true). */
  reuseChecks?: boolean;
  suiteId?: string;
  install?: { path: string };
}
export interface StartBatchInput {
  projectId: string;
  title?: string;
  brief?: string;
  suiteId?: string;
  devices: DeviceTarget[];
  packageId?: string;
  model?: string;
  harness?: HarnessId;
  thinking?: string;
  source?: StartRunSource;
  requestedBy?: string;
  /** false = fresh test plan instead of the previous checks as hints (default true). */
  reuseChecks?: boolean;
}

export interface RunListParams {
  project?: string;
  status?: RunStatus[];
  verdict?: Verdict[];
  q?: string;
  batch?: string;
  branch?: string;
  pr?: number;
  ticket?: string;
  commit?: string;
  /** Only runs with newly failing checks against their baseline. */
  regressed?: boolean;
  limit?: number;
  /** `createdAt` cursor: only runs created before it. */
  before?: string;
}

export class ApiError extends Error {
  status: number;
  /** The server's machine-readable `code` (e.g. `held_by_run`), when the error body carries one. */
  code: string | null;
  /** The lease the server reports as current when a release was refused. */
  lease: LeaseView | null;
  constructor(status: number, message: string, extra: { code?: string | null; lease?: LeaseView | null } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = extra.code ?? null;
    this.lease = extra.lease ?? null;
  }
}

function isLeaseView(value: unknown): value is LeaseView {
  return (
    typeof value === "object" &&
    value !== null &&
    "ref" in value &&
    typeof value.ref === "string" &&
    "holder" in value &&
    typeof value.holder === "string"
  );
}

async function ensureOk(res: Response): Promise<void> {
  if (res.ok) return;
  const body: unknown = await res.json().catch(() => null);
  const record = body && typeof body === "object" ? body : null;
  const message = record && "error" in record && typeof record.error === "string" ? record.error : `${res.status} ${res.statusText}`;
  const code = record && "code" in record && typeof record.code === "string" ? record.code : null;
  const lease = record && "lease" in record && isLeaseView(record.lease) ? record.lease : null;
  throw new ApiError(res.status, message, { code, lease });
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  await ensureOk(res);
  return (await res.json()) as T;
}

function post<T>(path: string, body?: unknown): Promise<T> {
  if (body === undefined) return request<T>(path, { method: "POST" });
  return request<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function parseCompareReason(body: unknown): CompareResponse | null {
  if (!body || typeof body !== "object" || !("reason" in body)) return null;
  const { reason } = body;
  if (reason !== "same_run" && reason !== "different_project") return null;
  const reasonText = "reasonText" in body && typeof body.reasonText === "string" ? body.reasonText : null;
  return { comparison: null, reason, reasonText };
}

function historyQuery(query: HistoryQuery): string {
  const q = new URLSearchParams();
  if (query.limit !== undefined) q.set("limit", String(query.limit));
  if (query.before) q.set("before", query.before);
  if (query.branch) q.set("branch", query.branch);
  if (query.platform) q.set("platform", query.platform);
  const qs = q.toString();
  return qs ? `?${qs}` : "";
}

async function sendCheckLink(method: "POST" | "DELETE", projectId: string, a: CheckRef, b: CheckRef): Promise<void> {
  await ensureOk(
    await fetch("/api/check-links", {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId, a, b }),
    }),
  );
}

export const api = {
  projects: () => request<ProjectStatus[]>("/api/projects"),
  createProject: (input: ProjectInput) => post<ProjectStatus>("/api/projects", input),
  updateProject: (id: string, patch: Partial<ProjectInput>) =>
    request<ProjectStatus>(`/api/projects/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }),
  async deleteProject(id: string) {
    await ensureOk(await fetch(`/api/projects/${encodeURIComponent(id)}`, { method: "DELETE" }));
  },
  validateProject: (input: Partial<ProjectInput>, mode: "create" | "update", existingId?: string) =>
    post<ValidationResult>("/api/projects/validate", { input, mode, existingId }),
  detectProject: (repoPath: string) => post<Detection>("/api/projects/detect", { repoPath }),
  devices: () => request<Device[]>("/api/devices"),
  doctor: (fresh = false) => request<DoctorReport>(`/api/doctor${fresh ? "?fresh=1" : ""}`),
  async runs(params: RunListParams = {}) {
    const q = new URLSearchParams();
    if (params.project) q.set("project", params.project);
    if (params.status?.length) q.set("status", params.status.join(","));
    if (params.verdict?.length) q.set("verdict", params.verdict.join(","));
    if (params.q) q.set("q", params.q);
    if (params.batch) q.set("batch", params.batch);
    if (params.branch) q.set("branch", params.branch);
    if (params.pr !== undefined) q.set("pr", String(params.pr));
    if (params.ticket) q.set("ticket", params.ticket);
    if (params.commit) q.set("commit", params.commit);
    if (params.regressed) q.set("regressed", "1");
    if (params.limit !== undefined) q.set("limit", String(params.limit));
    if (params.before) q.set("before", params.before);
    const qs = q.toString();
    return request<{ runs: RunView[]; hasMore: boolean }>(`/api/runs${qs ? `?${qs}` : ""}`);
  },
  run: (id: string) => request<RunView>(`/api/runs/${encodeURIComponent(id)}`),
  /** `baseline` = a run id, or "auto". 400 `same_run` / `different_project` bodies still carry the reason. */
  async compare(id: string, baseline: string = "auto"): Promise<CompareResponse> {
    const res = await fetch(`/api/runs/${encodeURIComponent(id)}/compare?baseline=${encodeURIComponent(baseline)}`);
    if (res.status === 400) {
      const body: unknown = await res.clone().json().catch(() => null);
      const parsed = parseCompareReason(body);
      if (parsed) return parsed;
    }
    await ensureOk(res);
    return (await res.json()) as CompareResponse;
  },
  baselineCandidates: (id: string, q: string) =>
    request<{ candidates: BaselineCandidate[] }>(
      `/api/runs/${encodeURIComponent(id)}/baseline-candidates${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ""}`,
    ),
  projectCheckHistory: (projectId: string, checkKey: string, query: HistoryQuery = {}) =>
    request<CheckHistory>(
      `/api/projects/${encodeURIComponent(projectId)}/checks/${encodeURIComponent(checkKey)}/history${historyQuery(query)}`,
    ),
  runCheckHistory: (runId: string, checkId: string, query: HistoryQuery = {}) =>
    request<CheckHistory>(
      `/api/runs/${encodeURIComponent(runId)}/checks/${encodeURIComponent(checkId)}/history${historyQuery(query)}`,
    ),
  flakyChecks: (projectId: string, platform?: Platform) =>
    request<FlakyResponse>(`/api/projects/${encodeURIComponent(projectId)}/flaky${platform ? `?platform=${platform}` : ""}`),
  /** Ties check `b` (newer) to check `a` (older): same check from now on. */
  async linkChecks(projectId: string, a: CheckRef, b: CheckRef) {
    await sendCheckLink("POST", projectId, a, b);
  },
  async unlinkChecks(projectId: string, a: CheckRef, b: CheckRef) {
    await sendCheckLink("DELETE", projectId, a, b);
  },
  startRun: (input: StartRunInput) => post<RunView>("/api/runs", input),
  startBatch: (input: StartBatchInput) => post<{ batchId: string; runs: RunView[] }>("/api/batches", input),
  batch: (id: string) => request<BatchView>(`/api/batches/${encodeURIComponent(id)}`),
  rerun: (id: string, only: "failed" | "all", device?: DeviceTarget) =>
    post<RunView>(`/api/runs/${encodeURIComponent(id)}/rerun`, { only, device }),
  async deleteRun(id: string) {
    await ensureOk(await fetch(`/api/runs/${encodeURIComponent(id)}`, { method: "DELETE" }));
  },
  cancel: (id: string) => post<RunView>(`/api/runs/${encodeURIComponent(id)}/cancel`),
  async steer(id: string, message: string) {
    await post(`/api/runs/${encodeURIComponent(id)}/steer`, { message });
  },
  activity(id: string, before: number | null, limit: number) {
    const q = new URLSearchParams({ limit: String(limit) });
    if (before !== null) q.set("before", String(before));
    return request<{ items: Activity[]; hasMore: boolean }>(`/api/runs/${encodeURIComponent(id)}/activity?${q}`);
  },
  async stderr(id: string, tail = 200) {
    const res = await fetch(`/api/runs/${encodeURIComponent(id)}/stderr?tail=${tail}`);
    await ensureOk(res);
    return res.text();
  },
  screenshots: (id: string) => request<RunScreenshot[]>(`/api/runs/${encodeURIComponent(id)}/screenshots`),
  stats(project?: string | null, days = 7) {
    const q = new URLSearchParams({ days: String(days) });
    if (project) q.set("project", project);
    return request<RunStats>(`/api/stats?${q}`);
  },
  async models(harness?: HarnessId) {
    const q = harness ? `?harness=${encodeURIComponent(harness)}` : "";
    return (await request<{ models: string[] }>(`/api/models${q}`)).models;
  },
  harnesses: () => request<HarnessList>("/api/harnesses"),
  templates: () => request<Template[]>("/api/templates"),
  suites: (projectId: string) => request<Suite[]>(`/api/projects/${encodeURIComponent(projectId)}/suites`),
  saveSuite: (projectId: string, input: SaveSuiteInput) =>
    post<Suite>(`/api/projects/${encodeURIComponent(projectId)}/suites`, input),
  mcpStatus: () => request<McpStatus>("/api/mcp/status"),
  projectSuggestions: () => request<ProjectSuggestion[]>("/api/projects/suggestions"),
  pool: () => request<PoolView>("/api/devices/pool"),
  async bootDevice(platform: Platform, target: string) {
    await post("/api/devices/boot", { platform, target });
  },
  async shutdownDevice(serial: string) {
    await ensureOk(await fetch(`/api/devices/${encodeURIComponent(serial)}/shutdown`, { method: "POST" }));
  },
  leases: () => request<LeaseView[]>("/api/leases"),
  /** UI force release; `ref` is the lease's public handle, so a lease that changed hands is never released by mistake. */
  async releaseDevice(serial: string, ref: string) {
    await ensureOk(
      await fetch(`/api/devices/${encodeURIComponent(serial)}/release`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ref }),
      }),
    );
  },
  reports: (projectId: string) => request<ReportEntry[]>(`/api/projects/${encodeURIComponent(projectId)}/reports`),
  report: (projectId: string, name: string) =>
    request<ReportDoc>(`/api/projects/${encodeURIComponent(projectId)}/reports/${encodeURIComponent(name)}`),
};

export const ACTIVE_STATUSES: RunStatus[] = ["queued", "preflight", "running", "finishing"];

export function isActive(status: RunStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

export function screenUrl(serial: string, tick: number): string {
  return `/api/devices/${encodeURIComponent(serial)}/screen.png?t=${tick}`;
}

/** The run fields that decide where its artefacts live (`storage`) and how they are addressed. */
export type ArtefactRun = Pick<Run, "id" | "projectId" | "storage">;

/**
 * Image URL for a check screenshot. Data runs (`storage: "data"`) keep `rel` (`screenshots/<name>`) relative to their
 * artefact folder in Tapocalypse's data dir; legacy runs hold a repo-relative path whose first segment is the project's
 * reports dir, which the legacy file route is rooted at.
 */
export function screenshotUrl(run: ArtefactRun, rel: string): string {
  const segments = rel.split("/").filter(Boolean);
  if (run.storage === "data") {
    return `/api/runs/${encodeURIComponent(run.id)}/files/${segments.map(encodeURIComponent).join("/")}`;
  }
  return `/files/${encodeURIComponent(run.projectId)}/${segments.slice(1).map(encodeURIComponent).join("/")}`;
}

export function transcriptUrl(runId: string): string {
  return `/api/runs/${encodeURIComponent(runId)}/transcript`;
}

/** Hash route of a report by the name the server lists it under (a run id for data runs, a file name for legacy ones). */
export function reportEntryHash(projectId: string, name: string): string {
  return `#/p/${encodeURIComponent(projectId)}/reports/${encodeURIComponent(name)}`;
}

/** Hash route of a run's report: data runs are keyed by run id, legacy runs by the report file's basename. */
export function reportHash(projectId: string, run: Pick<Run, "id" | "storage" | "reportPath">): string {
  const name = run.storage === "data" ? run.id : (run.reportPath?.split("/").pop() ?? run.id);
  return reportEntryHash(projectId, name);
}

export function runHash(id: string, checkId?: string, baseline?: string): string {
  const q = new URLSearchParams();
  if (checkId) q.set("check", checkId);
  if (baseline) q.set("baseline", baseline);
  const qs = q.toString();
  return `#/runs/${encodeURIComponent(id)}${qs ? `?${qs}` : ""}`;
}

/** Hash route of the comparison of run `id` against `baselineId`; `show` filters one transition, `pair` selects a row. */
export function compareHash(id: string, baselineId: string, opts: { show?: Transition; pair?: string } = {}): string {
  const q = new URLSearchParams();
  if (opts.show) q.set("show", opts.show);
  if (opts.pair) q.set("pair", opts.pair);
  const qs = q.toString();
  return `#/runs/${encodeURIComponent(id)}/compare/${encodeURIComponent(baselineId)}${qs ? `?${qs}` : ""}`;
}

export function flakyHash(projectId: string): string {
  return `#/p/${encodeURIComponent(projectId)}/flaky`;
}

export function batchHash(id: string): string {
  return `#/batches/${encodeURIComponent(id)}`;
}
