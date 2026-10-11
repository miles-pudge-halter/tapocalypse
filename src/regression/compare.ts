import { ACTIVE, type Check, type CheckStatus, type Run, type Verdict } from "../runs/types";
import { foldSnapshot, isDecisive, isTerminalRun, modelOf } from "./baseline";
import { keyAnalysis } from "./flaky";
import { matchScore } from "./keys";
import { type Baseline, type CompareSide, type ComparePair, type RunComparison, TRANSITIONS, type Transition } from "./types";

/** Minimum `matchScore` for a compare-time suggestion on an explicit two-run compare. */
const SUGGESTION_THRESHOLD = 0.5;

const VERDICT_RANK: Record<Verdict, number> = { PASS: 4, "PASS WITH ISSUES": 3, PARTIAL: 2, BLOCKED: 1, FAIL: 0 };

export interface Cell {
  transition: Transition;
  lostCoverage: boolean;
}

/** The transition table: baseline result (rows) against current result (columns); null = absent. Only pass/fail are decisive. */
export function transitionOf(baseline: CheckStatus | null, current: CheckStatus | null, headActive: boolean): Cell {
  if (baseline === null) return { transition: "new", lostCoverage: false };
  if (current === null) return { transition: "removed", lostCoverage: false };
  const inFlight = current === "pending" || current === "running";
  if (isDecisive(baseline)) {
    if (isDecisive(current)) {
      if (baseline === "pass") return { transition: current === "pass" ? "unchanged" : "newly_failing", lostCoverage: false };
      return { transition: current === "pass" ? "fixed" : "still_failing", lostCoverage: false };
    }
    if (inFlight && headActive) return { transition: "pending", lostCoverage: false };
    return { transition: "changed", lostCoverage: true };
  }
  if (isDecisive(current)) return { transition: "changed", lostCoverage: false };
  if (inFlight) return headActive ? { transition: "pending", lostCoverage: false } : { transition: "changed", lostCoverage: false };
  return { transition: "unchanged", lostCoverage: false };
}

/** The run only re-tests the failed checks of an earlier run (see `rerunBrief` in the scheduler). */
export function isRerunOfFailed(run: Run): boolean {
  return run.rerunOf !== null && run.brief.includes("\n\nRe-run ONLY these checks from run ");
}

export function verdictDirection(baseline: Verdict | null, current: Verdict | null): "better" | "worse" | "same" | "unknown" {
  if (baseline === null || current === null) return "unknown";
  const d = VERDICT_RANK[current] - VERDICT_RANK[baseline];
  return d > 0 ? "better" : d < 0 ? "worse" : "same";
}

export interface CompareDeps {
  runById: (id: string) => Run | null;
  durationMs: (run: Run) => number | null;
  screenshotUrl: (run: Run, check: Check) => string | null;
}

function sideOf(run: Run, check: Check, deps: CompareDeps): CompareSide {
  const span = check.startedAt && check.endedAt ? Date.parse(check.endedAt) - Date.parse(check.startedAt) : NaN;
  return {
    runId: run.id,
    checkId: check.id,
    title: check.title,
    status: check.status,
    note: check.note ?? null,
    screenshotUrl: check.screenshot ? deps.screenshotUrl(run, check) : null,
    durationMs: Number.isFinite(span) && span >= 0 ? span : null,
    createdAt: run.createdAt,
  };
}

function delta(current: number | null, baseline: number | null): number | null {
  return current !== null && baseline !== null ? current - baseline : null;
}

type Leftover = { side: CompareSide; row: ComparePair };

/** One-to-one alignment of unmatched rows by `matchScore`, highest first; sets `suggestion` on both rows of each pair. */
function suggest(added: Leftover[], removed: Leftover[]): void {
  const scored: { a: Leftover; r: Leftover; score: number }[] = [];
  for (const a of added) {
    for (const r of removed) {
      const score = matchScore({ id: a.side.checkId, title: a.side.title }, { id: r.side.checkId, title: r.side.title });
      if (score >= SUGGESTION_THRESHOLD) scored.push({ a, r, score });
    }
  }
  scored.sort((x, y) => y.score - x.score);
  const used = new Set<Leftover>();
  for (const { a, r, score } of scored) {
    if (used.has(a) || used.has(r)) continue;
    used.add(a).add(r);
    a.row.suggestion = { runId: r.side.runId, checkId: r.side.checkId, title: r.side.title, similarity: score };
    r.row.suggestion = { runId: a.side.runId, checkId: a.side.checkId, title: a.side.title, similarity: score };
  }
}

/** Everything of a comparison except the run views, which only the app can build. */
export type ComparisonCore = Omit<RunComparison, "current" | "baselineRun">;

/**
 * Compares `head` with the baseline snapshot: pairs checks by key, applies the transition table, marks flaky keys (their
 * `newly_failing` / `fixed` rows become `flaky` and stay out of those counts unless `includeFlaky`), and on an explicit
 * pick proposes matches for unpaired rows. `headRuns` (head first) folds same-commit reruns into the current side.
 */
export function compareRuns(head: Run, baseline: Baseline, opts: { includeFlaky: boolean; headRuns?: Run[] }, deps: CompareDeps): ComparisonCore | null {
  const runs = baseline.runIds.map((id) => deps.runById(id)).filter((r): r is Run => r !== null);
  const primary = runs.find((r) => r.id === baseline.primaryRunId);
  if (!primary) return null;
  const folded = foldSnapshot(runs);

  const headActive = ACTIVE.includes(head.status);
  const notReached = headActive || !isTerminalRun(head) || head.verdict === null || isRerunOfFailed(head);
  const flakyOf = new Map<string, boolean>();
  const isFlaky = (key: string): boolean => {
    let v = flakyOf.get(key);
    if (v === undefined) {
      v = keyAnalysis(head.projectId, key).flaky !== null;
      flakyOf.set(key, v);
    }
    return v;
  };

  const pairs: ComparePair[] = [];
  const paired = new Set<string>();
  const added: Leftover[] = [];
  for (const cur of foldSnapshot(opts.headRuns ?? [head]).values()) {
    const base = folded.get(cur.checkKey);
    const current = sideOf(cur.run, cur.check, deps);
    if (base) paired.add(cur.checkKey);
    const cell = transitionOf(base?.check.status ?? null, cur.check.status, headActive);
    const flaky = isFlaky(cur.checkKey);
    const decided = cell.transition === "newly_failing" || cell.transition === "fixed";
    const inferred = base !== undefined && (cur.keyKind === "inferred" || base.keyKind === "inferred");
    const row: ComparePair = {
      key: cur.check.id,
      checkKey: cur.checkKey,
      transition: decided && flaky && !opts.includeFlaky ? "flaky" : cell.transition,
      match: base ? (inferred ? "inferred" : cur.keyKind) : null,
      confidence: base ? (inferred ? "inferred" : "exact") : null,
      flaky,
      lostCoverage: cell.lostCoverage,
      notReached: false,
      baseline: base ? sideOf(base.run, base.check, deps) : null,
      current,
      suggestion: null,
    };
    pairs.push(row);
    if (!base) added.push({ side: current, row });
  }

  const removed: Leftover[] = [];
  for (const base of folded.values()) {
    if (paired.has(base.checkKey)) continue;
    const side = sideOf(base.run, base.check, deps);
    const row: ComparePair = {
      key: `b:${base.run.id}:${base.check.id}`,
      checkKey: base.checkKey,
      transition: "removed",
      match: null,
      confidence: null,
      flaky: isFlaky(base.checkKey),
      lostCoverage: false,
      notReached,
      baseline: side,
      current: null,
      suggestion: null,
    };
    pairs.push(row);
    removed.push({ side, row });
  }
  if (baseline.tier === "explicit") suggest(added, removed);

  const counts = Object.fromEntries(TRANSITIONS.map((t) => [t, 0])) as Record<Transition, number>;
  for (const p of pairs) counts[p.transition]++;

  const costOf = (r: Run) => r.usage?.cost ?? null;
  const [bCost, cCost] = [costOf(primary), costOf(head)];
  return {
    baseline,
    verdict: { baseline: primary.verdict, current: head.verdict, direction: verdictDirection(primary.verdict, head.verdict) },
    counts,
    durationMs: {
      baseline: deps.durationMs(primary),
      current: deps.durationMs(head),
      delta: delta(deps.durationMs(head), deps.durationMs(primary)),
    },
    cost: {
      baseline: bCost,
      current: cCost,
      delta: delta(cCost, bCost),
      comparable: bCost !== null && cCost !== null && primary.harness === head.harness && modelOf(primary) === modelOf(head),
    },
    pairs,
  };
}
