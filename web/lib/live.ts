import type { Check, HubAttribution, RunView } from "./api";

/** Mirrors `LIVE_STALE_MS` in src/hub/protocol.ts: the web bundle imports only types from `src/`, never its runtime values (zod). */
export const LIVE_STALE_MS = 3 * 60_000;

/** The empty-state copy of the panes a live run has no data for (the finished upload brings it). */
export const LIVE_PENDING_COPY = "The screen, activity and screenshots arrive when the run finishes.";

export type LiveState = { kind: "live"; machine: string; lastSeenAt: string } | { kind: "stale"; machine: string; minutes: number };

/**
 * Where a hub run still in progress on a laptop stands: `live` while the laptop was heard from within `LIVE_STALE_MS`, `stale` after
 * (with the whole minutes of silence). Null for a finished upload, a laptop run or anything without a hub origin.
 */
export function liveState(hub: Pick<HubAttribution, "machine" | "live"> | null | undefined, now: number): LiveState | null {
  if (!hub?.live) return null;
  const silent = now - Date.parse(hub.live.lastSeenAt);
  if (silent <= LIVE_STALE_MS) return { kind: "live", machine: hub.machine, lastSeenAt: hub.live.lastSeenAt };
  return { kind: "stale", machine: hub.machine, minutes: Math.floor(silent / 60_000) };
}

/** True for a run the hub holds in memory while its laptop is still working on it. */
export function isLiveRun(run: Pick<RunView, "hub">): boolean {
  return Boolean(run.hub?.live);
}

/** Resolved checks (pass, fail, blocked, skipped) over the total, and how many of them failed. */
export function checkProgress(checks: Pick<Check, "status">[]): { done: number; total: number; failing: number } {
  return {
    done: checks.filter((c) => c.status !== "pending" && c.status !== "running").length,
    total: checks.length,
    failing: checks.filter((c) => c.status === "fail").length,
  };
}
