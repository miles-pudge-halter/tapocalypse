import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { DATA_DIR } from "../config";
import { normalizeUsage } from "./outcome";
import { frameToActivity, type ToolStarts } from "./prompt";
import type { Activity, Backend, Run } from "./types";

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
  model: null,
  thinking: null,
  errorKind: null,
  verdictSource: null,
  usage: null,
  attempt: 1,
  retryOf: null,
  retriedBy: null,
  rerunOf: null,
  install: null,
} satisfies Partial<Run>;

type RunDefaultKey = keyof typeof RUN_DEFAULTS;

/** What callers of `createRun` must supply: everything but the generated id/createdAt and the optional newer fields. */
export type NewRun = Omit<Run, "id" | "createdAt" | RunDefaultKey> & Partial<Pick<Run, RunDefaultKey>>;

function normalizeRun(raw: Run): Run {
  const run = raw as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(RUN_DEFAULTS)) run[key] ??= value;
  // Runs persisted before `usage` existed carry only the raw omp stats.
  if (raw.usage === null && raw.stats) raw.usage = normalizeUsage(raw.stats, raw.model);
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

/** Removes the run directory (run.json, events, session, transcript) and forgets the run. Repo reports are untouched. */
export function deleteRun(id: string): void {
  if (!/^[A-Za-z0-9-]+$/.test(id)) return;
  rmSync(runDir(id), { recursive: true, force: true });
  loadIndex().delete(id);
  eventCounts.delete(id);
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

/**
 * Activity page: the newest `limit` items with `seq < before` (or the newest overall), oldest first.
 * Only the lines it walks are JSON-parsed, plus tool-call starts (to resolve tool names and durations).
 */
export function readActivity(id: string, opts: { before?: number; limit: number }): { items: Activity[]; hasMore: boolean } {
  const file = path.join(runDir(id), "events.jsonl");
  if (!existsSync(file)) return { items: [], hasMore: false };
  const lines = readFileSync(file, "utf8").split("\n");
  const backend: Backend = getRun(id)?.backend ?? "mobile-mcp";

  const starts: ToolStarts = new Map();
  lines.forEach((line, seq) => {
    if (line.startsWith('{"type":"tool_execution_start"')) frameToActivity(parseLine(line), backend, seq, starts);
  });

  const items: Activity[] = [];
  const need = Math.max(0, opts.limit) + 1;
  for (let seq = Math.min(opts.before ?? lines.length, lines.length) - 1; seq >= 0 && items.length < need; seq--) {
    const line = lines[seq]!;
    if (!line) continue;
    const activity = frameToActivity(parseLine(line), backend, seq, starts);
    if (activity) items.push(activity);
  }
  const hasMore = items.length === need;
  if (hasMore) items.pop();
  return { items: items.reverse(), hasMore };
}
