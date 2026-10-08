import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config";
import { listRuns } from "./runs/store";
import { ACTIVE, type Run, type Verdict } from "./runs/types";

/** Persisted next to the runs so a batch keeps its title even after its runs are renamed by device suffixes. */
export interface BatchMeta {
  id: string;
  projectId: string;
  title: string;
  createdAt: string;
}

export interface BatchSummary {
  status: "active" | "done";
  verdict: Verdict | null;
  cost: number | null;
  startedAt: string | null;
  endedAt: string | null;
}

const BATCHES_DIR = path.join(DATA_DIR, "batches");
const BATCH_ID_RE = /^b-\d{8}-\d{6}-[0-9a-f]{4}$/;

/** Worst first. */
const SEVERITY: Verdict[] = ["FAIL", "BLOCKED", "PARTIAL", "PASS WITH ISSUES", "PASS"];

export function makeBatchId(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `b-${stamp}-${randomBytes(2).toString("hex")}`;
}

export function isBatchId(id: string): boolean {
  return BATCH_ID_RE.test(id);
}

export function saveBatchMeta(meta: BatchMeta): void {
  mkdirSync(BATCHES_DIR, { recursive: true });
  const file = path.join(BATCHES_DIR, `${meta.id}.json`);
  writeFileSync(`${file}.tmp`, JSON.stringify(meta, null, 2));
  renameSync(`${file}.tmp`, file);
}

export function getBatchMeta(id: string): BatchMeta | null {
  if (!isBatchId(id)) return null;
  const file = path.join(BATCHES_DIR, `${id}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as BatchMeta;
  } catch {
    return null;
  }
}

/** Removes a batch's metadata file once no run references the batch any more (its last run was deleted). */
export function pruneBatchMeta(id: string): void {
  if (!isBatchId(id) || listRuns().some((r) => r.batchId === id)) return;
  rmSync(path.join(BATCHES_DIR, `${id}.json`), { force: true });
}

/** Worst verdict by FAIL > BLOCKED > PARTIAL > PASS WITH ISSUES > PASS; null when any run has none (or there are no runs). */
export function worstVerdict(verdicts: (Verdict | null)[]): Verdict | null {
  if (verdicts.length === 0 || verdicts.some((v) => v === null)) return null;
  let worst = SEVERITY.length - 1;
  for (const v of verdicts) worst = Math.min(worst, SEVERITY.indexOf(v as Verdict));
  return SEVERITY[worst]!;
}

/**
 * Status / verdict / cost / timing of a batch. A run superseded by an infra retry (`retriedBy`) is judged by its
 * successor, so a recovered boot failure does not leave the batch without a verdict; its cost still counts.
 */
export function summarizeBatch(runs: Run[]): BatchSummary {
  const current = runs.filter((r) => !r.retriedBy);
  const active = current.some((r) => ACTIVE.includes(r.status));
  const costs = runs.flatMap((r) => (typeof r.usage?.cost === "number" ? [r.usage.cost] : []));
  const started = runs.flatMap((r) => (r.startedAt ? [r.startedAt] : [])).sort();
  const ended = current.flatMap((r) => (r.endedAt ? [r.endedAt] : [])).sort();
  return {
    status: active ? "active" : "done",
    verdict: worstVerdict(current.map((r) => r.verdict)),
    cost: costs.length > 0 ? costs.reduce((a, b) => a + b, 0) : null,
    startedAt: started[0] ?? null,
    endedAt: active ? null : (ended.at(-1) ?? null),
  };
}
