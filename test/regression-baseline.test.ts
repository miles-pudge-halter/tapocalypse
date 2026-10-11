import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { defaultBranch, foldSnapshot, noBaselineReason, refreshDefaultBranch, resolveBaseline, setDefaultBranchDeps } from "../src/regression/baseline";
import { cleanupRuns, makeRun, uniqueTest, useGit } from "./support/regression";

const gitFor = (answers: Record<string, string | null>) => async (_cwd: string, args: string[]) => answers[args.join(" ")] ?? null;
const ORIGIN_HEAD = "symbolic-ref --short refs/remotes/origin/HEAD";

beforeEach(() => useGit(gitFor({ [ORIGIN_HEAD]: "origin/main" })));
afterEach(() => cleanupRuns());
afterAll(() => setDefaultBranchDeps());

describe("defaultBranch", () => {
  const repo = (name: string) => ({ repoPath: `/nowhere/${name}-${Math.random()}` });

  test("the project setting wins without asking git", () => {
    let calls = 0;
    setDefaultBranchDeps({ git: async () => (calls++, "origin/main") });
    expect(defaultBranch({ ...repo("a"), defaultBranch: "develop" })).toBe("develop");
    expect(calls).toBe(0);
  });

  test("never waits for git: unknown until the background detection lands, then served from the cache", async () => {
    const gate = Promise.withResolvers<string | null>();
    setDefaultBranchDeps({ git: () => gate.promise });
    const project = repo("pending");
    expect(defaultBranch(project)).toBeNull();
    gate.resolve("origin/trunk");
    await refreshDefaultBranch(project);
    expect(defaultBranch(project)).toBe("trunk");
  });

  test("falls back to origin/HEAD without the remote prefix, then to a local main or master", async () => {
    expect(await refreshDefaultBranch(repo("b"))).toBe("main");
    setDefaultBranchDeps({ git: gitFor({ "rev-parse --verify --quiet refs/heads/master": "abc" }) });
    const c = repo("c");
    expect(await refreshDefaultBranch(c)).toBe("master");
    expect(defaultBranch(c)).toBe("master");
    setDefaultBranchDeps({ git: gitFor({}) });
    const d = repo("d");
    expect(await refreshDefaultBranch(d)).toBeNull();
    expect(defaultBranch(d)).toBeNull();
  });

  test("the git answer is cached per repo for ten minutes; an expired answer is served while it refreshes in the background", async () => {
    let now = 1_000_000;
    let calls = 0;
    let answer = "origin/trunk";
    setDefaultBranchDeps({ git: async () => (calls++, answer), now: () => now });
    const project = repo("e");
    defaultBranch(project);
    await refreshDefaultBranch(project);
    expect(defaultBranch(project)).toBe("trunk");
    now += 9 * 60_000;
    expect(defaultBranch(project)).toBe("trunk");
    expect(calls).toBe(1);
    now += 2 * 60_000;
    answer = "origin/develop";
    expect(defaultBranch(project)).toBe("trunk");
    await refreshDefaultBranch(project);
    expect(calls).toBe(2);
    expect(defaultBranch(project)).toBe("develop");
  });
});

describe("dirty working trees", () => {
  test("a dirty run is its own code: it never folds into, or takes in, a same-commit snapshot", () => {
    const t = uniqueTest();
    const commit = "a".repeat(40);
    const dirtyOlder = makeRun({ testKey: t, at: 1, branch: "main", commit, dirty: true, checks: [["x", "pass"]] });
    const clean = makeRun({ testKey: t, at: 2, branch: "main", commit, checks: [["y", "pass"]] });
    const head = makeRun({ testKey: t, at: 3, branch: "feature/z", commit: "b".repeat(40), checks: [["x", "pass"]] });
    // Clean primary: the dirty run at the same commit stays out.
    expect(resolveBaseline(head, { baseline: "auto" })).toMatchObject({ primaryRunId: clean.id, runIds: [clean.id], kind: "run" });
    const dirtyNewer = makeRun({ testKey: t, at: 2.5, branch: "main", commit, dirty: true, checks: [["z", "pass"]] });
    // Dirty primary: the clean run at the same commit stays out.
    expect(resolveBaseline(head, { baseline: "auto" })).toMatchObject({ primaryRunId: dirtyNewer.id, runIds: [dirtyNewer.id], sameCommit: false });
    void dirtyOlder;
  });
});

describe("resolveBaseline tiers", () => {
  test("the PR base branch beats the default branch, which beats the same branch, which beats any branch", () => {
    const t = uniqueTest();
    makeRun({ testKey: t, at: 1, branch: "release/9", commit: "a".repeat(40), checks: [["w", "pass"]] });
    makeRun({ testKey: t, at: 2, branch: "feature/x", commit: "b".repeat(40), checks: [["w", "pass"]] });
    const main = makeRun({ testKey: t, at: 3, branch: "main", commit: "c".repeat(40), checks: [["w", "pass"]] });
    const develop = makeRun({ testKey: t, at: 4, branch: "develop", commit: "d".repeat(40), checks: [["w", "pass"]] });

    const prHead = makeRun({ testKey: t, at: 10, branch: "feature/x", commit: "e".repeat(40), prBase: "develop", checks: [["w", "fail"]] });
    expect(resolveBaseline(prHead, { baseline: "auto" })).toMatchObject({ tier: "pr-base", primaryRunId: develop.id, branch: "develop", auto: true });

    const plain = makeRun({ testKey: t, at: 11, branch: "feature/x", commit: "f".repeat(40), checks: [["w", "fail"]] });
    expect(resolveBaseline(plain, { baseline: "auto" })).toMatchObject({ tier: "default-branch", primaryRunId: main.id });

    const lonely = uniqueTest();
    const s = makeRun({ testKey: lonely, at: 1, branch: "feature/x", commit: "1".repeat(40), checks: [["w", "pass"]] });
    const h = makeRun({ testKey: lonely, at: 2, branch: "feature/x", commit: "2".repeat(40), checks: [["w", "fail"]] });
    expect(resolveBaseline(h, { baseline: "auto" })).toMatchObject({ tier: "same-branch", primaryRunId: s.id });

    const far = uniqueTest();
    const o = makeRun({ testKey: far, at: 1, branch: "release/9", commit: "3".repeat(40), checks: [["w", "pass"]] });
    const fh = makeRun({ testKey: far, at: 2, branch: "feature/x", commit: "4".repeat(40), checks: [["w", "fail"]] });
    expect(resolveBaseline(fh, { baseline: "auto" })).toMatchObject({ tier: "any", primaryRunId: o.id });
  });

  test("a head on the default branch compares with its own earlier runs, not with itself", () => {
    const t = uniqueTest();
    const earlier = makeRun({ testKey: t, at: 1, branch: "main", commit: "a".repeat(40), checks: [["w", "pass"]] });
    const head = makeRun({ testKey: t, at: 2, branch: "main", commit: "b".repeat(40), checks: [["w", "fail"]] });
    expect(resolveBaseline(head, { baseline: "auto" })).toMatchObject({ tier: "same-branch", primaryRunId: earlier.id });
  });

  test("never crosses platforms, and says so when only the other platform has history", () => {
    const t = uniqueTest();
    makeRun({ testKey: t, at: 1, platform: "ios", branch: "main", commit: "a".repeat(40), checks: [["w", "pass"]] });
    const head = makeRun({ testKey: t, at: 2, platform: "android", branch: "main", commit: "b".repeat(40), checks: [["w", "fail"]] });
    expect(resolveBaseline(head, { baseline: "auto" })).toBeNull();
    expect(noBaselineReason(head)).toBe("Earlier runs of this test ran on iOS only.");
    const fresh = makeRun({ testKey: uniqueTest(), at: 3, checks: [["w", "pass"]] });
    expect(noBaselineReason(fresh)).toBeNull();
  });

  test("skips later, active, superseded, check-less and lineage runs", () => {
    const t = uniqueTest();
    const good = makeRun({ testKey: t, at: 1, branch: "main", commit: "a".repeat(40), checks: [["w", "pass"]] });
    makeRun({ testKey: t, at: 2, branch: "main", commit: "b".repeat(40), status: "running", verdict: null, checks: [["w", "pass"]] });
    makeRun({ testKey: t, at: 3, branch: "main", commit: "c".repeat(40), retriedBy: "someone-else", checks: [["w", "pass"]] });
    makeRun({ testKey: t, at: 4, branch: "main", commit: "d".repeat(40), checks: [] });
    makeRun({ testKey: t, at: 5, branch: "main", commit: "e".repeat(40), checks: [["w", "pending"]] });
    const parent = makeRun({ testKey: t, at: 6, branch: "main", commit: "f".repeat(40), checks: [["w", "pass"]] });
    const head = makeRun({ testKey: t, at: 7, branch: "main", commit: "9".repeat(40), rerunOf: parent.id, checks: [["w", "fail"]] });
    makeRun({ testKey: t, at: 8, branch: "main", commit: "8".repeat(40), checks: [["w", "pass"]] });
    expect(resolveBaseline(head, { baseline: "auto" })?.primaryRunId).toBe(good.id);
  });
});

describe("resolveBaseline within a tier", () => {
  test("prefers a different commit; when only the same commit exists it says so", () => {
    const t = uniqueTest();
    makeRun({ testKey: t, at: 1, branch: "main", commit: "a".repeat(40), checks: [["w", "pass"]] });
    const different = makeRun({ testKey: t, at: 0, branch: "main", commit: "b".repeat(40), checks: [["w", "pass"]] });
    const head = makeRun({ testKey: t, at: 2, branch: "main", commit: "a".repeat(40), checks: [["w", "fail"]] });
    expect(resolveBaseline(head, { baseline: "auto" })).toMatchObject({ primaryRunId: different.id, sameCommit: false });

    const t2 = uniqueTest();
    const only = makeRun({ testKey: t2, at: 1, branch: "main", commit: "a".repeat(40), checks: [["w", "pass"]] });
    const head2 = makeRun({ testKey: t2, at: 2, branch: "main", commit: "a".repeat(40), checks: [["w", "fail"]] });
    expect(resolveBaseline(head2, { baseline: "auto" })).toMatchObject({ primaryRunId: only.id, sameCommit: true });
  });

  test("restricts to the same device when one exists, otherwise flags deviceChanged", () => {
    const t = uniqueTest();
    const sameDevice = makeRun({ testKey: t, at: 1, branch: "main", commit: "a".repeat(40), device: "Pixel 9", checks: [["w", "pass"]] });
    makeRun({ testKey: t, at: 2, branch: "main", commit: "b".repeat(40), device: "Pixel 3", checks: [["w", "pass"]] });
    const head = makeRun({ testKey: t, at: 3, branch: "main", commit: "c".repeat(40), device: "Pixel 9", checks: [["w", "fail"]] });
    expect(resolveBaseline(head, { baseline: "auto" })).toMatchObject({ primaryRunId: sameDevice.id, deviceChanged: false });

    const moved = makeRun({ testKey: t, at: 4, branch: "main", commit: "d".repeat(40), device: "Tablet", checks: [["w", "fail"]] });
    expect(resolveBaseline(moved, { baseline: "auto" })).toMatchObject({ deviceChanged: true });
  });

  test("flags harness, model and build differences without blocking", () => {
    const t = uniqueTest();
    makeRun({ testKey: t, at: 1, branch: "main", commit: "a".repeat(40), harness: "omp", model: "m1", build: { versionName: "1.0", versionCode: "1" }, checks: [["w", "pass"]] });
    const head = makeRun({ testKey: t, at: 2, branch: "main", commit: "b".repeat(40), harness: "claude", model: "m2", build: { versionName: "1.1", versionCode: "2" }, checks: [["w", "pass"]] });
    expect(resolveBaseline(head, { baseline: "auto" })).toMatchObject({ harnessChanged: true, modelChanged: true, buildChanged: true });
  });

  test("folds every finished run at the baseline commit, the newest decisive result winning; other commits stay out", () => {
    const t = uniqueTest();
    makeRun({ testKey: t, at: 1, branch: "main", commit: "1".repeat(40), checks: [["w", "fail"], ["z", "pass"]] });
    const round1 = makeRun({ testKey: t, at: 2, branch: "main", commit: "2".repeat(40), checks: [["w", "blocked"], ["y", "pass"], ["z", "fail"]] });
    const round2 = makeRun({ testKey: t, at: 3, branch: "main", commit: "2".repeat(40), checks: [["w", "pass"], ["z", "blocked"]] });
    const head = makeRun({ testKey: t, at: 4, branch: "main", commit: "3".repeat(40), checks: [["w", "pass"]] });

    const baseline = resolveBaseline(head, { baseline: "auto" });
    expect(baseline).toMatchObject({ kind: "snapshot", primaryRunId: round2.id, commit: "2".repeat(40) });
    expect(baseline?.runIds).toEqual([round2.id, round1.id]);
    expect(baseline?.reason).toContain("2 runs at 2222222");

    const folded = foldSnapshot([round2, round1]);
    const w = folded.get(`${t}/w`);
    const z = folded.get(`${t}/z`);
    expect([w?.check.status, w?.run.id]).toEqual(["pass", round2.id]);
    // z: round 2 only blocked it, so the newest decisive result (round 1's fail) stands.
    expect([z?.check.status, z?.run.id]).toEqual(["fail", round1.id]);
    expect(folded.get(`${t}/y`)?.run.id).toBe(round1.id);
  });
});

describe("explicit baseline", () => {
  test("is that run only, with mismatch flags; unknown, same-run and cross-project picks are rejected", () => {
    const t = uniqueTest();
    const ios = makeRun({ testKey: t, at: 1, platform: "ios", branch: "main", commit: "a".repeat(40), checks: [["w", "pass"]] });
    const head = makeRun({ testKey: t, at: 2, platform: "android", branch: "main", commit: "a".repeat(40), checks: [["w", "fail"]] });
    const baseline = resolveBaseline(head, { baseline: ios.id });
    expect(baseline).toMatchObject({ auto: false, tier: "explicit", kind: "run", runIds: [ios.id], platformMismatch: true, sameCommit: true });

    expect(() => resolveBaseline(head, { baseline: "no-such-run" })).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => resolveBaseline(head, { baseline: head.id })).toThrow(expect.objectContaining({ status: 400, code: "same_run" }));
    const foreign = makeRun({ testKey: t, at: 3, projectId: "another-project", checks: [["w", "pass"]] });
    expect(() => resolveBaseline(head, { baseline: foreign.id })).toThrow(expect.objectContaining({ status: 400, code: "different_project" }));
  });
});
