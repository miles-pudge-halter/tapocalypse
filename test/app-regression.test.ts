import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { baselineCandidates, compareView, findRegressions, queryRuns, runView } from "../src/app";
import { setDefaultBranchDeps } from "../src/regression/baseline";
import { screenshotsDir } from "../src/runs/artefacts";
import { deleteRun } from "../src/runs/store";
import { cleanupRuns, makeRun, uniqueTest, updateRun, useGit } from "./support/regression";

const PNG = Buffer.from("89504e470d0a1a0a", "hex");
const sha = (c: string): string => c.repeat(40);

beforeEach(() => useGit(async (_cwd, args) => (args.join(" ").includes("origin/HEAD") ? "origin/main" : null)));
afterEach(() => cleanupRuns());
afterAll(() => setDefaultBranchDeps());

/** A branch name nobody else uses, so find-regressions only sees this test's runs. */
const branchName = (): string => `feature/${uniqueTest().slice(5)}`;

describe("findRegressions", () => {
  test("no_runs when nothing matches the filters", () => {
    expect(findRegressions({ projectId: "test-proj", branch: branchName() })).toEqual({ status: "no_runs", summary: expect.any(String), tests: [] });
  });

  test("pending while any matching run is still active", () => {
    const branch = branchName();
    const t = uniqueTest();
    makeRun({ testKey: t, at: 1, branch: "main", commit: sha("a"), checks: [["x", "pass"]] });
    makeRun({ testKey: t, at: 2, branch, commit: sha("b"), checks: [["x", "fail"]] });
    makeRun({ testKey: uniqueTest(), at: 3, branch, commit: sha("b"), status: "running", verdict: null, checks: [["x", "running"]] });
    const result = findRegressions({ projectId: "test-proj", branch });
    expect(result.status).toBe("pending");
    expect(result.summary).toContain("1 run still running");
  });

  test("no_baseline when no matching test has an earlier run", () => {
    const branch = branchName();
    const head = makeRun({ testKey: uniqueTest(), at: 1, branch, commit: sha("b"), checks: [["x", "fail"]] });
    const result = findRegressions({ projectId: "test-proj", branch });
    expect(result.status).toBe("no_baseline");
    expect(result.tests).toHaveLength(1);
    expect(result.tests[0]).toMatchObject({ headRunIds: [head.id], baseline: null, newlyFailing: [] });
  });

  test("clean when nothing that passed before fails now", () => {
    const branch = branchName();
    const t = uniqueTest();
    makeRun({ testKey: t, at: 1, branch: "main", commit: sha("a"), checks: [["x", "pass"], ["y", "fail"]] });
    makeRun({ testKey: t, at: 2, branch, commit: sha("b"), checks: [["x", "pass"], ["y", "pass"]] });
    const result = findRegressions({ projectId: "test-proj", branch });
    expect(result.status).toBe("clean");
    expect(result.summary).toContain("1 test compared");
    expect(result.tests[0]).toMatchObject({ newlyFailing: [], fixed: 1, stillFailing: 0, baseline: { tier: "default-branch", branch: "main" } });
  });

  test("regressions: newly failing, flaky failures, lost coverage and new failures are told apart", () => {
    const branch = branchName();
    const t = uniqueTest();
    const base = makeRun({
      testKey: t,
      at: 1,
      branch: "main",
      commit: sha("a"),
      verdict: "PASS",
      checks: [["broke", "pass"], ["wobbly", "pass"], ["lost", "pass"], ["stuck", "fail"], ["ok", "pass"]],
    });
    // `wobbly` flips on one clean commit: flaky, so its failure is listed apart.
    makeRun({ testKey: t, at: 2, branch: "other", commit: sha("c"), checks: [["wobbly", "pass"]] });
    makeRun({ testKey: t, at: 3, branch: "other", commit: sha("c"), checks: [["wobbly", "fail"]] });
    makeRun({ testKey: t, at: 4, branch: "other", commit: sha("c"), checks: [["wobbly", "pass"]] });
    const head = makeRun({
      testKey: t,
      at: 5,
      branch,
      commit: sha("c"),
      verdict: "FAIL",
      checks: [["broke", "fail"], ["wobbly", "fail"], ["lost", "blocked"], ["stuck", "fail"], ["ok", "pass"], ["brand-new", "fail"]],
    });

    const result = findRegressions({ projectId: "test-proj", branch });
    expect(result.status).toBe("regressions");
    expect(result.summary).toBe("1 check that passed on main fail now (1 test); 1 flaky failure ignored; 1 check lost coverage; 1 new failing check.");
    const test = result.tests[0]!;
    expect(test).toMatchObject({ testKey: t, platform: "android", headRunIds: [head.id], verdict: { baseline: "PASS", current: "FAIL" }, fixed: 0, stillFailing: 1 });
    expect(test.baseline?.primaryRunId).toBe(base.id);
    expect(test.newlyFailing).toEqual([
      {
        checkKey: `${t}/broke`,
        title: "Check broke",
        current: { runId: head.id, checkId: "broke", status: "fail", note: null, screenshotPath: null },
        baseline: { runId: base.id, checkId: "broke", status: "pass", screenshotPath: null },
      },
    ]);
    expect(test.flakyFailing.map((i) => i.checkKey)).toEqual([`${t}/wobbly`]);
    expect(test.lostCoverage.map((i) => [i.checkKey, i.current.status])).toEqual([[`${t}/lost`, "blocked"]]);
    expect(test.newFailures.map((i) => [i.checkKey, i.baseline])).toEqual([[`${t}/brand-new`, null]]);

    const loud = findRegressions({ projectId: "test-proj", branch, includeFlaky: true });
    expect(loud.tests[0]!.newlyFailing.map((i) => i.checkKey).sort()).toEqual([`${t}/broke`, `${t}/wobbly`]);
    expect(loud.tests[0]!.flakyFailing).toEqual([]);
  });

  test("reports each (test, platform) group against its own baseline", () => {
    const branch = branchName();
    const [t1, t2] = [uniqueTest(), uniqueTest()];
    makeRun({ testKey: t1, at: 1, branch: "main", commit: sha("a"), checks: [["x", "pass"]] });
    makeRun({ testKey: t2, at: 1, branch: "main", commit: sha("a"), platform: "ios", device: "iPhone", checks: [["x", "pass"]] });
    makeRun({ testKey: t1, at: 2, branch, commit: sha("b"), checks: [["x", "pass"]] });
    makeRun({ testKey: t2, at: 2, branch, commit: sha("b"), platform: "ios", device: "iPhone", checks: [["x", "fail"]] });
    const result = findRegressions({ projectId: "test-proj", branch });
    expect(result.status).toBe("regressions");
    expect(result.tests.map((t) => [t.platform, t.newlyFailing.length]).sort()).toEqual([["android", 0], ["ios", 1]]);
  });

  test("a rerun of failed checks on the same commit completes the head snapshot; superseded runs are ignored", () => {
    const branch = branchName();
    const t = uniqueTest();
    makeRun({ testKey: t, at: 1, branch: "main", commit: sha("a"), checks: [["x", "pass"], ["y", "pass"]] });
    const round1 = makeRun({ testKey: t, at: 2, branch, commit: sha("b"), checks: [["x", "fail"], ["y", "fail"]] });
    makeRun({
      testKey: t,
      at: 3,
      branch,
      commit: sha("b"),
      rerunOf: round1.id,
      brief: `brief\n\nRe-run ONLY these checks from run ${round1.id} (previous status + note):\n- x`,
      checks: [["x", "pass"]],
    });
    makeRun({ testKey: t, at: 4, branch, commit: sha("b"), retriedBy: "successor", checks: [["x", "fail"], ["y", "fail"], ["z", "fail"]] });
    const result = findRegressions({ projectId: "test-proj", branch });
    expect(result.status).toBe("regressions");
    const test = result.tests[0]!;
    expect(test.headRunIds).toHaveLength(2);
    expect(test.newlyFailing.map((i) => i.checkKey)).toEqual([`${t}/y`]);
    expect(test.newFailures).toEqual([]);
  });

  test("screenshot paths are absolute files; filters by commit prefix and PR number work", () => {
    const branch = branchName();
    const t = uniqueTest();
    const base = makeRun({ testKey: t, at: 1, branch: "main", commit: sha("a"), checks: [{ id: "x", status: "pass", screenshot: "screenshots/ok.png" }] });
    const head = makeRun({
      testKey: t,
      at: 2,
      branch,
      commit: "f00dcafe".padEnd(40, "0"),
      prBase: "main",
      checks: [{ id: "x", status: "fail", screenshot: "screenshots/bad.png" }],
    });
    for (const [run, name] of [[base, "ok.png"], [head, "bad.png"]] as const) {
      fs.mkdirSync(screenshotsDir(run.id), { recursive: true });
      fs.writeFileSync(path.join(screenshotsDir(run.id), name), PNG);
    }
    const byCommit = findRegressions({ projectId: "test-proj", commit: "f00dcafe" });
    const item = byCommit.tests.find((x) => x.headRunIds.includes(head.id))!.newlyFailing[0]!;
    expect(item.current.screenshotPath).toBe(fs.realpathSync(path.join(screenshotsDir(head.id), "bad.png")));
    expect(item.baseline?.screenshotPath).toBe(fs.realpathSync(path.join(screenshotsDir(base.id), "ok.png")));
    expect(findRegressions({ projectId: "test-proj", prNumber: 7, branch }).tests[0]!.headRunIds).toEqual([head.id]);
  });
});

describe("RunView.regression and queryRuns regressed", () => {
  test("summarises the auto baseline comparison of a finished run only", () => {
    const t = uniqueTest();
    const base = makeRun({ testKey: t, at: 1, branch: "main", commit: sha("a"), title: "baseline run", checks: [["x", "pass"], ["y", "fail"]] });
    const head = makeRun({ testKey: t, at: 2, branch: "main", commit: sha("b"), checks: [["x", "fail"], ["y", "pass"]] });
    expect(runView(head).regression).toEqual({
      baselineId: base.id,
      baselineTitle: "baseline run",
      baselineBranch: "main",
      baselineCreatedAt: base.createdAt,
      newlyFailing: 1,
      fixed: 1,
      flaky: 0,
    });
    expect(runView(base).regression).toBeNull();
    const live = makeRun({ testKey: t, at: 3, branch: "main", commit: sha("c"), status: "running", verdict: null, checks: [["x", "fail"]] });
    expect(runView(live).regression).toBeNull();
  });

  test("the summary follows changes to the runs it was computed from", () => {
    const t = uniqueTest();
    const base = makeRun({ testKey: t, at: 1, branch: "main", commit: sha("a"), checks: [["x", "pass"]] });
    const head = makeRun({ testKey: t, at: 2, branch: "main", commit: sha("b"), checks: [["x", "fail"]] });
    expect(runView(head).regression?.newlyFailing).toBe(1);
    // The baseline's check now failed too: nothing is newly failing any more.
    updateRun(base, (r) => {
      r.checks[0]!.status = "fail";
    });
    expect(runView(head).regression).toMatchObject({ newlyFailing: 0 });
    // Once the baseline is deleted the run has nothing to compare with.
    deleteRun(base.id);
    expect(runView(head).regression).toBeNull();
  });

  test("regressed=true keeps only finished runs with newly failing checks", () => {
    const t = uniqueTest();
    const tag = `rg-${t.slice(5)}`;
    makeRun({ testKey: t, at: 1, branch: "main", commit: sha("a"), title: `${tag} base`, checks: [["x", "pass"]] });
    const bad = makeRun({ testKey: t, at: 2, branch: "main", commit: sha("b"), title: `${tag} bad`, checks: [["x", "fail"]] });
    const good = makeRun({ testKey: t, at: 3, branch: "main", commit: sha("c"), title: `${tag} good`, checks: [["x", "pass"]] });
    const all = queryRuns({ project: "test-proj", q: tag, limit: 50 }).runs.map((r) => r.id);
    expect(all).toEqual(expect.arrayContaining([bad.id, good.id]));
    const regressed = queryRuns({ project: "test-proj", q: tag, regressed: true, limit: 50 });
    expect(regressed.runs.map((r) => r.id)).toEqual([bad.id]);
  });

  test("a re-run of failed checks is compared as one head snapshot with its parent: the strip, the chip and find-regressions agree", () => {
    const t = uniqueTest();
    const branch = branchName();
    makeRun({ testKey: t, at: 1, branch: "main", commit: sha("a"), checks: [["x", "pass"], ["y", "pass"], ["z", "pass"]] });
    const round1 = makeRun({ testKey: t, at: 2, branch, commit: sha("b"), checks: [["x", "fail"], ["y", "fail"], ["z", "pass"]] });
    const rerun = makeRun({
      testKey: t,
      at: 3,
      branch,
      commit: sha("b"),
      rerunOf: round1.id,
      brief: `brief\n\nRe-run ONLY these checks from run ${round1.id} (previous status + note):\n- x\n- y`,
      checks: [["x", "pass"], ["y", "fail"]],
    });
    const comparison = compareView(rerun.id, { baseline: "auto", includeFlaky: false }).comparison!;
    expect(comparison.pairs.filter((p) => p.transition === "removed")).toEqual([]);
    expect(comparison.counts).toMatchObject({ newly_failing: 1, removed: 0 });
    expect(runView(rerun).regression).toMatchObject({ newlyFailing: 1 });
    expect(findRegressions({ projectId: "test-proj", branch }).tests[0]!.newlyFailing).toHaveLength(1);
  });

  test("a dirty working tree is its own code: dirty runs never fold into a snapshot, and the previous dirty run is a valid baseline", () => {
    const t = uniqueTest();
    const branch = branchName();
    makeRun({ testKey: t, at: 0, branch, commit: sha("z"), checks: [["x", "pass"], ["y", "pass"]] });
    const first = makeRun({ testKey: t, at: 1, branch, commit: sha("a"), dirty: true, checks: [["x", "pass"], ["y", "pass"]] });
    const second = makeRun({ testKey: t, at: 2, branch, commit: sha("a"), dirty: true, checks: [["x", "pass"], ["y", "fail"]] });
    const third = makeRun({ testKey: t, at: 3, branch, commit: sha("a"), dirty: true, checks: [["x", "fail"], ["y", "fail"]] });
    const comparison = compareView(third.id, { baseline: "auto", includeFlaky: false }).comparison!;
    // Edit, run, edit, run: the baseline is the previous run, not a fold of both earlier ones.
    expect(comparison.baseline.runIds).toEqual([second.id]);
    expect(comparison.counts).toMatchObject({ newly_failing: 1, still_failing: 1 });
    expect(compareView(second.id, { baseline: "auto", includeFlaky: false }).comparison!.baseline.runIds).toEqual([first.id]);
  });
});

describe("baselineCandidates", () => {
  test("groups runs of the project for the picker, newest first, with the suggestion on top", () => {
    const t = uniqueTest();
    const TAG = `pick-${t.slice(5)}`;
    const branch = branchName();
    const suggested = makeRun({ testKey: t, at: 1, branch: "main", commit: sha("a"), checks: [["x", "pass"]], title: `${TAG} suggested` });
    const sameBranch = makeRun({ testKey: uniqueTest(), at: 2, branch, commit: sha("d"), checks: [["x", "pass"]], title: `${TAG} branch` });
    const sameTest = makeRun({ testKey: t, at: 3, branch: "release/1", commit: sha("e"), checks: [["x", "pass"]], title: `${TAG} test` });
    const other = makeRun({ testKey: uniqueTest(), at: 4, branch: "elsewhere", commit: sha("f"), platform: "ios", checks: [["x", "pass"]], title: `${TAG} other` });
    makeRun({ testKey: t, at: 5, branch: "main", commit: sha("a"), checks: [], title: `${TAG} empty` });
    const head = makeRun({ testKey: t, at: 9, branch, commit: sha("b"), checks: [["x", "fail"]], title: `${TAG} head` });

    const { candidates } = baselineCandidates(head.id, { q: TAG, limit: 30 });
    expect(candidates.map((c) => [c.run.id, c.group])).toEqual([
      [suggested.id, "suggested"],
      [sameBranch.id, "branch"],
      [sameTest.id, "test"],
      [other.id, "other"],
    ]);
    expect(candidates[0]).toMatchObject({ suggested: true, platformMismatch: false });
    expect(candidates[0]!.reason).toContain("default branch main");
    expect(candidates[3]).toMatchObject({ suggested: false, platformMismatch: true });
    expect(candidates[3]!.reason).toContain("iOS");

    expect(baselineCandidates(head.id, { q: TAG, limit: 2 }).candidates).toHaveLength(2);
    expect(baselineCandidates(head.id, { q: "no such run", limit: 30 }).candidates).toEqual([]);
    // Several words narrow the list: each word must match some field (title, branch, …), in any order.
    expect(baselineCandidates(head.id, { q: `release/1 ${TAG}`, limit: 30 }).candidates.map((c) => c.run.id)).toEqual([sameTest.id]);
    expect(baselineCandidates(head.id, { q: `${TAG} release/1`, limit: 30 }).candidates.map((c) => c.run.id)).toEqual([sameTest.id]);
    expect(() => baselineCandidates("missing", { limit: 5 })).toThrow(expect.objectContaining({ status: 404 }));
  });

  test("runs on the default or PR base branch form the base group", () => {
    const tag = `bg-${uniqueTest().slice(5)}`;
    const head = makeRun({ testKey: uniqueTest(), at: 9, branch: branchName(), prBase: "develop", checks: [["x", "fail"]], title: `${tag} head` });
    const onDevelop = makeRun({ testKey: uniqueTest(), at: 1, branch: "develop", checks: [["x", "pass"]], title: `${tag} one` });
    const onMain = makeRun({ testKey: uniqueTest(), at: 2, branch: "main", checks: [["x", "pass"]], title: `${tag} two` });
    const groups = baselineCandidates(head.id, { q: tag, limit: 30 }).candidates.map((c) => [c.run.id, c.group]);
    expect(groups).toEqual([[onMain.id, "base"], [onDevelop.id, "base"]]);
  });
});
