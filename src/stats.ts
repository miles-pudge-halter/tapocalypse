import type { Run } from "./runs/types";

export interface RunStats {
  days: number;
  runs: number;
  pass: number;
  fail: number;
  issues: number;
  other: number;
  /** Null when no run in the window reported a cost. */
  cost: number | null;
  medianDurationMs: number | null;
  /** One entry per local calendar day, oldest first, zero-filled. */
  byDay: { date: string; runs: number; pass: number; issues: number; fail: number; other: number; cost: number | null }[];
}

function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/**
 * Aggregates runs created within the last `days` local calendar days (today included).
 * A run superseded by an infra retry is skipped: its successor represents the attempt.
 */
export function computeStats(runs: Run[], days: number, now = new Date()): RunStats {
  const first = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
  const byDay = new Map<string, RunStats["byDay"][number]>();
  for (let i = 0; i < days; i++) {
    const date = localDate(new Date(first.getFullYear(), first.getMonth(), first.getDate() + i));
    byDay.set(date, { date, runs: 0, pass: 0, issues: 0, fail: 0, other: 0, cost: null });
  }

  const stats: RunStats = { days, runs: 0, pass: 0, fail: 0, issues: 0, other: 0, cost: null, medianDurationMs: null, byDay: [] };
  const durations: number[] = [];
  for (const run of runs) {
    if (run.retriedBy) continue;
    const created = new Date(run.createdAt);
    if (created < first) continue;
    const bucket = byDay.get(localDate(created));
    if (!bucket) continue;

    stats.runs++;
    bucket.runs++;
    if (run.verdict === "PASS") {
      stats.pass++;
      bucket.pass++;
    } else if (run.verdict === "FAIL") {
      stats.fail++;
      bucket.fail++;
    } else if (run.verdict === "PASS WITH ISSUES") {
      stats.issues++;
      bucket.issues++;
    } else {
      stats.other++;
      bucket.other++;
    }

    const cost = run.usage?.cost;
    if (typeof cost === "number") {
      stats.cost = (stats.cost ?? 0) + cost;
      bucket.cost = (bucket.cost ?? 0) + cost;
    }
    if (run.startedAt && run.endedAt) {
      const ms = Date.parse(run.endedAt) - Date.parse(run.startedAt);
      if (ms >= 0) durations.push(ms);
    }
  }
  stats.medianDurationMs = median(durations);
  stats.byDay = [...byDay.values()];
  return stats;
}
