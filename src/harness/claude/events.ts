/**
 * Claude Code `--output-format stream-json` frames → normalized `HarnessEvent`s. Pure: no process, no I/O.
 * Frame shapes: `.agent-memory/research/harness-agnostic.md` §3 and §9 (E1–E2).
 */
import { z } from "zod";
import type { Activity, RunUsage } from "../../runs/types";
import { backendViolation } from "../../runs/prompt";
import { PROGRESS_SERVER, type HarnessEvent, type HarnessExit, type ReplayContext } from "../types";

const PROGRESS_TOOLS = ["qa_plan", "qa_check", "qa_finish"] as const;

const frameSchema = z.object({ type: z.string(), subtype: z.string().optional() }).loose();

const usageSchema = z
  .object({
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    cache_read_input_tokens: z.number().optional(),
    cache_creation_input_tokens: z.number().optional(),
  })
  .loose();

const messageSchema = z
  .object({ id: z.string().optional(), content: z.unknown(), usage: usageSchema.optional() })
  .loose();

const blockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }).loose(),
  z.object({ type: z.literal("tool_use"), id: z.string(), name: z.string(), input: z.unknown().optional() }).loose(),
  z
    .object({ type: z.literal("tool_result"), tool_use_id: z.string(), is_error: z.boolean().optional(), content: z.unknown().optional() })
    .loose(),
]);
export type Block = z.infer<typeof blockSchema>;

const resultSchema = z
  .object({
    subtype: z.string().optional(),
    is_error: z.boolean().optional(),
    terminal_reason: z.string().nullish(),
    result: z.unknown().optional(),
    errors: z.array(z.unknown()).optional(),
    total_cost_usd: z.number().optional(),
    usage: usageSchema.optional(),
    modelUsage: z.record(z.string(), z.object({ costUSD: z.number().optional() }).loose()).optional(),
  })
  .loose();

const initSchema = z
  .object({
    session_id: z.string().optional(),
    model: z.string().optional(),
    mcp_servers: z.array(z.object({ name: z.string(), status: z.string().optional() }).loose()).optional(),
  })
  .loose();

export interface CanonicalTool {
  /** Canonical name (`types.ts` § canonical tool names). */
  tool: string;
  /** Canonical MCP server (`tpc`, `mobile_mcp`, …), null for built-in tools. */
  server: string | null;
  args: unknown;
}

function field(input: unknown, key: string): unknown {
  return input && typeof input === "object" ? (input as Record<string, unknown>)[key] : undefined;
}

/** `mcp__<server>__<tool>`; plugin servers are `plugin_<plugin>_<server>`. Hyphens in server names become `_`. */
const MCP_NAME = /^mcp__(.+?)__(.+)$/;
const PLUGIN_SERVER = /^plugin_[^_]+_(.+)$/;

const BUILTIN: Record<string, (input: unknown) => CanonicalTool> = {
  Bash: (i) => ({ tool: "bash", server: null, args: { command: field(i, "command") } }),
  Read: (i) => ({ tool: "read", server: null, args: { path: field(i, "file_path") ?? field(i, "path") } }),
  Write: (i) => ({ tool: "write", server: null, args: { path: field(i, "file_path") ?? field(i, "path") } }),
  Edit: (i) => ({ tool: "edit", server: null, args: { path: field(i, "file_path") ?? field(i, "path") } }),
  MultiEdit: (i) => ({ tool: "edit", server: null, args: { path: field(i, "file_path") ?? field(i, "path") } }),
  WebSearch: (i) => ({ tool: "search", server: null, args: { query: field(i, "query") } }),
};

/** Maps a Claude tool name + input to the canonical tool name, server and args. */
export function canonicalTool(name: string, input: unknown): CanonicalTool {
  const mcp = MCP_NAME.exec(name);
  if (mcp) {
    const server = (PLUGIN_SERVER.exec(mcp[1])?.[1] ?? mcp[1]).replaceAll("-", "_");
    const tool = server === PROGRESS_SERVER && PROGRESS_TOOLS.some((t) => t === mcp[2]) ? mcp[2] : `mcp__${server}_${mcp[2]}`;
    return { tool, server, args: input ?? {} };
  }
  return BUILTIN[name]?.(input) ?? { tool: name.toLowerCase(), server: null, args: input ?? {} };
}

/** True for the progress tools reported through the run MCP endpoint (recorded server-side, so not shown twice). */
export function isProgressTool(c: CanonicalTool): boolean {
  return c.server === PROGRESS_SERVER && PROGRESS_TOOLS.some((t) => t === c.tool);
}

/** Text of a `tool_result.content`: a string, or text blocks joined (images dropped). */
export function resultText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => (field(c, "type") === "text" && typeof field(c, "text") === "string" ? (field(c, "text") as string) : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

/** Content blocks of an `assistant` / `user` frame; unknown block kinds (thinking, image…) are dropped. */
export function frameBlocks(frame: { type: string; message?: unknown }): Block[] {
  const message = messageSchema.safeParse(frame.message);
  if (!message.success || !Array.isArray(message.data.content)) return [];
  return message.data.content.flatMap((b) => {
    const parsed = blockSchema.safeParse(b);
    return parsed.success ? [parsed.data] : [];
  });
}

export function parseFrame(frame: unknown): z.infer<typeof frameSchema> | null {
  const parsed = frameSchema.safeParse(frame);
  return parsed.success ? parsed.data : null;
}

/** One-line description of an `api_retry` / `permission_denied` system frame. */
export function noticeText(frame: Record<string, unknown>): string {
  if (frame.subtype === "api_retry") {
    const err = typeof frame.error === "string" ? frame.error : "unknown error";
    const status = typeof frame.error_status === "number" ? ` (HTTP ${frame.error_status})` : "";
    return `Claude API retry ${String(frame.attempt ?? "?")}/${String(frame.max_retries ?? "?")}: ${err}${status}`;
  }
  const tool = frame.tool_name ?? frame.tool;
  const reason = frame.reason ?? frame.message;
  return `Claude Code denied ${typeof tool === "string" ? tool : "a tool call"}${typeof reason === "string" ? `: ${reason}` : ""}`;
}

export interface TurnResult {
  ok: boolean;
  error: string | null;
  limit: HarnessExit["limit"];
}

/**
 * Classifies a final `result` frame on `is_error` + `terminal_reason`, never `subtype` alone: Claude reports API failures
 * as `subtype:"success"` with `is_error:true`. Turn/budget limits are named by `subtype` or `terminal_reason`.
 */
export function classifyResult(frame: Record<string, unknown>): TurnResult {
  const r = resultSchema.safeParse(frame);
  const f = r.success ? r.data : {};
  const terminal = f.terminal_reason ?? null;
  const limit: HarnessExit["limit"] =
    f.subtype === "error_max_turns" || terminal === "max_turns"
      ? "turns"
      : f.subtype === "error_max_budget_usd" || terminal === "budget_exhausted"
        ? "budget"
        : null;
  if (f.is_error !== true && limit === null) return { ok: true, error: null, limit: null };
  const errors = (f.errors ?? []).map((e) => (typeof e === "string" ? e : JSON.stringify(e))).filter(Boolean);
  const text = typeof f.result === "string" ? f.result.trim() : "";
  const named = limit === "turns" ? "Claude Code hit its turn limit" : limit === "budget" ? "Claude Code hit its budget limit" : null;
  const error = errors.join("; ") || text || named || terminal || f.subtype || "Claude Code reported an error";
  return { ok: false, error, limit };
}

interface TokenCounts {
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
}

function counts(u: z.infer<typeof usageSchema> | undefined): TokenCounts {
  return {
    tokensIn: u?.input_tokens ?? 0,
    tokensOut: u?.output_tokens ?? 0,
    cacheRead: u?.cache_read_input_tokens ?? 0,
    cacheWrite: u?.cache_creation_input_tokens ?? 0,
  };
}

/** Stateful frame → event mapper for one live session. */
export class StreamMapper {
  /** Classification of the last `result` frame; null until the turn ends. */
  lastResult: TurnResult | null = null;
  /** Model from `system/init`. */
  model: string | null = null;
  /** Usage from the last `result` frame (cumulative for the process). */
  finalUsage: RunUsage | null = null;
  private readonly seenUsage = new Map<string, TokenCounts>();
  private readonly live: TokenCounts = { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0 };
  private toolCalls = 0;

  /** Tokens and tool calls seen on live frames; null when nothing happened yet. For sessions that die before their `result`. */
  liveUsage(): RunUsage | null {
    const { tokensIn, tokensOut, cacheRead, cacheWrite } = this.live;
    if (tokensIn + tokensOut + cacheRead + cacheWrite + this.toolCalls === 0) return null;
    return { cost: null, ...this.live, toolCalls: this.toolCalls, model: this.model };
  }

  /** Claude repeats a message's `usage` on every content-block frame of it; count each message id once, growing. */
  private assistantUsage(frame: { type: string; message?: unknown }, toolCalls: number): HarnessEvent[] {
    const message = messageSchema.safeParse(frame.message);
    const now = counts(message.success ? message.data.usage : undefined);
    const id = message.success ? message.data.id : undefined;
    const before = (id ? this.seenUsage.get(id) : undefined) ?? { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0 };
    if (id) this.seenUsage.set(id, now);
    const delta = {
      tokensIn: Math.max(0, now.tokensIn - before.tokensIn),
      tokensOut: Math.max(0, now.tokensOut - before.tokensOut),
      cacheRead: Math.max(0, now.cacheRead - before.cacheRead),
      cacheWrite: Math.max(0, now.cacheWrite - before.cacheWrite),
    };
    this.toolCalls += toolCalls;
    for (const k of Object.keys(delta) as (keyof TokenCounts)[]) this.live[k] += delta[k];
    if (Object.values(delta).every((n) => n === 0) && toolCalls === 0) return [];
    return [{ type: "usage", usage: { ...delta, toolCalls }, cumulative: false }];
  }

  private resultUsage(frame: Record<string, unknown>): RunUsage {
    const r = resultSchema.safeParse(frame);
    const f = r.success ? r.data : {};
    const tokens = f.usage ? counts(f.usage) : this.live;
    const topModel = Object.entries(f.modelUsage ?? {}).sort((a, b) => (b[1].costUSD ?? 0) - (a[1].costUSD ?? 0))[0]?.[0];
    return { cost: f.total_cost_usd ?? null, ...tokens, toolCalls: this.toolCalls, model: this.model ?? topModel ?? null };
  }

  map(raw: unknown): HarnessEvent[] {
    const frame = parseFrame(raw);
    if (!frame) return [];
    switch (frame.type) {
      case "system":
        return this.system(frame);
      case "assistant": {
        const blocks = frameBlocks(frame);
        const events = blocks.flatMap((b): HarnessEvent[] => {
          if (b.type === "text") return b.text.trim() ? [{ type: "text", text: b.text.trim() }] : [];
          if (b.type !== "tool_use") return [];
          const c = canonicalTool(b.name, b.input);
          return [{ type: "tool_call", callId: b.id, tool: c.tool, server: c.server, args: c.args }];
        });
        return [...events, ...this.assistantUsage(frame, blocks.filter((b) => b.type === "tool_use").length)];
      }
      case "user":
        return frameBlocks(frame).flatMap((b): HarnessEvent[] =>
          b.type === "tool_result" ? [{ type: "tool_result", callId: b.tool_use_id, ok: b.is_error !== true, text: resultText(b.content) }] : [],
        );
      case "result": {
        this.lastResult = classifyResult(frame);
        this.finalUsage = this.resultUsage(frame);
        return [{ type: "usage", usage: this.finalUsage, cumulative: true }, { type: "turn_end", ...this.lastResult }];
      }
      default:
        return [];
    }
  }

  private system(frame: Record<string, unknown> & { subtype?: string }): HarnessEvent[] {
    if (frame.subtype === "init") {
      const init = initSchema.safeParse(frame);
      if (!init.success) return [];
      this.model = init.data.model ?? null;
      const events: HarnessEvent[] = [{ type: "session", sessionId: init.data.session_id ?? null, model: this.model }];
      for (const s of init.data.mcp_servers ?? []) {
        if (s.status !== "connected") events.push({ type: "notice", level: "warn", text: `MCP server ${s.name} is ${s.status ?? "unavailable"}` });
      }
      return events;
    }
    if (frame.subtype === "api_retry" || frame.subtype === "permission_denied") {
      return [{ type: "notice", level: "warn", text: noticeText(frame) }];
    }
    return [];
  }
}

const activityFrameSchema = z.object({
  kind: z.enum(["tool", "tool_end", "say", "warn", "info", "user", "error", "check"]),
  text: z.string(),
});

const ARGS_LIMIT = 2048;

/** Keeps the value as-is when its JSON fits `ARGS_LIMIT`, else a truncated JSON string. */
function truncateArgs(v: unknown): unknown {
  const json = JSON.stringify(v);
  if (json === undefined || json.length <= ARGS_LIMIT) return v;
  return `${json.slice(0, ARGS_LIMIT)}…`;
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Maps one persisted raw frame to a feed line. `ctx.seq` is the frame's 0-based line index in events.jsonl; `ctx.starts`
 * carries tool starts across frames so results resolve their tool and duration. A frame holds several content blocks,
 * but a feed line is one: a real tool call wins over text, and the first of several calls is shown.
 */
export function toActivity(raw: unknown, ctx: ReplayContext): Activity | null {
  const frame = parseFrame(raw);
  if (!frame) return null;
  const ts = typeof frame._ts === "string" ? frame._ts : new Date().toISOString();
  const seq = ctx.seq;
  switch (frame.type) {
    case "_activity": {
      const a = activityFrameSchema.safeParse(frame);
      return a.success ? { ts, seq, kind: a.data.kind, text: a.data.text } : null;
    }
    // `system` frames (api_retry, permission_denied, init warnings) are `notice` events: the runner writes their single warn line.
    case "assistant": {
      const blocks = frameBlocks(frame);
      let activity: Activity | null = null;
      for (const b of blocks) {
        if (b.type !== "tool_use") continue;
        const c = canonicalTool(b.name, b.input);
        ctx.starts.set(b.id, { ts: Date.parse(ts), tool: c.tool });
        if (activity || isProgressTool(c)) continue;
        const base = { ts, seq, callId: b.id, tool: c.tool, args: truncateArgs(c.args) };
        activity = backendViolation(c.tool)
          ? { ...base, kind: "warn", text: `backend violation: ${c.tool}` }
          : { ...base, kind: "tool", text: `${c.tool} ${(JSON.stringify(c.args) ?? "").slice(0, 200)}` };
      }
      if (activity) return activity;
      const text = blocks
        .flatMap((b) => (b.type === "text" && b.text.trim() ? [b.text.trim()] : []))
        .join("\n");
      return text ? { ts, seq, kind: "say", text: text.slice(0, 500) } : null;
    }
    case "user": {
      for (const b of frameBlocks(frame)) {
        if (b.type !== "tool_result") continue;
        const start = ctx.starts.get(b.tool_use_id);
        const ok = b.is_error !== true;
        // A successful qa_* call is already a "check" line from the server-side recorder; a rejected one must stay visible.
        if (ok && start && PROGRESS_TOOLS.some((t) => t === start.tool)) continue;
        const tool = start?.tool ?? "tool";
        const durationMs = start ? Math.max(0, Date.parse(ts) - start.ts) : undefined;
        const took = durationMs === undefined ? "" : ` (${formatDuration(durationMs)})`;
        const detail = ok ? "" : `: ${resultText(b.content).slice(0, 200)}`;
        return { ts, seq, kind: "tool_end", text: `${tool} ${ok ? "ok" : "failed"}${took}${detail}`, callId: b.tool_use_id, tool, ok, durationMs };
      }
      return null;
    }
    case "result": {
      const r = classifyResult(frame);
      return r.ok ? null : { ts, seq, kind: "error", text: (r.error ?? "Claude Code reported an error").slice(0, 500) };
    }
    default:
      return null;
  }
}
