import { GIT_BIN, HttpError } from "../config";
import { exec } from "../devices/devices";
import { getProject, type Project } from "../projects/registry";
import { getRun } from "../runs/store";
import { ACTIVE, type Check, type CheckStatus, type KeyKind, type Platform, type Run } from "../runs/types";
import { indexedRun, keysOf, linkedRuns, runsOfTest } from "./index";
import type { Baseline, BaselineTier } from "./types";

// ---------------------------------------------------------------------------------------------------------------
// Default branch
// ---------------------------------------------------------------------------------------------------------------

const DEFAULT_BRANCH_TTL_MS = 10 * 60_000;

/** Runs `git <args>` in `cwd`; stdout trimmed, null on a non-zero exit or when git cannot run. */
export type GitRunner = (cwd: string, args: string[]) => Promise<string | null>;

const spawnGit: GitRunner = async (cwd, args) => {
  const r = await exec([GIT_BIN, ...args], { cwd, timeoutMs: 3000 });
  return r.code === 0 ? r.text.trim() : null;
};

const gitDefaults: { git: GitRunner; now: () => number } = { git: spawnGit, now: Date.now };
const detected = new Map<string, { value: string | null; at: number }>();
const refreshing = new Map<string, Promise<string | null>>();
/** Bumped by `setDefaultBranchDeps`, so a detection that started before it cannot write into the new cache. */
let epoch = 0;

/** Test seam: swaps the git runner / clock and clears the per-repo cache. Call with no argument to restore the defaults. */
export function setDefaultBranchDeps(deps: Partial<typeof gitDefaults> = {}): void {
  gitDefaults.git = deps.git ?? spawnGit;
  gitDefaults.now = deps.now ?? Date.now;
  detected.clear();
  refreshing.clear();
  epoch++;
}

async function detectDefaultBranch(repoPath: string): Promise<string | null> {
  const { git } = gitDefaults;
  const head = await git(repoPath, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (head) return head.replace(/^origin\//, "");
  for (const name of ["main", "master"]) {
    if ((await git(repoPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`])) !== null) return name;
    if ((await git(repoPath, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${name}`])) !== null) return name;
  }
  return null;
}

/** Detects the repo's default branch now (joining a detection already running) and caches it. Never rejects. */
export function refreshDefaultBranch(project: Pick<Project, "repoPath">): Promise<string | null> {
  const { repoPath } = project;
  const running = refreshing.get(repoPath);
  if (running) return running;
  const started = epoch;
  const promise = detectDefaultBranch(repoPath)
    .catch(() => null)
    .then((value) => {
      if (started === epoch) {
        detected.set(repoPath, { value, at: gitDefaults.now() });
        refreshing.delete(repoPath);
      }
      return value;
    });
  refreshing.set(repoPath, promise);
  return promise;
}

/**
 * The project's default branch: its `defaultBranch` setting, else `origin/HEAD`, else `main`/`master` when one exists.
 * Git is asked in the background (answers cached 10 min per repo), so this never blocks: it returns the cached answer,
 * even an expired one while it refreshes, and null until the first detection lands.
 */
export function defaultBranch(project: Pick<Project, "repoPath"> & { defaultBranch?: string }): string | null {
  if (project.defaultBranch) return project.defaultBranch;
  // A hub project has no repository to ask: its default branch is what the uploaders reported.
  if (!project.repoPath) return null;
  const hit = detected.get(project.repoPath);
  if (!hit || gitDefaults.now() - hit.at >= DEFAULT_BRANCH_TTL_MS) void refreshDefaultBranch(project);
  return hit?.value ?? null;
}

// ---------------------------------------------------------------------------------------------------------------
// Shared run helpers
// ---------------------------------------------------------------------------------------------------------------

export const isDecisive = (status: CheckStatus): boolean => status === "pass" || status === "fail";
const isResolved = (status: CheckStatus): boolean => isDecisive(status) || status === "blocked" || status === "skipped";

export const isTerminalRun = (run: Run): boolean => !ACTIVE.includes(run.status);

export const platformOf = (run: Run): Platform => run.deviceRequest.platform;
export const branchOf = (run: Run): string | null => run.source?.branch ?? null;
export const commitOf = (run: Run): string | null => run.source?.commit ?? null;
export const isDirty = (run: Run): boolean => run.source?.dirty === true;
export const modelOf = (run: Run): string | null => run.model ?? run.usage?.model ?? null;
export const shortSha = (commit: string | null): string => (commit ? commit.slice(0, 7) : "unknown");

function buildLabel(run: Run): string | null {
  const b = run.build;
  return b && (b.versionName || b.versionCode) ? `${b.versionName ?? ""}|${b.versionCode ?? ""}` : null;
}

/** Ids of the run, its rerun/retry ancestors and every descendant of any of them. */
export function lineageOf(head: Run): Set<string> {
  // Only runs with a parent link can join a lineage: the fixed point below never needs the rest.
  const byId = new Map(linkedRuns(head.projectId).map((r) => [r.id, r]));
  byId.set(head.id, head);
  const seen = new Set<string>([head.id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const run of byId.values()) {
      const parents = [run.rerunOf, run.retryOf].filter((p): p is string => p !== null);
      const linked = seen.has(run.id) ? parents.some((p) => !seen.has(p)) : parents.some((p) => seen.has(p));
      if (!linked) continue;
      for (const id of [run.id, ...parents]) seen.add(id);
      grew = true;
    }
  }
  return seen;
}

/**
 * What a run's own side of a comparison is made of: the run plus its finished re-runs and retries at the same commit (a
 * re-run of the failed checks only completes its parent). A dirty working tree is its own code and never folds. Newest first.
 * The strip, the row chip, the compare page and find-regressions all read this one answer.
 */
export function headSnapshot(run: Run): Run[] {
  if (isDirty(run)) return [run];
  const lineage = lineageOf(run);
  const same = [...lineage]
    .flatMap((id) => indexedRun(id) ?? [])
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .filter(
      (r) =>
        r.id !== run.id &&
        r.projectId === run.projectId &&
        r.createdAt < run.createdAt &&
        r.retriedBy === null &&
        isTerminalRun(r) &&
        !isDirty(r) &&
        platformOf(r) === platformOf(run) &&
        commitOf(r) === commitOf(run),
    );
  return [run, ...same];
}

const PLATFORM_NAMES: Record<Platform, string> = { android: "Android", ios: "iOS" };

/** Why a run has no auto baseline when earlier runs of the test exist on the other platform only; null otherwise. */
export function noBaselineReason(head: Run): string | null {
  if (!head.testKey) return null;
  const mine = platformOf(head);
  const others = runsOfTest(head.projectId, head.testKey).filter((r) => r.id !== head.id && r.createdAt < head.createdAt);
  const otherPlatforms = [...new Set(others.map(platformOf))].filter((p) => p !== mine);
  if (otherPlatforms.length === 0) return null;
  return `Earlier runs of this test ran on ${otherPlatforms.map((p) => PLATFORM_NAMES[p]).join(" and ")} only.`;
}

// ---------------------------------------------------------------------------------------------------------------
// Baseline resolution
// ---------------------------------------------------------------------------------------------------------------

function candidatesOf(head: Run): Run[] {
  if (!head.testKey) return [];
  const platform = platformOf(head);
  const lineage = lineageOf(head);
  return runsOfTest(head.projectId, head.testKey)
    .filter(
      (r) =>
        r.projectId === head.projectId &&
        r.testKey === head.testKey &&
        platformOf(r) === platform &&
        r.createdAt < head.createdAt &&
        isTerminalRun(r) &&
        r.checks.some((c) => isResolved(c.status)) &&
        r.retriedBy === null &&
        !lineage.has(r.id),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function tierPool(head: Run, candidates: Run[]): { tier: BaselineTier; pool: Run[]; where: string } | null {
  const prBase = head.source?.pr?.baseBranch ?? null;
  if (prBase) {
    const pool = candidates.filter((r) => branchOf(r) === prBase);
    if (pool.length) return { tier: "pr-base", pool, where: `the PR base branch ${prBase}` };
  }
  const project = getProject(head.projectId);
  const def = project ? defaultBranch(project) : null;
  if (def && branchOf(head) !== def) {
    const pool = candidates.filter((r) => branchOf(r) === def);
    if (pool.length) return { tier: "default-branch", pool, where: `the default branch ${def}` };
  }
  const own = branchOf(head);
  if (own) {
    const pool = candidates.filter((r) => branchOf(r) === own);
    if (pool.length) return { tier: "same-branch", pool, where: own };
  }
  if (candidates.length) return { tier: "any", pool: candidates, where: branchOf(candidates[0]!) ?? "an unrecorded branch" };
  return null;
}

/** Runs of the pool that make up the baseline snapshot of `primary`: same commit, else same build, else the run alone. */
function snapshotOf(primary: Run, pool: Run[]): Run[] {
  if (isDirty(primary)) return [primary];
  const commit = commitOf(primary);
  const build = buildLabel(primary);
  const same = pool.filter(
    (r) => !isDirty(r) && (commit ? commitOf(r) === commit : build ? commitOf(r) === null && buildLabel(r) === build : r.id === primary.id),
  );
  return [primary, ...same.filter((r) => r.id !== primary.id)];
}

function flagsBetween(head: Run, primary: Run): Pick<Baseline, "platformMismatch" | "deviceChanged" | "harnessChanged" | "modelChanged" | "buildChanged" | "sameCommit"> {
  const hb = buildLabel(head);
  const pb = buildLabel(primary);
  const [hc, pc] = [commitOf(head), commitOf(primary)];
  return {
    platformMismatch: platformOf(head) !== platformOf(primary),
    deviceChanged: head.deviceName !== null && primary.deviceName !== null && head.deviceName !== primary.deviceName,
    harnessChanged: head.harness !== primary.harness,
    modelChanged: modelOf(head) !== modelOf(primary),
    buildChanged: hb !== null && pb !== null && hb !== pb,
    sameCommit: hc !== null && hc === pc && !isDirty(head) && !isDirty(primary),
  };
}

export interface ResolveOptions {
  baseline: "auto" | string;
  /** Resolves an explicit baseline id, live runs included. Defaults to the store. */
  find?: (id: string) => Run | null;
}

/**
 * The run(s) `head` is compared with. `auto` walks the tiers (PR base, default branch, same branch, any) and folds every
 * finished run at the chosen commit into one snapshot; an explicit id is that run only. Null when `auto` finds nothing.
 * Throws 404 for an unknown explicit run and 400 (`code` `same_run` / `different_project`) for an unusable one.
 */
export function resolveBaseline(head: Run, opts: ResolveOptions): Baseline | null {
  if (opts.baseline !== "auto") {
    const run = (opts.find ?? getRun)(opts.baseline);
    if (!run) throw new HttpError(404, `run not found: ${opts.baseline}`);
    if (run.id === head.id) throw new HttpError(400, "A run cannot be compared with itself.", "same_run");
    if (run.projectId !== head.projectId) {
      throw new HttpError(400, "Checks are only matched within one project; pick a baseline from the same project.", "different_project");
    }
    return {
      auto: false,
      tier: "explicit",
      kind: "run",
      primaryRunId: run.id,
      runIds: [run.id],
      branch: branchOf(run),
      commit: commitOf(run),
      reason: "Chosen by you.",
      ...flagsBetween(head, run),
    };
  }

  const tiered = tierPool(head, candidatesOf(head));
  if (!tiered) return null;
  let pool = tiered.pool;
  const headCommit = commitOf(head);
  // A dirty working tree is its own code: two dirty runs at one HEAD are different code, so edit/run/edit/run compares with the previous run.
  const otherCommit = pool.filter((r) => commitOf(r) === null || commitOf(r) !== headCommit || isDirty(head) || isDirty(r));
  if (otherCommit.length) pool = otherCommit;
  if (head.deviceName) {
    const sameDevice = pool.filter((r) => r.deviceName === head.deviceName);
    if (sameDevice.length) pool = sameDevice;
  }
  const primary = pool[0]!;
  const runs = snapshotOf(primary, pool);
  const flags = flagsBetween(head, primary);
  const at = commitOf(primary);
  const reason =
    `Newest run of this test on ${tiered.where}` +
    (flags.sameCommit ? `, at the same commit ${shortSha(at)}` : " before this one") +
    (runs.length > 1 ? ` (${runs.length} runs at ${shortSha(at)})` : "");
  return {
    auto: true,
    tier: tiered.tier,
    kind: runs.length > 1 ? "snapshot" : "run",
    primaryRunId: primary.id,
    runIds: runs.map((r) => r.id),
    branch: branchOf(primary),
    commit: at,
    reason,
    ...flags,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Snapshot fold
// ---------------------------------------------------------------------------------------------------------------

/** One side's result for a check key: the check, its run and how its key was assigned. */
export interface Resolved {
  run: Run;
  check: Check;
  checkKey: string;
  keyKind: KeyKind;
}

/**
 * Folds runs (primary / newest first) into one result per check key: the newest decisive (pass/fail) result, else the
 * newest result of any status. Round-2 runs and reruns at the same commit therefore complete the baseline.
 */
export function foldSnapshot(runs: Run[]): Map<string, Resolved> {
  const out = new Map<string, Resolved>();
  for (const run of runs) {
    const keys = keysOf(run);
    for (const check of run.checks) {
      const k = keys.get(check.id);
      if (!k) continue;
      const have = out.get(k.checkKey);
      if (have && (isDecisive(have.check.status) || !isDecisive(check.status))) continue;
      out.set(k.checkKey, { run, check, checkKey: k.checkKey, keyKind: k.keyKind });
    }
  }
  return out;
}
