import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { DATA_DIR } from "../config";
import { getHarness } from "../harness";
import { legacyProgressActivity } from "../harness/omp/activity";
import { normalizeUsage } from "../harness/omp/usage";
import { HarnessIdSchema, type ReplayContext } from "../harness/types";
import type { Activity, CheckStatus, Run } from "./types";

const RUNS_DIR = path.join(DATA_DIR, "runs");

export function runDir(id: string): string {
  return path.join(RUNS_DIR, id);
}

export function makeRunId(title: string, now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32)
      .replace(/-+$/, "") || "run";
  return `${stamp}-${randomBytes(2).toString("hex")}-${slug}`;
}

/** Fields added after the first release; persisted runs missing them load with these defaults. */
const RUN_DEFAULTS = {
  source: null,
  deviceName: null,
  build: null,
  batchId: null,
  suiteId: null,
  suiteChecks: null,
  harness: "omp",
  model: null,
  thinking: null,
  effort: null,
  errorKind: null,
  verdictSource: null,
  usage: null,
  attempt: 1,
  retryOf: null,
  retriedBy: null,
  rerunOf: null,
  install: null,
  storage: "repo",
  gated: false,
} satisfies Partial<Run>;

type RunDefaultKey = keyof typeof RUN_DEFAULTS;

/** What callers of `createRun` must supply: everything but the generated id/createdAt and the optional newer fields. */
export type NewRun = Omit<Run, "id" | "createdAt" | RunDefaultKey> & Partial<Pick<Run, RunDefaultKey>>;

function normalizeRun(raw: Run): Run {
  const run = raw as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(RUN_DEFAULTS)) run[key] ??= value;
  // A corrupt or foreign harness id would leave replay and start without an adapter.
  raw.harness = HarnessIdSchema.catch("omp").parse(raw.harness);
  // Runs persisted before `usage` existed carry only the raw omp stats (and were always omp runs).
  if (raw.usage === null && raw.stats && raw.harness === "omp") raw.usage = normalizeUsage(raw.stats, raw.model);
  // `backend` (mobile-mcp | artemis) was dropped when Artemis support was removed; old run.json files still carry it.
  delete run.backend;
  return raw;
}

/** Every persisted run by id, loaded from disk once and kept current by `saveRun` / `deleteRun`. */
let index: Map<string, Run> | null = null;
let sorted: Run[] | null = null;
/** Number of frames in each run's events.jsonl, i.e. the next `seq`. */
const eventCounts = new Map<string, number>();

function loadIndex(): Map<string, Run> {
  if (index) return index;
  index = new Map();
  if (existsSync(RUNS_DIR)) {
    for (const id of readdirSync(RUNS_DIR)) {
      const run = getRun(id);
      if (run) index.set(run.id, run);
    }
  }
  return index;
}

export function createRun(fields: NewRun): Run {
  let id = makeRunId(fields.title);
  while (existsSync(runDir(id))) id = makeRunId(fields.title);
  const run = normalizeRun({ ...fields, id, createdAt: new Date().toISOString() } as Run);
  const dir = runDir(run.id);
  mkdirSync(path.join(dir, "session"), { recursive: true });
  writeFileSync(path.join(dir, "brief.md"), run.brief);
  saveRun(run);
  return run;
}

/** Persists the run and refreshes the index. A no-op once the run was deleted: a runner may still be winding down. */
export function saveRun(run: Run): void {
  const dir = runDir(run.id);
  if (!existsSync(dir)) return;
  const file = path.join(dir, "run.json");
  try {
    writeFileSync(`${file}.tmp`, JSON.stringify(run, null, 2));
    renameSync(`${file}.tmp`, file);
  } catch (err) {
    // The directory can vanish between the check and the write (delete racing a runner).
    if (!existsSync(dir)) return;
    throw err;
  }
  // A snapshot: callers keep mutating their live object between saves.
  loadIndex().set(run.id, structuredClone(run));
  sorted = null;
}

export function getRun(id: string): Run | null {
  if (!/^[A-Za-z0-9-]+$/.test(id)) return null;
  const file = path.join(runDir(id), "run.json");
  if (!existsSync(file)) return null;
  try {
    return normalizeRun(JSON.parse(readFileSync(file, "utf8")) as Run);
  } catch {
    return null;
  }
}

/** Removes the run directory (run.json, events, session, transcript, and for `storage: "data"` runs the report and screenshots) and forgets the run. Legacy repo reports are untouched. */
export function deleteRun(id: string): void {
  if (!/^[A-Za-z0-9-]+$/.test(id)) return;
  rmSync(runDir(id), { recursive: true, force: true });
  loadIndex().delete(id);
  eventCounts.delete(id);
  replayStarts.delete(id);
  sorted = null;
}

/**
 * All persisted runs, newest first, served from the in-memory index. The returned runs are the index's own
 * snapshots: treat them as read-only (mutate a copy, then `saveRun`).
 */
export function listRuns(filter: { projectId?: string } = {}): Run[] {
  sorted ??= [...loadIndex().values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return filter.projectId ? sorted.filter((r) => r.projectId === filter.projectId) : [...sorted];
}

/** Persists a frame and returns its `seq` (0-based line index in events.jsonl). `_ts` keeps replayed activity's original time. */
export function appendEvent(id: string, frame: object): number {
  const file = path.join(runDir(id), "events.jsonl");
  let seq = eventCounts.get(id);
  if (seq === undefined) seq = existsSync(file) ? countLines(readFileSync(file, "utf8")) : 0;
  try {
    appendFileSync(file, JSON.stringify({ ...frame, _ts: new Date().toISOString() }) + "\n");
  } catch (err) {
    // Run deleted while its runner is still emitting frames: drop them.
    if (!existsSync(runDir(id))) return seq;
    throw err;
  }
  eventCounts.set(id, seq + 1);
  return seq;
}

function countLines(text: string): number {
  let n = 0;
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) n++;
  return n;
}

export function appendStderr(id: string, text: string): void {
  try {
    appendFileSync(path.join(runDir(id), "stderr.log"), text);
  } catch (err) {
    if (!existsSync(runDir(id))) return;
    throw err;
  }
}

/** Every persisted frame of a run, oldest first. */
export function readEvents(id: string): unknown[] {
  const file = path.join(runDir(id), "events.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
}

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/** Tool-call starts seen so far per run, extended incrementally since events.jsonl is append-only. */
const replayStarts = new Map<string, { harness: string; lines: number; starts: ReplayContext["starts"] }>();

/** Tapocalypse's own feed lines (progress checks, info, warnings) are stored as `_activity` frames, whatever the harness. */
function activityFrame(frame: unknown, seq: number): Activity | null {
  const f = frame as { type?: unknown; _ts?: unknown; kind?: unknown; text?: unknown; checkId?: unknown; checkStatus?: unknown } | null;
  if (f?.type !== "_activity") return null;
  const ts = typeof f._ts === "string" ? f._ts : new Date().toISOString();
  const activity: Activity = { ts, seq, kind: f.kind as Activity["kind"], text: String(f.text) };
  if (typeof f.checkId === "string") activity.checkId = f.checkId;
  if (typeof f.checkStatus === "string") activity.checkStatus = f.checkStatus as CheckStatus;
  return activity;
}

/**
 * Activity page: the newest `limit` items with `seq < before` (or the newest overall), oldest first.
 * Only the lines it walks are mapped to feed lines; the rest are scanned once for tool-call starts (to resolve tool
 * names and durations), incrementally across calls.
 */
export function readActivity(id: string, opts: { before?: number; limit: number }): { items: Activity[]; hasMore: boolean } {
  const file = path.join(runDir(id), "events.jsonl");
  if (!existsSync(file)) return { items: [], hasMore: false };
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  const run = getRun(id);
  const harnessId = run?.harness ?? "omp";
  const harness = getHarness(harnessId);
  const gated = run?.gated ?? false;
  // Runs recorded before progress calls were logged server-side have no `check` lines of their own (omp only).
  const legacyChecks = harnessId === "omp" && !text.includes('"kind":"check"');

  let cached = replayStarts.get(id);
  if (!cached || cached.harness !== harnessId) {
    cached = { harness: harnessId, lines: 0, starts: new Map() };
    replayStarts.set(id, cached);
  }
  // The last segment is empty after a trailing newline, or an unfinished line: never mark it scanned.
  const complete = lines.length - 1;
  for (let seq = cached.lines; seq < complete; seq++) {
    const line = lines[seq]!;
    if (line && !line.startsWith('{"type":"_activity"')) harness.toActivity(parseLine(line), { seq, gated, starts: cached.starts });
  }
  cached.lines = Math.max(cached.lines, complete);
  const starts = cached.starts;

  const items: Activity[] = [];
  const need = Math.max(0, opts.limit) + 1;
  for (let seq = Math.min(opts.before ?? lines.length, lines.length) - 1; seq >= 0 && items.length < need; seq--) {
    const line = lines[seq]!;
    if (!line) continue;
    const frame = parseLine(line);
    const activity =
      activityFrame(frame, seq) ?? (legacyChecks ? legacyProgressActivity(frame, seq) : null) ?? harness.toActivity(frame, { seq, gated, starts });
    if (activity) items.push(activity);
  }
  const hasMore = items.length === need;
  if (hasMore) items.pop();
  return { items: items.reverse(), hasMore };
}
