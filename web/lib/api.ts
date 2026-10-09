import type { Activity, Backend, Platform, Run, RunStatus, Verdict } from "../../src/runs/types";

export type {
  Activity,
  Backend,
  BuildInfo,
  Check,
  CheckStatus,
  ErrorKind,
  InstallRequest,
  Platform,
  PrStatus,
  PullRequestInfo,
  Run,
  RunSource,
  RunStatus,
  RunUsage,
  Verdict,
  VerdictSource,
} from "../../src/runs/types";
export type { Device } from "../../src/devices/devices";
export type { DoctorCheck, DoctorReport } from "../../src/doctor";
export type { Detection, Framework } from "../../src/projects/detect";
export type { Project, ProjectInput, ProjectStatus, ValidationResult } from "../../src/projects/registry";
import type { Device } from "../../src/devices/devices";
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

export type RunView = Run & {
  queuePosition: number | null;
  durationMs: number | null;
  queueReason: string | null;
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
}

export interface ReportEntry {
  name: string;
  title: string;
  verdict: Verdict | null;
  mtime: string;
  runId: string | null;
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
  backend: Backend;
  packageId: string;
  source?: StartRunSource;
  model?: string;
  harness?: HarnessId;
  thinking?: string;
  suiteId?: string;
  install?: { path: string };
}
export interface StartBatchInput {
  projectId: string;
  title?: string;
  brief?: string;
  suiteId?: string;
  devices: DeviceTarget[];
  backend?: Backend;
  packageId?: string;
  model?: string;
  harness?: HarnessId;
  thinking?: string;
  source?: StartRunSource;
  requestedBy?: string;
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
  limit?: number;
  /** `createdAt` cursor: only runs created before it. */
  before?: string;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function ensureOk(res: Response): Promise<void> {
  if (res.ok) return;
  const body: unknown = await res.json().catch(() => null);
  const message =
    body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : `${res.status} ${res.statusText}`;
  throw new ApiError(res.status, message);
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
    if (params.limit !== undefined) q.set("limit", String(params.limit));
    if (params.before) q.set("before", params.before);
    const qs = q.toString();
    return request<{ runs: RunView[]; hasMore: boolean }>(`/api/runs${qs ? `?${qs}` : ""}`);
  },
  run: (id: string) => request<RunView>(`/api/runs/${encodeURIComponent(id)}`),
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

/** `repoRelPath` is relative to the project repo (`<reportsDir>/...`); the file route is rooted at reportsDir. */
export function screenshotUrl(projectId: string, repoRelPath: string): string {
  const rest = repoRelPath.split("/").filter(Boolean).slice(1).map(encodeURIComponent).join("/");
  return `/files/${encodeURIComponent(projectId)}/${rest}`;
}

export function transcriptUrl(runId: string): string {
  return `/api/runs/${encodeURIComponent(runId)}/transcript`;
}

export function reportHash(projectId: string, reportPath: string): string {
  const base = reportPath.split("/").pop() ?? reportPath;
  return `#/p/${encodeURIComponent(projectId)}/reports/${encodeURIComponent(base)}`;
}

export function runHash(id: string, checkId?: string): string {
  return `#/runs/${encodeURIComponent(id)}${checkId ? `?check=${encodeURIComponent(checkId)}` : ""}`;
}

export function batchHash(id: string): string {
  return `#/batches/${encodeURIComponent(id)}`;
}
