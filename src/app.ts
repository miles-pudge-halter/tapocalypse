import path from "node:path";
import { type BatchSummary, getBatchMeta, summarizeBatch } from "./batches";
import { config } from "./config";
import { type Device, listDevices } from "./devices/devices";
import { gateway, stopOnLeaseEnd } from "./devices/gateway";
import * as leases from "./devices/leases";
import {
  bootAndroid,
  bootedCount,
  bootIos,
  isBootedByTapocalypse,
  isBootingTarget,
  manualBootCount,
  type PoolView,
  poolView,
  startIdleReaper,
} from "./devices/pool";
import { getProject, initProjects } from "./projects/registry";
import { LEGACY_REPORTS_DIR, reportLocation, runArtefactDir, runImages } from "./runs/artefacts";
import { startRetention } from "./retention";
import { createRunner } from "./runs/runner";
import { type QueueHold, Scheduler } from "./runs/scheduler";
import { runMatches } from "./runs/source";
import { getRun, listRuns } from "./runs/store";
import type { Run } from "./runs/types";

export const scheduler: Scheduler = new Scheduler({
  config,
  listDevices,
  bootedCount,
  manualBootCount,
  isBootingTarget,
  leases: {
    bus: leases.bus,
    grantRun: leases.grantRun,
    releaseRun: leases.releaseRun,
    deviceOwner: leases.deviceOwner,
    runLease: leases.runLease,
    runLeaseCount: leases.runLeaseCount,
    grantAgent: leases.grantAgent,
    claim: leases.claim,
    holdForClaim: leases.holdForClaim,
  },
  boot: (platform, target) => (platform === "android" ? bootAndroid(target) : bootIos(target)),
  startRun: (run, target) => runner.startRun(run, target),
  cancelActive: (id) => runner.cancelActive(id),
});

export const runner = createRunner(scheduler);

export async function devicesView(): Promise<Device[]> {
  return scheduler.overlay(await listDevices(), isBootedByTapocalypse);
}

/** Pool state for the Devices page: run slots, boots, idle devices and who waits for any device of a platform. */
export async function poolStateView(): Promise<PoolView> {
  await listDevices();
  return poolView(scheduler.activeCount(), scheduler.waitingView());
}

export type RunView = Run & {
  queuePosition: number | null;
  /** Elapsed time for active runs, total time for finished ones; null before the run started. */
  durationMs: number | null;
  /** Why a queued run is still waiting; null once it has a slot. */
  queueReason: string | null;
  /** The agent lease a queued run waits behind (explicit serial: its holder; "any": the lease that ends first); null otherwise. */
  queueHold: QueueHold | null;
  /** Absolute path where the run's report is stored (either storage), derived from the run record without touching the disk; null when it has none. */
  reportFile: string | null;
  /** Absolute path of the run's folder in Tapocalypse's data dir (events, and for data runs the report and screenshots). */
  runDir: string;
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
    queueHold: scheduler.queueHold(run.id),
    reportFile: reportLocation(run, getProject(run.projectId) ?? null),
    runDir: runArtefactDir(run.id),
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
  /** Same form as `Check.screenshot`: relative to the run's artefact folder (data runs) or to the project repo (legacy runs). */
  path: string;
  url: string;
  name: string;
  mtime: string;
  checkId: string | null;
}

/** Images in the run's screenshots folder plus any other image a check points at, each with the URL the UI loads it from. */
export function runScreenshots(run: Run): RunScreenshot[] {
  const project = getProject(run.projectId) ?? null;
  const segments = (p: string) => p.split("/").map(encodeURIComponent).join("/");
  const reportsDir = path.posix.normalize((project?.reportsDir ?? LEGACY_REPORTS_DIR).replace(/\\/g, "/"));
  const out: RunScreenshot[] = [];
  for (const image of runImages(run, project)) {
    let url: string;
    if (run.storage === "data") {
      url = `/api/runs/${encodeURIComponent(run.id)}/files/${segments(image.rel)}`;
    } else {
      const rest = path.posix.relative(reportsDir, image.rel);
      if (!project || !rest || rest.startsWith("..") || path.posix.isAbsolute(rest)) continue;
      url = `/files/${encodeURIComponent(project.id)}/${segments(rest)}`;
    }
    out.push({ path: image.rel, url, name: image.name, mtime: image.mtime, checkId: image.checkId });
  }
  return out;
}

export function init(): void {
  initProjects();
  leases.restore();
  stopOnLeaseEnd(leases.ends, gateway);
  // Warm the device tool list in the background so the first run (and the first agent tools/list) never waits on a cold probe.
  void gateway.tools();
  leases.setNextResolver((serial) => scheduler.nextFor(serial));
  scheduler.restore();
  startIdleReaper();
  setInterval(() => void scheduler.schedule(), 10_000);
  // Expiry, vanished devices and unclaimed grants end leases here; ending one wakes the scheduler through the lease bus.
  setInterval(() => {
    listDevices()
      .then((devices) => leases.sweep(devices))
      .catch((e: unknown) => console.error("lease sweep failed:", e));
  }, 15_000);
  void scheduler.schedule();
  startRetention((id) => scheduler.isHeld(id));
}
