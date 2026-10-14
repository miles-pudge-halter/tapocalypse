import { describe, expect, test } from "bun:test";
import { describeProblem } from "../web/components/run/outcome-callout";
import { createModeStore, parseHealth } from "../web/lib/mode";
import { parseHash, runsHash } from "../web/lib/hooks";
import { pageKey } from "../web/lib/page-key";
import { overviewHash, parseRef, refParam, releaseHash, releasesHash } from "../web/lib/api";
import {
  attribution,
  briefAttribution,
  alertCoalesce,
  blockerGroups,
  displayPerson,
  headersInput,
  hubQueueChip,
  hubStatusPill,
  hubUrlError,
  hubTokenError,
  syncChip,
  syncReason,
  uploadAlert,
  externalUrl,
  filterLanes,
  firstSyncInProgress,
  groupRefs,
  latestRelease,
  matrixRows,
  missingKind,
  releaseBanner,
  releaseStatus,
  releaseStatusText,
  testedBy,
  machineNotes,
  machinesSummary,
  passRateDelta,
  sortLanes,
  trendBars,
  trendTooltip,
} from "../web/lib/hub";
import type { HubStatus, HubSync, HubMachine, RunView, LaneCell, ProjectOverview, RefSummary, ReleaseCell, ReleaseView, RunBrief, Verdict } from "../web/lib/api";

const NOW = Date.parse("2026-10-13T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

describe("displayPerson", () => {
  test("takes the first piece of an email local part, capitalised", () => {
    expect(displayPerson("ann.lee@acme.dev")).toBe("Ann");
    expect(displayPerson("ben_k+qa@acme.dev")).toBe("Ben");
    expect(displayPerson("cara-d@acme.dev")).toBe("Cara");
  });
  test("leaves a value without @ as given and null as null", () => {
    expect(displayPerson("ann")).toBe("ann");
    expect(displayPerson(null)).toBeNull();
  });
  test("falls back to the whole value when the local part is empty", () => {
    expect(displayPerson("@acme.dev")).toBe("@acme.dev");
  });
});

describe("attribution", () => {
  const hub = { machine: "ann-mbp", uploader: "ann.lee@acme.dev", receivedAt: "2026-10-13T14:02:00Z", localProjectId: "app" };
  test("short names the person and the machine; the long form carries the full identity", () => {
    const a = attribution(hub);
    expect(a.short).toBe("by Ann on ann-mbp");
    expect(a.long).toContain("by ann.lee@acme.dev");
    expect(a.long).toContain("“ann-mbp”");
  });
  test("without an uploader it is 'from machine'", () => {
    const a = attribution({ ...hub, uploader: null });
    expect(a.short).toBe("from ann-mbp");
    expect(a.long).not.toContain(" by ");
  });
  test("a brief shows only the person when known, with the machine moved to the title", () => {
    expect(briefAttribution("ann-mbp", "ann.lee@acme.dev")).toEqual({ text: "by Ann", title: "by ann.lee@acme.dev on ann-mbp" });
    expect(briefAttribution("ann-mbp", null)).toEqual({ text: "from ann-mbp", title: "from ann-mbp" });
    expect(briefAttribution(null, null)).toBeNull();
  });
});

describe("machineNotes", () => {
  const base: HubMachine = { name: "ann-mbp", uploader: null, lastUploadAt: ago(DAY), runs30d: 3, clockSkewMs: null, revoked: false };
  test("a healthy recent machine has no notes", () => {
    expect(machineNotes(base, NOW)).toEqual({ revoked: false, skew: null, idle: false });
  });
  test("flags revoked tokens and machines idle for a week or more or never seen", () => {
    expect(machineNotes({ ...base, revoked: true }, NOW).revoked).toBe(true);
    expect(machineNotes({ ...base, lastUploadAt: ago(7 * DAY) }, NOW).idle).toBe(true);
    expect(machineNotes({ ...base, lastUploadAt: ago(6 * DAY) }, NOW).idle).toBe(false);
    expect(machineNotes({ ...base, lastUploadAt: null }, NOW).idle).toBe(true);
  });
  test("skew beyond 5 minutes reads ahead or behind in whole minutes; within 5 minutes is silent", () => {
    expect(machineNotes({ ...base, clockSkewMs: 12 * MIN }, NOW).skew).toBe("clock 12 min ahead");
    expect(machineNotes({ ...base, clockSkewMs: -7.4 * MIN }, NOW).skew).toBe("clock 7 min behind");
    expect(machineNotes({ ...base, clockSkewMs: 5 * MIN }, NOW).skew).toBeNull();
  });
});

describe("machinesSummary", () => {
  const m = (name: string, last: string | null): HubMachine => ({ name, uploader: null, lastUploadAt: last, runs30d: 0, clockSkewMs: null, revoked: false });
  test("counts machines and finds the newest upload", () => {
    const s = machinesSummary([m("a", ago(2 * DAY)), m("b", ago(MIN)), m("c", null)], NOW);
    expect(s.count).toBe(3);
    expect(s.lastUploadAt).toBe(ago(MIN));
    expect(s.recent).toBe(true);
  });
  test("no uploads yet and stale uploads are not recent", () => {
    expect(machinesSummary([m("a", null)], NOW)).toMatchObject({ count: 1, lastUploadAt: null, recent: false });
    expect(machinesSummary([m("a", ago(3 * DAY))], NOW).recent).toBe(false);
  });
  test("sorts by last upload, newest first and never-uploaded last", () => {
    const s = machinesSummary([m("never", null), m("old", ago(3 * DAY)), m("new", ago(MIN))], NOW);
    expect(s.sorted.map((x) => x.name)).toEqual(["new", "old", "never"]);
  });
});

describe("routes", () => {
  test("the empty hash is the home route, #/runs the list, and a legacy query on #/ still means the list", () => {
    expect(parseHash("")).toEqual({ name: "home" });
    expect(parseHash("#/")).toEqual({ name: "home" });
    expect(parseHash("#/runs?verdict=FAIL")).toEqual({ name: "runs", filters: { verdict: ["FAIL"] } });
    expect(parseHash("#/?verdict=FAIL")).toEqual({ name: "runs", filters: { verdict: ["FAIL"] } });
  });

  test("runsHash always names #/runs and carries branch, version and machine filters", () => {
    expect(runsHash({})).toBe("#/runs");
    const hash = runsHash({ project: "app", branch: "release/2.4", version: "2.4.0", machine: ["ann-mbp", "ben-pc"] });
    const parsed = parseHash(hash);
    expect(parsed).toEqual({ name: "runs", filters: { project: "app", branch: "release/2.4", version: "2.4.0", machine: ["ann-mbp", "ben-pc"] } });
  });

  test("overview carries the ref and the show filter; unknown show values are dropped", () => {
    expect(parseHash(overviewHash("app", { ref: { kind: "branch", name: "release/2.4" }, show: "failing" }))).toEqual({
      name: "overview",
      projectId: "app",
      ref: "branch:release/2.4",
      show: "failing",
    });
    expect(parseHash("#/p/app/overview")).toEqual({ name: "overview", projectId: "app", ref: null, show: undefined });
    expect(parseHash("#/p/app/overview?show=bogus")).toMatchObject({ name: "overview", show: undefined });
  });

  test("releases list and release detail round-trip, including a branch typed with raw slashes", () => {
    expect(parseHash(releasesHash("app"))).toEqual({ name: "releases", projectId: "app" });
    const hash = releaseHash("app", { kind: "branch", name: "release/2.4" }, { against: "version:2.3.1", group: "platform" });
    expect(parseHash(hash)).toEqual({
      name: "release",
      projectId: "app",
      ref: { kind: "branch", name: "release/2.4" },
      against: "version:2.3.1",
      group: "platform",
    });
    expect(parseHash("#/p/app/releases/branch/release/2.4")).toMatchObject({ ref: { kind: "branch", name: "release/2.4" }, group: "device" });
    expect(parseHash("#/p/app/releases/version/2.4.0")).toMatchObject({ ref: { kind: "version", name: "2.4.0" }, against: null });
  });

  test("about; an unknown release kind falls back to the releases list", () => {
    expect(parseHash("#/about")).toEqual({ name: "about" });
    expect(parseHash("#/p/app/releases/tag/x")).toEqual({ name: "releases", projectId: "app" });
  });
});

describe("refs", () => {
  test("refParam and parseRef are inverses; all and garbage parse to null", () => {
    const ref = { kind: "version", name: "2.4.0-rc1" } as const;
    expect(refParam(ref)).toBe("version:2.4.0-rc1");
    expect(parseRef(refParam(ref))).toEqual(ref);
    expect(refParam(null)).toBe("all");
    expect(parseRef("all")).toBeNull();
    expect(parseRef("tag:x")).toBeNull();
    expect(parseRef("version:")).toBeNull();
    expect(parseRef(null)).toBeNull();
  });
});

function brief(id: string, verdict: Verdict | null, createdAt = "2026-10-10T10:00:00Z"): RunBrief {
  return {
    id,
    title: id,
    verdict,
    status: "done",
    createdAt,
    endedAt: createdAt,
    deviceName: "Pixel 8",
    platform: "android",
    branch: "main",
    commit: null,
    versionName: null,
    machine: "ann-mbp",
    uploader: null,
    reportPath: null,
    failed: [],
    failedMore: 0,
  };
}
function cell(id: string, verdict: Verdict | null, extra: Partial<LaneCell> = {}, createdAt?: string): LaneCell {
  return { latest: brief(id, verdict, createdAt), newerWithoutVerdict: 0, history: [], newlyFailing: 0, flaky: 0, ...extra };
}
type Lane = ProjectOverview["lanes"][number];
function lane(title: string, platforms: Lane["platforms"]): Lane {
  return { testKey: `k-${title}`, title, suiteId: null, checks: 3, platforms };
}

describe("passRateDelta", () => {
  const rate = (current: number | null, previous: number | null) => ({ current, previous, pass: 0, decided: 1 });
  test("no previous window means no comparison", () => {
    expect(passRateDelta(rate(0.8, null))).toEqual({ kind: "none", points: 0 });
    expect(passRateDelta(rate(null, 0.5))).toEqual({ kind: "none", points: 0 });
  });
  test("less than one point is the same; otherwise up or down in whole percentage points", () => {
    expect(passRateDelta(rate(0.805, 0.8))).toEqual({ kind: "same", points: 0 });
    expect(passRateDelta(rate(0.82, 0.76))).toEqual({ kind: "up", points: 6 });
    expect(passRateDelta(rate(0.5, 0.634))).toEqual({ kind: "down", points: 13 });
  });
});

describe("trendBars", () => {
  const day = (date: string, runs: number, pass = 0, issues = 0, fail = 0, other = 0) => ({ date, runs, pass, issues, fail, other });
  test("stacks pass, issues, fail, other bottom-up scaled to the busiest day, with a 3-unit minimum", () => {
    const bars = trendBars([day("2026-10-01", 10, 5, 2, 2, 1), day("2026-10-02", 1, 1), day("2026-10-03", 0)]);
    expect(bars).toHaveLength(3);
    const first = bars[0];
    expect(first?.x).toBe(1.5);
    expect(first?.segments.map((s) => s.kind)).toEqual(["pass", "issues", "fail", "other"]);
    const total = first?.segments.reduce((sum, s) => sum + s.height, 0) ?? 0;
    expect(total).toBeCloseTo(96, 5);
    // bottom-up: the first segment rests on the baseline at y = 98
    expect(first?.segments[0]?.y).toBeCloseTo(98 - (first?.segments[0]?.height ?? 0), 5);
    expect(bars[1]?.segments[0]?.height).toBeGreaterThanOrEqual(3);
    expect(bars[2]?.empty).toBe(true);
    expect(bars[1]?.x).toBe(11.5);
  });
  test("a busy day with a tiny segment keeps every non-zero segment visible", () => {
    const bars = trendBars([day("2026-10-01", 100, 99, 0, 1)]);
    expect(bars[0]?.segments.map((s) => s.kind)).toEqual(["pass", "fail"]);
  });
});

describe("trendTooltip", () => {
  test("lists non-zero parts only and says 'no runs' for an empty day", () => {
    expect(trendTooltip("Mon 12 Oct", { date: "", runs: 4, pass: 3, issues: 0, fail: 1, other: 0 })).toBe("Mon 12 Oct · 4 runs · 3 pass · 1 fail");
    expect(trendTooltip("Mon 12 Oct", { date: "", runs: 0, pass: 0, issues: 0, fail: 0, other: 0 })).toBe("Mon 12 Oct · no runs");
    expect(trendTooltip("Tue 13 Oct", { date: "", runs: 1, pass: 0, issues: 1, fail: 0, other: 0 })).toBe("Tue 13 Oct · 1 run · 1 with issues");
  });
});

describe("lane sorting and filtering", () => {
  const lanes: Lane[] = [
    lane("Passing", { android: cell("a1", "PASS", {}, "2026-10-12T00:00:00Z") }),
    lane("Failing old", { android: cell("a2", "FAIL", {}, "2026-10-01T00:00:00Z") }),
    lane("Newly failing", { android: cell("a3", "FAIL", { newlyFailing: 2 }, "2026-10-02T00:00:00Z") }),
    lane("Blocked", { ios: cell("a4", "BLOCKED", {}, "2026-10-03T00:00:00Z") }),
    lane("Issues", { android: cell("a5", "PASS WITH ISSUES", {}, "2026-10-04T00:00:00Z") }),
    lane("No verdict", { ios: cell("a6", null, {}, "2026-10-05T00:00:00Z") }),
    lane("Flaky pass", { android: cell("a7", "PASS", { flaky: 1 }, "2026-10-06T00:00:00Z"), ios: cell("a8", "PASS", {}, "2026-10-07T00:00:00Z") }),
  ];
  test("problems first: newly failing, fail, blocked, issues, no verdict, then passes, newest first within a tier", () => {
    expect(sortLanes(lanes, "problems").map((l) => l.title)).toEqual(["Newly failing", "Failing old", "Blocked", "Issues", "No verdict", "Passing", "Flaky pass"]);
  });
  test("recently tested sorts by the newest cell and A–Z by title", () => {
    expect(sortLanes(lanes, "recent")[0]?.title).toBe("Passing");
    expect(sortLanes(lanes, "title").map((l) => l.title)[0]).toBe("Blocked");
  });
  test("filters: failing = a fail or blocked cell, newly failing, flaky, and a case-insensitive title match", () => {
    expect(filterLanes(lanes, { show: "failing", q: "" }).map((l) => l.title).sort()).toEqual(["Blocked", "Failing old", "Newly failing"]);
    expect(filterLanes(lanes, { show: "newly_failing", q: "" }).map((l) => l.title)).toEqual(["Newly failing"]);
    expect(filterLanes(lanes, { show: "flaky", q: "" }).map((l) => l.title)).toEqual(["Flaky pass"]);
    expect(filterLanes(lanes, { show: null, q: "  ISSUES " }).map((l) => l.title)).toEqual(["Issues"]);
  });
});

function rcell(id: string, verdict: Verdict | null, extra: Partial<ReleaseCell> = {}): ReleaseCell {
  const latest = brief(id, verdict);
  return { latest, attempts: [latest], newlyFailing: 0, flaky: 0, ...extra };
}

function release(tests: { title: string; cells: Record<string, ReleaseCell | null> }[], extra: Partial<ReleaseView> = {}): ReleaseView {
  const devices = [
    { key: "pixel", name: "Pixel 8", platform: "android" as const },
    { key: "iphone", name: "iPhone 15", platform: "ios" as const },
  ];
  const rows = tests.map((t) => ({ testKey: `k-${t.title}`, title: t.title, suiteId: null, cells: t.cells, platforms: {}, worst: null }));
  const blockers = rows.flatMap((t) =>
    Object.entries(t.cells).flatMap(([deviceKey, c]) =>
      c && (c.latest.verdict === "FAIL" || c.latest.verdict === "BLOCKED") ? [{ testKey: t.testKey, title: t.title, deviceKey, cell: c }] : [],
    ),
  );
  return {
    project: { id: "app", name: "Acme App", hubKey: null },
    ref: { kind: "version", name: "2.4.0" },
    previous: { kind: "version", name: "2.3.1" },
    auto: true,
    span: { firstAt: "2026-10-02T00:00:00Z", lastAt: "2026-10-09T00:00:00Z" },
    runs: 5,
    machines: [],
    devices,
    tests: rows,
    blockers,
    untested: [],
    changes: null,
    summary: { tests: rows.length, cells: 0, pass: 0, issues: 0, fail: 0, blocked: 0, other: 0 },
    ...extra,
  };
}

describe("releaseBanner", () => {
  test("blockers lead: two named, the rest counted, then how many tests pass", () => {
    const view = release([
      { title: "Checkout smoke", cells: { pixel: rcell("a", "FAIL"), iphone: rcell("b", "PASS") } },
      { title: "Login", cells: { pixel: rcell("c", "PASS"), iphone: rcell("d", "BLOCKED") } },
      { title: "Search", cells: { pixel: rcell("e", "FAIL") } },
      { title: "Profile", cells: { pixel: rcell("f", "PASS") } },
    ]);
    const banner = releaseBanner(view);
    expect(banner.kind).toBe("blockers");
    expect(banner.title).toBe("3 blockers");
    expect(banner.description).toBe("“Checkout smoke” fails on Pixel 8; “Login” could not be tested on iPhone 15 and 1 more. 1 of 4 tests pass.");
  });
  test("one blocker reads singular", () => {
    const view = release([{ title: "Login", cells: { pixel: rcell("c", "FAIL") } }]);
    expect(releaseBanner(view)).toMatchObject({ kind: "blockers", title: "1 blocker", description: "“Login” fails on Pixel 8. 0 of 1 tests pass." });
  });
  test("no blockers but issues or partial: orange, counting tests", () => {
    const view = release([
      { title: "A", cells: { pixel: rcell("a", "PASS WITH ISSUES") } },
      { title: "B", cells: { pixel: rcell("b", "PARTIAL") } },
      { title: "C", cells: { pixel: rcell("c", "PASS") } },
    ]);
    expect(releaseBanner(view)).toEqual({
      kind: "issues",
      title: "No blockers. 2 tests passed with issues",
      description: "1 of 3 tests pass cleanly. Open a test to read the issues.",
    });
    expect(releaseBanner(release([{ title: "A", cells: { pixel: rcell("a", "PASS WITH ISSUES") } }])).title).toBe("No blockers. 1 test passed with issues");
  });
  test("everything passing, and no verdicts at all", () => {
    expect(releaseBanner(release([{ title: "A", cells: { pixel: rcell("a", "PASS"), iphone: null } }]))).toEqual({
      kind: "pass",
      title: "All 1 tests pass",
      description: "On the latest run of each test on each device.",
    });
    expect(releaseBanner(release([{ title: "A", cells: { pixel: rcell("a", null) } }]))).toMatchObject({ kind: "none", title: "No results yet" });
  });
});

describe("blockerGroups", () => {
  test("splits failing from could-not-be-tested, newly failing first then newest", () => {
    const mk = (id: string, verdict: Verdict, newly: number, at: string) => ({
      testKey: id,
      title: id,
      deviceKey: "pixel",
      cell: { ...rcell(id, verdict, { newlyFailing: newly }), latest: brief(id, verdict, at) },
    });
    const groups = blockerGroups([
      mk("f-old", "FAIL", 0, "2026-10-01T00:00:00Z"),
      mk("f-new", "FAIL", 0, "2026-10-05T00:00:00Z"),
      mk("f-reg", "FAIL", 2, "2026-10-02T00:00:00Z"),
      mk("b1", "BLOCKED", 0, "2026-10-03T00:00:00Z"),
    ]);
    expect(groups.failing.map((b) => b.title)).toEqual(["f-reg", "f-new", "f-old"]);
    expect(groups.blocked.map((b) => b.title)).toEqual(["b1"]);
  });
});

describe("matrixRows", () => {
  const tests = release([
    { title: "Zeta pass", cells: { pixel: rcell("a", "PASS") } },
    { title: "Beta blocked", cells: { pixel: rcell("b", "BLOCKED") } },
    { title: "Alpha pass", cells: { pixel: rcell("c", "PASS") } },
    { title: "Gamma fail", cells: { iphone: rcell("d", "FAIL"), pixel: rcell("e", "PASS") } },
    { title: "Delta issues", cells: { pixel: rcell("f", "PASS WITH ISSUES") } },
    { title: "Epsilon none", cells: { pixel: rcell("g", null) } },
  ]).tests;
  test("fail, blocked, issues, no verdict, then all-pass; A–Z inside a tier", () => {
    expect(matrixRows(tests, "").map((t) => t.title)).toEqual(["Gamma fail", "Beta blocked", "Delta issues", "Epsilon none", "Alpha pass", "Zeta pass"]);
  });
  test("filters by title, ignoring case and surrounding space", () => {
    expect(matrixRows(tests, " PASS ").map((t) => t.title)).toEqual(["Alpha pass", "Zeta pass"]);
  });
});

describe("testedBy", () => {
  test("names the first two (person when known, else machine) and counts the rest", () => {
    const machines = [
      { name: "ann-mbp", uploader: "ann.lee@acme.dev" },
      { name: "ben-pc", uploader: null },
      { name: "cara-air", uploader: "cara@acme.dev" },
      { name: "dev-4", uploader: null },
    ];
    const result = testedBy(machines);
    expect(result.text).toBe("Ann, ben-pc and 2 more");
    expect(result.all).toBe("Ann on ann-mbp, ben-pc, Cara on cara-air, dev-4");
    expect(testedBy([machines[0]!, machines[1]!]).text).toBe("Ann and ben-pc");
    expect(testedBy([machines[1]!]).text).toBe("ben-pc");
    expect(testedBy([]).text).toBeNull();
  });
});

describe("releaseStatus and groupRefs", () => {
  const ref = (name: string, kind: "version" | "branch", extra: Partial<RefSummary> = {}): RefSummary => ({
    ref: { kind, name },
    release: kind === "version" || /^(release|hotfix)\//.test(name),
    isDefaultBranch: false,
    runs: 1,
    firstAt: "2026-10-01T00:00:00Z",
    lastAt: "2026-10-02T00:00:00Z",
    machines: [],
    lanes: { pass: 0, issues: 0, fail: 0, blocked: 0, other: 0 },
    previous: null,
    newlyFailing: null,
    ...extra,
  });
  test("blockers (fail + blocked) beat issues, which beat all passing", () => {
    expect(releaseStatus({ pass: 3, issues: 1, fail: 1, blocked: 1, other: 0 })).toEqual({ kind: "blockers", count: 2 });
    expect(releaseStatus({ pass: 3, issues: 2, fail: 0, blocked: 0, other: 0 })).toEqual({ kind: "issues", count: 2 });
    expect(releaseStatus({ pass: 3, issues: 0, fail: 0, blocked: 0, other: 0 })).toEqual({ kind: "pass", count: 0 });
  });
  test("partial and verdict-less lanes are never 'all passing': they read as incomplete, and no lanes at all as no results", () => {
    expect(releaseStatus({ pass: 3, issues: 0, fail: 0, blocked: 0, other: 1 })).toEqual({ kind: "partial", count: 1 });
    expect(releaseStatus({ pass: 0, issues: 0, fail: 0, blocked: 0, other: 2 })).toEqual({ kind: "partial", count: 2 });
    expect(releaseStatus({ pass: 0, issues: 0, fail: 0, blocked: 0, other: 0 })).toEqual({ kind: "none", count: 0 });
    expect(releaseStatus({ pass: 1, issues: 1, fail: 0, blocked: 0, other: 5 })).toEqual({ kind: "issues", count: 1 });
  });
  test("the chip text names every kind", () => {
    expect(releaseStatusText({ kind: "blockers", count: 1 })).toBe("1 blocker");
    expect(releaseStatusText({ kind: "blockers", count: 2 })).toBe("2 blockers");
    expect(releaseStatusText({ kind: "issues", count: 2 })).toBe("2 with issues");
    expect(releaseStatusText({ kind: "partial", count: 3 })).toBe("3 incomplete");
    expect(releaseStatusText({ kind: "none", count: 0 })).toBe("no results");
    expect(releaseStatusText({ kind: "pass", count: 0 })).toBe("all passing");
  });
  test("groups into versions, release branches and other branches with the default branch first", () => {
    const groups = groupRefs([
      ref("2.4.0", "version"),
      ref("feature/x", "branch"),
      ref("main", "branch", { isDefaultBranch: true }),
      ref("release/2.4", "branch"),
      ref("2.3.1", "version"),
    ]);
    expect(groups.versions.map((r) => r.ref.name)).toEqual(["2.4.0", "2.3.1"]);
    expect(groups.releaseBranches.map((r) => r.ref.name)).toEqual(["release/2.4"]);
    expect(groups.branches.map((r) => r.ref.name)).toEqual(["main", "feature/x"]);
  });
});

function sync(state: HubSync["state"], extra: Partial<HubSync> = {}): HubSync {
  return { state, url: null, uploadedAt: null, error: null, attempts: 0, nextAttemptAt: null, ...extra };
}

describe("syncChip", () => {
  test("each state has its own copy; uploaded is the only one that opens the hub", () => {
    expect(syncChip(sync("waiting"), NOW).text).toBe("Team hub: after it finishes");
    expect(syncChip(sync("local"), NOW).text).toBe("Not on team hub");
    expect(syncChip(sync("queued"), NOW).text).toBe("Queued for team hub");
    expect(syncChip(sync("uploading"), NOW).text).toBe("Uploading to team hub…");
    expect(syncChip(sync("uploaded", { url: "https://hub.example/#/runs/r1" }), NOW)).toMatchObject({ text: "On team hub", opensHub: true });
    expect(syncChip(sync("outdated"), NOW).text).toBe("Team hub update queued");
    expect(syncChip(sync("paused"), NOW).text).toBe("Team hub uploads paused");
    expect(syncChip(sync("parked"), NOW).text).toBe("Not uploaded: id taken on hub");
  });
  test("failed shows when the retry happens, and the tone tells warnings from errors", () => {
    const failed = syncChip(sync("failed", { nextAttemptAt: new Date(NOW + 4 * MIN).toISOString() }), NOW);
    expect(failed.text).toBe("Upload failed · retrying in 4 min");
    expect(failed.tone).toBe("warn");
    expect(syncChip(sync("failed", { nextAttemptAt: new Date(NOW - 1000).toISOString() }), NOW).text).toBe("Upload failed · retrying now");
    expect(syncChip(sync("failed"), NOW).text).toBe("Upload failed");
    expect(syncChip(sync("parked"), NOW).tone).toBe("error");
    expect(syncChip(sync("uploading"), NOW).tone).toBe("busy");
    expect(syncChip(sync("uploaded"), NOW).tone).toBe("done");
  });
});

describe("syncReason", () => {
  test("names the host and the server detail where the copy has room for them", () => {
    expect(syncReason({ code: "unreachable", detail: "connection refused" }, "qa.example.com")).toBe(
      "Could not reach qa.example.com: connection refused. Uploads retry on their own.",
    );
    expect(syncReason({ code: "too_large", detail: "9 MB" }, "qa.example.com")).toBe("The hub refused the upload as too large: 9 MB.");
    expect(syncReason({ code: "not_a_hub", detail: "" }, "qa.example.com")).toBe("qa.example.com answered, but not like a Tapocalypse hub. Check the address in Setup.");
    expect(syncReason({ code: "other", detail: "boom" }, null)).toBe("boom");
    expect(syncReason({ code: "unauthorized", detail: "" }, null)).toContain("rejected this machine's upload token");
    expect(syncReason({ code: "id_conflict", detail: "" }, null)).toContain("Another machine already uploaded a run with this id");
  });
});

describe("hubStatusPill and hubQueueChip", () => {
  const status = (over: Partial<HubStatus> & { state?: HubStatus["connection"]["state"] } = {}): HubStatus => ({
    configured: true,
    url: "https://hub.example",
    screenshots: "webp",
    credentials: { file: "/x", token: "file", tokenHint: "a1b2", headers: { source: null, names: [] } },
    connection: { state: over.state ?? "ok", machine: "ann-mbp", hubVersion: "1.0.0", minProtocol: 1, checkedAt: null, detail: null },
    queue: { waiting: 0, uploading: null, failed: 0, parked: 0, uploaded: 5, backfill: null },
    paused: null,
    lastUploadAt: null,
    sharedProjects: [],
    ...over,
  });
  test("pill: not connected, connected as machine, paused beats connection state", () => {
    expect(hubStatusPill(status({ configured: false })).text).toBe("Not connected");
    expect(hubStatusPill(status())).toEqual({ tone: "ok", text: "Connected as ann-mbp" });
    expect(hubStatusPill(status({ paused: { reason: "unauthorized", detail: "", at: "x" } })).text).toBe("Uploads paused");
    expect(hubStatusPill(status({ state: "unauthorized" }))).toEqual({ tone: "error", text: "Can't upload" });
    expect(hubStatusPill(status({ state: "unreachable" }))).toEqual({ tone: "warn", text: "Hub unreachable" });
    expect(hubStatusPill(status({ state: "protocol_unsupported" })).text).toBe("Update needed");
  });
  test("queue chip: paused and failed outrank waiting, which outranks all uploaded; hidden when not configured", () => {
    expect(hubQueueChip(status({ configured: false }))).toBeNull();
    expect(hubQueueChip(status())).toEqual({ tone: "ok", text: "Team hub: all uploaded" });
    expect(hubQueueChip(status({ queue: { waiting: 3, uploading: null, failed: 0, parked: 0, uploaded: 1, backfill: null } }))).toEqual({ tone: "busy", text: "Team hub: 3 waiting" });
    expect(hubQueueChip(status({ queue: { waiting: 3, uploading: null, failed: 2, parked: 0, uploaded: 1, backfill: null } }))).toEqual({ tone: "warn", text: "Team hub: 2 failed" });
    expect(hubQueueChip(status({ paused: { reason: "protocol_unsupported", detail: "", at: "x" } }))).toEqual({ tone: "warn", text: "Team hub: paused" });
  });
});

describe("connection form input", () => {
  test("the address must be https, or http on localhost", () => {
    expect(hubUrlError("https://qa.example.com")).toBeNull();
    expect(hubUrlError("http://localhost:4311")).toBeNull();
    expect(hubUrlError("http://127.0.0.1:4311")).toBeNull();
    expect(hubUrlError("http://qa.example.com")).toBe("Use the hub's https:// address.");
    expect(hubUrlError("qa.example.com")).toBe("Use the hub's https:// address.");
    expect(hubUrlError("")).toBe("Use the hub's https:// address.");
  });
  test("a typed token starts with tpu_; blank is fine (keeps the saved one)", () => {
    expect(hubTokenError("")).toBeNull();
    expect(hubTokenError("tpu_abc")).toBeNull();
    expect(hubTokenError("abc")).toBe("Upload tokens start with tpu_.");
  });
  test("headers: untouched saved rows keep their value (null), typed values replace, blanks and a removed row drop out", () => {
    const rows = [
      { name: "X-Team", value: "", saved: true },
      { name: "X-Edge", value: "s3cret", saved: true },
      { name: "X-New", value: "v", saved: false },
      { name: "  ", value: "ignored", saved: false },
    ];
    expect(headersInput(rows, true)).toEqual({ ok: true, headers: { "X-Team": null, "X-Edge": "s3cret", "X-New": "v" } });
  });
  test("headers: a new row without a value, a bad name or a duplicate name is an error; nothing touched means no change", () => {
    expect(headersInput([{ name: "X-A", value: "", saved: false }], false)).toMatchObject({ ok: false, error: "Header X-A needs a value." });
    expect(headersInput([{ name: "bad name", value: "v", saved: false }], false)).toMatchObject({ ok: false });
    expect(
      headersInput(
        [
          { name: "X-A", value: "1", saved: false },
          { name: "x-a", value: "2", saved: false },
        ],
        false,
      ),
    ).toMatchObject({ ok: false, error: "Header x-a appears twice." });
    expect(headersInput([], false)).toEqual({ ok: true, headers: undefined });
    expect(headersInput([], true)).toEqual({ ok: true, headers: {} });
  });
});

describe("uploadAlert", () => {
  const run = (over: Partial<RunView>): RunView =>
    ({
      id: "r1",
      title: "Checkout smoke",
      status: "done",
      verdict: "FAIL",
      endedAt: new Date(NOW - 10 * MIN).toISOString(),
      hub: { machine: "ann-mbp", uploader: "ann.lee@acme.dev", receivedAt: new Date(NOW - 5_000).toISOString(), localProjectId: "app" },
      source: { branch: "release/2.4" },
      regression: null,
      ...over,
    }) as unknown as RunView;
  test("a fresh failing upload alerts with person, branch and newly failing count", () => {
    expect(uploadAlert(run({ regression: { newlyFailing: 2 } as RunView["regression"] }), NOW)).toEqual({
      severity: "error",
      title: "Checkout smoke: FAIL",
      description: "by Ann on ann-mbp · release/2.4 · 2 newly failing",
    });
    expect(uploadAlert(run({}), NOW)?.description).toBe("by Ann on ann-mbp · release/2.4");
  });
  test("blocked is a warning; a passing run is silent unless something newly failed", () => {
    expect(uploadAlert(run({ verdict: "BLOCKED" }), NOW)?.severity).toBe("warning");
    expect(uploadAlert(run({ verdict: "PASS" }), NOW)).toBeNull();
    expect(uploadAlert(run({ verdict: "PASS", regression: { newlyFailing: 1 } as RunView["regression"] }), NOW)?.severity).toBe("error");
  });
  test("backfills and old runs are silent: received more than a minute ago, ended more than 30 minutes ago, or no hub attribution", () => {
    expect(uploadAlert(run({ hub: { machine: "m", uploader: null, receivedAt: new Date(NOW - 90_000).toISOString(), localProjectId: "a" } }), NOW)).toBeNull();
    expect(uploadAlert(run({ endedAt: new Date(NOW - 31 * MIN).toISOString() }), NOW)).toBeNull();
    expect(uploadAlert(run({ hub: null }), NOW)).toBeNull();
  });
});

describe("alertCoalesce", () => {
  test("three alerts within ten seconds collapse into one; older ones fall out of the window", () => {
    let history: number[] = [];
    const push = (at: number) => {
      const next = alertCoalesce(history, at);
      history = next.history;
      return next.collapse;
    };
    expect(push(NOW)).toBe(false);
    expect(push(NOW + 3_000)).toBe(false);
    expect(push(NOW + 6_000)).toBe(true);
    expect(push(NOW + 40_000)).toBe(false);
  });
});

describe("parseHealth", () => {
  test("accepts both modes", () => {
    expect(parseHealth({ ok: true, mode: "hub", version: "1.0.0", runs: 3 })).toEqual({ ok: true, mode: "hub", version: "1.0.0", runs: 3 });
    expect(parseHealth({ ok: true, mode: "local", version: "1.0.0", runs: 0 })?.mode).toBe("local");
  });
  test("an older server without a mode is a laptop; anything that is not a health body is rejected", () => {
    expect(parseHealth({ ok: true, version: "0.9.0", runs: 2 })?.mode).toBe("local");
    expect(parseHealth({ ok: true, mode: "other", version: "1", runs: 1 })).toBeNull();
    expect(parseHealth("<html>")).toBeNull();
    expect(parseHealth(null)).toBeNull();
  });
});

describe("mode store", () => {
  const health = { ok: true, mode: "hub", version: "1.0.0", runs: 1 } as const;

  test("a failed load is an error; retry on the same store recovers it for every subscriber", async () => {
    let fail = true;
    const store = createModeStore(async () => {
      if (fail) throw new Error("401 Unauthorized");
      return health;
    });
    const seen: Array<string | null> = [];
    store.subscribe(() => seen.push(store.getSnapshot().mode));
    await store.load();
    expect(store.getSnapshot()).toEqual({ mode: null, error: "401 Unauthorized" });
    fail = false;
    await store.retry();
    expect(store.getSnapshot()).toEqual({ mode: "hub", error: null });
    expect(seen.at(-1)).toBe("hub");
    expect(store.isHub()).toBe(true);
  });

  test("concurrent loads share one request and a resolved mode is never fetched again", async () => {
    let calls = 0;
    const store = createModeStore(async () => {
      calls += 1;
      return health;
    });
    await Promise.all([store.load(), store.load()]);
    await store.load();
    expect(calls).toBe(1);
  });

  test("retry clears the error immediately so the boot gate shows loading again", async () => {
    const gate = Promise.withResolvers<void>();
    let first = true;
    const store = createModeStore(async () => {
      if (first) {
        first = false;
        throw new Error("down");
      }
      await gate.promise;
      return health;
    });
    await store.load();
    const retrying = store.retry();
    expect(store.getSnapshot().error).toBeNull();
    gate.resolve();
    await retrying;
    expect(store.getSnapshot().mode).toBe("hub");
  });
});

describe("describeProblem on the hub", () => {
  const failed = { status: "error", errorKind: "infra", error: "boom", checks: [] } as unknown as RunView;
  test("the stderr tail is a laptop-only route: offered locally, never on the hub", () => {
    expect(describeProblem(failed, 0, false)?.showStderr).toBe(true);
    expect(describeProblem(failed, 0, true)?.showStderr).toBe(false);
    const interrupted = { ...failed, status: "interrupted", errorKind: null } as unknown as RunView;
    expect(describeProblem(interrupted, 0, true)?.showStderr).toBe(false);
  });
});

describe("firstSyncInProgress", () => {
  const project = (firstSeenAgo: number | null, lastAgo: number | null) => ({
    firstSeenAt: firstSeenAgo === null ? null : ago(firstSeenAgo),
    lastUploadAt: lastAgo === null ? null : ago(lastAgo),
  });
  test("a young project that is still receiving runs is in its first upload", () => {
    expect(firstSyncInProgress(project(10 * MIN, 20_000), NOW)).toBe(true);
  });
  test("the banner clears once nothing has arrived for the quiet period, even inside the first hour", () => {
    expect(firstSyncInProgress(project(10 * MIN, 3 * MIN), NOW)).toBe(false);
    expect(firstSyncInProgress(project(10 * MIN, 90_000), NOW)).toBe(true);
  });
  test("an established project or one without uploads never shows it", () => {
    expect(firstSyncInProgress(project(3 * DAY, 10_000), NOW)).toBe(false);
    expect(firstSyncInProgress(project(null, null), NOW)).toBe(false);
  });
});

describe("externalUrl", () => {
  test("only https links from uploaded data are clickable; other schemes and malformed values are dropped", () => {
    expect(externalUrl("https://github.com/acme/shop/pull/12")).toBe("https://github.com/acme/shop/pull/12");
    expect(externalUrl("http://example.com/x")).toBeNull();
    expect(externalUrl("javascript:alert(1)")).toBeNull();
    expect(externalUrl("data:text/html,x")).toBeNull();
    expect(externalUrl("//evil.example/x")).toBeNull();
    expect(externalUrl("")).toBeNull();
    expect(externalUrl(null)).toBeNull();
  });
});

describe("pageKey", () => {
  test("on a laptop # and #/runs are one page, so a filter edit does not scroll to the top; on the hub they differ", () => {
    expect(pageKey({ name: "home" }, false)).toBe(pageKey({ name: "runs", filters: {} }, false));
    expect(pageKey({ name: "home" }, true)).not.toBe(pageKey({ name: "runs", filters: {} }, true));
  });
});

describe("latestRelease", () => {
  const rel = (name: string, lastAt: string, release = true): RefSummary => ({
    ref: { kind: "version", name },
    release,
    isDefaultBranch: false,
    runs: 1,
    firstAt: "2026-09-01T00:00:00Z",
    lastAt,
    machines: [],
    lanes: { pass: 1, issues: 0, fail: 0, blocked: 0, other: 0 },
    previous: null,
    newlyFailing: null,
  });
  test("the release with the newest activity wins over the highest version, like the overview's changes card", () => {
    const refs = [rel("2.5.0", "2026-10-01T00:00:00Z"), rel("2.4.1", "2026-10-12T00:00:00Z"), rel("main", "2026-10-13T00:00:00Z", false)];
    expect(latestRelease(refs)?.ref.name).toBe("2.4.1");
  });
  test("no release refs means none", () => {
    expect(latestRelease([rel("main", "2026-10-13T00:00:00Z", false)])).toBeNull();
    expect(latestRelease([])).toBeNull();
  });
});

describe("missingKind", () => {
  test("only a 404 is a missing thing; without a code it is the ref when the project is known, else the project", () => {
    expect(missingKind({ status: 500, code: null }, true)).toBeNull();
    expect(missingKind({ status: null, code: null }, true)).toBeNull();
    expect(missingKind({ status: 404, code: null }, true)).toBe("ref");
    expect(missingKind({ status: 404, code: null }, false)).toBe("project");
  });
  test("a server code wins over the guess", () => {
    expect(missingKind({ status: 404, code: "unknown_ref" }, false)).toBe("ref");
    expect(missingKind({ status: 404, code: "unknown_project" }, true)).toBe("project");
  });
});
