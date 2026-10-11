import type { Check, CheckStatus, Platform, Run } from "../runs/types";
import { isDecisive, platformOf } from "./baseline";
import { checkEntries, keysOf, projectKeys } from "./index";
import type { FlakyCheck } from "./types";

export const DEFAULT_WINDOW = 20;
/** The label clears once this many of the newest groupable decisive results show no flip. */
const CLEAR_AFTER = 5;
const RECENT_LIMIT = 10;

export interface KeyEntry {
  run: Run;
  check: Check;
}

export interface KeyAnalysis {
  flaky: "flaky" | "suspect" | null;
  deviceSensitive: boolean;
  unstable: boolean;
  flips: number;
  /** Decisive results considered (at most the requested window). */
  window: number;
  passRate: number | null;
  /** The newest run whose result flipped against the previous result of its group. */
  lastFlip: { runId: string; at: string; branch: string | null } | null;
  /** Runs whose result flipped pass↔fail against the previous result of the same code, platform and device. */
  flippedRuns: Set<string>;
}

/** (clean commit) or, without a commit, (build version): what "the same code" means. Null: unknown, the result is not used. */
function codeIdentity(run: Run): string | null {
  const commit = run.source?.commit ?? null;
  if (commit) return run.source?.dirty === false ? `c:${commit}` : null;
  const b = run.build;
  return b?.versionName && b.versionCode ? `b:${b.versionName}|${b.versionCode}` : null;
}

interface Point {
  entry: KeyEntry;
  status: CheckStatus;
  code: string;
  platform: Platform;
  device: string;
}

function point(entry: KeyEntry): Point | null {
  const code = codeIdentity(entry.run);
  if (code === null) return null;
  return { entry, status: entry.check.status, code, platform: platformOf(entry.run), device: entry.run.deviceName ?? "" };
}

/** Adjacent `a`↔`b` status changes per group, input newest first. Returns the flipping (newer) points. */
function flipsBetween(points: Point[], a: CheckStatus, b: CheckStatus, groupOf: (p: Point) => string): Point[] {
  const groups = new Map<string, Point[]>();
  for (const p of [...points].reverse()) {
    if (p.status !== a && p.status !== b) continue;
    const g = groupOf(p);
    groups.set(g, [...(groups.get(g) ?? []), p]);
  }
  const flipped: Point[] = [];
  for (const list of groups.values()) {
    for (let i = 1; i < list.length; i++) if (list[i]!.status !== list[i - 1]!.status) flipped.push(list[i]!);
  }
  return flipped;
}

const sameCode = (p: Point) => `${p.code}|${p.platform}|${p.device}`;

/** Whether the same code passes on one device and fails on another (same code identity and platform). */
function isDeviceSensitive(points: Point[]): boolean {
  const byCode = new Map<string, { pass: Set<string>; fail: Set<string> }>();
  for (const p of points) {
    if (!isDecisive(p.status)) continue;
    const slot = byCode.get(`${p.code}|${p.platform}`) ?? { pass: new Set<string>(), fail: new Set<string>() };
    (p.status === "pass" ? slot.pass : slot.fail).add(p.device);
    byCode.set(`${p.code}|${p.platform}`, slot);
  }
  for (const { pass, fail } of byCode.values()) {
    for (const p of pass) for (const f of fail) if (p !== f) return true;
  }
  return false;
}

/**
 * Flakiness of one check key from its results (newest first, as `checkEntries` returns them): flips are pass↔fail
 * changes among results of the same code (clean commit, else build), platform and device, over the newest `window`
 * decisive results of runs that were not superseded by a retry.
 */
export function analyzeEntries(entries: KeyEntry[], window = DEFAULT_WINDOW): KeyAnalysis {
  const live = entries.filter((e) => e.run.retriedBy === null);
  const decisive = live.filter((e) => isDecisive(e.check.status)).slice(0, window);
  const points = decisive.map(point).filter((p): p is Point => p !== null);

  const flipped = flipsBetween(points, "pass", "fail", sameCode);
  const recentFlips = flipsBetween(points.slice(0, CLEAR_AFTER), "pass", "fail", sameCode).length;
  const flips = flipped.length;
  const flaky = flips === 0 || recentFlips === 0 ? null : flips >= 2 ? "flaky" : "suspect";

  const passes = decisive.filter((e) => e.check.status === "pass").length;
  const envPoints = live
    .filter((e) => e.check.status === "pass" || e.check.status === "blocked")
    .slice(0, window)
    .map(point)
    .filter((p): p is Point => p !== null);
  const newest = flipped.sort((a, b) => b.entry.run.createdAt.localeCompare(a.entry.run.createdAt))[0];

  return {
    flaky,
    deviceSensitive: isDeviceSensitive(points),
    unstable: flipsBetween(envPoints, "pass", "blocked", sameCode).length >= 2,
    flips,
    window: decisive.length,
    passRate: decisive.length ? passes / decisive.length : null,
    lastFlip: newest ? { runId: newest.entry.run.id, at: newest.entry.run.createdAt, branch: newest.entry.run.source?.branch ?? null } : null,
    flippedRuns: new Set(flipped.map((p) => p.entry.run.id)),
  };
}

/** Flaky label of a key, used by compare and find-regressions. */
export function keyAnalysis(projectId: string, checkKey: string, window = DEFAULT_WINDOW): KeyAnalysis {
  return analyzeEntries(checkEntries(projectId, checkKey), window);
}

/** Flaky and suspect checks of a project, flaky first, then by flips and recency. */
export function flakyChecks(
  projectId: string,
  opts: { platform?: Platform; window: number },
): { checks: FlakyCheck[]; trackedKeys: number; repeatedKeys: number } {
  const keys = projectKeys(projectId);
  const checks: FlakyCheck[] = [];
  for (const { checkKey } of keys) {
    const all = checkEntries(projectId, checkKey);
    const entries = opts.platform ? all.filter((e) => platformOf(e.run) === opts.platform) : all;
    const a = analyzeEntries(entries, opts.window);
    const newest = entries[0];
    if (!a.flaky || !a.lastFlip || !newest) continue;
    const recent = entries
      .filter((e) => e.run.retriedBy === null)
      .slice(0, RECENT_LIMIT)
      .map((e) => e.check.status)
      .reverse();
    checks.push({
      checkKey,
      keyKind: keysOf(newest.run).get(newest.check.id)?.keyKind ?? "title",
      title: newest.check.title,
      confidence: a.flaky,
      flips: a.flips,
      window: a.window,
      passRate: a.passRate,
      recent,
      lastFlipAt: a.lastFlip.at,
      lastFlipBranch: a.lastFlip.branch,
    });
  }
  checks.sort(
    (x, y) =>
      Number(y.confidence === "flaky") - Number(x.confidence === "flaky") || y.flips - x.flips || y.lastFlipAt.localeCompare(x.lastFlipAt),
  );
  return { checks, trackedKeys: keys.length, repeatedKeys: keys.filter((k) => k.runs > 1).length };
}

/** Runs whose result flipped pass↔fail against the previous decisive result on the same platform and device, whatever the code. */
export function deviceFlips(entries: KeyEntry[]): Set<string> {
  const last = new Map<string, CheckStatus>();
  const flipped = new Set<string>();
  for (const e of [...entries].reverse()) {
    if (e.run.retriedBy !== null || !isDecisive(e.check.status)) continue;
    const group = `${platformOf(e.run)}|${e.run.deviceName ?? ""}`;
    const prev = last.get(group);
    if (prev !== undefined && prev !== e.check.status) flipped.add(e.run.id);
    last.set(group, e.check.status);
  }
  return flipped;
}
