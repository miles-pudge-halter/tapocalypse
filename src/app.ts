import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { type BatchSummary, getBatchMeta, summarizeBatch } from "./batches";
import { config } from "./config";
import { type Device, listDevices } from "./devices/devices";
import {
  bootedCount,
  isBootedByTapocalypse,
  isBootingSerial,
  isBootingTarget,
  manualBootCount,
  markAssigned,
  markReleased,
  startIdleReaper,
} from "./devices/pool";
import { getProject, initProjects } from "./projects/registry";
import { reportFilePath } from "./reports/reports";
import { startRetention } from "./retention";
import { createRunner } from "./runs/runner";
import { Scheduler } from "./runs/scheduler";
import { runMatches } from "./runs/source";
import { getRun, listRuns } from "./runs/store";
import type { Run } from "./runs/types";

export const scheduler: Scheduler = new Scheduler({
  config,
  listDevices,
  bootedCount,
  manualBootCount,
  isBootingSerial,
  isBootingTarget,
  markAssigned,
  markReleased,
  startRun: (run, target) => runner.startRun(run, target),
  cancelActive: (id) => runner.cancelActive(id),
});

export const runner = createRunner(scheduler);

export async function devicesView(): Promise<Device[]> {
  return scheduler.overlay(await listDevices(), isBootedByTapocalypse);
}

export type RunView = Run & {
  queuePosition: number | null;
  /** Elapsed time for active runs, total time for finished ones; null before the run started. */
  durationMs: number | null;
  /** Why a queued run is still waiting; null once it has a slot. */
  queueReason: string | null;
};

export function runDurationMs(run: Run): number | null {
  if (!run.startedAt) return null;
  const end = run.endedAt ? Date.parse(run.endedAt) : Date.now();
  return Math.max(0, end - Date.parse(run.startedAt));
}

export function runView(run: Run): RunView {
  return {
    ...run,
    queuePosition: scheduler.queuePosition(run.id),
    durationMs: runDurationMs(run),
    queueReason: scheduler.queueReason(run.id),
  };
}

export function findRun(id: string): Run | null {
  return scheduler.getLive(id) ?? getRun(id);
}

export interface RunQuery {
  project?: string;
  status?: string[];
  /** Verdict names; `none` matches runs without a verdict. */
  verdict?: string[];
  q?: string;
  batch?: string;
  branch?: string;
  pr?: number;
  ticket?: string;
  commit?: string;
  limit?: number;
  /** `createdAt` of the last run of the previous page. */
  before?: string;
}

const DEFAULT_RUN_LIMIT = 100;
const MAX_RUN_LIMIT = 500;

function matchesText(run: Run, q: string): boolean {
  const pr = run.source?.pr;
  const haystack = [
    run.id,
    run.title,
    run.requestedBy,
    run.deviceSerial,
    run.deviceName,
    run.source?.branch,
    run.source?.commit,
    pr ? `#${pr.number}` : null,
    pr?.title,
    ...(run.source?.tickets ?? []),
  ];
  return haystack.some((h) => h?.toLowerCase().includes(q));
}

/** Newest-first page of runs matching every given filter; live scheduler state wins over the persisted copy. */
export function queryRuns(query: RunQuery): { runs: RunView[]; hasMore: boolean } {
  const limit = Math.min(MAX_RUN_LIMIT, Math.max(1, query.limit ?? DEFAULT_RUN_LIMIT));
  const q = query.q?.trim().toLowerCase();
  const source = { branch: query.branch, pr: query.pr, ticket: query.ticket, commit: query.commit };
  const bySource = Object.values(source).some((v) => v !== undefined);
  const matched: Run[] = [];
  let hasMore = false;
  for (const stored of listRuns({ projectId: query.project })) {
    if (query.before && stored.createdAt >= query.before) continue;
    const run = scheduler.getLive(stored.id) ?? stored;
    if (query.status?.length && !query.status.includes(run.status)) continue;
    if (query.verdict?.length && !query.verdict.includes(run.verdict ?? "none")) continue;
    if (query.batch && run.batchId !== query.batch) continue;
    if (bySource && !runMatches(run, source)) continue;
    if (q && !matchesText(run, q)) continue;
    if (matched.length === limit) {
      hasMore = true;
      break;
    }
    matched.push(run);
  }
  return { runs: matched.map(runView), hasMore };
}

export interface BatchView extends BatchSummary {
  id: string;
  projectId: string;
  title: string;
  runs: RunView[];
}

/** Null when no run (and no metadata) carries this batch id. */
export function batchView(id: string): BatchView | null {
  const runs = listRuns()
    .filter((r) => r.batchId === id)
    .map((r) => scheduler.getLive(r.id) ?? r)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const meta = getBatchMeta(id);
  const first = runs[0];
  if (!first) return null;
  return {
    id,
    projectId: meta?.projectId ?? first.projectId,
    title: meta?.title ?? first.title,
    runs: runs.map(runView),
    ...summarizeBatch(runs),
  };
}

export interface RunScreenshot {
  /** Relative to the project repo (same form as `Check.screenshot`). */
  path: string;
  url: string;
  name: string;
  mtime: string;
  checkId: string | null;
}

const posix = (p: string) => path.posix.normalize(p.replace(/\\/g, "/")).replace(/^\.\//, "");

/** Files in `<reportsDir>/screenshots/<runId>/` plus any other report-folder image a check points at. */
export function runScreenshots(run: Run): RunScreenshot[] {
  const project = getProject(run.projectId);
  if (!project) return [];
  const reportsDir = posix(project.reportsDir);
  const candidates = new Set<string>();
  try {
    for (const file of readdirSync(path.join(project.repoPath, project.reportsDir, "screenshots", run.id), { recursive: true })) {
      candidates.add(posix(path.posix.join(reportsDir, "screenshots", run.id, String(file))));
    }
  } catch {
    // no screenshots directory yet
  }
  const checkByPath = new Map<string, string>();
  for (const c of run.checks) {
    if (!c.screenshot) continue;
    const rel = posix(c.screenshot);
    candidates.add(rel);
    if (!checkByPath.has(rel)) checkByPath.set(rel, c.id);
  }

  const out: RunScreenshot[] = [];
  for (const rel of candidates) {
    const rest = path.posix.relative(reportsDir, rel);
    if (!rest || rest.startsWith("..") || path.posix.isAbsolute(rest)) continue;
    const abs = reportFilePath(project, rest);
    if (!abs) continue;
    out.push({
      path: rel,
      url: `/files/${encodeURIComponent(project.id)}/${rest.split("/").map(encodeURIComponent).join("/")}`,
      name: path.posix.basename(rel),
      mtime: statSync(abs).mtime.toISOString(),
      checkId: checkByPath.get(rel) ?? null,
    });
  }
  return out.sort((a, b) => a.mtime.localeCompare(b.mtime) || a.name.localeCompare(b.name));
}

export function init(): void {
  initProjects();
  scheduler.restore();
  startIdleReaper();
  setInterval(() => void scheduler.schedule(), 10_000);
  void scheduler.schedule();
  startRetention((id) => scheduler.isHeld(id));
}
