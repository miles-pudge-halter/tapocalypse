import { createHash } from "node:crypto";
import type { Check, KeyKind, Run } from "../runs/types";

const LEADING_ID = /^\s*([A-Z]{1,3}\d+[a-z]?(\.\d+)?|[A-Z]\d*-[A-Z]?\d+)(\s*[:/—-]\s*|\s+)/;
const FILLER = new Set(["a", "an", "the", "is", "are", "be", "to", "verify", "check", "ensure", "confirm", "that", "this", "it", "its"]);

/** Only the first part of a title identifies a check; a longer title (an upload can carry 2,000 characters) would make every comparison cost more for no better key. */
export const KEY_TITLE_CHARS = 300;
const TOKEN_CACHE_MAX = 4096;
const tokenCache = new Map<string, { tokens: readonly string[]; set: ReadonlySet<string> }>();

/** Tokens of a title, in order: accents dropped, agent id stripped, lowercased, split on non-letters/digits, filler removed. Memoised: matching compares the same titles many times. */
function tokenized(title: string): { tokens: readonly string[]; set: ReadonlySet<string> } {
  const cached = tokenCache.get(title);
  if (cached) return cached;
  const tokens = title
    .slice(0, KEY_TITLE_CHARS)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(LEADING_ID, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t !== "" && !FILLER.has(t));
  if (tokenCache.size >= TOKEN_CACHE_MAX) tokenCache.clear();
  const entry = { tokens, set: new Set(tokens) };
  tokenCache.set(title, entry);
  return entry;
}

const titleTokens = (title: string): readonly string[] => tokenized(title).tokens;

/** A title reduced to what identifies the check: the same check worded with another id, case or filler words compares equal. */
export function canonicalTitle(title: string): string {
  const tokens = titleTokens(title);
  return tokens.length > 0 ? tokens.join(" ") : title.trim().slice(0, KEY_TITLE_CHARS);
}

export const sha256url = (text: string, length: number): string => createHash("sha256").update(text).digest("base64url").slice(0, length);

const RERUN_SECTION = "\n\nRe-run ONLY these checks from run ";

/** Identifies a brief independent of the appended re-run section, case and whitespace. */
export function briefFingerprint(brief: string): string {
  const cut = brief.indexOf(RERUN_SECTION);
  const original = cut < 0 ? brief : brief.slice(0, cut);
  return sha256url(original.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim(), 12);
}

/** A run title without its re-run suffix, version numbers and trailing round number ("lane-2"), so release lanes line up. */
export function runTitleFingerprint(title: string): string {
  return title
    .replace(/ \(re-run\)\s*$/, "")
    .replace(/\bv?\d+(\.\d+){1,3}\b/g, "#")
    .replace(/[-\s]\d+\s*$/, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** The check key a canonical title earns in a project; `checkId` makes it unique for a second check of the same run with the same title. */
export function titleKey(projectId: string, canonical: string, checkId?: string): string {
  return `t:${sha256url(checkId === undefined ? `${projectId}\0${canonical}` : `${projectId}\0${canonical}\0${checkId}`, 16)}`;
}

const TICKET = /(?<![\p{L}\p{N}])([A-Z][A-Z0-9]+-\d+|#\d+)(?![\p{L}\p{N}])/gu;

/** How likely two checks test the same thing: token Jaccard, +0.25 for a shared ticket key, +0.1 for the same id. Range 0–1.35. */
export function matchScore(a: { id: string; title: string }, b: { id: string; title: string }): number {
  const left = tokenized(a.title).set;
  const right = tokenized(b.title).set;
  let shared = 0;
  for (const t of left) if (right.has(t)) shared++;
  const union = left.size + right.size - shared;
  let score = union === 0 ? 0 : shared / union;
  const tickets = new Set(a.title.slice(0, KEY_TITLE_CHARS).match(TICKET));
  if (tickets.size > 0 && b.title.slice(0, KEY_TITLE_CHARS).match(TICKET)?.some((t) => tickets.has(t))) score += 0.25;
  if (a.id === b.id) score += 0.1;
  return score;
}

/** What identity needs to know about the other runs; `regression/index.ts` answers it from the store. */
export interface KeyLookup {
  getRun(id: string): Run | null;
  /** Earliest run of the project that has a `testKey` and whose brief has this fingerprint. */
  earliestWithBrief(projectId: string, fingerprint: string): Run | null;
  /** Earliest run of the project that has a `testKey` and whose title has this fingerprint. */
  earliestWithTitle(projectId: string, fingerprint: string): Run | null;
  /** Terminal runs of one test created before `before` with at least one check, newest first. */
  recentTestRuns(projectId: string, testKey: string, before: string, limit: number): Run[];
  /** True when a persisted check of the project carries this key. */
  hasCheckKey(projectId: string, checkKey: string): boolean;
}

/** The parents a run descends from, nearest first: the attempt it retries, then the run it re-runs. */
function parentIds(run: Pick<Run, "retryOf" | "rerunOf">): string[] {
  return [run.retryOf, run.rerunOf].filter((id, i, all): id is string => id !== null && all.indexOf(id) === i);
}

/** The test a run belongs to: its suite, its parent's test, the earliest run with the same brief or run title, else a new test. */
export function assignTestKey(run: Pick<Run, "projectId" | "title" | "brief" | "suiteId" | "retryOf" | "rerunOf">, lookup: KeyLookup): string {
  if (run.suiteId) return `suite:${run.suiteId}`;
  for (const id of parentIds(run)) {
    const parent = lookup.getRun(id)?.testKey;
    if (parent) return parent;
  }
  const brief = briefFingerprint(run.brief);
  return (
    lookup.earliestWithBrief(run.projectId, brief)?.testKey ??
    lookup.earliestWithTitle(run.projectId, runTitleFingerprint(run.title))?.testKey ??
    `brief:${brief}`
  );
}

/** The key of the check with this id in the run's nearest parent that has one. */
function lineageKey(run: Pick<Run, "retryOf" | "rerunOf">, checkId: string, lookup: KeyLookup): string | undefined {
  for (const id of parentIds(run)) {
    const key = lookup.getRun(id)?.checks.find((c) => c.id === checkId)?.checkKey;
    if (key) return key;
  }
  return undefined;
}

/** Runs of the same test searched for an inferred key, newest first. */
const INFERENCE_WINDOW = 3;
/** Title comparisons one run may spend on inferred keys; a run of 40 checks against 3 runs of 40 needs 4,800. Past the budget a check just gets its title key. */
const COMPARISON_BUDGET = 20_000;
export const INFERRED_THRESHOLD = 0.6;

/** The best-scoring key of the test's last runs that this run has not used yet, when it reaches the threshold (ties: the newer run, the earlier check). */
function bestMatch(run: Run, check: Check, used: ReadonlySet<string>, lookup: KeyLookup, budget: { left: number }): { checkKey: string; score: number } | null {
  let best: { checkKey: string; score: number } | null = null;
  for (const earlier of lookup.recentTestRuns(run.projectId, run.testKey!, run.createdAt, INFERENCE_WINDOW)) {
    for (const candidate of earlier.checks) {
      if (!candidate.checkKey || used.has(candidate.checkKey)) continue;
      if (budget.left-- <= 0) return best;
      const score = matchScore(check, candidate);
      if (score + 1e-9 >= INFERRED_THRESHOLD && (!best || score > best.score + 1e-9)) best = { checkKey: candidate.checkKey, score };
    }
  }
  return best;
}

export interface AssignedKey {
  checkKey: string;
  keyKind: KeyKind;
  /** `matchScore` of an `inferred` key. */
  keyScore?: number;
}

/**
 * Keys for the checks of `run` that do not carry one yet, by check id (a second check with an id already seen gets none).
 * First rule that matches wins: suite id, lineage (parent check with the same id), carried (`was` naming a hint), the
 * canonical title when the project already knows it, an inferred match inside the same test, else the title key (new).
 * A key is handed out once per run.
 */
export function assignCheckKeys(run: Run, lookup: KeyLookup): Map<string, AssignedKey> {
  const assigned = new Map<string, AssignedKey>();
  const used = new Set(run.checks.flatMap((c) => (c.checkKey ? [c.checkKey] : [])));
  const seen = new Set<string>();
  const claimed = new Set<string>();
  const budget = { left: COMPARISON_BUDGET };

  for (const check of run.checks) {
    if (seen.has(check.id)) continue;
    seen.add(check.id);
    if (check.checkKey) continue;

    const take = (found: AssignedKey): void => {
      used.add(found.checkKey);
      assigned.set(check.id, found);
    };

    if (run.suiteId && run.suiteChecks?.some((c) => c.id === check.id)) {
      take({ checkKey: `s:${run.suiteId}:${check.id}`, keyKind: "suite" });
      continue;
    }

    const parentKey = lineageKey(run, check.id, lookup);
    if (parentKey && !used.has(parentKey)) {
      take({ checkKey: parentKey, keyKind: "lineage" });
      continue;
    }

    const hint = check.was === undefined || claimed.has(check.was) ? undefined : run.checkHints?.checks.find((h) => h.id === check.was);
    if (hint && !used.has(hint.checkKey)) {
      claimed.add(hint.id);
      take({ checkKey: hint.checkKey, keyKind: "carried" });
      continue;
    }

    const canonical = canonicalTitle(check.title);
    const tKey = titleKey(run.projectId, canonical);

    if (!used.has(tKey) && lookup.hasCheckKey(run.projectId, tKey)) {
      take({ checkKey: tKey, keyKind: "title" });
      continue;
    }
    const inferred = run.testKey === null ? null : bestMatch(run, check, used, lookup, budget);
    if (inferred) {
      take({ checkKey: inferred.checkKey, keyKind: "inferred", keyScore: inferred.score });
      continue;
    }
    take({ checkKey: used.has(tKey) ? titleKey(run.projectId, canonical, check.id) : tKey, keyKind: "title" });
  }
  return assigned;
}
