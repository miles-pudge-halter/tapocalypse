import { randomBytes } from "node:crypto";
import type { Check, CheckStatus, KeyKind, Platform, Run, Verdict } from "../../src/runs/types";
import { getProject } from "../../src/projects/registry";
import { type GitRunner, refreshDefaultBranch, setDefaultBranchDeps } from "../../src/regression/baseline";
import { createRun, deleteRun, saveRun } from "../../src/runs/store";

export const PROJECT = "test-proj";

/** Swaps the git answers and waits for the fixture project's default branch to be detected, as the server's boot warm-up does. */
export async function useGit(git: GitRunner): Promise<void> {
  setDefaultBranchDeps({ git });
  await refreshDefaultBranch(getProject(PROJECT)!);
}
const BASE = Date.parse("2026-03-01T10:00:00.000Z");

export const uniqueTest = (): string => `test:${randomBytes(4).toString("hex")}`;

export interface CheckSpec {
  /** Check id; also the suffix of the key. */
  id: string;
  status: CheckStatus;
  title?: string;
  note?: string;
  keyKind?: KeyKind;
  /** `storage: "data"` form: relative to the run's artefact dir. */
  screenshot?: string;
  /** Overrides the key (default `<testKey>/<id>`), e.g. to model a renumbered check. */
  key?: string;
}

export interface RunSpec {
  testKey: string;
  /** Minutes after a fixed epoch: orders runs without relying on the wall clock. */
  at: number;
  checks?: (CheckSpec | [string, CheckStatus])[];
  title?: string;
  branch?: string | null;
  commit?: string | null;
  dirty?: boolean | null;
  prBase?: string | null;
  platform?: Platform;
  device?: string | null;
  status?: Run["status"];
  verdict?: Verdict | null;
  rerunOf?: string | null;
  retryOf?: string | null;
  retriedBy?: string | null;
  brief?: string;
  harness?: Run["harness"];
  model?: string | null;
  cost?: number | null;
  build?: { versionName: string; versionCode: string } | null;
  projectId?: string;
}

const created: string[] = [];

/** Persists a keyed run into the shared store. Assert only on ids you create. */
export function makeRun(spec: RunSpec): Run {
  const checks: Check[] = (spec.checks ?? []).map((c) => {
    const s: CheckSpec = Array.isArray(c) ? { id: c[0], status: c[1] } : c;
    const at = new Date(BASE + spec.at * 60_000).toISOString();
    return {
      id: s.id,
      title: s.title ?? `Check ${s.id}`,
      status: s.status,
      ...(s.note ? { note: s.note } : {}),
      ...(s.screenshot ? { screenshot: s.screenshot } : {}),
      updatedAt: at,
      checkKey: s.key ?? `${spec.testKey}/${s.id}`,
      keyKind: s.keyKind ?? "title",
    };
  });
  const run = createRun({
    projectId: spec.projectId ?? PROJECT,
    title: spec.title ?? "regression fixture",
    brief: spec.brief ?? "brief",
    requestedBy: "test",
    deviceRequest: { platform: spec.platform ?? "android" },
    deviceSerial: null,
    deviceName: spec.device === undefined ? "Pixel" : spec.device,
    bootedByRun: false,
    packageId: "com.example.app",
    status: spec.status ?? "done",
    verdict: spec.verdict === undefined ? "PASS" : spec.verdict,
    summary: null,
    reportPath: null,
    checks,
    error: null,
    startedAt: null,
    endedAt: null,
    stats: null,
    transcriptHtml: false,
    source:
      spec.branch === undefined && spec.commit === undefined && spec.prBase === undefined
        ? null
        : {
            path: "/tmp/none",
            branch: spec.branch ?? null,
            commit: spec.commit ?? null,
            commitSubject: null,
            dirty: spec.dirty === undefined ? (spec.commit ? false : null) : spec.dirty,
            remoteUrl: null,
            pr: spec.prBase
              ? { number: 7, title: null, url: null, state: null, baseBranch: spec.prBase, isDraft: null, author: null }
              : null,
            prStatus: spec.prBase ? "found" : "none",
            tickets: [],
            labels: {},
          },
    build: spec.build ? { packageId: "com.example.app", ...spec.build, capturedAt: "2026-03-01T00:00:00.000Z" } : null,
    harness: spec.harness ?? "omp",
    model: spec.model ?? null,
    usage: spec.cost === undefined ? null : { cost: spec.cost, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, toolCalls: 0, model: spec.model ?? null },
    rerunOf: spec.rerunOf ?? null,
    retryOf: spec.retryOf ?? null,
    retriedBy: spec.retriedBy ?? null,
    storage: "data",
    testKey: spec.testKey,
  });
  created.push(run.id);
  run.createdAt = new Date(BASE + spec.at * 60_000).toISOString();
  saveRun(run);
  return run;
}

/** Changes a stored fixture run (e.g. flips a status after the fact) and persists it. */
export function updateRun(run: Run, change: (r: Run) => void): Run {
  change(run);
  saveRun(run);
  return run;
}

export function cleanupRuns(): void {
  for (const id of created.splice(0)) deleteRun(id);
}
