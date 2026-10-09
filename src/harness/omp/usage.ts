import type { RunUsage } from "../../runs/types";

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
