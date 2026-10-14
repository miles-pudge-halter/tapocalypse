import type { Run } from "../runs/types";
import { LIVE_EXPIRE_MS } from "./protocol";

/**
 * Runs still in progress on a laptop, kept in memory only: they never enter the run store, so regressions, stats, the overview,
 * releases and retention never see them. Keyed by run id; a hub restart empties the map and the next update restores it.
 */
const live = new Map<string, Run>();

/** Far above what one laptop runs at once (a batch is at most 8 devices): beyond it a token is flooding the hub's memory. */
export const LIVE_MAX_PER_MACHINE = 32;
/** Bounds the map at about 128 MB even with every entry at `LIVE_MAX_BYTES`. */
export const LIVE_MAX_TOTAL = 512;

/** Whether `machine` may send live progress for `id`: a known id always may; a new one only below both limits. */
export function liveRoomFor(machine: string, id: string): boolean {
  if (live.has(id)) return true;
  if (live.size >= LIVE_MAX_TOTAL) return false;
  let mine = 0;
  for (const run of live.values()) if (run.hub?.machine === machine) mine++;
  return mine < LIVE_MAX_PER_MACHINE;
}

export function putLiveRun(run: Run): void {
  live.set(run.id, run);
}

export function getLiveRun(id: string): Run | undefined {
  return live.get(id);
}

/** Every live run, in no particular order. */
export function listLiveRuns(): Run[] {
  return [...live.values()];
}

/** True when an entry existed. */
export function deleteLiveRun(id: string): boolean {
  return live.delete(id);
}

/** Drops the entries not updated for `LIVE_EXPIRE_MS` as of `now` (epoch ms) and returns them. */
export function sweepLiveRuns(now: number = Date.now()): Run[] {
  const expired: Run[] = [];
  for (const run of live.values()) {
    const seen = Date.parse(run.hub?.live?.lastSeenAt ?? "");
    if (Number.isNaN(seen) || now - seen > LIVE_EXPIRE_MS) expired.push(run);
  }
  for (const run of expired) live.delete(run.id);
  return expired;
}
