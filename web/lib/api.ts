import type { Backend, Platform, Run, RunStatus, Verdict } from "../../src/runs/types";

export type {
  Activity,
  Backend,
  BuildInfo,
  Check,
  CheckStatus,
  Platform,
  PrStatus,
  PullRequestInfo,
  Run,
  RunSource,
  RunStatus,
  Verdict,
} from "../../src/runs/types";
export type { Device } from "../../src/devices/devices";
export type { DoctorCheck, DoctorReport } from "../../src/doctor";
export type { Detection, Framework } from "../../src/projects/detect";
export type { Project, ProjectInput, ProjectStatus, ValidationResult } from "../../src/projects/registry";
import type { Device } from "../../src/devices/devices";
import type { Detection } from "../../src/projects/detect";
import type { ProjectInput, ProjectStatus, ValidationResult } from "../../src/projects/registry";
import type { DoctorReport } from "../../src/doctor";

export type RunView = Run & { queuePosition: number | null };
export interface ReportEntry {
  name: string;
  title: string;
  verdict: Verdict | null;
  mtime: string;
}
export interface ReportDoc {
  name: string;
  title: string;
  verdict: Verdict | null;
  html: string;
}
/** Requester-supplied source metadata; all fields optional (see `POST /api/runs`). */
export interface StartRunSource {
  path?: string;
  prNumber?: number;
}
export interface StartRunInput {
  projectId: string;
  title: string;
  brief: string;
  device: { platform: Platform; serial?: string };
  backend: Backend;
  packageId: string;
  source?: StartRunSource;
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
  runs(params: { project?: string; status?: string; branch?: string; pr?: number; ticket?: string; commit?: string } = {}) {
    const q = new URLSearchParams();
    if (params.project) q.set("project", params.project);
    if (params.status) q.set("status", params.status);
    if (params.branch) q.set("branch", params.branch);
    if (params.pr !== undefined) q.set("pr", String(params.pr));
    if (params.ticket) q.set("ticket", params.ticket);
    if (params.commit) q.set("commit", params.commit);
    const qs = q.toString();
    return request<RunView[]>(`/api/runs${qs ? `?${qs}` : ""}`);
  },
  run: (id: string) => request<RunView>(`/api/runs/${encodeURIComponent(id)}`),
  startRun: (input: StartRunInput) => post<RunView>("/api/runs", input),
  cancel: (id: string) => post<RunView>(`/api/runs/${encodeURIComponent(id)}/cancel`),
  async steer(id: string, message: string) {
    await post(`/api/runs/${encodeURIComponent(id)}/steer`, { message });
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
