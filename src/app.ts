import path from "node:path";
import { type BatchSummary, getBatchMeta, summarizeBatch } from "./batches";
import { config, HttpError } from "./config";
import { type Device, listDevices } from "./devices/devices";
import { gateway, stopOnLeaseEnd } from "./devices/gateway";
import * as leases from "./devices/leases";
import {
  bootAndroid,
  bootedCount,
  bootIos,
  isBootedByTapocalypse,
  isBootingTarget,
  manualBootCount,
  type PoolView,
  poolView,
  startIdleReaper,
} from "./devices/pool";
import { gcBlobs, hubEvents } from "./hub/ingest";
import { isHub } from "./hub/mode";
import { installHubProjects } from "./hub/projects";
import { type HubSync, hubSyncState, startHubSync } from "./hub/sync";
import { getProject, initProjects, listProjects } from "./projects/registry";
import { branchOf, commitOf, defaultBranch, headSnapshot, noBaselineReason, platformOf, resolveBaseline } from "./regression/baseline";
import { compareRuns } from "./regression/compare";
import { analyzeEntries, deviceFlips, flakyChecks } from "./regression/flaky";
import { backfill, checkEntries, keysOf, projectGeneration } from "./regression/index";
import type {
  Baseline,
  CheckHistory,
  CheckHistoryEntry,
  ComparePair,
  FindRegressionsResult,
  FindRegressionsTest,
  FlakyCheck,
  RegressionItem,
  RunComparison,
  RunRegression,
} from "./regression/types";
import { isImagePath, LEGACY_REPORTS_DIR, reportLocation, runArtefactDir, runImages, screenshotFile } from "./runs/artefacts";
import { startRetention } from "./retention";
import { createRunner } from "./runs/runner";
import { type QueueHold, Scheduler } from "./runs/scheduler";
import { runMatches } from "./runs/source";
import { getRun, listRuns } from "./runs/store";
import { ACTIVE, type Check, type HubOrigin, type Platform, type Run } from "./runs/types";

export const scheduler: Scheduler = new Scheduler({
  config,
  listDevices,
  bootedCount,
  manualBootCount,
  isBootingTarget,
  leases: {
    bus: leases.bus,
    grantRun: leases.grantRun,
    releaseRun: leases.releaseRun,
    deviceOwner: leases.deviceOwner,
    runLease: leases.runLease,
    runLeaseCount: leases.runLeaseCount,
    grantAgent: leases.grantAgent,
    claim: leases.claim,
    holdForClaim: leases.holdForClaim,
  },
  boot: (platform, target) => (platform === "android" ? bootAndroid(target) : bootIos(target)),
  startRun: (run, target) => runner.startRun(run, target),
  cancelActive: (id) => runner.cancelActive(id),
});

export const runner = createRunner(scheduler);

export async function devicesView(): Promise<Device[]> {
  return scheduler.overlay(await listDevices(), isBootedByTapocalypse);
}

/** Pool state for the Devices page: run slots, boots, idle devices and who waits for any device of a platform. */
export async function poolStateView(): Promise<PoolView> {
  await listDevices();
  return poolView(scheduler.activeCount(), scheduler.waitingView());
}

/** Who uploaded a hub copy and when (the run's `hub` origin without the uploader's machine-local keys). */
export type HubAttribution = Pick<HubOrigin, "machine" | "uploader" | "receivedAt" | "localProjectId">;

export type RunView = Omit<Run, "hub"> & {
  /** Hub copies only: who uploaded the run; null on laptops and for runs that were never uploaded. */
  hub: HubAttribution | null;
  queuePosition: number | null;
  /** Elapsed time for active runs, total time for finished ones; null before the run started. */
  durationMs: number | null;
  /** Why a queued run is still waiting; null once it has a slot. */
  queueReason: string | null;
  /** The agent lease a queued run waits behind (explicit serial: its holder; "any": the lease that ends first); null otherwise. */
  queueHold: QueueHold | null;
  /** Absolute path where the run's report is stored (either storage), derived from the run record without touching the disk; null when it has none. */
  reportFile: string | null;
  /** Absolute path of the run's folder in Tapocalypse's data dir (events, and for data runs the report and screenshots). */
  runDir: string;
  /** How a finished run compares with its automatic baseline (null while active, without checks or without an earlier run of the test). */
  regression: RunRegression | null;
  /** Laptop only: upload state of this run when its project is shared and a hub is configured; null otherwise (and always on a hub). */
  hubSync: HubSync | null;
};

export function runDurationMs(run: Run): number | null {
  if (!run.startedAt) return null;
  const end = run.endedAt ? Date.parse(run.endedAt) : Date.now();
  return Math.max(0, end - Date.parse(run.startedAt));
}

export function runView(run: Run): RunView {
  const { hub, ...rest } = run;
  return {
    ...rest,
    // The uploader's own keys stay on the server: the UI needs only who sent it and when.
    hub: hub ? { machine: hub.machine, uploader: hub.uploader, receivedAt: hub.receivedAt, localProjectId: hub.localProjectId } : null,
    queuePosition: scheduler.queuePosition(run.id),
    durationMs: runDurationMs(run),
    queueReason: scheduler.queueReason(run.id),
    queueHold: scheduler.queueHold(run.id),
    // The hub's own filesystem layout is none of a viewer's business.
    reportFile: isHub() ? null : reportLocation(run, getProject(run.projectId) ?? null),
    runDir: isHub() ? "" : runArtefactDir(run.id),
    regression: regressionOf(run),
    hubSync: isHub() ? null : hubSyncState(run.id, run),
  };
}

export function findRun(id: string): Run | null {
  return scheduler.getLive(id) ?? getRun(id);
}

export interface RunQuery {
  project?: string;
  status?: string[];
  /** Verdict names; `none` matches runs without a verdict. */
  verdict?: string[];
  q?: string;
  batch?: string;
  branch?: string;
  /** `build.versionName` of the run. */
  version?: string;
  /** Hub only: upload token names (a run matches any of them). */
  machine?: string[];
  pr?: number;
  ticket?: string;
  commit?: string;
  /** Only finished runs with at least one newly failing check against their automatic baseline (flaky excluded). */
  regressed?: boolean;
  limit?: number;
  /** `createdAt` of the last run of the previous page. */
  before?: string;
}

const DEFAULT_RUN_LIMIT = 100;
const MAX_RUN_LIMIT = 500;

function matchesText(run: Run, q: string): boolean {
  const pr = run.source?.pr;
  const haystack = [
    run.id,
    run.title,
    run.requestedBy,
    run.deviceSerial,
    run.deviceName,
    run.source?.branch,
    run.source?.commit,
    pr ? `#${pr.number}` : null,
    pr?.title,
    ...(run.source?.tickets ?? []),
  ];
  // Every word must match some field, in any order: "checkout main" finds a Checkout run on main.
  return q.split(/\s+/).every((word) => haystack.some((h) => h?.toLowerCase().includes(word)));
}

/** Newest-first page of runs matching every given filter; live scheduler state wins over the persisted copy. */
export function queryRuns(query: RunQuery): { runs: RunView[]; hasMore: boolean } {
  const limit = Math.min(MAX_RUN_LIMIT, Math.max(1, query.limit ?? DEFAULT_RUN_LIMIT));
  const q = query.q?.trim().toLowerCase();
  const source = { branch: query.branch, pr: query.pr, ticket: query.ticket, commit: query.commit };
  const bySource = Object.values(source).some((v) => v !== undefined);
  const matched: Run[] = [];
  let hasMore = false;
  for (const stored of listRuns({ projectId: query.project })) {
    if (query.before && stored.createdAt >= query.before) continue;
    const run = scheduler.getLive(stored.id) ?? stored;
    if (query.status?.length && !query.status.includes(run.status)) continue;
    if (query.verdict?.length && !query.verdict.includes(run.verdict ?? "none")) continue;
    if (query.batch && run.batchId !== query.batch) continue;
    if (query.version && run.build?.versionName !== query.version) continue;
    if (query.machine?.length && !(run.hub && query.machine.includes(run.hub.machine))) continue;
    if (bySource && !runMatches(run, source)) continue;
    if (q && !matchesText(run, q)) continue;
    if (query.regressed && !((regressionOf(run)?.newlyFailing ?? 0) > 0)) continue;
    if (matched.length === limit) {
      hasMore = true;
      break;
    }
    matched.push(run);
  }
  return { runs: matched.map(runView), hasMore };
}

export interface BatchView extends BatchSummary {
  id: string;
  projectId: string;
  title: string;
  runs: RunView[];
}

/** Null when no run (and no metadata) carries this batch id. */
export function batchView(id: string): BatchView | null {
  const runs = listRuns()
    .filter((r) => r.batchId === id)
    .map((r) => scheduler.getLive(r.id) ?? r)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const meta = getBatchMeta(id);
  const first = runs[0];
  if (!first) return null;
  return {
    id,
    projectId: meta?.projectId ?? first.projectId,
    title: meta?.title ?? first.title,
    runs: runs.map(runView),
    ...summarizeBatch(runs),
  };
}

export interface RunScreenshot {
  /** Same form as `Check.screenshot`: relative to the run's artefact folder (data runs) or to the project repo (legacy runs). */
  path: string;
  url: string;
  name: string;
  mtime: string;
  checkId: string | null;
}

/** URL the UI loads a check screenshot (`Check.screenshot` form) from; null when the file could not be served. Touches no disk. */
function screenshotUrlFor(run: Run, rel: string): string | null {
  const segments = (p: string) => p.split("/").map(encodeURIComponent).join("/");
  if (run.storage === "data") return `/api/runs/${encodeURIComponent(run.id)}/files/${segments(rel)}`;
  const project = getProject(run.projectId) ?? null;
  const reportsDir = path.posix.normalize((project?.reportsDir ?? LEGACY_REPORTS_DIR).replace(/\\/g, "/"));
  const rest = path.posix.relative(reportsDir, rel);
  if (!project || !rest || rest.startsWith("..") || path.posix.isAbsolute(rest)) return null;
  return `/files/${encodeURIComponent(project.id)}/${segments(rest)}`;
}

/** Images in the run's screenshots folder plus any other image a check points at, each with the URL the UI loads it from. */
export function runScreenshots(run: Run): RunScreenshot[] {
  const project = getProject(run.projectId) ?? null;
  const out: RunScreenshot[] = [];
  for (const image of runImages(run, project)) {
    const url = screenshotUrlFor(run, image.rel);
    if (url) out.push({ path: image.rel, url, name: image.name, mtime: image.mtime, checkId: image.checkId });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Regression intelligence: compare, baseline picker, check history, flaky checks, find-regressions
// ---------------------------------------------------------------------------------------------------------------

const compareDeps = {
  runById: findRun,
  durationMs: runDurationMs,
  screenshotUrl: (run: Run, check: Check) => (check.screenshot && isImagePath(check.screenshot) ? screenshotUrlFor(run, check.screenshot) : null),
};

/** Memoised per run; a project's entries are dropped whenever one of its finished runs is saved or deleted or a check is linked, never by a live run's progress. */
const regressionMemo = new Map<string, { generation: number; runs: Map<string, { stamp: string; value: RunRegression | null }> }>();

export function regressionOf(run: Run): RunRegression | null {
  if (ACTIVE.includes(run.status) || run.checks.length === 0) return null;
  const generation = projectGeneration(run.projectId);
  let project = regressionMemo.get(run.projectId);
  if (!project || project.generation !== generation) {
    project = { generation, runs: new Map() };
    regressionMemo.set(run.projectId, project);
  }
  const settings = getProject(run.projectId);
  const stamp = `${run.status}|${run.endedAt}|${run.checks.length}|${settings ? (defaultBranch(settings) ?? "") : ""}`;
  const hit = project.runs.get(run.id);
  if (hit?.stamp === stamp) return hit.value;
  let value: RunRegression | null = null;
  const baseline = resolveBaseline(run, { baseline: "auto", find: findRun });
  const primary = baseline ? findRun(baseline.primaryRunId) : null;
  const core = baseline && primary ? compareRuns(run, baseline, { includeFlaky: false, headRuns: headSnapshot(run) }, compareDeps) : null;
  if (core && primary) {
    value = {
      baselineId: primary.id,
      baselineTitle: primary.title,
      baselineBranch: branchOf(primary),
      baselineCreatedAt: primary.createdAt,
      newlyFailing: core.counts.newly_failing,
      fixed: core.counts.fixed,
      flaky: core.counts.flaky,
    };
  }
  project.runs.set(run.id, { stamp, value });
  return value;
}

export interface CompareViewResult {
  comparison: RunComparison | null;
  reason: "no_baseline" | "no_checks" | null;
  reasonText: string | null;
}

/**
 * The run against its baseline (`auto` or a run id). Unknown run: 404. An explicit baseline that is unknown is 404,
 * the run itself or another project's run is 400 with `code` `same_run` / `different_project`.
 */
export function compareView(runId: string, opts: { baseline: "auto" | string; includeFlaky: boolean }): CompareViewResult {
  const head = findRun(runId);
  if (!head) throw new HttpError(404, `run not found: ${runId}`);
  const baseline = resolveBaseline(head, { baseline: opts.baseline, find: findRun });
  if (head.checks.length === 0) {
    const reasonText = ACTIVE.includes(head.status)
      ? "Comparing once the agent declares its checks."
      : "This run resolved no checks, so there is nothing to compare.";
    return { comparison: null, reason: "no_checks", reasonText };
  }
  const core = baseline ? compareRuns(head, baseline, { includeFlaky: opts.includeFlaky, headRuns: headSnapshot(head) }, compareDeps) : null;
  const baselineRun = baseline ? findRun(baseline.primaryRunId) : null;
  if (!core || !baselineRun) return { comparison: null, reason: "no_baseline", reasonText: noBaselineReason(head) };
  return { comparison: { current: runView(head), baselineRun: runView(baselineRun), ...core }, reason: null, reasonText: null };
}

export type CandidateGroup = "suggested" | "branch" | "base" | "test" | "other";
const CANDIDATE_GROUPS: CandidateGroup[] = ["suggested", "branch", "base", "test", "other"];

export interface BaselineCandidate {
  run: RunView;
  suggested: boolean;
  group: CandidateGroup;
  platformMismatch: boolean;
  reason: string | null;
}

/** Runs of the same project the user can pick as a baseline, grouped (suggested, same branch, base branch, same test, other), newest first. */
export function baselineCandidates(runId: string, opts: { q?: string; limit: number }): { candidates: BaselineCandidate[] } {
  const head = findRun(runId);
  if (!head) throw new HttpError(404, `run not found: ${runId}`);
  const q = opts.q?.trim().toLowerCase();
  const auto = resolveBaseline(head, { baseline: "auto", find: findRun });
  const project = getProject(head.projectId);
  const baseBranches = new Set([head.source?.pr?.baseBranch ?? null, project ? defaultBranch(project) : null].filter((b): b is string => b !== null));
  const own = branchOf(head);
  // Filter, group and sort on the raw runs; only the page that is returned pays for a `runView`.
  const found: { run: Run; suggested: boolean; group: CandidateGroup; platformMismatch: boolean }[] = [];
  for (const stored of listRuns({ projectId: head.projectId })) {
    const run = findRun(stored.id) ?? stored;
    if (run.id === head.id || run.checks.length === 0 || (q && !matchesText(run, q))) continue;
    const suggested = auto?.runIds.includes(run.id) ?? false;
    const branch = branchOf(run);
    const group: CandidateGroup = suggested
      ? "suggested"
      : own !== null && branch === own
        ? "branch"
        : branch !== null && baseBranches.has(branch)
          ? "base"
          : head.testKey !== null && run.testKey === head.testKey
            ? "test"
            : "other";
    found.push({ run, suggested, group, platformMismatch: platformOf(run) !== platformOf(head) });
  }
  found.sort((a, b) => CANDIDATE_GROUPS.indexOf(a.group) - CANDIDATE_GROUPS.indexOf(b.group) || (a.run.createdAt < b.run.createdAt ? 1 : -1));
  const candidates = found.slice(0, opts.limit).map(({ run, suggested, group, platformMismatch }) => ({
    run: runView(run),
    suggested,
    group,
    platformMismatch,
    reason: suggested && auto ? auto.reason : platformMismatch ? `Ran on ${platformOf(run) === "ios" ? "iOS" : "Android"}, this run on ${platformOf(head) === "ios" ? "iOS" : "Android"}.` : null,
  }));
  return { candidates };
}

/** History of one check across runs: by key, or by a run's check (live runs resolve the key on the fly). Unknown key / run / check: 404. */
export function historyView(
  input: { projectId: string; checkKey: string } | { runId: string; checkId: string },
  opts: { limit: number; before?: string; branch?: string; platform?: Platform },
): CheckHistory {
  let projectId: string;
  let checkKey: string;
  let liveCheck: { run: Run; check: Check } | null = null;
  if ("runId" in input) {
    const head = findRun(input.runId);
    const check = head?.checks.find((c) => c.id === input.checkId);
    const key = head && check ? keysOf(head).get(check.id) : undefined;
    if (!head || !check || !key) throw new HttpError(404, `check not found: ${input.runId}/${input.checkId}`);
    projectId = head.projectId;
    checkKey = key.checkKey;
    liveCheck = { run: head, check };
  } else {
    ({ projectId, checkKey } = input);
  }
  const all = checkEntries(projectId, checkKey);
  if (all.length === 0 && !liveCheck) throw new HttpError(404, `unknown check key: ${checkKey}`);
  const newest = all[0] ?? liveCheck;
  if (!newest) throw new HttpError(404, `unknown check key: ${checkKey}`);

  const analysis = analyzeEntries(all);
  const sameCodeFlips = analyzeEntries(all, all.length).flippedRuns;
  const flips = deviceFlips(all);
  const shown = all.filter(
    (e) =>
      (!opts.before || e.run.createdAt < opts.before) &&
      (!opts.branch || branchOf(e.run) === opts.branch) &&
      (!opts.platform || platformOf(e.run) === opts.platform),
  );
  const entries: CheckHistoryEntry[] = shown.slice(0, opts.limit).map(({ run, check }) => ({
    runId: run.id,
    runTitle: run.title,
    checkId: check.id,
    title: check.title,
    status: check.status,
    note: check.note ?? null,
    screenshotUrl: compareDeps.screenshotUrl(run, check),
    createdAt: run.createdAt,
    platform: platformOf(run),
    deviceName: run.deviceName,
    commit: commitOf(run),
    dirty: run.source?.dirty ?? null,
    branch: branchOf(run),
    build: run.build?.versionName ? `${run.build.versionName}${run.build.versionCode ? ` (${run.build.versionCode})` : ""}` : null,
    harness: run.harness,
    model: run.model ?? run.usage?.model ?? null,
    verdict: run.verdict,
    keyKind: keysOf(run).get(check.id)?.keyKind ?? null,
    flip: flips.has(run.id),
    flippedOnSameCode: sameCodeFlips.has(run.id),
  }));
  return {
    projectId,
    checkKey,
    keyKind: keysOf(newest.run).get(newest.check.id)?.keyKind ?? "title",
    title: newest.check.title,
    flaky: analysis.flaky,
    deviceSensitive: analysis.deviceSensitive,
    unstable: analysis.unstable,
    flips: analysis.flips,
    window: analysis.window,
    passRate: analysis.passRate,
    entries,
    hasMore: shown.length > opts.limit,
  };
}

export function flakyView(
  projectId: string,
  opts: { platform?: Platform; window: number },
): { checks: FlakyCheck[]; trackedKeys: number; repeatedKeys: number } {
  return flakyChecks(projectId, opts);
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

function regressionItem(pair: ComparePair): RegressionItem | null {
  const { current, baseline } = pair;
  if (!current || !pair.checkKey) return null;
  const shot = (runId: string, checkId: string): string | null => {
    const run = findRun(runId);
    const rel = run?.checks.find((c) => c.id === checkId)?.screenshot;
    return run && rel ? screenshotFile(run, getProject(run.projectId) ?? null, rel) : null;
  };
  return {
    checkKey: pair.checkKey,
    title: current.title,
    current: { runId: current.runId, checkId: current.checkId, status: current.status, note: current.note, screenshotPath: shot(current.runId, current.checkId) },
    baseline: baseline ? { runId: baseline.runId, checkId: baseline.checkId, status: baseline.status, screenshotPath: shot(baseline.runId, baseline.checkId) } : null,
  };
}

function regressionTest(newest: Run, headRuns: Run[], baseline: Baseline | null, includeFlaky: boolean): FindRegressionsTest {
  const test: FindRegressionsTest = {
    testKey: newest.testKey ?? `run:${newest.id}`,
    title: newest.title,
    platform: platformOf(newest),
    headRunIds: headRuns.map((r) => r.id),
    baseline,
    verdict: { baseline: null, current: newest.verdict },
    newlyFailing: [],
    flakyFailing: [],
    lostCoverage: [],
    newFailures: [],
    fixed: 0,
    stillFailing: 0,
  };
  const core = baseline ? compareRuns(newest, baseline, { includeFlaky, headRuns }, compareDeps) : null;
  if (!core) return test;
  test.verdict.baseline = core.verdict.baseline;
  test.fixed = core.counts.fixed;
  test.stillFailing = core.counts.still_failing;
  for (const pair of core.pairs) {
    const item = regressionItem(pair);
    if (!item) continue;
    if (pair.transition === "newly_failing") test.newlyFailing.push(item);
    else if (pair.transition === "flaky" && pair.current?.status === "fail") test.flakyFailing.push(item);
    else if (pair.lostCoverage) test.lostCoverage.push(item);
    else if (pair.transition === "new" && pair.current?.status === "fail") test.newFailures.push(item);
  }
  return test;
}

function regressionSummary(tests: FindRegressionsTest[]): { status: "regressions" | "clean"; summary: string } {
  const compared = tests.filter((t) => t.baseline !== null);
  const count = (pick: (t: FindRegressionsTest) => number) => compared.reduce((n, t) => n + pick(t), 0);
  const failing = count((t) => t.newlyFailing.length);
  const regressed = compared.filter((t) => t.newlyFailing.length > 0);
  const branches = new Set(regressed.map((t) => t.baseline?.branch ?? null));
  const only = branches.size === 1 ? [...branches][0] : null;
  const extras = [
    count((t) => t.flakyFailing.length) > 0 ? `${plural(count((t) => t.flakyFailing.length), "flaky failure")} ignored` : null,
    count((t) => t.lostCoverage.length) > 0 ? `${plural(count((t) => t.lostCoverage.length), "check")} lost coverage` : null,
    count((t) => t.newFailures.length) > 0 ? `${plural(count((t) => t.newFailures.length), "new failing check")}` : null,
  ].filter((e): e is string => e !== null);
  const tail = extras.length ? `; ${extras.join("; ")}.` : ".";
  if (failing > 0) {
    return {
      status: "regressions",
      summary: `${plural(failing, "check")} that passed${only ? ` on ${only}` : " before"} fail now (${plural(regressed.length, "test")})${tail}`,
    };
  }
  return { status: "clean", summary: `No checks that passed before fail now (${plural(compared.length, "test")} compared)${tail}` };
}

/** "Did I break anything?": the newest matching runs per (test, platform) against their automatic baselines. */
export function findRegressions(input: {
  projectId: string;
  branch?: string;
  prNumber?: number;
  commit?: string;
  includeFlaky?: boolean;
}): FindRegressionsResult {
  const filter = { branch: input.branch, pr: input.prNumber, commit: input.commit };
  const heads = listRuns({ projectId: input.projectId })
    .map((r) => scheduler.getLive(r.id) ?? r)
    .filter((r) => r.retriedBy === null && runMatches(r, filter));
  if (heads.length === 0) return { status: "no_runs", summary: "No runs match these filters.", tests: [] };
  const active = heads.filter((r) => ACTIVE.includes(r.status)).length;
  if (active > 0) {
    return { status: "pending", summary: `${plural(active, "run")} still running; check again when ${active === 1 ? "it finishes" : "they finish"}.`, tests: [] };
  }

  const groups = new Map<string, Run[]>();
  for (const run of heads) {
    const key = `${run.testKey ?? `run:${run.id}`}|${platformOf(run)}`;
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }
  const tests: FindRegressionsTest[] = [];
  for (const runs of groups.values()) {
    const newest = runs[0]!;
    const headRuns = headSnapshot(newest);
    const baseline = resolveBaseline(newest, { baseline: "auto", find: findRun });
    tests.push(regressionTest(newest, headRuns, baseline, input.includeFlaky ?? false));
  }
  if (tests.every((t) => t.baseline === null)) {
    return { status: "no_baseline", summary: "No earlier run of the same test to compare with yet.", tests };
  }
  return { ...regressionSummary(tests), tests };
}

export async function init(): Promise<void> {
  initProjects();
  // Detect each repo's default branch in the background, so the first runs list already has its baseline tiers.
  for (const project of listProjects()) void defaultBranch(project);
  leases.restore();
  stopOnLeaseEnd(leases.ends, gateway);
  // Warm the device tool list in the background so the first run (and the first agent tools/list) never waits on a cold probe.
  void gateway.tools();
  leases.setNextResolver((serial) => scheduler.nextFor(serial));
  // Give every stored run its test and check keys before the scheduler restores (and finalises) interrupted runs.
  await backfill();
  scheduler.restore();
  startIdleReaper();
  setInterval(() => void scheduler.schedule(), 10_000);
  // Expiry, vanished devices and unclaimed grants end leases here; ending one wakes the scheduler through the lease bus.
  setInterval(() => {
    listDevices()
      .then((devices) => leases.sweep(devices))
      .catch((e: unknown) => console.error("lease sweep failed:", e));
  }, 15_000);
  void scheduler.schedule();
  startRetention((id) => scheduler.isHeld(id));
  // Finished runs of shared projects go to the team hub, when one is configured.
  startHubSync();
}

const BLOB_GC_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Boot for `TAPOCALYPSE_MODE=hub`. Nothing here touches a device, an agent or a repository: the project registry is the hub's,
 * the scheduler never runs anything (uploaded runs are always terminal), and the leases, gateway and idle reaper stay off.
 * Retention follows the hub policy and unreferenced blobs are collected alongside it.
 */
export async function initHub(): Promise<void> {
  installHubProjects();
  // The live lists listen on the scheduler's bus; an ingested run is announced there like a finished local one.
  hubEvents.on("run", (run: Run) => scheduler.bus.emit("run", run));
  startRetention(() => false);
  gcBlobs();
  setInterval(() => gcBlobs(), BLOB_GC_INTERVAL_MS).unref();
}
