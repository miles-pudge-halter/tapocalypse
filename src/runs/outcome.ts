import type { Check, ErrorKind, RunUsage, Verdict } from "./types";

/** omp sends SIGTERM-induced exits as 128 + 15. */
export const SIGTERM_EXIT = 143;

/** At least one check reached a terminal status (pass/fail/blocked/skipped). */
export function hasResolvedCheck(checks: readonly Check[]): boolean {
  return checks.some((c) => c.status !== "pending" && c.status !== "running");
}

/** Parses omp `--max-time` strings such as `90m`, `1h30m`, `45s`, `2h`; null when unparseable. A bare number is minutes. */
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
  /** The agent's final `prompt_result`, if any. */
  promptResult: { status: string; error: string | null } | null;
  exitCode: number;
  /** The session reported settled before the process ended. */
  settled: boolean;
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

/** Maps how the omp process ended to the run's terminal state. */
export function classifyExit(i: ExitInput): Outcome {
  if (i.cancelled) return { status: "cancelled", errorKind: "cancelled", error: null, derived: null };
  if (i.verdictRecorded) return { status: "done", errorKind: null, error: null, derived: null };

  const timedOut = i.budgetMs !== null && i.elapsedMs !== null && i.elapsedMs >= i.budgetMs;
  const resolved = hasResolvedCheck(i.checks);
  let cause: string;
  let crashed = false;
  if (timedOut) {
    cause = `Run exceeded its time budget (${i.budgetLabel})`;
  } else if (i.promptResult?.status === "error") {
    cause = i.promptResult.error ?? "agent run failed";
  } else if (!i.settled && i.exitCode === SIGTERM_EXIT) {
    cause = "omp was stopped (SIGTERM): the run was cancelled or Tapocalypse shut down";
  } else if (!i.settled && i.exitCode !== 0) {
    cause = `omp exited with code ${i.exitCode}; see stderr.log`;
    crashed = true;
  } else {
    cause = "agent ended without qa_finish";
  }
  const errorKind: ErrorKind = timedOut ? "timeout" : crashed && !resolved ? "infra" : "agent";

  const derived = deriveVerdict(i.checks);
  if (derived) return { status: "done", errorKind, error: cause, derived };
  return { status: "error", errorKind, error: cause, derived: null };
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Normalizes omp `get_session_stats` data; null when `stats` is not an object. */
export function normalizeUsage(stats: unknown, model: string | null): RunUsage | null {
  if (!stats || typeof stats !== "object") return null;
  const s = stats as { tokens?: unknown; cost?: unknown; toolCalls?: unknown };
  const t = (s.tokens && typeof s.tokens === "object" ? s.tokens : {}) as Record<string, unknown>;
  return {
    cost: typeof s.cost === "number" && Number.isFinite(s.cost) ? s.cost : null,
    tokensIn: num(t.input),
    tokensOut: num(t.output),
    cacheRead: num(t.cacheRead),
    cacheWrite: num(t.cacheWrite),
    toolCalls: num(s.toolCalls),
    model,
  };
}

/**
 * Totals usage from live frames (assistant `message_end` usage + tool starts) so a run that dies before
 * `get_session_stats` can answer (crash, timeout kill) still reports what it consumed.
 */
export class UsageAccumulator {
  private tokensIn = 0;
  private tokensOut = 0;
  private cacheRead = 0;
  private cacheWrite = 0;
  private cost = 0;
  private hasCost = false;
  private toolCalls = 0;
  private model: string | null = null;

  add(frame: { type: string; [key: string]: unknown }): void {
    if (frame.type === "tool_execution_start") {
      this.toolCalls++;
      return;
    }
    if (frame.type !== "message_end") return;
    const msg = frame.message as { role?: unknown; usage?: Record<string, unknown>; model?: unknown; provider?: unknown } | undefined;
    if (msg?.role !== "assistant" || !msg.usage) return;
    this.tokensIn += num(msg.usage.input);
    this.tokensOut += num(msg.usage.output);
    this.cacheRead += num(msg.usage.cacheRead);
    this.cacheWrite += num(msg.usage.cacheWrite);
    const cost = (msg.usage.cost as { total?: unknown } | undefined)?.total;
    if (typeof cost === "number" && Number.isFinite(cost)) {
      this.cost += cost;
      this.hasCost = true;
    }
    if (typeof msg.model === "string") this.model = typeof msg.provider === "string" ? `${msg.provider}/${msg.model}` : msg.model;
  }

  /** Null when no assistant turn was observed. */
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
