import { HttpError } from "../config";
import { getRun, listRuns, saveRun, subscribeRuns } from "../runs/store";
import { ACTIVE, type Check, type CheckHints, type KeyKind, type Run } from "../runs/types";
import { assignCheckKeys, assignTestKey, type AssignedKey, briefFingerprint, type KeyLookup, runTitleFingerprint, sha256url } from "./keys";

/** Derived, in-memory maps over the store (never persisted): built on first use, then kept current by the store's change feed. */
type PerProject<T> = Map<string, Map<string, T[]>>;

interface CheckEntry {
  run: Run;
  check: Check;
}

const byTest: PerProject<Run> = new Map();
const byCheckKey: PerProject<CheckEntry> = new Map();
const byBrief: PerProject<Run> = new Map();
const byRunTitle: PerProject<Run> = new Map();
/** The snapshot each run is currently indexed under, so a change can take exactly its old entries out. */
const indexed = new Map<string, Run>();
/** Runs with a `rerunOf` / `retryOf` parent, by project and id (live ones included): all a lineage walk needs, so it never scans the whole project. */
const linked: Map<string, Map<string, Run>> = new Map();
let built = false;
const generations = new Map<string, number>();

const isTerminal = (run: Pick<Run, "status">): boolean => !ACTIVE.includes(run.status);

function bucket<T>(map: PerProject<T>, projectId: string, key: string): T[] {
  let inner = map.get(projectId);
  if (!inner) map.set(projectId, (inner = new Map()));
  let list = inner.get(key);
  if (!list) inner.set(key, (list = []));
  return list;
}

/** Keeps `list` ordered oldest first by run creation time. */
function insert<T>(list: T[], item: T, createdAt: (item: T) => string): void {
  let i = list.length;
  while (i > 0 && createdAt(list[i - 1]!) > createdAt(item)) i--;
  list.splice(i, 0, item);
}

function remove<T>(map: PerProject<T>, projectId: string, key: string, drop: (item: T) => boolean): void {
  const inner = map.get(projectId);
  const list = inner?.get(key);
  if (!inner || !list) return;
  const kept = list.filter((item) => !drop(item));
  if (kept.length > 0) inner.set(key, kept);
  else inner.delete(key);
  if (inner.size === 0) map.delete(projectId);
}

function add(run: Run): void {
  // A hand-edited or truncated run.json must not take every enqueue down with it.
  if (typeof run.brief !== "string" || typeof run.title !== "string" || !Array.isArray(run.checks)) return;
  indexed.set(run.id, run);
  if (run.rerunOf !== null || run.retryOf !== null) {
    let inner = linked.get(run.projectId);
    if (!inner) linked.set(run.projectId, (inner = new Map()));
    inner.set(run.id, run);
  }
  const runCreated = (r: Run) => r.createdAt;
  if (run.testKey !== null) {
    insert(bucket(byBrief, run.projectId, briefFingerprint(run.brief)), run, runCreated);
    insert(bucket(byRunTitle, run.projectId, runTitleFingerprint(run.title)), run, runCreated);
  }
  if (!isTerminal(run)) return;
  if (run.testKey !== null) insert(bucket(byTest, run.projectId, run.testKey), run, runCreated);
  for (const check of run.checks) {
    if (check.checkKey) insert(bucket(byCheckKey, run.projectId, check.checkKey), { run, check }, (e) => e.run.createdAt);
  }
}

function drop(id: string): void {
  const old = indexed.get(id);
  if (!old) return;
  indexed.delete(id);
  linked.get(old.projectId)?.delete(id);
  const isOld = (r: Run) => r.id === id;
  if (old.testKey !== null) {
    remove(byBrief, old.projectId, briefFingerprint(old.brief), isOld);
    remove(byRunTitle, old.projectId, runTitleFingerprint(old.title), isOld);
    remove(byTest, old.projectId, old.testKey, isOld);
  }
  for (const check of old.checks) {
    if (check.checkKey) remove(byCheckKey, old.projectId, check.checkKey, (e) => e.run.id === id);
  }
}

/**
 * Adds the store's runs oldest first, so `insert` appends instead of walking the whole bucket (O(n²) per key at 50k
 * runs). `listRuns()` is newest first; runs created at the same instant keep that order, exactly as inserting them
 * newest first would have left them.
 */
function addOldestFirst(runs: Run[]): void {
  for (let end = runs.length; end > 0; ) {
    let start = end - 1;
    while (start > 0 && runs[start - 1]!.createdAt === runs[end - 1]!.createdAt) start--;
    for (let i = start; i < end; i++) add(runs[i]!);
    end = start;
  }
}

function ensureBuilt(): void {
  if (built) return;
  built = true;
  addOldestFirst(listRuns());
  subscribeRuns((change) => {
    const old = indexed.get("deleted" in change ? change.deleted : change.saved.id);
    // Only finished runs feed baselines, snapshots and flakiness: a live run saving a check touches nothing derived.
    const projectId = "deleted" in change ? old?.projectId : change.saved.projectId;
    if (projectId !== undefined && ((old && isTerminal(old)) || ("saved" in change && isTerminal(change.saved)))) {
      generations.set(projectId, (generations.get(projectId) ?? 0) + 1);
    }
    if ("deleted" in change) return drop(change.deleted);
    drop(change.saved.id);
    add(change.saved);
  });
}

/**
 * Changes whenever a finished run of the project is saved or deleted (relinks included), and never for another
 * project or for a live run's progress: a cheap key to memoise anything derived from the project's finished runs.
 */
export function projectGeneration(projectId: string): number {
  ensureBuilt();
  return generations.get(projectId) ?? 0;
}

/** The runs of the project that are re-runs or retries of another run, in no particular order. */
export function linkedRuns(projectId: string): Run[] {
  ensureBuilt();
  return [...(linked.get(projectId)?.values() ?? [])];
}

/** A run from the index (the store's current snapshot); null for an unknown id. Unlike `getRun` it never reads the disk. */
export function indexedRun(id: string): Run | null {
  ensureBuilt();
  return indexed.get(id) ?? null;
}

/** The terminal runs of one test, newest first. */
export function runsOfTest(projectId: string, testKey: string): Run[] {
  ensureBuilt();
  return [...(byTest.get(projectId)?.get(testKey) ?? [])].reverse();
}

/** Every check of the project that carries `checkKey`, newest run first. */
export function checkEntries(projectId: string, checkKey: string): { run: Run; check: Check }[] {
  ensureBuilt();
  return [...(byCheckKey.get(projectId)?.get(checkKey) ?? [])].reverse();
}

/** Every check key the project has, with the number of terminal checks that carry it. */
export function projectKeys(projectId: string): { checkKey: string; runs: number }[] {
  ensureBuilt();
  return [...(byCheckKey.get(projectId) ?? [])].map(([checkKey, entries]) => ({ checkKey, runs: entries.length }));
}

/** What `assignTestKey` / `assignCheckKeys` read, answered from the maps. */
export const keyLookup: KeyLookup = {
  getRun: (id) => getRun(id),
  earliestWithBrief: (projectId, fingerprint) => (ensureBuilt(), byBrief.get(projectId)?.get(fingerprint)?.[0] ?? null),
  earliestWithTitle: (projectId, fingerprint) => (ensureBuilt(), byRunTitle.get(projectId)?.get(fingerprint)?.[0] ?? null),
  recentTestRuns: (projectId, testKey, before, limit) => {
    ensureBuilt();
    const recent: Run[] = [];
    const runs = byTest.get(projectId)?.get(testKey) ?? [];
    for (let i = runs.length - 1; i >= 0 && recent.length < limit; i--) {
      const run = runs[i]!;
      if (run.createdAt < before && run.checks.length > 0) recent.push(run);
    }
    return recent;
  },
  hasCheckKey: (projectId, checkKey) => (ensureBuilt(), (byCheckKey.get(projectId)?.get(checkKey)?.length ?? 0) > 0),
};

/**
 * Fills in what a run is missing, in place: its `testKey`, and once it is terminal the key of every check. True when it changed.
 * A run that cannot be keyed (a hand-edited or truncated run.json) is logged and left as it is: keying must never stop
 * boot or a save.
 */
export function keyRun(run: Run, lookup: KeyLookup = keyLookup): boolean {
  let changed = false;
  try {
    if (run.testKey === null) {
      run.testKey = assignTestKey(run, lookup);
      changed = true;
    }
    if (isTerminal(run)) {
      for (const [id, key] of assignCheckKeys(run, lookup)) {
        const check = run.checks.find((c) => c.id === id)!;
        check.checkKey = key.checkKey;
        check.keyKind = key.keyKind;
        if (key.keyScore !== undefined) check.keyScore = key.keyScore;
        changed = true;
      }
    }
  } catch (err) {
    console.warn(`regression: run ${run.id} could not be keyed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return changed;
}

/**
 * A `KeyLookup` over runs the caller keys in memory, oldest first: `add` each run once it has its keys and later runs see it.
 * Lets a project be re-keyed from scratch without persisting the half-cleared state in between. `getRun` answers from
 * `known` (the caller's working copies) before the store.
 */
export function createKeyPass(known: ReadonlyMap<string, Run>): { lookup: KeyLookup; add(run: Run): void } {
  const brief = new Map<string, Run>();
  const title = new Map<string, Run>();
  const tests = new Map<string, Run[]>();
  const checkKeys = new Set<string>();
  const add = (run: Run): void => {
    if (typeof run.brief !== "string" || typeof run.title !== "string" || !Array.isArray(run.checks)) return;
    if (run.testKey !== null) {
      const b = `${run.projectId}\0${briefFingerprint(run.brief)}`;
      if (!brief.has(b)) brief.set(b, run);
      const t = `${run.projectId}\0${runTitleFingerprint(run.title)}`;
      if (!title.has(t)) title.set(t, run);
    }
    if (!isTerminal(run)) return;
    if (run.testKey !== null) {
      const k = `${run.projectId}\0${run.testKey}`;
      const list = tests.get(k) ?? [];
      list.push(run);
      tests.set(k, list);
    }
    for (const check of run.checks) if (check.checkKey) checkKeys.add(`${run.projectId}\0${check.checkKey}`);
  };
  const lookup: KeyLookup = {
    getRun: (id) => known.get(id) ?? getRun(id),
    earliestWithBrief: (projectId, fingerprint) => brief.get(`${projectId}\0${fingerprint}`) ?? null,
    earliestWithTitle: (projectId, fingerprint) => title.get(`${projectId}\0${fingerprint}`) ?? null,
    recentTestRuns: (projectId, testKey, before, limit) => {
      const recent: Run[] = [];
      const runs = tests.get(`${projectId}\0${testKey}`) ?? [];
      for (let i = runs.length - 1; i >= 0 && recent.length < limit; i--) {
        const run = runs[i]!;
        if (run.createdAt < before && run.checks.length > 0) recent.push(run);
      }
      return recent;
    },
    hasCheckKey: (projectId, checkKey) => checkKeys.has(`${projectId}\0${checkKey}`),
  };
  return { lookup, add };
}

const BACKFILL_YIELD_EVERY = 200;

/** Gives every run persisted before regression intelligence its `testKey` and check keys, oldest first. Idempotent; keyed runs are skipped. */
export async function backfill(): Promise<{ keyed: number }> {
  let keyed = 0;
  for (const run of listRuns().reverse()) {
    if (run.testKey !== null) continue;
    const copy = structuredClone(run);
    if (!keyRun(copy)) continue;
    saveRun(copy);
    if (++keyed % BACKFILL_YIELD_EVERY === 0) await Bun.sleep(0);
  }
  return { keyed };
}

/** Every check's key: the persisted one, or what `assignCheckKeys` would give it now (live runs, runs not backfilled yet). */
export function keysOf(run: Run): Map<string, AssignedKey> {
  const keys = new Map<string, AssignedKey>();
  for (const check of run.checks) {
    if (check.checkKey && !keys.has(check.id)) keys.set(check.id, { checkKey: check.checkKey, keyKind: check.keyKind ?? "title", ...(check.keyScore === undefined ? {} : { keyScore: check.keyScore }) });
  }
  for (const [id, key] of assignCheckKeys(run, keyLookup)) keys.set(id, key);
  return keys;
}

const HINT_TITLE_CHARS = 160;
const HINT_RUNS = 2;

function hintTitle(title: string): string {
  const flat = title.replace(/\s+/g, " ").trim();
  return flat.length > HINT_TITLE_CHARS ? `${flat.slice(0, HINT_TITLE_CHARS - 1)}…` : flat;
}

function hintsFromRuns(runs: Run[]): CheckHints | null {
  const checks: CheckHints["checks"] = [];
  const keys = new Set<string>();
  const ids = new Set<string>();
  const fromRunIds: string[] = [];
  for (const run of runs) {
    const before = checks.length;
    for (const [id, key] of keysOf(run)) {
      const check = run.checks.find((c) => c.id === id)!;
      if (keys.has(key.checkKey) || ids.has(id)) continue;
      keys.add(key.checkKey);
      ids.add(id);
      checks.push({ id, title: hintTitle(check.title), checkKey: key.checkKey });
    }
    if (checks.length > before) fromRunIds.push(run.id);
  }
  return checks.length > 0 ? { fromRunIds, checks } : null;
}

/**
 * The previous checks a new run's prompt should show. None for suite runs (the suite pins ids) and for a re-run of the
 * failed checks only (no `parent` given: the brief already lists them). With a `parent` (re-run of everything, retry):
 * its checks, or the hints it was shown when it never got to plan. Otherwise the last 2 terminal runs of the same test
 * with checks, preferring the same platform, deduped by key (newer wins an id clash). Titles are cut; the prompt applies the size cap.
 */
export function hintsFor(
  run: Pick<Run, "projectId" | "testKey" | "suiteId" | "retryOf" | "rerunOf" | "deviceRequest"> & { id?: string },
  opts: { parent?: Run | null },
): CheckHints | null {
  if (run.suiteId) return null;
  if (opts.parent) return hintsFromRuns([opts.parent]) ?? (opts.parent.checkHints ? structuredClone(opts.parent.checkHints) : null);
  if (run.rerunOf || run.retryOf || run.testKey === null) return null;
  const candidates = runsOfTest(run.projectId, run.testKey).filter((r) => r.id !== run.id && r.checks.length > 0);
  const samePlatform = candidates.filter((r) => r.deviceRequest.platform === run.deviceRequest.platform);
  return hintsFromRuns((samePlatform.length > 0 ? samePlatform : candidates).slice(0, HINT_RUNS));
}

interface CheckRef {
  runId: string;
  checkId: string;
}

/** The stored run and check a reference names, with the key the check carries (persisted first when the run was never keyed). */
function resolveCheck(projectId: string, ref: CheckRef): { run: Run; key: string } {
  const run = getRun(ref.runId);
  if (!run) throw new HttpError(404, `unknown run ${ref.runId}`);
  if (run.projectId !== projectId) throw new HttpError(400, `run ${ref.runId} is not in project ${projectId}`);
  if (!isTerminal(run)) throw new HttpError(409, `run ${ref.runId} is still active`);
  const check = run.checks.find((c) => c.id === ref.checkId);
  if (!check) throw new HttpError(404, `run ${ref.runId} has no check ${ref.checkId}`);
  if (!check.checkKey && keyRun(run)) saveRun(run);
  const key = run.checks.find((c) => c.id === ref.checkId)?.checkKey;
  if (!key) throw new HttpError(400, `check ${ref.checkId} of run ${ref.runId} has no identity yet`);
  return { run, key };
}

function setManualKey(check: Check, key: string): void {
  check.checkKey = key;
  check.keyKind = "manual" satisfies KeyKind;
  delete check.keyScore;
}

/**
 * Declares that the checks `a` (older) and `b` test the same thing: every check of the project carrying b's key takes a's key.
 * Equal keys already (an inferred or title match being confirmed) only turn both checks `manual`. Refused (400) for a link
 * inside one run and for one that would give two checks of a run the same key (a run keeps one check per key).
 */
export function relink(projectId: string, a: CheckRef, b: CheckRef): void {
  if (a.runId === b.runId) throw new HttpError(400, "a link joins checks of two different runs");
  const from = resolveCheck(projectId, b);
  const to = resolveCheck(projectId, a);
  ensureBuilt();
  if (from.key === to.key) {
    for (const [ref, runId] of [[a, a.runId], [b, b.runId]] as const) {
      const run = getRun(runId)!;
      const check = run.checks.find((c) => c.id === ref.checkId)!;
      if (check.keyKind === "manual") continue;
      setManualKey(check, check.checkKey!);
      saveRun(run);
    }
    return;
  }
  const runIds = new Set(checkEntries(projectId, from.key).map((e) => e.run.id));
  for (const id of runIds) {
    const run = getRun(id);
    if (run?.checks.some((c) => c.checkKey === to.key)) {
      throw new HttpError(400, `run ${id} already has a check with the key of ${a.checkId}: linking would merge two checks of one run`);
    }
  }
  for (const id of runIds) {
    const run = getRun(id);
    if (!run) continue;
    for (const check of run.checks) if (check.checkKey === from.key) setManualKey(check, to.key);
    saveRun(run);
  }
}

/** Declares that a check does not test what its key says: it gets a key of its own. */
export function unlink(projectId: string, runId: string, checkId: string): void {
  const { key } = resolveCheck(projectId, { runId, checkId });
  const own = `u:${sha256url(`${runId}\0${checkId}`, 16)}`;
  if (key === own) return;
  const fresh = getRun(runId)!;
  setManualKey(fresh.checks.find((c) => c.id === checkId)!, own);
  saveRun(fresh);
}
