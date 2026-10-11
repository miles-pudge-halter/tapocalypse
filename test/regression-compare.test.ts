import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { compareView } from "../src/app";
import { setDefaultBranchDeps } from "../src/regression/baseline";
import { transitionOf } from "../src/regression/compare";
import type { Transition } from "../src/regression/types";
import type { CheckStatus } from "../src/runs/types";
import { cleanupRuns, makeRun, uniqueTest, useGit } from "./support/regression";

beforeEach(() => useGit(async () => null));
afterEach(() => cleanupRuns());
afterAll(() => setDefaultBranchDeps());

type Cell = [Transition, boolean];
type Row = Record<CheckStatus | "absent", Cell>;

describe("transition table", () => {
  const ok = (t: Transition): Cell => [t, false];
  const lost: Cell = ["changed", true];
  // Rows: baseline result; columns: current result. `activeHead` only changes the in-flight columns.
  const finished: Record<CheckStatus | "absent", Row> = {
    pass: { pass: ok("unchanged"), fail: ok("newly_failing"), blocked: lost, skipped: lost, pending: lost, running: lost, absent: ok("removed") },
    fail: { pass: ok("fixed"), fail: ok("still_failing"), blocked: lost, skipped: lost, pending: lost, running: lost, absent: ok("removed") },
    blocked: { pass: ok("changed"), fail: ok("changed"), blocked: ok("unchanged"), skipped: ok("unchanged"), pending: ok("changed"), running: ok("changed"), absent: ok("removed") },
    skipped: { pass: ok("changed"), fail: ok("changed"), blocked: ok("unchanged"), skipped: ok("unchanged"), pending: ok("changed"), running: ok("changed"), absent: ok("removed") },
    pending: { pass: ok("changed"), fail: ok("changed"), blocked: ok("unchanged"), skipped: ok("unchanged"), pending: ok("changed"), running: ok("changed"), absent: ok("removed") },
    running: { pass: ok("changed"), fail: ok("changed"), blocked: ok("unchanged"), skipped: ok("unchanged"), pending: ok("changed"), running: ok("changed"), absent: ok("removed") },
    absent: { pass: ok("new"), fail: ok("new"), blocked: ok("new"), skipped: ok("new"), pending: ok("new"), running: ok("new"), absent: ok("new") },
  };
  const statuses = ["pass", "fail", "blocked", "skipped", "pending", "running"] as const;

  for (const baseline of [...statuses, "absent"] as const) {
    for (const current of [...statuses, "absent"] as const) {
      if (baseline === "absent" && current === "absent") continue;
      test(`baseline ${baseline} → current ${current}, finished head`, () => {
        const cell = transitionOf(baseline === "absent" ? null : baseline, current === "absent" ? null : current, false);
        expect([cell.transition, cell.lostCoverage]).toEqual(finished[baseline][current]);
      });
    }
  }

  test("an active head turns in-flight results of decisive baselines into pending, not lost coverage", () => {
    for (const current of ["pending", "running"] as const) {
      expect(transitionOf("pass", current, true)).toEqual({ transition: "pending", lostCoverage: false });
      expect(transitionOf("fail", current, true)).toEqual({ transition: "pending", lostCoverage: false });
      expect(transitionOf("blocked", current, true)).toEqual({ transition: "pending", lostCoverage: false });
      expect(transitionOf("skipped", current, true)).toEqual({ transition: "pending", lostCoverage: false });
    }
    // Resolved results are final whatever the run is doing.
    expect(transitionOf("pass", "fail", true).transition).toBe("newly_failing");
  });
});

describe("compareView", () => {
  const A = "a".repeat(40);
  const B = "b".repeat(40);

  test("pairs checks by key and reports every transition, with removed rows keyed by the baseline run", () => {
    const t = uniqueTest();
    const base = makeRun({
      testKey: t,
      at: 1,
      branch: "main",
      commit: A,
      verdict: "PASS",
      checks: [["keep", "pass"], ["break", "pass"], ["heal", "fail"], ["stuck", "fail"], ["gone", "pass"]],
    });
    const head = makeRun({
      testKey: t,
      at: 2,
      branch: "main",
      commit: B,
      verdict: "FAIL",
      checks: [["keep", "pass"], ["break", "fail"], ["heal", "pass"], ["stuck", "fail"], ["fresh", "pass"]],
    });
    const { comparison, reason } = compareView(head.id, { baseline: "auto", includeFlaky: false });
    expect(reason).toBeNull();
    const c = comparison!;
    expect(c.baseline.primaryRunId).toBe(base.id);
    expect(c.baselineRun.id).toBe(base.id);
    expect(c.current.id).toBe(head.id);
    const byKey = Object.fromEntries(c.pairs.map((p) => [p.key, p]));
    expect(byKey.keep!.transition).toBe("unchanged");
    expect(byKey.break!.transition).toBe("newly_failing");
    expect(byKey.heal!.transition).toBe("fixed");
    expect(byKey.stuck!.transition).toBe("still_failing");
    expect(byKey.fresh).toMatchObject({ transition: "new", baseline: null, match: null, confidence: null });
    const removed = byKey[`b:${base.id}:gone`]!;
    expect(removed).toMatchObject({ transition: "removed", current: null, notReached: false, checkKey: `${t}/gone` });
    expect(byKey.break).toMatchObject({ match: "title", confidence: "exact", baseline: { runId: base.id, status: "pass" }, current: { runId: head.id, status: "fail" } });
    expect(c.counts).toMatchObject({ unchanged: 1, newly_failing: 1, fixed: 1, still_failing: 1, new: 1, removed: 1, flaky: 0 });
    expect(c.verdict).toEqual({ baseline: "PASS", current: "FAIL", direction: "worse" });
  });

  test("blocked or skipped where a decisive result existed is lost coverage, never newly failing", () => {
    const t = uniqueTest();
    makeRun({ testKey: t, at: 1, branch: "main", commit: A, checks: [["p", "pass"], ["f", "fail"], ["b", "blocked"]] });
    const head = makeRun({ testKey: t, at: 2, branch: "main", commit: B, checks: [["p", "blocked"], ["f", "skipped"], ["b", "fail"]] });
    const pairs = compareView(head.id, { baseline: "auto", includeFlaky: false }).comparison!.pairs;
    const by = Object.fromEntries(pairs.map((p) => [p.key, p]));
    expect([by.p!.transition, by.p!.lostCoverage]).toEqual(["changed", true]);
    expect([by.f!.transition, by.f!.lostCoverage]).toEqual(["changed", true]);
    expect([by.b!.transition, by.b!.lostCoverage]).toEqual(["changed", false]);
  });

  test("a finished head that only re-ran some checks marks the rest as not reached", () => {
    const t = uniqueTest();
    const base = makeRun({ testKey: t, at: 1, branch: "main", commit: A, checks: [["x", "pass"], ["y", "pass"]] });
    const head = makeRun({
      testKey: t,
      at: 2,
      branch: "main",
      commit: B,
      rerunOf: "some-parent",
      brief: "do it\n\nRe-run ONLY these checks from run some-parent (previous status + note):\n- x ...",
      checks: [["x", "pass"]],
    });
    const c = compareView(head.id, { baseline: "auto", includeFlaky: false }).comparison!;
    const gone = c.pairs.find((p) => p.key === `b:${base.id}:y`)!;
    expect(gone).toMatchObject({ transition: "removed", notReached: true });
  });

  test("a still-running head shows unresolved checks as pending", () => {
    const t = uniqueTest();
    makeRun({ testKey: t, at: 1, branch: "main", commit: A, checks: [["x", "pass"], ["y", "pass"]] });
    const head = makeRun({ testKey: t, at: 2, branch: "main", commit: B, status: "running", verdict: null, checks: [["x", "running"], ["y", "pass"]] });
    const c = compareView(head.id, { baseline: "auto", includeFlaky: false }).comparison!;
    expect(c.pairs.find((p) => p.key === "x")!.transition).toBe("pending");
    expect(c.verdict.direction).toBe("unknown");
  });

  test("flaky keys turn newly failing into flaky and drop out of the counts, unless includeFlaky", () => {
    const t = uniqueTest();
    const C = "c".repeat(40);
    makeRun({ testKey: t, at: 1, branch: "main", commit: A, checks: [["wob", "pass"], ["ok", "pass"]] });
    makeRun({ testKey: t, at: 2, branch: "main", commit: C, checks: [["wob", "pass"]] });
    makeRun({ testKey: t, at: 3, branch: "main", commit: C, checks: [["wob", "fail"]] });
    makeRun({ testKey: t, at: 4, branch: "main", commit: C, checks: [["wob", "pass"]] });
    const head = makeRun({ testKey: t, at: 5, branch: "main", commit: C, checks: [["wob", "fail"], ["ok", "fail"]] });

    const quiet = compareView(head.id, { baseline: "auto", includeFlaky: false }).comparison!;
    expect(quiet.baseline.runIds).toHaveLength(1);
    const wob = quiet.pairs.find((p) => p.key === "wob")!;
    expect(wob).toMatchObject({ transition: "flaky", flaky: true });
    expect(quiet.pairs.find((p) => p.key === "ok")).toMatchObject({ transition: "newly_failing", flaky: false });
    expect(quiet.counts).toMatchObject({ newly_failing: 1, flaky: 1 });

    const loud = compareView(head.id, { baseline: "auto", includeFlaky: true }).comparison!;
    expect(loud.pairs.find((p) => p.key === "wob")).toMatchObject({ transition: "newly_failing", flaky: true });
    expect(loud.counts).toMatchObject({ newly_failing: 2, flaky: 0 });
  });

  test("an explicit pick suggests renumbered look-alikes on unpaired rows, an auto compare does not", () => {
    const t = uniqueTest();
    const base = makeRun({
      testKey: t,
      at: 1,
      branch: "main",
      commit: A,
      checks: [{ id: "W1", status: "pass", title: "Login shows welcome banner" }, { id: "Z9", status: "pass", title: "Unrelated settings toggle persists" }],
    });
    const head = makeRun({
      testKey: t,
      at: 2,
      branch: "main",
      commit: B,
      checks: [{ id: "W2", status: "pass", title: "Login shows welcome banner message", key: `${t}/other` }],
    });
    const explicit = compareView(head.id, { baseline: base.id, includeFlaky: false }).comparison!;
    const added = explicit.pairs.find((p) => p.key === "W2")!;
    const removed = explicit.pairs.find((p) => p.key === `b:${base.id}:W1`)!;
    expect(added.suggestion).toMatchObject({ runId: base.id, checkId: "W1", title: "Login shows welcome banner" });
    expect(added.suggestion!.similarity).toBeGreaterThanOrEqual(0.5);
    expect(removed.suggestion).toMatchObject({ runId: head.id, checkId: "W2" });
    expect(explicit.pairs.find((p) => p.key === `b:${base.id}:Z9`)!.suggestion).toBeNull();
    expect(explicit.counts).toMatchObject({ new: 1, removed: 2 });

    const auto = compareView(head.id, { baseline: "auto", includeFlaky: false }).comparison!;
    expect(auto.pairs.every((p) => p.suggestion === null)).toBe(true);
  });

  test("inferred keys are flagged on the pair", () => {
    const t = uniqueTest();
    makeRun({ testKey: t, at: 1, branch: "main", commit: A, checks: [["x", "pass"]] });
    const head = makeRun({ testKey: t, at: 2, branch: "main", commit: B, checks: [{ id: "x", status: "fail", keyKind: "inferred" }] });
    const pair = compareView(head.id, { baseline: "auto", includeFlaky: false }).comparison!.pairs[0]!;
    expect(pair).toMatchObject({ match: "inferred", confidence: "inferred", transition: "newly_failing" });
  });

  test("cost and duration deltas; cost is only comparable on the same harness and model", () => {
    const t = uniqueTest();
    makeRun({ testKey: t, at: 1, branch: "main", commit: A, harness: "omp", model: "m1", cost: 0.5, checks: [["x", "pass"]] });
    const same = makeRun({ testKey: t, at: 2, branch: "main", commit: B, harness: "omp", model: "m1", cost: 0.75, checks: [["x", "pass"]] });
    expect(compareView(same.id, { baseline: "auto", includeFlaky: false }).comparison!.cost).toEqual({ baseline: 0.5, current: 0.75, delta: 0.25, comparable: true });
    const other = makeRun({ testKey: t, at: 3, branch: "main", commit: "d".repeat(40), harness: "omp", model: "m2", cost: 0.75, checks: [["x", "pass"]] });
    const c = compareView(other.id, { baseline: same.id, includeFlaky: false }).comparison!;
    expect(c.cost.comparable).toBe(false);
    expect(c.verdict.direction).toBe("same");
  });

  test("verdict direction follows the rank PASS > PASS WITH ISSUES > PARTIAL > BLOCKED > FAIL", () => {
    const t = uniqueTest();
    const base = makeRun({ testKey: t, at: 1, branch: "main", commit: A, verdict: "BLOCKED", checks: [["x", "pass"]] });
    const better = makeRun({ testKey: t, at: 2, branch: "main", commit: B, verdict: "PARTIAL", checks: [["x", "pass"]] });
    const unknown = makeRun({ testKey: t, at: 3, branch: "main", commit: B, verdict: null, status: "error", checks: [["x", "pass"]] });
    expect(compareView(better.id, { baseline: base.id, includeFlaky: false }).comparison!.verdict.direction).toBe("better");
    expect(compareView(unknown.id, { baseline: base.id, includeFlaky: false }).comparison!.verdict.direction).toBe("unknown");
  });

  test("reasons: no checks, no baseline (naming the other platform), unknown run, bad explicit baseline", () => {
    const t = uniqueTest();
    const empty = makeRun({ testKey: t, at: 1, checks: [] });
    expect(compareView(empty.id, { baseline: "auto", includeFlaky: false })).toMatchObject({ comparison: null, reason: "no_checks" });

    makeRun({ testKey: t, at: 2, platform: "ios", checks: [["x", "pass"]] });
    const lone = makeRun({ testKey: t, at: 3, platform: "android", checks: [["x", "pass"]] });
    expect(compareView(lone.id, { baseline: "auto", includeFlaky: false })).toEqual({
      comparison: null,
      reason: "no_baseline",
      reasonText: "Earlier runs of this test ran on iOS only.",
    });
    expect(() => compareView("missing-run", { baseline: "auto", includeFlaky: false })).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => compareView(lone.id, { baseline: lone.id, includeFlaky: false })).toThrow(expect.objectContaining({ status: 400, code: "same_run" }));
  });
});
