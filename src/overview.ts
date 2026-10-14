import { z } from "zod";
import { type RunView, regressionOf, runView } from "./app";
import { HttpError } from "./config";
import { getProject, type Project } from "./projects/registry";
import { branchOf, commitOf, defaultBranch, foldSnapshot, isTerminalRun, platformOf } from "./regression/baseline";
import { compareRuns } from "./regression/compare";
import { flakyChecks } from "./regression/flaky";
import { projectGeneration } from "./regression/index";
import { type Baseline, type FlakyCheck, TRANSITIONS, type Transition } from "./regression/types";
import { listRuns } from "./runs/store";
import { computeStats } from "./stats";
import type { CheckStatus, Platform, Run, RunStatus, Verdict } from "./runs/types";

// ---------------------------------------------------------------------------------------------------------------
// Wire types (design §1). Mode-agnostic: on a laptop `machine` / `uploader` are null and the hub fields are empty.
// ---------------------------------------------------------------------------------------------------------------

export interface Ref {
  kind: "version" | "branch";
  name: string;
}

export interface LaneCounts {
  pass: number;
  issues: number;
  fail: number;
  blocked: number;
  other: number;
}

/** A run as a list row: everything a verdict cell, a blocker row and an attempts popover show. */
export interface RunBrief {
  id: string;
  title: string;
  verdict: Verdict | null;
  status: RunStatus;
  createdAt: string;
  endedAt: string | null;
  deviceName: string | null;
  platform: Platform;
  branch: string | null;
  commit: string | null;
  versionName: string | null;
  machine: string | null;
  uploader: string | null;
  /** Truthy = the "Report" / "HTML" links render. */
  reportPath: string | null;
  /** Non-pass decisive checks, at most 3, fail before blocked. */
  failed: { id: string; title: string; status: CheckStatus }[];
  failedMore: number;
}

export type CheckTransition = Transition;

export interface ChangeItem {
  transition: CheckTransition;
  checkKey: string;
  title: string;
  testKey: string;
  testTitle: string;
  platform: Platform;
  current: { runId: string; checkId: string; status: CheckStatus | null } | null;
  previous: { runId: string; checkId: string; status: CheckStatus | null } | null;
}

export interface ReleaseCell {
  latest: RunBrief;
  /** Newest first, at most 10. */
  attempts: RunBrief[];
  newlyFailing: number;
  flaky: number;
}

export interface ReleaseView {
  project: { id: string; name: string; hubKey: string | null };
  ref: Ref;
  previous: Ref | null;
  /** The previous release was picked by the rule rather than `?against=`. */
  auto: boolean;
  span: { firstAt: string; lastAt: string };
  runs: number;
  machines: { name: string; uploader: string | null }[];
  /** Columns: Android first, then iOS, each by name. */
  devices: { key: string; name: string; platform: Platform }[];
  tests: {
    testKey: string;
    title: string;
    suiteId: string | null;
    cells: Record<string, ReleaseCell | null>;
    platforms: Partial<Record<Platform, ReleaseCell>>;
    worst: Verdict | null;
  }[];
  /** Latest verdict FAIL (first) or BLOCKED. */
  blockers: { testKey: string; title: string; deviceKey: string; cell: ReleaseCell }[];
  /** Lanes of the previous release with no run here. */
  untested: { testKey: string; title: string; platform: Platform }[];
  changes: { counts: Record<CheckTransition, number>; items: ChangeItem[] } | null;
  summary: { tests: number; cells: number } & LaneCounts;
}

export interface RefSummary {
  ref: Ref;
  /** Versions are always releases; branches when the name matches the release prefixes. */
  release: boolean;
  isDefaultBranch: boolean;
  runs: number;
  firstAt: string;
  lastAt: string;
  machines: string[];
  /** Latest result per test × device. */
  lanes: LaneCounts;
  previous: Ref | null;
  newlyFailing: number | null;
}

// ---------------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------------

const RELEASE_BRANCH = /^((release|releases|hotfix)\/|release-)/i;

export const isReleaseBranch = (name: string): boolean => RELEASE_BRANCH.test(name);

const refKey = (ref: Ref): string => `${ref.kind}:${ref.name}`;
const sameRef = (a: Ref, b: Ref): boolean => a.kind === b.kind && a.name === b.name;

/** Terminal runs of the project, newest first: the hub only ever holds these, and a live run has no result to report. */
function finishedRuns(projectId: string): Run[] {
  return listRuns({ projectId }).filter(isTerminalRun);
}

const versionOf = (run: Run): string | null => run.build?.versionName || null;

function inRef(run: Run, ref: Ref): boolean {
  return ref.kind === "version" ? versionOf(run) === ref.name : branchOf(run) === ref.name;
}

/** The refs a run belongs to: its app version and its git branch. */
function refsOf(run: Run): Ref[] {
  const refs: Ref[] = [];
  const version = versionOf(run);
  if (version) refs.push({ kind: "version", name: version });
  const branch = branchOf(run);
  if (branch) refs.push({ kind: "branch", name: branch });
  return refs;
}

/** `2.4.0-rc1` < `2.4.0`: numeric per dot segment, a non-numeric suffix sorts before the plain version. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): { nums: number[]; suffix: string } => {
    const m = /^v?(\d+(?:\.\d+)*)(.*)$/i.exec(v.trim());
    return m ? { nums: m[1]!.split(".").map(Number), suffix: m[2]! } : { nums: [], suffix: v };
  };
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return d;
  }
  if (x.suffix === y.suffix) return 0;
  if (x.suffix === "") return 1;
  if (y.suffix === "") return -1;
  return x.suffix.localeCompare(y.suffix, undefined, { numeric: true });
}

/** The version a release branch name carries: `release/2.4` → `2.4`. */
function embeddedVersion(branch: string): string | null {
  return /(\d+(?:\.\d+)*)/.exec(branch.replace(RELEASE_BRANCH, ""))?.[1] ?? null;
}

type Bucket = "pass" | "issues" | "fail" | "blocked" | "other";

function bucketOf(verdict: Verdict | null): Bucket {
  if (verdict === "PASS") return "pass";
  if (verdict === "PASS WITH ISSUES") return "issues";
  if (verdict === "FAIL") return "fail";
  if (verdict === "BLOCKED") return "blocked";
  return "other";
}

const deviceKeyOf = (run: Run): string => `${platformOf(run)}:${run.deviceName ?? ""}`;
const deviceNameOf = (run: Run): string => run.deviceName ?? (platformOf(run) === "ios" ? "iOS device" : "Android device");

/** One test on one device within a scope: every run of it (newest first) and the one that decides the cell. */
interface Cell {
  testKey: string;
  deviceKey: string;
  deviceName: string;
  platform: Platform;
  runs: Run[];
  latest: Run;
}

/** Runs without a `testKey` are left out; the newest run with a verdict decides, else the newest run. Input newest first. */
function foldCells(runs: Run[]): Cell[] {
  const cells = new Map<string, Cell>();
  for (const run of runs) {
    if (run.testKey === null) continue;
    const deviceKey = deviceKeyOf(run);
    const key = `${run.testKey}\0${deviceKey}`;
    const cell = cells.get(key);
    if (cell) cell.runs.push(run);
    else cells.set(key, { testKey: run.testKey, deviceKey, deviceName: deviceNameOf(run), platform: platformOf(run), runs: [run], latest: run });
  }
  for (const cell of cells.values()) cell.latest = cell.runs.find((r) => r.verdict !== null) ?? cell.runs[0]!;
  return [...cells.values()];
}

function laneCounts(cells: Cell[]): LaneCounts {
  const counts: LaneCounts = { pass: 0, issues: 0, fail: 0, blocked: 0, other: 0 };
  for (const cell of cells) counts[bucketOf(cell.latest.verdict)]++;
  return counts;
}

function projectOrThrow(projectId: string): Project {
  const project = getProject(projectId);
  if (!project) throw new HttpError(404, `unknown project ${projectId}`, "unknown_project");
  return project;
}

// ---------------------------------------------------------------------------------------------------------------
// Refs
// ---------------------------------------------------------------------------------------------------------------

/** The release `ref` compares with: the next lower version, or for a release branch the next lower embedded version, else the next older one. */
function previousRelease(ref: Ref, candidates: { ref: Ref; lastAt: string }[]): Ref | null {
  const others = candidates.filter((c) => !sameRef(c.ref, ref));
  if (ref.kind === "version") {
    const lower = others.filter((c) => c.ref.kind === "version" && compareVersions(c.ref.name, ref.name) < 0);
    lower.sort((a, b) => compareVersions(b.ref.name, a.ref.name));
    return lower[0]?.ref ?? null;
  }
  const branches = others.filter((c) => c.ref.kind === "branch" && isReleaseBranch(c.ref.name));
  const mine = embeddedVersion(ref.name);
  if (mine !== null) {
    const lower = branches
      .map((c) => ({ c, v: embeddedVersion(c.ref.name) }))
      .filter((x): x is { c: (typeof branches)[number]; v: string } => x.v !== null && compareVersions(x.v, mine) < 0)
      .sort((a, b) => compareVersions(b.v, a.v));
    if (lower[0]) return lower[0].c.ref;
  }
  const mineAt = candidates.find((c) => sameRef(c.ref, ref))?.lastAt ?? "";
  const older = branches.filter((c) => c.lastAt < mineAt).sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  return older[0]?.ref ?? null;
}

interface RefGroup {
  ref: Ref;
  release: boolean;
  runs: Run[];
  firstAt: string;
  lastAt: string;
}

/** Every ref that has a finished run, versions semver-descending then branches by last activity; runs newest first. */
function refGroups(projectId: string): RefGroup[] {
  const groups = new Map<string, RefGroup>();
  for (const run of finishedRuns(projectId)) {
    for (const ref of refsOf(run)) {
      const key = refKey(ref);
      const group = groups.get(key);
      if (group) {
        group.runs.push(run);
        if (run.createdAt < group.firstAt) group.firstAt = run.createdAt;
        if (run.createdAt > group.lastAt) group.lastAt = run.createdAt;
      } else {
        groups.set(key, { ref, release: ref.kind === "version" || isReleaseBranch(ref.name), runs: [run], firstAt: run.createdAt, lastAt: run.createdAt });
      }
    }
  }
  const all = [...groups.values()];
  const versions = all.filter((g) => g.ref.kind === "version").sort((a, b) => compareVersions(b.ref.name, a.ref.name));
  const branches = all.filter((g) => g.ref.kind === "branch").sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  return [...versions, ...branches];
}

const machinesOf = (runs: Run[]): string[] => [...new Set(runs.map((r) => r.hub?.machine).filter((m): m is string => !!m))].sort();

/** `GET /api/projects/:id/refs`: the versions and branches that have runs, with their latest results. */
export function projectRefs(projectId: string): RefSummary[] {
  const project = projectOrThrow(projectId);
  const groups = refGroups(projectId);
  const releases = groups.filter((g) => g.release);
  const defaultName = defaultBranch(project);
  return groups.map((g) => {
    const prev = g.release ? previousRelease(g.ref, releases) : null;
    const prevGroup = prev && groups.find((x) => sameRef(x.ref, prev));
    return {
      ref: g.ref,
      release: g.release,
      isDefaultBranch: g.ref.kind === "branch" && g.ref.name === defaultName,
      runs: g.runs.length,
      firstAt: g.firstAt,
      lastAt: g.lastAt,
      machines: machinesOf(g.runs),
      lanes: laneCounts(foldCells(g.runs)),
      previous: prev,
      newlyFailing: prevGroup ? changesBetween(projectId, g, prevGroup).counts.newly_failing : null,
    };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Briefs and cells
// ---------------------------------------------------------------------------------------------------------------

const BRIEF_FAILED = 3;
const CELL_ATTEMPTS = 10;

function briefOf(run: Run): RunBrief {
  const problems = [...run.checks.filter((c) => c.status === "fail"), ...run.checks.filter((c) => c.status === "blocked")];
  return {
    id: run.id,
    title: run.title,
    verdict: run.verdict,
    status: run.status,
    createdAt: run.createdAt,
    endedAt: run.endedAt,
    deviceName: run.deviceName,
    platform: platformOf(run),
    branch: branchOf(run),
    commit: commitOf(run),
    versionName: versionOf(run),
    machine: run.hub?.machine ?? null,
    uploader: run.hub?.uploader ?? null,
    reportPath: run.reportPath,
    failed: problems.slice(0, BRIEF_FAILED).map((c) => ({ id: c.id, title: c.title, status: c.status })),
    failedMore: Math.max(0, problems.length - BRIEF_FAILED),
  };
}

/** Flaky and suspect checks of a project, memoised until one of its finished runs changes. */
const flakyMemo = new Map<string, { generation: number; checks: FlakyCheck[] }>();

function flakyOf(projectId: string): FlakyCheck[] {
  const generation = projectGeneration(projectId);
  const hit = flakyMemo.get(projectId);
  if (hit?.generation === generation) return hit.checks;
  const checks = flakyChecks(projectId, { window: 20 }).checks;
  flakyMemo.set(projectId, { generation, checks });
  return checks;
}

/** The newest run decides; `runs` are newest first. */
function cellOf(runs: Run[]): ReleaseCell {
  const latest = runs.find((r) => r.verdict !== null) ?? runs[0]!;
  return {
    latest: briefOf(latest),
    attempts: runs.slice(0, CELL_ATTEMPTS).map(briefOf),
    newlyFailing: regressionOf(latest)?.newlyFailing ?? 0,
    flaky: flakyCountOf(latest),
  };
}

/** How many of the run's checks have a flip history. */
function flakyCountOf(run: Run): number {
  const keys = new Set(flakyOf(run.projectId).map((c) => c.checkKey));
  return run.checks.filter((c) => c.checkKey && keys.has(c.checkKey)).length;
}

const byNewest = (a: Run, b: Run): number => b.createdAt.localeCompare(a.createdAt);

const WORST_RANK: Record<Verdict, number> = { FAIL: 0, BLOCKED: 1, PARTIAL: 2, "PASS WITH ISSUES": 3, PASS: 4 };

/** The worst verdict across cells; null when none has a verdict. */
function worstOf(cells: Cell[]): Verdict | null {
  let worst: Verdict | null = null;
  for (const cell of cells) {
    const v = cell.latest.verdict;
    if (v !== null && (worst === null || WORST_RANK[v] < WORST_RANK[worst])) worst = v;
  }
  return worst;
}

/** Rows with a FAIL cell first, then BLOCKED, then issues/partial, then no verdict, then all-pass; titles A–Z within each. */
function rowRank(worst: Verdict | null): number {
  if (worst === null) return 3;
  return worst === "FAIL" ? 0 : worst === "BLOCKED" ? 1 : worst === "PASS" ? 4 : 2;
}

// ---------------------------------------------------------------------------------------------------------------
// Changes between two releases (the regression module's compare, lane by lane)
// ---------------------------------------------------------------------------------------------------------------

interface Changes {
  counts: Record<CheckTransition, number>;
  items: ChangeItem[];
  untested: ReleaseView["untested"];
  /** When the run behind each item's current side was created, to list the newest regressions first. */
  at: Map<string, string>;
}

const changesMemo = new Map<string, { generation: number; value: Changes }>();

/** Runs by test × platform, each list newest first (the input order). */
function lanesOf(runs: Run[]): Map<string, Run[]> {
  const lanes = new Map<string, Run[]>();
  for (const run of runs) {
    if (run.testKey === null) continue;
    const key = `${run.testKey}\0${platformOf(run)}`;
    const lane = lanes.get(key);
    if (lane) lane.push(run);
    else lanes.set(key, [run]);
  }
  return lanes;
}

const emptyCounts = (): Record<CheckTransition, number> => Object.fromEntries(TRANSITIONS.map((t) => [t, 0])) as Record<CheckTransition, number>;

/**
 * What changed from `previous` to `current`: each test × platform of `current` is compared with the same lane of
 * `previous` (every run of the lane folded, newest decisive result per check), so re-runs complete the picture. Lanes
 * that only `previous` has are listed as untested, and their checks as removed.
 */
function changesBetween(projectId: string, current: RefGroup, previous: RefGroup): Changes {
  const memoKey = `${projectId}|${refKey(current.ref)}|${refKey(previous.ref)}`;
  const generation = projectGeneration(projectId);
  const hit = changesMemo.get(memoKey);
  if (hit?.generation === generation) return hit.value;

  const runs = new Map([...current.runs, ...previous.runs].map((r) => [r.id, r]));
  const deps = { runById: (id: string) => runs.get(id) ?? null, durationMs: () => null, screenshotUrl: () => null };
  const testTitle = new Map<string, string>();
  for (const run of [...previous.runs, ...current.runs].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) if (run.testKey !== null) testTitle.set(run.testKey, run.title);

  const value: Changes = { counts: emptyCounts(), items: [], untested: [], at: new Map() };
  // A check that is new (or gone) on both platforms is one check: those two counts are of distinct check keys, the rows stay per lane.
  const counted = new Set<string>();
  const add = (item: ChangeItem): void => {
    value.items.push(item);
    const once = item.transition === "new" || item.transition === "removed";
    if (!once || !counted.has(`${item.transition}\0${item.checkKey}`)) value.counts[item.transition]++;
    if (once) counted.add(`${item.transition}\0${item.checkKey}`);
    if (item.current) value.at.set(item.current.runId, runs.get(item.current.runId)?.createdAt ?? "");
  };

  const before = lanesOf(previous.runs);
  const now = lanesOf(current.runs);
  for (const [laneKey, laneRuns] of now) {
    const baseRuns = before.get(laneKey);
    const head = laneRuns[0]!;
    const lane = { testKey: head.testKey!, testTitle: testTitle.get(head.testKey!) ?? head.title, platform: platformOf(head) };
    const primary = baseRuns?.[0];
    if (!baseRuns || !primary) {
      for (const [checkKey, r] of foldSnapshot(laneRuns)) add({ ...lane, transition: "new", checkKey, title: r.check.title, current: { runId: r.run.id, checkId: r.check.id, status: r.check.status }, previous: null });
      continue;
    }
    const baseline: Baseline = {
      auto: true,
      tier: "any",
      kind: baseRuns.length > 1 ? "snapshot" : "run",
      primaryRunId: primary.id,
      runIds: baseRuns.map((r) => r.id),
      branch: branchOf(primary),
      commit: commitOf(primary),
      reason: "",
      platformMismatch: false,
      deviceChanged: false,
      harnessChanged: false,
      modelChanged: false,
      buildChanged: false,
      sameCommit: false,
    };
    const core = compareRuns(head, baseline, { includeFlaky: false, headRuns: laneRuns }, deps);
    for (const pair of core?.pairs ?? []) {
      const side = pair.current ?? pair.baseline!;
      add({
        ...lane,
        transition: pair.transition,
        checkKey: pair.checkKey ?? pair.key,
        title: side.title,
        current: pair.current && { runId: pair.current.runId, checkId: pair.current.checkId, status: pair.current.status },
        previous: pair.baseline && { runId: pair.baseline.runId, checkId: pair.baseline.checkId, status: pair.baseline.status },
      });
    }
  }
  for (const [laneKey, laneRuns] of before) {
    if (now.has(laneKey)) continue;
    const head = laneRuns[0]!;
    const lane = { testKey: head.testKey!, testTitle: testTitle.get(head.testKey!) ?? head.title, platform: platformOf(head) };
    value.untested.push({ testKey: lane.testKey, title: lane.testTitle, platform: lane.platform });
    for (const [checkKey, r] of foldSnapshot(laneRuns)) add({ ...lane, transition: "removed", checkKey, title: r.check.title, current: null, previous: { runId: r.run.id, checkId: r.check.id, status: r.check.status } });
  }
  changesMemo.set(memoKey, { generation, value });
  return value;
}

// ---------------------------------------------------------------------------------------------------------------
// Release view
// ---------------------------------------------------------------------------------------------------------------

/** `version:2.4.0` / `branch:release/2.4`; the name may itself contain colons. `all` and empty mean no ref. */
export function parseRef(text: string | null | undefined): Ref | null {
  if (!text || text === "all") return null;
  const colon = text.indexOf(":");
  const kind = text.slice(0, colon);
  const name = text.slice(colon + 1);
  if (colon < 0 || (kind !== "version" && kind !== "branch") || name === "") throw new HttpError(400, `ref must be all, version:<name> or branch:<name>, got ${text}`);
  return { kind, name };
}

/** The release `ref` is compared with: `against` when it names a ref, else the rule's previous release. */
function resolveAgainst(ref: Ref, against: string | undefined, groups: RefGroup[]): { previous: RefGroup | null; auto: boolean } {
  const picked = against === undefined || against === "auto" ? null : parseRef(against);
  if (picked === null) {
    const prev = previousRelease(ref, groups.filter((g) => g.release));
    return { previous: groups.find((g) => prev && sameRef(g.ref, prev)) ?? null, auto: true };
  }
  if (sameRef(picked, ref)) throw new HttpError(400, "a release cannot be compared with itself", "same_ref");
  const group = groups.find((g) => sameRef(g.ref, picked));
  if (!group) throw new HttpError(404, `no runs for ${refKey(picked)}`, "unknown_ref");
  return { previous: group, auto: false };
}

export function releaseView(projectId: string, opts: { kind: Ref["kind"]; name: string; against?: string }): ReleaseView {
  const project = projectOrThrow(projectId);
  const ref: Ref = { kind: opts.kind, name: opts.name };
  const groups = refGroups(projectId);
  const group = groups.find((g) => sameRef(g.ref, ref));
  if (!group) throw new HttpError(404, `no runs for ${refKey(ref)}`, "unknown_ref");

  const { previous, auto } = resolveAgainst(ref, opts.against, groups);
  const changes = previous ? changesBetween(projectId, group, previous) : null;
  const cells = foldCells(group.runs);
  const titleOf = new Map<string, Run>();
  for (const run of group.runs) if (run.testKey !== null && !titleOf.has(run.testKey)) titleOf.set(run.testKey, run);

  const devices = new Map<string, { key: string; name: string; platform: Platform }>();
  for (const cell of cells) devices.set(cell.deviceKey, { key: cell.deviceKey, name: cell.deviceName, platform: cell.platform });
  const columns = [...devices.values()].sort((a, b) => Number(a.platform === "ios") - Number(b.platform === "ios") || a.name.localeCompare(b.name));

  const byTest = new Map<string, Cell[]>();
  for (const cell of cells) byTest.set(cell.testKey, [...(byTest.get(cell.testKey) ?? []), cell]);

  const tests = [...byTest.entries()].map(([testKey, testCells]) => {
    const newest = titleOf.get(testKey)!;
    const platforms: Partial<Record<Platform, ReleaseCell>> = {};
    for (const platform of ["android", "ios"] as const) {
      const onPlatform = testCells.filter((c) => c.platform === platform);
      if (onPlatform.length > 0) platforms[platform] = cellOf(onPlatform.flatMap((c) => c.runs).sort(byNewest));
    }
    return {
      testKey,
      title: newest.title,
      suiteId: newest.suiteId,
      cells: Object.fromEntries(columns.map((d) => [d.key, ((c) => (c ? cellOf(c.runs) : null))(testCells.find((x) => x.deviceKey === d.key))])),
      platforms,
      worst: worstOf(testCells),
    };
  });
  tests.sort((a, b) => rowRank(a.worst) - rowRank(b.worst) || a.title.localeCompare(b.title));

  const blockers: ReleaseView["blockers"] = [];
  for (const test of tests) {
    for (const [deviceKey, cell] of Object.entries(test.cells)) {
      if (cell && (cell.latest.verdict === "FAIL" || cell.latest.verdict === "BLOCKED")) blockers.push({ testKey: test.testKey, title: test.title, deviceKey, cell });
    }
  }
  blockers.sort(
    (a, b) =>
      Number(a.cell.latest.verdict === "BLOCKED") - Number(b.cell.latest.verdict === "BLOCKED") ||
      b.cell.newlyFailing - a.cell.newlyFailing ||
      b.cell.latest.createdAt.localeCompare(a.cell.latest.createdAt),
  );

  const machines = new Map<string, string | null>();
  for (const run of group.runs) {
    const hub = run.hub;
    if (hub && (!machines.has(hub.machine) || machines.get(hub.machine) === null)) machines.set(hub.machine, hub.uploader);
  }

  return {
    project: { id: project.id, name: project.name, hubKey: project.hubKey ?? null },
    ref,
    previous: previous?.ref ?? null,
    auto,
    span: { firstAt: group.firstAt, lastAt: group.lastAt },
    runs: group.runs.length,
    machines: [...machines].map(([name, uploader]) => ({ name, uploader })).sort((a, b) => a.name.localeCompare(b.name)),
    devices: columns,
    tests,
    blockers,
    untested: changes?.untested ?? [],
    changes: changes && { counts: changes.counts, items: changes.items },
    summary: { tests: tests.length, cells: cells.length, ...laneCounts(cells) },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Project overview
// ---------------------------------------------------------------------------------------------------------------

export interface LaneCell {
  /** Newest run with a verdict in scope. */
  latest: RunBrief;
  /** Newer runs that ended without a verdict (error, cancelled, interrupted). */
  newerWithoutVerdict: number;
  /** Oldest → newest, at most 10. */
  history: { id: string; verdict: Verdict | null; status: RunStatus; createdAt: string }[];
  newlyFailing: number;
  flaky: number;
}

export interface ProjectOverview {
  project: {
    id: string;
    name: string;
    hubKey: string | null;
    defaultBranch: string | null;
    firstSeenAt: string | null;
    lastUploadAt: string | null;
    lastUploadBy: { machine: string; uploader: string | null } | null;
  };
  ref: Ref | null;
  days: number;
  /** Oldest first, zero-filled. */
  trend: { date: string; runs: number; pass: number; issues: number; fail: number; other: number }[];
  /** 0–1; `previous` is the `days` before. Only PASS counts as passed; BLOCKED and PARTIAL are not decided. */
  passRate: { current: number | null; previous: number | null; pass: number; decided: number };
  counts: { newlyFailing: number; newlyFailingTests: number; flaky: number; suspects: number; failingNow: number; blockedNow: number; tests: number };
  lanes: { testKey: string; title: string; suiteId: string | null; checks: number; platforms: Partial<Record<Platform, LaneCell>> }[];
  latestRelease: { ref: Ref; previous: Ref | null; counts: Record<CheckTransition, number>; top: ChangeItem[] } | null;
  recent: RunView[];
}

const DEFAULT_DAYS = 30;
const HISTORY = 10;
const RECENT = 8;
const TOP_CHANGES = 5;
const NO_VERDICT: RunStatus[] = ["error", "cancelled", "interrupted"];

const passRateOf = (stats: { pass: number; issues: number; fail: number }): { rate: number | null; pass: number; decided: number } => {
  const decided = stats.pass + stats.issues + stats.fail;
  return { rate: decided === 0 ? null : stats.pass / decided, pass: stats.pass, decided };
};

/** `latestRelease`: the scoped release, else the release with the newest activity, with what changed since its previous one. */
function latestReleaseOf(projectId: string, groups: RefGroup[], scope: RefGroup | null): ProjectOverview["latestRelease"] {
  const releases = groups.filter((g) => g.release);
  const current = scope?.release ? scope : releases.reduce<RefGroup | null>((best, g) => (best === null || g.lastAt > best.lastAt ? g : best), null);
  if (!current) return null;
  const prev = previousRelease(current.ref, releases);
  const previous = groups.find((g) => prev && sameRef(g.ref, prev)) ?? null;
  if (!previous) return { ref: current.ref, previous: null, counts: emptyCounts(), top: [] };
  const changes = changesBetween(projectId, current, previous);
  const top = changes.items
    .filter((i) => i.transition === "newly_failing")
    .sort((a, b) => (changes.at.get(b.current!.runId) ?? "").localeCompare(changes.at.get(a.current!.runId) ?? ""))
    .slice(0, TOP_CHANGES);
  return { ref: current.ref, previous: previous.ref, counts: changes.counts, top };
}

export function projectOverview(projectId: string, opts: { ref?: Ref | null; days?: number; now?: Date } = {}): ProjectOverview {
  const project = projectOrThrow(projectId);
  const days = opts.days ?? DEFAULT_DAYS;
  const now = opts.now ?? new Date();
  const ref = opts.ref ?? null;
  const groups = refGroups(projectId);
  const scope = ref ? (groups.find((g) => sameRef(g.ref, ref)) ?? null) : null;
  if (ref && !scope) throw new HttpError(404, `no runs for ${refKey(ref)}`, "unknown_ref");
  const all = finishedRuns(projectId);
  const runs = scope ? scope.runs : all;

  const stats = computeStats(runs, days, now);
  const first = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
  const before = computeStats(runs, days, new Date(first.getFullYear(), first.getMonth(), first.getDate() - 1));
  const [current, previous] = [passRateOf(stats), passRateOf(before)];

  const flaky = flakyOf(projectId);
  const scoped = new Set(runs.flatMap((r) => r.checks.map((c) => c.checkKey).filter((k): k is string => !!k)));
  const inScope = flaky.filter((c) => scoped.has(c.checkKey));

  const byTest = new Map<string, { title: string; suiteId: string | null; checks: number; at: string; platforms: Partial<Record<Platform, LaneCell>> }>();
  let newlyFailing = 0;
  const regressed = new Set<string>();
  const worst = new Map<string, Verdict | null>();
  for (const [laneKey, laneRuns] of lanesOf(runs)) {
    const latest = laneRuns.find((r) => r.verdict !== null);
    if (!latest) continue;
    const testKey = laneKey.split("\0")[0]!;
    const newer = laneRuns.slice(0, laneRuns.indexOf(latest));
    const cell: LaneCell = {
      latest: briefOf(latest),
      newerWithoutVerdict: newer.filter((r) => NO_VERDICT.includes(r.status)).length,
      history: laneRuns.slice(0, HISTORY).reverse().map((r) => ({ id: r.id, verdict: r.verdict, status: r.status, createdAt: r.createdAt })),
      newlyFailing: regressionOf(latest)?.newlyFailing ?? 0,
      flaky: flakyCountOf(latest),
    };
    newlyFailing += cell.newlyFailing;
    if (cell.newlyFailing > 0) regressed.add(testKey);
    const have = byTest.get(testKey);
    const entry = have ?? { title: latest.title, suiteId: latest.suiteId, checks: latest.checks.length, at: latest.createdAt, platforms: {} };
    entry.platforms[platformOf(latest)] = cell;
    if (latest.createdAt >= entry.at) Object.assign(entry, { title: latest.title, suiteId: latest.suiteId, checks: latest.checks.length, at: latest.createdAt });
    byTest.set(testKey, entry);
    const prior = worst.get(testKey) ?? null;
    worst.set(testKey, prior !== null && (latest.verdict === null || WORST_RANK[prior] <= WORST_RANK[latest.verdict]) ? prior : latest.verdict);
  }
  const verdicts = [...worst.values()];

  const uploaded = all.filter((r) => r.hub).sort((a, b) => a.hub!.receivedAt.localeCompare(b.hub!.receivedAt));
  const lastUpload = uploaded.at(-1)?.hub ?? null;

  return {
    project: {
      id: project.id,
      name: project.name,
      hubKey: project.hubKey ?? null,
      defaultBranch: defaultBranch(project),
      firstSeenAt: uploaded[0]?.hub?.receivedAt ?? null,
      lastUploadAt: lastUpload?.receivedAt ?? null,
      lastUploadBy: lastUpload ? { machine: lastUpload.machine, uploader: lastUpload.uploader } : null,
    },
    ref,
    days,
    trend: stats.byDay.map(({ date, runs: n, pass, issues, fail, other }) => ({ date, runs: n, pass, issues, fail, other })),
    passRate: { current: current.rate, previous: previous.rate, pass: current.pass, decided: current.decided },
    counts: {
      newlyFailing,
      newlyFailingTests: regressed.size,
      flaky: inScope.filter((c) => c.confidence === "flaky").length,
      suspects: inScope.filter((c) => c.confidence === "suspect").length,
      failingNow: verdicts.filter((v) => v === "FAIL").length,
      blockedNow: verdicts.filter((v) => v === "BLOCKED").length,
      tests: byTest.size,
    },
    lanes: [...byTest.entries()]
      .map(([testKey, { title, suiteId, checks, platforms }]) => ({ testKey, title, suiteId, checks, platforms }))
      .sort((a, b) => a.title.localeCompare(b.title)),
    latestRelease: latestReleaseOf(projectId, groups, scope),
    recent: runs.slice(0, RECENT).map(runView),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------------------------------

const MAX_DAYS = 90;
const OverviewQuery = z.object({ days: z.coerce.number().int().min(1).max(MAX_DAYS).default(DEFAULT_DAYS) });

/**
 * `GET /api/projects/:id/refs`, `/overview?ref=&days=` and `/releases/:kind/:name?against=`. Null for any other request,
 * so the caller falls through to its own routes. Errors are `HttpError`s (400 bad query, 404 unknown project or ref).
 */
export async function overviewRoute(req: Request, url: URL): Promise<Response | null> {
  if (req.method !== "GET") return null;
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] !== "api" || parts[1] !== "projects" || parts[2] === undefined) return null;
  const projectId = parts[2];

  if (parts.length === 4 && parts[3] === "refs") return Response.json({ refs: projectRefs(projectId) });

  if (parts.length === 4 && parts[3] === "overview") {
    const query = OverviewQuery.safeParse({ ...(url.searchParams.has("days") ? { days: url.searchParams.get("days") } : {}) });
    if (!query.success) throw new HttpError(400, `days must be an integer between 1 and ${MAX_DAYS}`);
    return Response.json(projectOverview(projectId, { ref: parseRef(url.searchParams.get("ref")), days: query.data.days }));
  }

  if (parts.length >= 6 && parts[3] === "releases") {
    const kind = parts[4];
    if (kind !== "version" && kind !== "branch") throw new HttpError(404, `unknown release kind ${kind}`);
    // A branch name may carry unencoded slashes (`release/2.4`): everything after the kind is the name.
    return Response.json(releaseView(projectId, { kind, name: parts.slice(5).join("/"), against: url.searchParams.get("against") ?? undefined }));
  }
  return null;
}
