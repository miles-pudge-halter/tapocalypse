import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { DATA_DIR } from "../config";
import type { Run } from "./types";

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

export function createRun(fields: Omit<Run, "id" | "createdAt">): Run {
  let id = makeRunId(fields.title);
  while (existsSync(runDir(id))) id = makeRunId(fields.title);
  const run: Run = { ...fields, id, createdAt: new Date().toISOString() };
  const dir = runDir(run.id);
  mkdirSync(path.join(dir, "session"), { recursive: true });
  writeFileSync(path.join(dir, "brief.md"), run.brief);
  saveRun(run);
  return run;
}

export function saveRun(run: Run): void {
  const file = path.join(runDir(run.id), "run.json");
  writeFileSync(`${file}.tmp`, JSON.stringify(run, null, 2));
  renameSync(`${file}.tmp`, file);
}

export function getRun(id: string): Run | null {
  if (!/^[A-Za-z0-9-]+$/.test(id)) return null;
  const file = path.join(runDir(id), "run.json");
  if (!existsSync(file)) return null;
  try {
    const run = JSON.parse(readFileSync(file, "utf8")) as Run;
    run.source ??= null;
    run.build ??= null;
    return run;
  } catch {
    return null;
  }
}

/** All persisted runs, newest first. */
export function listRuns(filter: { projectId?: string } = {}): Run[] {
  if (!existsSync(RUNS_DIR)) return [];
  return readdirSync(RUNS_DIR)
    .map(getRun)
    .filter((r): r is Run => r !== null && (!filter.projectId || r.projectId === filter.projectId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Persists a frame; `_ts` lets replayed activity keep its original time. */
export function appendEvent(id: string, frame: object): void {
  appendFileSync(path.join(runDir(id), "events.jsonl"), JSON.stringify({ ...frame, _ts: new Date().toISOString() }) + "\n");
}

export function appendStderr(id: string, text: string): void {
  appendFileSync(path.join(runDir(id), "stderr.log"), text);
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
