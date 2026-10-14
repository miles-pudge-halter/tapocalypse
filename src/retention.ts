import { pruneBatchMeta } from "./batches";
import { config } from "./config";
import { hubRetention, isHub } from "./hub/mode";
import { deleteRun, listRuns } from "./runs/store";
import { ACTIVE, type Run } from "./runs/types";

export interface RetentionPolicy {
  days?: number;
  maxRuns?: number;
}

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

/** The policy in force: the hub's (`TAPOCALYPSE_HUB_RETENTION_*`, a year by default) on a hub, `config.retention` on a laptop. */
export function retentionPolicy(): RetentionPolicy {
  return isHub() ? hubRetention() : config.retention;
}

/**
 * Ids of runs the policy removes: terminal runs older than `days` (by end time), plus terminal runs beyond the newest `maxRuns`
 * (active runs occupy slots in that ranking but are never selected). An empty policy selects nothing. Runs of a batch that
 * still has an active run are kept, so the batch's verdict and cost rollup do not shrink while it runs.
 */
export function selectExpiredRuns(runs: readonly Run[], policy: RetentionPolicy, now: number): string[] {
  const expired = new Set<string>();
  const activeBatches = new Set(runs.filter((r) => r.batchId && ACTIVE.includes(r.status)).map((r) => r.batchId));
  const newestFirst = [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  newestFirst.forEach((run, index) => {
    if (ACTIVE.includes(run.status)) return;
    if (run.batchId && activeBatches.has(run.batchId)) return;
    if (policy.maxRuns !== undefined && index >= policy.maxRuns) expired.add(run.id);
    if (policy.days !== undefined) {
      const at = Date.parse(run.endedAt ?? run.createdAt);
      if (Number.isFinite(at) && now - at > policy.days * 86_400_000) expired.add(run.id);
    }
  });
  return [...expired];
}

/**
 * Deletes expired run directories under the data dir, including each data-stored run's report and screenshots (`report.md`,
 * `screenshots/`); legacy reports in repos are never touched. `isHeld` marks runs whose
 * runner is still winding down (e.g. cancelled mid-preflight): they are skipped. Returns the deleted ids.
 */
export function applyRetention(opts: { now?: number; policy?: RetentionPolicy; isHeld?: (id: string) => boolean } = {}): string[] {
  const policy = opts.policy ?? retentionPolicy();
  if (policy.days === undefined && policy.maxRuns === undefined) return [];
  const runs = listRuns();
  const ids = selectExpiredRuns(runs, policy, opts.now ?? Date.now()).filter((id) => !opts.isHeld?.(id));
  for (const id of ids) deleteRun(id);
  for (const batchId of new Set(runs.filter((r) => ids.includes(r.id)).map((r) => r.batchId))) {
    if (batchId) pruneBatchMeta(batchId);
  }
  if (ids.length > 0) console.log(`retention: deleted ${ids.length} old run(s)`);
  return ids;
}

/** Applies the retention policy now and every 6 hours. */
export function startRetention(isHeld: (id: string) => boolean): void {
  applyRetention({ isHeld });
  setInterval(() => applyRetention({ isHeld }), SIX_HOURS_MS).unref();
}
