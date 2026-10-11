import type { RunView } from "../app";
import type { CheckStatus, KeyKind, Platform, Verdict } from "../runs/types";
import type { HarnessId } from "../harness/types";

export type Transition =
  | "newly_failing"
  | "fixed"
  | "flaky"
  | "still_failing"
  | "unchanged"
  | "changed"
  | "new"
  | "removed"
  | "pending";

export const TRANSITIONS: readonly Transition[] = [
  "newly_failing",
  "fixed",
  "flaky",
  "still_failing",
  "unchanged",
  "changed",
  "new",
  "removed",
  "pending",
];

export type BaselineTier = "explicit" | "pr-base" | "default-branch" | "same-branch" | "any";

export interface Baseline {
  /** True when the server picked it (`baseline=auto`). */
  auto: boolean;
  tier: BaselineTier;
  /** `run`: one run (explicit pick, or a snapshot of one run). `snapshot`: several runs at one commit folded together. */
  kind: "run" | "snapshot";
  primaryRunId: string;
  /** Primary first. */
  runIds: string[];
  branch: string | null;
  commit: string | null;
  /** One human sentence, shown verbatim. */
  reason: string;
  platformMismatch: boolean;
  deviceChanged: boolean;
  harnessChanged: boolean;
  modelChanged: boolean;
  buildChanged: boolean;
  sameCommit: boolean;
}

export interface CompareSide {
  runId: string;
  checkId: string;
  title: string;
  status: CheckStatus;
  note: string | null;
  screenshotUrl: string | null;
  durationMs: number | null;
  createdAt: string;
}

export interface ComparePair {
  /** Stable row id: the current check id, or `b:<baselineRunId>:<checkId>` for removed rows. */
  key: string;
  checkKey: string | null;
  transition: Transition;
  match: KeyKind | null;
  /** `inferred` iff `match === "inferred"`. */
  confidence: "exact" | "inferred" | null;
  flaky: boolean;
  lostCoverage: boolean;
  /** A removed row whose current run never got to it (rerun of failed checks, or no terminal verdict). */
  notReached: boolean;
  baseline: CompareSide | null;
  current: CompareSide | null;
  /** Compare-time candidate for new/removed rows of an explicit two-run compare; never counted. */
  suggestion: { runId: string; checkId: string; title: string; similarity: number } | null;
}

export interface RunComparison {
  current: RunView;
  baselineRun: RunView;
  baseline: Baseline;
  verdict: { baseline: Verdict | null; current: Verdict | null; direction: "better" | "worse" | "same" | "unknown" };
  /** `newly_failing` and `fixed` exclude flaky keys unless `includeFlaky` was requested. */
  counts: Record<Transition, number>;
  durationMs: { baseline: number | null; current: number | null; delta: number | null };
  cost: { baseline: number | null; current: number | null; delta: number | null; comparable: boolean };
  pairs: ComparePair[];
}

export interface CheckHistoryEntry {
  runId: string;
  runTitle: string;
  checkId: string;
  title: string;
  status: CheckStatus;
  note: string | null;
  screenshotUrl: string | null;
  createdAt: string;
  platform: Platform;
  deviceName: string | null;
  commit: string | null;
  dirty: boolean | null;
  branch: string | null;
  /** `versionName (versionCode)` of the app build, when known. */
  build: string | null;
  harness: HarnessId;
  model: string | null;
  verdict: Verdict | null;
  keyKind: KeyKind | null;
  /** Pass↔fail against the previous decisive entry of the same group (same code, platform, device). */
  flip: boolean;
  flippedOnSameCode: boolean;
}

export interface CheckHistory {
  projectId: string;
  checkKey: string;
  keyKind: KeyKind;
  title: string;
  flaky: "flaky" | "suspect" | null;
  deviceSensitive: boolean;
  unstable: boolean;
  flips: number;
  window: number;
  passRate: number | null;
  /** Newest first. */
  entries: CheckHistoryEntry[];
  hasMore: boolean;
}

export interface FlakyCheck {
  checkKey: string;
  keyKind: KeyKind;
  title: string;
  confidence: "flaky" | "suspect";
  flips: number;
  window: number;
  passRate: number | null;
  /** Up to 10 most recent results, oldest → newest (left to right). */
  recent: (CheckStatus | null)[];
  lastFlipAt: string;
  lastFlipBranch: string | null;
}

export interface RegressionItem {
  checkKey: string;
  title: string;
  current: { runId: string; checkId: string; status: CheckStatus; note: string | null; screenshotPath: string | null };
  baseline: { runId: string; checkId: string; status: CheckStatus; screenshotPath: string | null } | null;
}

export type FindRegressionsStatus = "regressions" | "clean" | "pending" | "no_runs" | "no_baseline";

export interface FindRegressionsTest {
  testKey: string;
  title: string;
  platform: Platform;
  headRunIds: string[];
  baseline: Baseline | null;
  verdict: { baseline: Verdict | null; current: Verdict | null };
  /** Decisive pass → fail, not flaky. */
  newlyFailing: RegressionItem[];
  flakyFailing: RegressionItem[];
  /** Was decisive, now blocked, skipped or not reached. */
  lostCoverage: RegressionItem[];
  /** Failing checks with no baseline counterpart. */
  newFailures: RegressionItem[];
  fixed: number;
  stillFailing: number;
}

export interface FindRegressionsResult {
  status: FindRegressionsStatus;
  summary: string;
  tests: FindRegressionsTest[];
}

/** `RunView.regression`: the auto-baseline comparison of a terminal run, summarised for the runs list. */
export interface RunRegression {
  baselineId: string;
  baselineTitle: string;
  baselineBranch: string | null;
  baselineCreatedAt: string;
  newlyFailing: number;
  fixed: number;
  flaky: number;
}
