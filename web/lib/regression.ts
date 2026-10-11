import type { CheckRef, ComparePair, Transition } from "./api";

/** Fixed display order of the compare table (design §4.3). */
export const GROUP_ORDER: readonly Transition[] = [
  "newly_failing",
  "flaky",
  "fixed",
  "changed",
  "still_failing",
  "pending",
  "new",
  "removed",
  "unchanged",
];

export interface PairGroup {
  transition: Transition;
  pairs: ComparePair[];
}

/** Pairs bucketed by transition in `GROUP_ORDER`; empty groups are dropped and rows keep their input order. */
export function groupPairs(pairs: readonly ComparePair[]): PairGroup[] {
  return GROUP_ORDER.map((transition) => ({ transition, pairs: pairs.filter((p) => p.transition === transition) })).filter(
    (g) => g.pairs.length > 0,
  );
}

/**
 * The groups the compare table shows collapsed. Unchanged is collapsed by default, but only while other groups exist
 * and nothing points at it: neither the `show` filter nor the selected pair (`?pair=`) may be hidden inside it.
 * An explicit `override` (true = collapsed, false = open) always wins.
 */
export function collapsedGroups(
  groups: readonly PairGroup[],
  opts: { show?: Transition; selectedKey?: string | null; override: Readonly<Record<string, boolean>> },
): Set<Transition> {
  const out = new Set<Transition>();
  for (const g of groups) {
    const targeted = opts.show === g.transition || g.pairs.some((p) => p.key === opts.selectedKey);
    if (opts.override[g.transition] ?? (g.transition === "unchanged" && groups.length > 1 && !targeted)) out.add(g.transition);
  }
  return out;
}

export interface DiffToken {
  text: string;
  changed: boolean;
}

export interface WordDiff {
  baseline: DiffToken[];
  current: DiffToken[];
  /** A side exceeded `MAX_DIFF_TOKENS`: nothing is highlighted. */
  truncated: boolean;
}

export const MAX_DIFF_TOKENS = 400;

/** Word-level longest-common-subsequence diff of two notes (in-house; agent text is rendered as JSX spans only). */
export function wordDiff(baseline: string, current: string): WordDiff {
  const a = baseline.split(/\s+/).filter(Boolean);
  const b = current.split(/\s+/).filter(Boolean);
  if (a.length > MAX_DIFF_TOKENS || b.length > MAX_DIFF_TOKENS) {
    return {
      baseline: a.map((text) => ({ text, changed: false })),
      current: b.map((text) => ({ text, changed: false })),
      truncated: true,
    };
  }
  // lcs[i][j] = length of the LCS of a[i..] and b[j..]
  const width = b.length + 1;
  const lcs = new Uint16Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * width + j] =
        a[i] === b[j] ? (lcs[(i + 1) * width + j + 1] ?? 0) + 1 : Math.max(lcs[(i + 1) * width + j] ?? 0, lcs[i * width + j + 1] ?? 0);
    }
  }
  const outA: DiffToken[] = [];
  const outB: DiffToken[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const left = a[i];
    const right = b[j];
    if (left !== undefined && right !== undefined && left === right) {
      outA.push({ text: left, changed: false });
      outB.push({ text: right, changed: false });
      i++;
      j++;
    } else if (left !== undefined && (right === undefined || (lcs[(i + 1) * width + j] ?? 0) >= (lcs[i * width + j + 1] ?? 0))) {
      outA.push({ text: left, changed: true });
      i++;
    } else if (right !== undefined) {
      outB.push({ text: right, changed: true });
      j++;
    }
  }
  return { baseline: outA, current: outB, truncated: false };
}

/**
 * The two checks a Confirm / Link action ties together, `a` = the older (baseline side), `b` = the newer one.
 * A matched row names its own two sides. A suggestion names the counterpart check (and its run): a leftover baseline
 * check for a new row, a check of the current run for a removed row.
 */
export function linkTarget(pair: ComparePair): { a: CheckRef; b: CheckRef } | null {
  if (pair.baseline && pair.current) {
    return { a: { runId: pair.baseline.runId, checkId: pair.baseline.checkId }, b: { runId: pair.current.runId, checkId: pair.current.checkId } };
  }
  const { suggestion } = pair;
  if (!suggestion) return null;
  if (pair.current) {
    return { a: { runId: suggestion.runId, checkId: suggestion.checkId }, b: { runId: pair.current.runId, checkId: pair.current.checkId } };
  }
  if (pair.baseline) {
    return {
      a: { runId: pair.baseline.runId, checkId: pair.baseline.checkId },
      b: { runId: suggestion.runId, checkId: suggestion.checkId },
    };
  }
  return null;
}

const refKey = (ref: CheckRef): string => `${ref.runId}:${ref.checkId}`;

/**
 * Identity of a suggested pair, the same from both of its rows (the added row and the removed row it points at), so a
 * dismissal hides the hint on both. Null when the row carries no suggestion.
 */
export function suggestionKey(pair: ComparePair): string | null {
  const target = pair.suggestion ? linkTarget(pair) : null;
  return target ? `${refKey(target.a)}|${refKey(target.b)}` : null;
}

/** `tapocalypse-dismissed-suggestions`: `{ [projectId]: suggestionKey[] }`. A dismissal is a client-side preference, never written to a run. */
export const DISMISSED_KEY = "tapocalypse-dismissed-suggestions";

function parseDismissedStore(raw: string | null): Record<string, string[]> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, string[]> = {};
    for (const [project, keys] of Object.entries(parsed)) {
      if (Array.isArray(keys)) out[project] = keys.filter((k): k is string => typeof k === "string");
    }
    return out;
  } catch {
    return {};
  }
}

/** The suggestion keys dismissed in one project; unreadable storage reads as none. */
export function readDismissed(raw: string | null, projectId: string): Set<string> {
  return new Set(parseDismissedStore(raw)[projectId]);
}

/** The storage value with `key` added to the project's dismissed set. */
export function addDismissed(raw: string | null, projectId: string, key: string): string {
  const store = parseDismissedStore(raw);
  store[projectId] = [...new Set([...(store[projectId] ?? []), key])];
  return JSON.stringify(store);
}
