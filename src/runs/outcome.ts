import type { HarnessExit } from "../harness/types";
import type { Check, ErrorKind, RunUsage, Verdict } from "./types";

/** Shells (and omp) report SIGTERM-induced exits as 128 + 15. */
export const SIGTERM_EXIT = 143;

/** At least one check reached a terminal status (pass/fail/blocked/skipped). */
export function hasResolvedCheck(checks: readonly Check[]): boolean {
  return checks.some((c) => c.status !== "pending" && c.status !== "running");
}

/** Parses duration strings (`runMaxTime`, omp `--max-time`) such as `90m`, `1h30m`, `45s`, `2h`; null when unparseable. A bare number is minutes. */
export function parseDurationMs(text: string): number | null {
  const s = text.trim().toLowerCase();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 60_000);
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 } as const;
  const part = /(\d+(?:\.\d+)?)(ms|s|m|h)/gy;
  let total = 0;
  let end = 0;
  for (let m = part.exec(s); m; m = part.exec(s)) {
    total += Number(m[1]) * unit[m[2] as keyof typeof unit];
    end = part.lastIndex;
  }
  return end === s.length && end > 0 ? Math.round(total) : null;
}

export interface CheckCounts {
  pass: number;
  fail: number;
  blocked: number;
  skipped: number;
  /** pending + running */
  unresolved: number;
}

export function countChecks(checks: readonly Check[]): CheckCounts {
  const c: CheckCounts = { pass: 0, fail: 0, blocked: 0, skipped: 0, unresolved: 0 };
  for (const check of checks) {
    if (check.status === "pending" || check.status === "running") c.unresolved++;
    else c[check.status]++;
  }
  return c;
}

/**
 * Verdict synthesized from checks when the agent never called qa_finish; null when no check resolved.
 * FAIL if any check failed, else PARTIAL if any is blocked/pending/running or nothing passed (all skipped), else PASS.
 */
export function deriveVerdict(checks: readonly Check[]): { verdict: Verdict; summary: string } | null {
  if (!hasResolvedCheck(checks)) return null;
  const c = countChecks(checks);
  const verdict: Verdict = c.fail > 0 ? "FAIL" : c.blocked > 0 || c.unresolved > 0 || c.pass === 0 ? "PARTIAL" : "PASS";
  const parts = (
    [
      [c.pass, "pass"],
      [c.fail, "fail"],
      [c.blocked, "blocked"],
      [c.skipped, "skipped"],
      [c.unresolved, "unresolved"],
    ] as const
  )
    .filter(([n]) => n > 0)
    .map(([n, label]) => `${n} ${label}`);
  return { verdict, summary: `No report from the agent; verdict derived from checks: ${parts.join(" · ")}.` };
}

export interface ExitInput {
  /** Cancellation was requested; wins over everything. */
  cancelled: boolean;
  /** The agent called qa_finish. */
  verdictRecorded: boolean;
  checks: readonly Check[];
  /** How the harness session ended. */
  exit: HarnessExit;
  /** Display name of the harness, for messages (`omp`, `Claude Code`, `Codex CLI`). */
  harnessLabel: string;
  /** Time since spawn; null if the agent never started. */
  elapsedMs: number | null;
  /** Parsed `runMaxTime`; null when unparseable. */
  budgetMs: number | null;
  /** The raw `runMaxTime`, for the message. */
  budgetLabel: string;
}

export interface Outcome {
  status: "done" | "error" | "cancelled";
  errorKind: ErrorKind | null;
  error: string | null;
  /** Present only when the verdict is synthesized from checks (status `done`, verdictSource "derived"). */
  derived: { verdict: Verdict; summary: string } | null;
}

const LIMIT_NAMES: Record<NonNullable<HarnessExit["limit"]>, string> = {
  turns: "turn limit",
  budget: "budget limit",
  time: "time limit",
};

/** Maps how the harness process ended to the run's terminal state. */
export function classifyExit(i: ExitInput): Outcome {
  if (i.cancelled) return { status: "cancelled", errorKind: "cancelled", error: null, derived: null };
  if (i.verdictRecorded) return { status: "done", errorKind: null, error: null, derived: null };

  const { exit, harnessLabel: label } = i;
  const timedOut = i.budgetMs !== null && i.elapsedMs !== null && i.elapsedMs >= i.budgetMs;
  const resolved = hasResolvedCheck(i.checks);
  let cause: string;
  let crashed = false;
  let limited = false;
  if (timedOut) {
    cause = `Run exceeded its time budget (${i.budgetLabel})`;
  } else if (exit.limit) {
    limited = true;
    cause = `${label} stopped at its ${LIMIT_NAMES[exit.limit]}${exit.error ? `: ${exit.error}` : ""}`;
  } else if (!exit.started) {
    cause = exit.error ?? `${label} could not be started; see stderr.log`;
    crashed = true;
  } else if (exit.error !== null) {
    cause = exit.error;
  } else if (!exit.settled && exit.code === SIGTERM_EXIT) {
    cause = `${label} was stopped (SIGTERM): the run was cancelled or Tapocalypse shut down`;
  } else if (!exit.settled && exit.code !== 0) {
    cause = `${label} exited with code ${exit.code}; see stderr.log`;
    crashed = true;
  } else {
    cause = "agent ended without qa_finish";
  }
  const errorKind: ErrorKind = timedOut || limited ? "timeout" : crashed && !resolved ? "infra" : "agent";

  const derived = deriveVerdict(i.checks);
  if (derived) return { status: "done", errorKind, error: cause, derived };
  return { status: "error", errorKind, error: cause, derived: null };
}

/**
 * Totals the `usage` events of a session so a run that dies before the harness can report final usage (crash, timeout
 * kill) still carries what it consumed. `cumulative` events replace the running totals instead of adding to them.
 */
export class UsageTotals {
  private tokensIn = 0;
  private tokensOut = 0;
  private cacheRead = 0;
  private cacheWrite = 0;
  private cost = 0;
  private hasCost = false;
  private toolCalls = 0;
  private model: string | null = null;

  add(usage: Partial<RunUsage>, cumulative: boolean): void {
    if (cumulative) {
      this.tokensIn = 0;
      this.tokensOut = 0;
      this.cacheRead = 0;
      this.cacheWrite = 0;
      this.cost = 0;
      this.hasCost = false;
    }
    if (usage.model) this.model = usage.model;
    this.tokensIn += usage.tokensIn ?? 0;
    this.tokensOut += usage.tokensOut ?? 0;
    this.cacheRead += usage.cacheRead ?? 0;
    this.cacheWrite += usage.cacheWrite ?? 0;
    if (typeof usage.cost === "number" && Number.isFinite(usage.cost)) {
      this.cost += usage.cost;
      this.hasCost = true;
    }
  }

  toolCall(): void {
    this.toolCalls++;
  }

  /** Null when nothing was consumed. */
  snapshot(model: string | null): RunUsage | null {
    if (this.tokensIn + this.tokensOut + this.cacheRead + this.cacheWrite + this.toolCalls === 0) return null;
    return {
      cost: this.hasCost ? this.cost : null,
      tokensIn: this.tokensIn,
      tokensOut: this.tokensOut,
      cacheRead: this.cacheRead,
      cacheWrite: this.cacheWrite,
      toolCalls: this.toolCalls,
      model: model ?? this.model,
    };
  }
}
