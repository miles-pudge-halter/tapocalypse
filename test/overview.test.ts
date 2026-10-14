import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createProject, deleteProject, getProject } from "../src/projects/registry";
import { overviewRoute, projectOverview, projectRefs, releaseView } from "../src/overview";
import { cleanupRuns, makeRun, type RunSpec, updateRun } from "./support/regression";

/** An isolated project: nothing else writes runs into it, so every test sees only its own fixtures. */
const OV = "overview-iso";
const EMPTY = "overview-empty";
const DAY = 24 * 60;

beforeAll(() => {
  const repoPath = getProject("test-proj")!.repoPath;
  for (const [id, name] of [[OV, "Acme Shop"], [EMPTY, "Acme Empty"]] as const) {
    createProject({ id, name, repoPath, defaultPackage: "com.example.app", defaultPlatform: "android", defaultBranch: "main" });
  }
});
afterEach(() => cleanupRuns());
afterAll(() => {
  deleteProject(OV, []);
  deleteProject(EMPTY, []);
});

interface Spec extends Omit<RunSpec, "projectId" | "build"> {
  version?: string;
  machine?: string;
  uploader?: string | null;
}

/** A finished run of the isolated project; `machine` marks it as uploaded to a hub. */
function run(spec: Spec) {
  const { version, machine, uploader, ...rest } = spec;
  const made = makeRun({ title: `Test ${rest.testKey}`, ...rest, projectId: OV, ...(version ? { build: { versionName: version, versionCode: "1" } } : {}) });
  if (machine) {
    updateRun(made, (r) => {
      r.hub = { machine, uploader: uploader ?? null, receivedAt: made.createdAt, localProjectId: "local", clockSkewMs: null, contentHash: "h", clientVersion: "1", keys: { testKey: null, checks: {}, checkHints: null } };
    });
  }
  return made;
}

const sha = (c: string): string => c.repeat(40);

describe("projectRefs", () => {
  test("release is a run version or a branch with a release prefix, case-insensitively", () => {
    const names = ["release/2.4", "releases/2.5", "hotfix/2.4.1", "release-2.6", "Release/2.7", "main", "feature/release", "prerelease/1", "releasey/2"];
    names.forEach((branch, i) => run({ testKey: `t:${i}`, at: i, branch, checks: [["a", "pass"]] }));
    run({ testKey: "t:v", at: 20, version: "2.4.0", checks: [["a", "pass"]] });

    const refs = projectRefs(OV);
    const byName = new Map(refs.map((r) => [`${r.ref.kind}:${r.ref.name}`, r]));
    const released = names.filter((n) => byName.get(`branch:${n}`)!.release);
    expect(released).toEqual(["release/2.4", "releases/2.5", "hotfix/2.4.1", "release-2.6", "Release/2.7"]);
    expect(byName.get("version:2.4.0")!.release).toBe(true);
  });

  test("counts runs, spans, machines and the latest result per test and device", () => {
    run({ testKey: "t:a", at: 10, branch: "main", device: "Pixel 8", machine: "ann-mbp", checks: [["x", "fail"]], verdict: "FAIL" });
    run({ testKey: "t:a", at: 20, branch: "main", device: "Pixel 8", machine: "ben-pc", checks: [["x", "pass"]], verdict: "PASS" });
    run({ testKey: "t:a", at: 30, branch: "main", device: "Pixel 4", checks: [["x", "pass"]], verdict: "PASS WITH ISSUES" });
    run({ testKey: "t:b", at: 40, branch: "main", device: "Pixel 8", machine: "ann-mbp", checks: [["x", "blocked"]], verdict: "BLOCKED" });
    run({ testKey: "t:c", at: 50, branch: "main", device: "Pixel 8", checks: [["x", "pass"]], verdict: "PARTIAL" });
    run({ testKey: "t:d", at: 60, branch: "main", device: "Pixel 8", status: "running", verdict: null });

    const main = projectRefs(OV).find((r) => r.ref.name === "main")!;
    expect(main).toMatchObject({ runs: 5, isDefaultBranch: true, machines: ["ann-mbp", "ben-pc"] });
    expect(main.firstAt < main.lastAt).toBe(true);
    // t:a on Pixel 8 resolves to its newest run (PASS), the failed run before it is only an attempt.
    expect(main.lanes).toEqual({ pass: 1, issues: 1, fail: 0, blocked: 1, other: 1 });
  });

  test("a version with no commit and a branch are separate refs; versions come first, semver-descending", () => {
    run({ testKey: "t:a", at: 1, version: "2.9.0", branch: "feature/x", checks: [["x", "pass"]] });
    run({ testKey: "t:a", at: 2, version: "2.10.0", checks: [["x", "pass"]] });
    run({ testKey: "t:a", at: 3, branch: "feature/y", checks: [["x", "pass"]] });
    const order = projectRefs(OV).map((r) => `${r.ref.kind}:${r.ref.name}`);
    expect(order).toEqual(["version:2.10.0", "version:2.9.0", "branch:feature/y", "branch:feature/x"]);
  });

  test("a version's previous release is the next lower version, release candidates sorting before the plain version", () => {
    for (const [i, v] of ["2.3.9", "2.4.0-rc1", "2.4.0", "2.10.0"].entries()) run({ testKey: "t:a", at: i, version: v, checks: [["x", "pass"]] });
    const previous = Object.fromEntries(projectRefs(OV).map((r) => [r.ref.name, r.previous?.name ?? null]));
    expect(previous).toEqual({ "2.3.9": null, "2.4.0-rc1": "2.3.9", "2.4.0": "2.4.0-rc1", "2.10.0": "2.4.0" });
  });

  test("a release branch compares with the branch of the next lower embedded version, else the next older release branch", () => {
    run({ testKey: "t:a", at: 5, branch: "release/2.2", checks: [["x", "pass"]] });
    run({ testKey: "t:a", at: 1, branch: "release/2.4", checks: [["x", "pass"]] });
    run({ testKey: "t:a", at: 9, branch: "hotfix/2.3.1", checks: [["x", "pass"]] });
    run({ testKey: "t:a", at: 7, branch: "release-nightly", checks: [["x", "pass"]] });
    run({ testKey: "t:a", at: 8, branch: "feature/z", checks: [["x", "pass"]] });
    const previous = Object.fromEntries(projectRefs(OV).map((r) => [r.ref.name, r.previous?.name ?? null]));
    expect(previous).toMatchObject({
      "release/2.4": "hotfix/2.3.1", // lower embedded version, even though it is newer
      "hotfix/2.3.1": "release/2.2",
      "release/2.2": "release/2.4", // nothing lower: the release branch with the next older last activity
      "release-nightly": "release/2.2", // no embedded version: same fallback
      "feature/z": null,
    });
  });

  test("an unknown project is a 404", () => {
    expect(() => projectRefs("no-such-project")).toThrow(expect.objectContaining({ status: 404 }));
  });
});

/** v2.0.0 (earlier) and v2.1.0: one test regresses, one is fixed, one is blocked, one is gone, one is new. */
function twoReleases() {
  const prev = { version: "2.0.0", branch: "release/2.0" };
  const prevA = run({ ...prev, testKey: "t:a", at: 1, device: "Pixel 8", commit: sha("a"), checks: [["x", "pass"], ["y", "fail"], ["z", "pass"]], verdict: "FAIL" });
  run({ ...prev, testKey: "t:b", at: 2, device: "Pixel 8", commit: sha("a"), checks: [["x", "pass"]] });
  run({ ...prev, testKey: "t:c", at: 3, device: "iPhone 15", platform: "ios", commit: sha("a"), checks: [["x", "pass"]] });
  const cur = { version: "2.1.0", branch: "release/2.1" };
  const first = run({ ...cur, testKey: "t:a", at: 100, device: "Pixel 8", commit: sha("b"), machine: "ann-mbp", uploader: "ann@acme.test", checks: [["x", "fail"], ["y", "pass"], ["w", "pass"]], verdict: "FAIL" });
  const second = run({ ...cur, testKey: "t:a", at: 110, device: "Pixel 8", commit: sha("b"), machine: "ben-pc", rerunOf: first.id, checks: [["x", "fail"], ["y", "pass"], ["w", "pass"]], verdict: "FAIL" });
  const p4 = run({ ...cur, testKey: "t:a", at: 105, device: "Pixel 4", commit: sha("b"), machine: "ann-mbp", uploader: "ann@acme.test", checks: [["x", "pass"], ["y", "pass"], ["w", "pass"]] });
  const blocked = run({ ...cur, testKey: "t:b", at: 120, device: "Pixel 8", commit: sha("b"), checks: [["x", "blocked"]], verdict: "BLOCKED" });
  const ios = run({ ...cur, testKey: "t:d", at: 130, device: "iPhone 15", platform: "ios", commit: sha("b"), checks: [["x", "pass"]], verdict: "PASS WITH ISSUES" });
  return { prevA, first, second, p4, blocked, ios };
}

describe("releaseView", () => {
  test("folds every run of a test on a device into one cell with its attempts", () => {
    const { first, second, p4, blocked, ios } = twoReleases();
    const view = releaseView(OV, { kind: "version", name: "2.1.0" });

    expect(view).toMatchObject({
      project: { id: OV, name: "Acme Shop" },
      ref: { kind: "version", name: "2.1.0" },
      previous: { kind: "version", name: "2.0.0" },
      auto: true,
      runs: 5,
      machines: [{ name: "ann-mbp", uploader: "ann@acme.test" }, { name: "ben-pc", uploader: null }],
    });
    expect(view.span.firstAt < view.span.lastAt).toBe(true);
    expect(view.devices).toEqual([
      { key: "android:Pixel 4", name: "Pixel 4", platform: "android" },
      { key: "android:Pixel 8", name: "Pixel 8", platform: "android" },
      { key: "ios:iPhone 15", name: "iPhone 15", platform: "ios" },
    ]);

    const a = view.tests.find((t) => t.testKey === "t:a")!;
    expect(a.cells["android:Pixel 8"]!.latest.id).toBe(second.id);
    expect(a.cells["android:Pixel 8"]!.attempts.map((r) => r.id)).toEqual([second.id, first.id]);
    expect(a.cells["android:Pixel 4"]!.latest.id).toBe(p4.id);
    expect(a.cells["ios:iPhone 15"]).toBeNull();
    // the platform column shows the newest result across that platform's devices
    expect(a.platforms.android!.latest.id).toBe(second.id);
    expect(a.platforms.android!.attempts.map((r) => r.id)).toEqual([second.id, p4.id, first.id]);
    expect(a.platforms.ios).toBeUndefined();
    expect(a.worst).toBe("FAIL");
    expect(view.tests.find((t) => t.testKey === "t:b")!.cells["android:Pixel 8"]!.latest.id).toBe(blocked.id);
    expect(view.tests.find((t) => t.testKey === "t:d")!.cells["ios:iPhone 15"]!.latest.id).toBe(ios.id);
    // one folded cell per test x device: 4 cells, not 5 runs
    expect(view.summary).toEqual({ tests: 3, cells: 4, pass: 1, issues: 1, fail: 1, blocked: 1, other: 0 });
  });

  test("blockers list FAIL before BLOCKED, newly failing first, then the most recent", () => {
    const branch = "release/9.0";
    run({ testKey: "t:2", at: 10, branch: "main", device: "Pixel 8", commit: sha("a"), checks: [["x", "pass"]] });
    run({ testKey: "t:1", at: 50, branch, device: "Pixel 8", commit: sha("b"), checks: [["x", "fail"]], verdict: "FAIL" });
    run({ testKey: "t:2", at: 40, branch, device: "Pixel 8", commit: sha("b"), checks: [["x", "fail"]], verdict: "FAIL" });
    run({ testKey: "t:3", at: 60, branch, device: "Pixel 8", commit: sha("b"), checks: [["x", "fail"]], verdict: "FAIL" });
    run({ testKey: "t:4", at: 70, branch, device: "Pixel 8", commit: sha("b"), checks: [["x", "blocked"]], verdict: "BLOCKED" });
    run({ testKey: "t:5", at: 80, branch, device: "Pixel 8", commit: sha("b"), checks: [["x", "pass"]] });

    const view = releaseView(OV, { kind: "branch", name: branch });
    expect(view.blockers.map((b) => [b.testKey, b.cell.latest.verdict, b.cell.newlyFailing])).toEqual([
      ["t:2", "FAIL", 1],
      ["t:3", "FAIL", 0],
      ["t:1", "FAIL", 0],
      ["t:4", "BLOCKED", 0],
    ]);
    // blocked counts as its own tally and keeps its failing check visible in the brief
    expect(view.summary).toEqual({ tests: 5, cells: 5, pass: 1, issues: 0, fail: 3, blocked: 1, other: 0 });
    expect(view.blockers[3]!.cell.latest.failed).toEqual([{ id: "x", title: "Check x", status: "blocked" }]);
    // rows: FAIL tests first, then BLOCKED, all-pass last
    expect(view.tests.map((t) => t.testKey)).toEqual(["t:1", "t:2", "t:3", "t:4", "t:5"]);
  });

  test("failed checks in a brief list failures before blockers, at most three, and count the rest", () => {
    const r = run({
      testKey: "t:1", at: 1, branch: "release/9.1", device: "Pixel 8", verdict: "FAIL",
      checks: [["a", "blocked"], ["b", "fail"], ["c", "fail"], ["d", "pass"], ["e", "fail"], ["f", "fail"]],
    });
    const brief = releaseView(OV, { kind: "branch", name: "release/9.1" }).blockers[0]!.cell.latest;
    expect(brief.id).toBe(r.id);
    expect(brief.failed.map((c) => c.id)).toEqual(["b", "c", "e"]);
    expect(brief.failedMore).toBe(2);
  });

  test("a chosen release replaces the automatic previous one", () => {
    twoReleases();
    run({ testKey: "t:a", at: 200, version: "1.0.0", checks: [["x", "pass"]] });
    const auto = releaseView(OV, { kind: "version", name: "2.1.0" });
    const chosen = releaseView(OV, { kind: "version", name: "2.1.0", against: "version:1.0.0" });
    expect([auto.previous?.name, auto.auto]).toEqual(["2.0.0", true]);
    expect([chosen.previous?.name, chosen.auto]).toEqual(["1.0.0", false]);
    expect(releaseView(OV, { kind: "version", name: "2.1.0", against: "auto" }).auto).toBe(true);
    expect(releaseView(OV, { kind: "branch", name: "release/2.0", against: "branch:release/2.1" }).previous).toEqual({ kind: "branch", name: "release/2.1" });
  });

  test("the first release has no previous", () => {
    run({ testKey: "t:a", at: 1, version: "1.0.0", checks: [["x", "pass"]] });
    expect(releaseView(OV, { kind: "version", name: "1.0.0" })).toMatchObject({ previous: null, auto: true, changes: null, untested: [] });
  });

  test("an unknown release, an unknown comparison or comparing with itself is refused", () => {
    twoReleases();
    expect(() => releaseView(OV, { kind: "version", name: "9.9.9" })).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => releaseView(OV, { kind: "version", name: "2.1.0", against: "version:9.9.9" })).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => releaseView(OV, { kind: "version", name: "2.1.0", against: "version:2.1.0" })).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => releaseView(OV, { kind: "version", name: "2.1.0", against: "tag:1" })).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => releaseView("no-such-project", { kind: "version", name: "2.1.0" })).toThrow(expect.objectContaining({ status: 404 }));
  });

  test("changes against the previous release use the regression transitions, and lanes that did not run are listed", () => {
    const { prevA, second } = twoReleases();
    const view = releaseView(OV, { kind: "version", name: "2.1.0" });

    expect(view.untested).toEqual([{ testKey: "t:c", title: "Test t:c", platform: "ios" }]);
    expect(view.changes!.counts).toEqual({ newly_failing: 1, fixed: 1, flaky: 0, still_failing: 0, unchanged: 0, changed: 1, new: 2, removed: 2, pending: 0 });
    const items = Object.fromEntries(view.changes!.items.map((i) => [i.checkKey, i]));
    expect(items["t:a/x"]).toEqual({
      transition: "newly_failing",
      checkKey: "t:a/x",
      title: "Check x",
      testKey: "t:a",
      testTitle: "Test t:a",
      platform: "android",
      current: { runId: second.id, checkId: "x", status: "fail" },
      previous: { runId: prevA.id, checkId: "x", status: "pass" },
    });
    expect(items["t:a/y"]!.transition).toBe("fixed");
    expect(items["t:a/w"]).toMatchObject({ transition: "new", previous: null });
    expect(items["t:a/z"]).toMatchObject({ transition: "removed", current: null, previous: { runId: prevA.id, status: "pass" } });
    expect(items["t:b/x"]!.transition).toBe("changed"); // pass -> blocked
    expect(items["t:c/x"]).toMatchObject({ transition: "removed", current: null, platform: "ios", testTitle: "Test t:c" });
    expect(items["t:d/x"]).toMatchObject({ transition: "new", previous: null });
  });

  test("a check new in both the Android and the iOS lane counts once; the lanes keep their own rows", () => {
    run({ version: "3.0.0", testKey: "t:a", at: 1, device: "Pixel 8", checks: [["x", "pass"]] });
    run({ version: "3.1.0", testKey: "t:a", at: 10, device: "Pixel 8", checks: [["x", "pass"]] });
    run({ version: "3.1.0", testKey: "t:e", at: 11, device: "Pixel 8", checks: [["n1", "pass"], ["n2", "pass"]] });
    run({ version: "3.1.0", testKey: "t:e", at: 12, device: "iPhone 15", platform: "ios", checks: [["n1", "pass"], ["n2", "pass"]] });
    const view = releaseView(OV, { kind: "version", name: "3.1.0" });
    expect(view.changes!.items.filter((i) => i.transition === "new")).toHaveLength(4);
    expect(view.changes!.counts.new).toBe(2);
    expect(projectOverview(OV, { now: new Date(2026, 5, 1) }).latestRelease!.counts.new).toBe(2);
  });

  test("the cell of a re-run carries how many checks newly fail against its own baseline", () => {
    const { second } = twoReleases();
    const cell = releaseView(OV, { kind: "version", name: "2.1.0" }).tests.find((t) => t.testKey === "t:a")!.cells["android:Pixel 8"]!;
    expect(cell.latest.id).toBe(second.id);
    expect(cell.newlyFailing).toBe(1);
  });
});

describe("projectRefs against the previous release", () => {
  test("counts the checks that newly fail; the first release has none", () => {
    twoReleases();
    const refs = Object.fromEntries(projectRefs(OV).filter((r) => r.ref.kind === "version").map((r) => [r.ref.name, r.newlyFailing]));
    expect(refs).toEqual({ "2.1.0": 1, "2.0.0": null });
  });
});

/** Minutes after the fixture epoch for `day` (0 = 1 Mar 2026) at about midday UTC, so the local date is the same in every sane timezone. */
const at = (day: number, minute = 0): number => day * DAY + 120 + minute;
const NOW = new Date(2026, 2, 5, 12, 0, 0);

/** Three tests across a 7-day window; an older week gives the pass-rate delta. */
function weekOfRuns() {
  const old = (day: number, verdict: "PASS" | "FAIL", extra: Partial<Spec> = {}) =>
    run({ testKey: "t:a", at: at(day), device: "Pixel 8", checks: [["x", verdict === "PASS" ? "pass" : "fail"]], verdict, ...extra });
  const first = old(-7, "PASS", { machine: "ben-pc", uploader: null });
  old(-6, "PASS");
  old(-5, "FAIL");
  old(-4, "FAIL");
  const passed = old(0, "PASS");
  const failed = old(2, "FAIL");
  run({ testKey: "t:a", at: at(1), device: "iPhone 15", platform: "ios", checks: [["x", "pass"]] });
  const issues = run({ testKey: "t:b", at: at(1, 30), device: "Pixel 8", checks: [["x", "pass"]], verdict: "PASS WITH ISSUES" });
  const blocked = run({ testKey: "t:b", at: at(3), device: "Pixel 8", checks: [["x", "blocked"]], verdict: "BLOCKED" });
  const cPass = run({ testKey: "t:c", at: at(2, 30), device: "Pixel 8", checks: [["x", "pass"]] });
  const errored = run({ testKey: "t:c", at: at(3, 30), device: "Pixel 8", status: "error", verdict: null, machine: "ann-mbp", uploader: "ann@acme.test" });
  return { first, passed, failed, issues, blocked, cPass, errored };
}

describe("projectOverview", () => {
  test("pass rate, trend and counts of a known week", async () => {
    weekOfRuns();
    const view = projectOverview(OV, { days: 7, now: NOW });

    expect(view.project).toEqual({
      id: OV,
      name: "Acme Shop",
      hubKey: null,
      defaultBranch: "main",
      firstSeenAt: expect.any(String),
      lastUploadAt: expect.any(String),
      lastUploadBy: { machine: "ann-mbp", uploader: "ann@acme.test" },
    });
    expect(view.ref).toBeNull();
    expect(view.days).toBe(7);
    expect(view.trend.map((d) => [d.date, d.runs, d.pass, d.issues, d.fail, d.other])).toEqual([
      ["2026-02-27", 0, 0, 0, 0, 0],
      ["2026-02-28", 0, 0, 0, 0, 0],
      ["2026-03-01", 1, 1, 0, 0, 0],
      ["2026-03-02", 2, 1, 1, 0, 0],
      ["2026-03-03", 2, 1, 0, 1, 0],
      ["2026-03-04", 2, 0, 0, 0, 2], // blocked and no-verdict runs are "other"
      ["2026-03-05", 0, 0, 0, 0, 0],
    ]);
    // 3 passes of 5 decided runs this week; 2 of 4 the week before
    expect(view.passRate).toEqual({ current: 0.6, previous: 0.5, pass: 3, decided: 5 });
    expect(view.counts).toEqual({ newlyFailing: 1, newlyFailingTests: 1, flaky: 0, suspects: 0, failingNow: 1, blockedNow: 1, tests: 3 });
    expect(view.latestRelease).toBeNull();
  });

  test("a lane is a test on a platform: its latest verdict, history and newer runs without one", () => {
    const { failed, blocked, cPass, errored, first } = weekOfRuns();
    const lanes = projectOverview(OV, { days: 7, now: NOW }).lanes;
    expect(lanes.map((l) => [l.testKey, l.title, l.checks, Object.keys(l.platforms)])).toEqual([
      ["t:a", "Test t:a", 1, ["android", "ios"]],
      ["t:b", "Test t:b", 1, ["android"]],
      ["t:c", "Test t:c", 1, ["android"]],
    ]);

    const a = lanes[0]!.platforms.android!;
    expect(a.latest.id).toBe(failed.id);
    expect(a.history.map((h) => h.verdict)).toEqual(["PASS", "PASS", "FAIL", "FAIL", "PASS", "FAIL"]);
    expect(a.history[0]!.id).toBe(first.id);
    expect([a.newlyFailing, a.flaky, a.newerWithoutVerdict]).toEqual([1, 0, 0]);
    expect(lanes[0]!.platforms.ios!.latest.verdict).toBe("PASS");
    expect(lanes[1]!.platforms.android!.latest.id).toBe(blocked.id);
    // the errored run is newer but has no verdict: the lane keeps showing the last real result
    const c = lanes[2]!.platforms.android!;
    expect([c.latest.id, c.newerWithoutVerdict]).toEqual([cPass.id, 1]);
    expect(c.history.at(-1)!.id).toBe(errored.id);
  });

  test("recent holds the eight newest finished runs", () => {
    const { errored, blocked } = weekOfRuns();
    const recent = projectOverview(OV, { days: 7, now: NOW }).recent;
    expect(recent).toHaveLength(8);
    expect(recent.slice(0, 2).map((r) => r.id)).toEqual([errored.id, blocked.id]);
  });

  test("flaky checks and suspects are counted, and a lane says how many of its checks flip", () => {
    const outcomes: ["pass" | "fail", "pass" | "fail"][] = [["pass", "pass"], ["fail", "pass"], ["pass", "pass"], ["fail", "fail"]];
    for (const [i, [x, y]] of outcomes.entries()) {
      run({ testKey: "t:f", at: at(i), device: "Pixel 8", commit: sha("c"), checks: [["x", x], ["y", y]], verdict: x === "pass" && y === "pass" ? "PASS" : "FAIL" });
    }
    const view = projectOverview(OV, { days: 7, now: NOW });
    // x flips three times on the same code (flaky); y flips once (suspect)
    expect(view.counts).toMatchObject({ flaky: 1, suspects: 1 });
    expect(view.lanes[0]!.platforms.android!.flaky).toBe(2);
  });

  test("scoped to a ref, only that ref's runs count; a ref nobody ran is a 404", () => {
    weekOfRuns();
    run({ testKey: "t:z", at: at(1), branch: "feature/login", device: "Pixel 8", checks: [["x", "fail"]], verdict: "FAIL" });
    const scoped = projectOverview(OV, { ref: { kind: "branch", name: "feature/login" }, days: 7, now: NOW });
    expect(scoped.ref).toEqual({ kind: "branch", name: "feature/login" });
    expect(scoped.lanes.map((l) => l.testKey)).toEqual(["t:z"]);
    expect(scoped.counts).toMatchObject({ tests: 1, failingNow: 1, blockedNow: 0 });
    expect(scoped.passRate).toEqual({ current: 0, previous: null, pass: 0, decided: 1 });
    expect(scoped.recent).toHaveLength(1);
    expect(() => projectOverview(OV, { ref: { kind: "version", name: "0.0.1" } })).toThrow(expect.objectContaining({ status: 404 }));
  });

  test("a project without runs is an empty overview, not an error", () => {
    const view = projectOverview(EMPTY, { days: 3, now: NOW });
    expect(view).toMatchObject({
      project: { id: EMPTY, name: "Acme Empty", firstSeenAt: null, lastUploadAt: null, lastUploadBy: null },
      passRate: { current: null, previous: null, pass: 0, decided: 0 },
      counts: { newlyFailing: 0, newlyFailingTests: 0, flaky: 0, suspects: 0, failingNow: 0, blockedNow: 0, tests: 0 },
      lanes: [],
      latestRelease: null,
      recent: [],
    });
    expect(view.trend.map((d) => d.runs)).toEqual([0, 0, 0]);
    expect(projectRefs(EMPTY)).toEqual([]);
  });

  test("a run without a test key is in the trend but in no lane", () => {
    const keyless = run({ testKey: "t:a", at: at(0), device: "Pixel 8", checks: [["x", "pass"]] });
    updateRun(keyless, (r) => {
      r.testKey = null;
    });
    const view = projectOverview(OV, { days: 7, now: NOW });
    expect(view.trend.find((d) => d.date === "2026-03-01")!.runs).toBe(1);
    expect(view.lanes).toEqual([]);
    expect(view.recent).toHaveLength(1);
  });

  test("an unknown project is a 404", () => {
    expect(() => projectOverview("no-such-project")).toThrow(expect.objectContaining({ status: 404 }));
  });
});

describe("latest release on the overview", () => {
  test("is the release with the newest activity and says what changed since its previous one", () => {
    const { second } = twoReleases();
    const view = projectOverview(OV, { now: new Date(2026, 5, 1) });
    expect(view.latestRelease).toMatchObject({ ref: { kind: "version", name: "2.1.0" }, previous: { kind: "version", name: "2.0.0" } });
    expect(view.latestRelease!.counts).toMatchObject({ newly_failing: 1, fixed: 1, changed: 1, new: 2, removed: 2 });
    expect(view.latestRelease!.top.map((i) => [i.checkKey, i.current!.runId])).toEqual([["t:a/x", second.id]]);
  });

  test("scoped to a release it is that release, even when a newer one exists", () => {
    twoReleases();
    run({ testKey: "t:a", at: 500, version: "2.2.0", checks: [["x", "pass"]] });
    const unscoped = projectOverview(OV, { now: new Date(2026, 5, 1) });
    expect(unscoped.latestRelease!.ref.name).toBe("2.2.0");
    const scoped = projectOverview(OV, { ref: { kind: "version", name: "2.0.0" }, now: new Date(2026, 5, 1) });
    expect(scoped.latestRelease).toMatchObject({ ref: { name: "2.0.0" }, previous: null, top: [] });
  });

  test("lists at most five newly failing checks, newest first", () => {
    for (let i = 0; i < 7; i++) {
      run({ testKey: `t:${i}`, at: at(0, i), version: "1.0.0", device: "Pixel 8", checks: [["x", "pass"]] });
      run({ testKey: `t:${i}`, at: at(1, i), version: "1.1.0", device: "Pixel 8", checks: [["x", "fail"]], verdict: "FAIL" });
    }
    const top = projectOverview(OV, { now: new Date(2026, 5, 1) }).latestRelease!.top;
    expect(top.map((i) => i.testKey)).toEqual(["t:6", "t:5", "t:4", "t:3", "t:2"]);
  });

  test("a branch that is not a release does not become one", () => {
    run({ testKey: "t:a", at: 1, branch: "feature/x", checks: [["x", "pass"]] });
    expect(projectOverview(OV, { now: new Date(2026, 5, 1) }).latestRelease).toBeNull();
  });
});

describe("overviewRoute", () => {
  const get = (path: string) => overviewRoute(new Request(`http://localhost${path}`), new URL(`http://localhost${path}`));

  test("serves refs, the overview with its ref and days, and a release with the name decoded", async () => {
    twoReleases();
    const refs = (await (await get(`/api/projects/${OV}/refs`))!.json()) as { refs: { ref: { name: string } }[] };
    expect(refs.refs.map((r) => r.ref.name)).toContain("2.1.0");

    const overview = (await (await get(`/api/projects/${OV}/overview?ref=branch:release/2.1&days=5`))!.json()) as { ref: unknown; days: number };
    expect(overview).toMatchObject({ ref: { kind: "branch", name: "release/2.1" }, days: 5 });

    const release = (await (await get(`/api/projects/${OV}/releases/branch/release%2F2.1?against=branch:release/2.0`))!.json()) as { ref: unknown; previous: unknown; auto: boolean };
    expect(release).toMatchObject({ ref: { kind: "branch", name: "release/2.1" }, previous: { kind: "branch", name: "release/2.0" }, auto: false });
  });

  test("is not its business for other paths or methods", async () => {
    expect(await get("/api/projects")).toBeNull();
    expect(await get(`/api/projects/${OV}/flaky`)).toBeNull();
    expect(await overviewRoute(new Request(`http://localhost/api/projects/${OV}/refs`, { method: "POST" }), new URL(`http://localhost/api/projects/${OV}/refs`))).toBeNull();
  });

  test("an unknown ref is told apart from an unknown project", async () => {
    twoReleases();
    await expect(get(`/api/projects/${OV}/overview?ref=version:9.9.9`)).rejects.toMatchObject({ status: 404, code: "unknown_ref" });
    await expect(get(`/api/projects/${OV}/releases/version/9.9.9`)).rejects.toMatchObject({ status: 404, code: "unknown_ref" });
    await expect(get(`/api/projects/nope/overview`)).rejects.toMatchObject({ status: 404, code: "unknown_project" });
    await expect(get(`/api/projects/nope/refs`)).rejects.toMatchObject({ status: 404, code: "unknown_project" });
  });

  test("refuses a bad days, a bad ref, an unknown project and an unknown release", async () => {
    twoReleases();
    for (const [path, status] of [
      [`/api/projects/${OV}/overview?days=0`, 400],
      [`/api/projects/${OV}/overview?days=91`, 400],
      [`/api/projects/${OV}/overview?days=abc`, 400],
      [`/api/projects/${OV}/overview?ref=tag:1`, 400],
      [`/api/projects/${OV}/overview?ref=version:9.9.9`, 404],
      [`/api/projects/nope/refs`, 404],
      [`/api/projects/${OV}/releases/tag/2.1.0`, 404],
      [`/api/projects/${OV}/releases/version/9.9.9`, 404],
    ] as const) {
      await expect(get(path)).rejects.toMatchObject({ status });
    }
  });
});
