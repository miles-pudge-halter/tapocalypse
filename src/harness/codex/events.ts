/**
 * Codex CLI `exec --json` stream: parsing, normalization into `HarnessEvent`s (live) and replay into feed lines
 * (`toActivity`). Frame shapes follow codex-rs `exec_events.rs`: `thread.started`, `turn.*`, `item.started|updated|completed`
 * (`agent_message`, `reasoning`, `command_execution`, `file_change`, `mcp_tool_call`, `web_search`, `todo_list`, `error`), `error`.
 */
import { z } from "zod";
import { backendViolation } from "../../runs/prompt";
import type { Activity, RunUsage } from "../../runs/types";
import { CANONICAL_TOOL_PREFIX, type HarnessEvent, type ReplayContext } from "../types";

/** The one place that knows how Codex names an MCP tool for the model (`mcp__<server>__<tool>`). [INFERENCE: not observed on a live run] */
export const codexToolName = (server: string, tool: string): string => `mcp__${server}__${tool}`;

const PROGRESS_TOOLS: readonly string[] = ["qa_plan", "qa_check", "qa_finish"];
const PROGRESS_SERVER_NAME = "tpc";

const nonNegative = z.number().nullish();

const usageSchema = z.looseObject({
  input_tokens: nonNegative,
  cached_input_tokens: nonNegative,
  cache_write_input_tokens: nonNegative,
  output_tokens: nonNegative,
  reasoning_output_tokens: nonNegative,
});

const commandItem = z.looseObject({
  type: z.literal("command_execution"),
  id: z.string(),
  command: z.string(),
  aggregated_output: z.string().nullish(),
  exit_code: z.number().nullish(),
  status: z.string().nullish(),
});
const fileChangeItem = z.looseObject({
  type: z.literal("file_change"),
  id: z.string(),
  changes: z.array(z.looseObject({ path: z.string(), kind: z.string().nullish() })).nullish(),
  status: z.string().nullish(),
});
const mcpItem = z.looseObject({
  type: z.literal("mcp_tool_call"),
  id: z.string(),
  server: z.string(),
  tool: z.string(),
  arguments: z.unknown(),
  result: z.looseObject({ content: z.array(z.unknown()).nullish() }).nullish(),
  error: z.looseObject({ message: z.string().nullish() }).nullish(),
  status: z.string().nullish(),
});
const searchItem = z.looseObject({ type: z.literal("web_search"), id: z.string(), query: z.string().nullish() });
const messageItem = z.looseObject({ type: z.enum(["agent_message", "reasoning"]), id: z.string(), text: z.string().nullish() });
const errorItem = z.looseObject({ type: z.literal("error"), id: z.string().optional(), message: z.string().nullish() });
const otherItem = z.looseObject({ type: z.string(), id: z.string().optional() });
const itemSchema = z.union([commandItem, fileChangeItem, mcpItem, searchItem, messageItem, errorItem, otherItem]);

const frameSchema = z.union([
  z.looseObject({ type: z.literal("thread.started"), thread_id: z.string().nullish() }),
  z.looseObject({ type: z.literal("turn.started") }),
  z.looseObject({ type: z.enum(["item.started", "item.updated", "item.completed"]), item: itemSchema }),
  z.looseObject({ type: z.literal("turn.completed"), usage: usageSchema.nullish() }),
  z.looseObject({ type: z.literal("turn.failed"), error: z.looseObject({ message: z.string().nullish() }).nullish() }),
  z.looseObject({ type: z.literal("error"), message: z.string().nullish() }),
]);

type Item = z.infer<typeof itemSchema>;
type CodexFrame = z.infer<typeof frameSchema>;
type CodexUsage = z.infer<typeof usageSchema>;

/** Parses one persisted/live frame; null for anything that is not a known Codex event. */
export function parseFrame(raw: unknown): CodexFrame | null {
  const r = frameSchema.safeParse(raw);
  return r.success ? r.data : null;
}

interface ToolDescription {
  /** Canonical tool name (see `CANONICAL_TOOL_PREFIX` in types.ts). */
  tool: string;
  server: string | null;
  args: unknown;
}

/** Tool-like items (the ones that become `tool_call` / `tool_result`); null for messages, reasoning, todo lists, errors. */
function describeTool(item: Item): ToolDescription | null {
  switch (item.type) {
    case "command_execution": {
      const c = commandItem.safeParse(item);
      return c.success ? { tool: "bash", server: null, args: { command: c.data.command } } : null;
    }
    case "file_change": {
      const c = fileChangeItem.safeParse(item);
      if (!c.success) return null;
      const paths = (c.data.changes ?? []).map((ch) => ch.path);
      return { tool: "edit", server: null, args: { path: paths[0] ?? "", paths } };
    }
    case "mcp_tool_call": {
      const c = mcpItem.safeParse(item);
      if (!c.success) return null;
      // Hyphens and underscores are interchangeable in server keys; the canonical form uses underscores.
      const server = c.data.server.replace(/-/g, "_");
      const progress = server === PROGRESS_SERVER_NAME && PROGRESS_TOOLS.includes(c.data.tool);
      const tool = progress ? c.data.tool : `${CANONICAL_TOOL_PREFIX}${server}_${c.data.tool}`;
      return { tool, server, args: c.data.arguments ?? {} };
    }
    case "web_search": {
      const c = searchItem.safeParse(item);
      return c.success ? { tool: "search", server: null, args: { query: c.data.query ?? "" } } : null;
    }
    default:
      return null;
  }
}

const RESULT_TEXT_LIMIT = 2000;

function clip(s: string): string {
  return s.length > RESULT_TEXT_LIMIT ? `${s.slice(0, RESULT_TEXT_LIMIT)}…` : s;
}

/** Outcome of a finished tool-like item. */
function describeOutcome(item: Item): { ok: boolean; text: string } {
  switch (item.type) {
    case "command_execution": {
      const c = commandItem.parse(item);
      const ok = (c.status ?? "completed") === "completed" && (c.exit_code ?? 0) === 0;
      return { ok, text: clip((c.aggregated_output ?? "").trim()) };
    }
    case "file_change": {
      const c = fileChangeItem.parse(item);
      const text = (c.changes ?? []).map((ch) => `${ch.kind ?? "change"} ${ch.path}`).join(", ");
      return { ok: (c.status ?? "completed") !== "failed", text };
    }
    case "mcp_tool_call": {
      const c = mcpItem.parse(item);
      if (c.error || c.status === "failed") return { ok: false, text: clip(c.error?.message ?? "tool call failed") };
      const text = (c.result?.content ?? [])
        .map((b) => (b && typeof b === "object" && "text" in b && typeof b.text === "string" ? b.text : ""))
        .filter(Boolean)
        .join("\n")
        .trim();
      return { ok: true, text: clip(text) };
    }
    default:
      return { ok: true, text: "" };
  }
}

function usageToRunUsage(u: CodexUsage, toolCalls: number): Partial<RunUsage> {
  const input = u.input_tokens ?? 0;
  const cached = u.cached_input_tokens ?? 0;
  return {
    // Codex counts cached tokens inside input_tokens; RunUsage keeps them apart (omp convention), so they are not billed twice.
    tokensIn: Math.max(0, input - cached),
    tokensOut: u.output_tokens ?? 0,
    cacheRead: cached,
    cacheWrite: u.cache_write_input_tokens ?? 0,
    toolCalls,
  };
}

/** Stateful live translator: one instance per `codex exec` process. */
export class CodexTranslator {
  sessionId: string | null = null;
  settled = false;
  error: string | null = null;
  /** Startup errors that name a requested MCP server, keyed by the server name as requested. */
  readonly serverErrors = new Map<string, string>();
  private started = new Set<string>();
  private toolCalls = 0;
  private lastNotice = "";
  private usage: RunUsage | null = null;

  constructor(
    private servers: readonly string[],
    private model: string | null,
  ) {}

  /** Usage seen on `turn.completed`; null before that. `cost` is always null (Codex reports tokens only). */
  usageSnapshot(): RunUsage | null {
    return this.usage;
  }

  translate(raw: unknown): HarnessEvent[] {
    const frame = parseFrame(raw);
    if (!frame) return [];
    switch (frame.type) {
      case "thread.started":
        this.sessionId = frame.thread_id ?? null;
        return [{ type: "session", sessionId: this.sessionId, model: this.model }];
      case "item.started":
      case "item.updated":
        return this.ensureCall(frame.item);
      case "item.completed":
        return this.completed(frame.item);
      case "error":
        return this.notice(frame.message ?? "codex error");
      case "turn.completed": {
        this.settled = true;
        const usage = frame.usage ? usageToRunUsage(frame.usage, this.toolCalls) : { toolCalls: this.toolCalls };
        this.usage = {
          cost: null,
          tokensIn: usage.tokensIn ?? 0,
          tokensOut: usage.tokensOut ?? 0,
          cacheRead: usage.cacheRead ?? 0,
          cacheWrite: usage.cacheWrite ?? 0,
          toolCalls: this.toolCalls,
          model: this.model,
        };
        return [
          { type: "usage", usage, cumulative: false },
          { type: "turn_end", ok: true, error: null, limit: null },
        ];
      }
      case "turn.failed": {
        this.settled = true;
        this.error = frame.error?.message ?? "codex turn failed";
        return [{ type: "turn_end", ok: false, error: this.error, limit: null }];
      }
      default:
        return [];
    }
  }

  private ensureCall(item: Item): HarnessEvent[] {
    const d = describeTool(item);
    const id = "id" in item ? item.id : undefined;
    if (!d || !id || this.started.has(id)) return [];
    this.started.add(id);
    this.toolCalls++;
    return [{ type: "tool_call", callId: id, tool: d.tool, server: d.server, args: d.args }];
  }

  private completed(item: Item): HarnessEvent[] {
    if (item.type === "agent_message") {
      const text = messageText(item);
      return text ? [{ type: "text", text }] : [];
    }
    if (item.type === "error") {
      const parsed = errorItem.safeParse(item);
      return this.notice((parsed.success ? parsed.data.message : null) ?? "codex error");
    }
    const events = this.ensureCall(item);
    const id = "id" in item ? item.id : undefined;
    if (!describeTool(item) || !id) return events;
    return [...events, { type: "tool_result", callId: id, ...describeOutcome(item) }];
  }

  private notice(text: string): HarnessEvent[] {
    for (const server of this.servers) {
      if (!mentionsServer(text, server) || !/mcp|server|start|initiali|connect|fail/i.test(text)) continue;
      this.serverErrors.set(server, text);
    }
    // Codex repeats "Reconnecting…" every few seconds while offline; show it once.
    if (text === this.lastNotice) return [];
    this.lastNotice = text;
    return [{ type: "notice", level: "warn", text }];
  }
}

/** Trimmed text of an `agent_message` item; null when it is empty or malformed. */
function messageText(item: Item): string | null {
  const parsed = messageItem.safeParse(item);
  return (parsed.success ? parsed.data.text?.trim() : null) || null;
}

function mentionsServer(text: string, server: string): boolean {
  const lower = text.toLowerCase();
  const name = server.toLowerCase();
  return lower.includes(name) || lower.includes(name.replace(/_/g, "-"));
}

// ---- replay -------------------------------------------------------------------------------------------------------

const ARGS_LIMIT = 2048;

function truncateArgs(v: unknown): unknown {
  let json: string | undefined;
  try {
    json = JSON.stringify(v);
  } catch {
    return undefined;
  }
  if (json === undefined || json.length <= ARGS_LIMIT) return v;
  return `${json.slice(0, ARGS_LIMIT)}…`;
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function isProgressTool(tool: string): boolean {
  return PROGRESS_TOOLS.includes(tool);
}

/**
 * Maps one persisted frame to a feed line. Progress tool calls and their successful results return null (the recorder writes
 * the `check` lines server-side); a rejected progress call stays visible.
 */
export function frameToActivity(frame: unknown, ctx: ReplayContext): Activity | null {
  if (!frame || typeof frame !== "object") return null;
  const f = frame as Record<string, unknown>;
  const ts = typeof f._ts === "string" ? f._ts : new Date().toISOString();
  const seq = ctx.seq;
  if (f.type === "_activity") return { ts, seq, kind: f.kind as Activity["kind"], text: String(f.text) };
  const parsed = parseFrame(frame);
  if (!parsed) return null;
  switch (parsed.type) {
    case "item.started":
    case "item.updated": {
      const d = describeTool(parsed.item);
      const id = "id" in parsed.item ? parsed.item.id : undefined;
      const prev = id ? ctx.starts.get(id) : undefined;
      // The store maps a frame twice (scan, then page): only a different frame repeating the id is a duplicate.
      if (!d || !id || (prev && prev.seq !== seq)) return null;
      ctx.starts.set(id, { ts: Date.parse(ts), tool: d.tool, seq });
      return toolLine(d, id, ts, seq);
    }
    case "item.completed": {
      const item = parsed.item;
      if (item.type === "agent_message") {
        const text = messageText(item);
        return text ? { ts, seq, kind: "say", text: text.slice(0, 500) } : null;
      }
      if (item.type === "error") return null;
      const d = describeTool(item);
      const id = "id" in item ? item.id : undefined;
      if (!d || !id) return null;
      const start = ctx.starts.get(id);
      if (!start) return toolLine(d, id, ts, seq);
      const outcome = describeOutcome(item);
      if (isProgressTool(d.tool) && outcome.ok) return null;
      const durationMs = Math.max(0, Date.parse(ts) - start.ts);
      const detail = outcome.ok || !outcome.text ? "" : `: ${outcome.text.slice(0, 200)}`;
      return {
        ts,
        seq,
        kind: "tool_end",
        text: `${d.tool} ${outcome.ok ? "ok" : "failed"} (${formatDuration(durationMs)})${detail}`,
        callId: id,
        tool: d.tool,
        ok: outcome.ok,
        durationMs,
      };
    }
    // `error` frames and error items are `notice` events: the runner writes their single warn line.
    case "turn.failed":
      return { ts, seq, kind: "error", text: parsed.error?.message ?? "codex turn failed" };
    default:
      return null;
  }
}

function toolLine(d: ToolDescription, callId: string, ts: string, seq: number): Activity | null {
  if (isProgressTool(d.tool)) return null;
  const base = { ts, seq, callId, tool: d.tool, args: truncateArgs(d.args) };
  if (backendViolation(d.tool)) return { ...base, kind: "warn", text: `backend violation: ${d.tool}` };
  const shown = JSON.stringify(d.args) ?? "";
  return { ...base, kind: "tool", text: `${d.tool} ${shown.slice(0, 200)}` };
}
