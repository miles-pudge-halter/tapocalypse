// Maps omp RPC frames (live or replayed from events.jsonl) to feed lines and canonical tool names.
import { backendViolation } from "../../runs/prompt";
import type { Activity, CheckStatus } from "../../runs/types";
import { MOBILE_MCP_SERVER, type ReplayContext } from "../types";

const ARGS_LIMIT = 2048;
const CHECK_STATUSES: readonly CheckStatus[] = ["pending", "running", "pass", "fail", "blocked", "skipped"];
const PROGRESS_TOOL_NAMES: readonly string[] = ["qa_plan", "qa_check", "qa_finish"];

/**
 * Device tools reach the agent through Tapocalypse's stdio bridge: `mcp__tpc_qa_mobile_x` (plugin `tpc`, server `qa`), and
 * `mcp__tpc_mobile_mcp_mobile_x` for runs recorded when the plugin still wrapped mobile-mcp itself. Both canonicalize to
 * `mcp__mobile_mcp_mobile_x`. Any other MCP name (an agent's own mobile-mcp included) stays raw so `backendViolation` can see it.
 */
const DEVICE_TOOL = /^mcp__tpc_(?:qa_|mobile_mcp_)(mobile_.+)$/;

/** Canonical form of an omp tool name (see `CANONICAL_TOOL_PREFIX` in `harness/types`); built-ins and unknown MCP servers pass through. */
export function canonicalToolName(name: string): string {
  const m = DEVICE_TOOL.exec(name);
  return m ? `mcp__${MOBILE_MCP_SERVER}_${m[1]}` : name;
}

/** The MCP server (`mobile_mcp`) a canonical tool name belongs to; null otherwise. */
export function serverOf(canonical: string): string | null {
  return canonical.startsWith(`mcp__${MOBILE_MCP_SERVER}_`) ? MOBILE_MCP_SERVER : null;
}

export interface ResolvedCall {
  tool: string;
  /** The call's arguments as the agent wrote them (an xd:// write's `content`, JSON-parsed when it is a string). */
  args: unknown;
  /** The tool name as the harness reported it, before canonicalisation: what tells Tapocalypse's gateway from an agent's own mobile-mcp. */
  raw: string;
}

/**
 * omp mounts MCP tools as xd:// devices: a `write xd://mcp__x` is the actual call of tool `mcp__x` (a `read` of it only
 * fetches its docs), so such a write is attributed to the MCP tool.
 */
export function resolveCall(toolName: string, rawArgsIn: unknown): ResolvedCall {
  const rawArgs = (rawArgsIn ?? {}) as Record<string, unknown>;
  const xdTool = typeof rawArgs.path === "string" && rawArgs.path.startsWith("xd://") ? rawArgs.path.slice(5) : null;
  const [tool, detail] = toolName === "write" && xdTool ? [xdTool, rawArgs.content ?? {}] : [toolName, rawArgs];
  let args = detail;
  if (typeof detail === "string") {
    try {
      args = JSON.parse(detail);
    } catch {}
  }
  return { tool: canonicalToolName(tool), args, raw: tool };
}

/** Keeps the value as-is when its JSON fits `ARGS_LIMIT`, else a truncated JSON string. */
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

/** Tool-result text blocks joined. */
export function resultText(result: unknown): string {
  const content = (result as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c): c is { type: "text"; text: string } => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n")
    .trim();
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Feed line for a progress tool call (qa_plan / qa_check / qa_finish); null when its arguments are malformed. */
function progressActivity(tool: string, args: Record<string, unknown>): Pick<Activity, "text" | "checkId" | "checkStatus"> | null {
  if (tool === "qa_plan" && Array.isArray(args.checks)) {
    return { text: `Test plan: ${args.checks.length} check${args.checks.length === 1 ? "" : "s"}` };
  }
  if (tool === "qa_check" && typeof args.id === "string" && CHECK_STATUSES.includes(args.status as CheckStatus)) {
    const note = typeof args.note === "string" && args.note ? ` — ${args.note.slice(0, 300)}` : "";
    return { text: `${args.id}: ${String(args.status)}${note}`, checkId: args.id, checkStatus: args.status as CheckStatus };
  }
  if (tool === "qa_finish" && typeof args.verdict === "string") return { text: `Finished: ${args.verdict}` };
  return null;
}

/**
 * Check lines for runs recorded before progress calls were logged server-side: those events.jsonl files only have the
 * host-tool call frame. Null for every other frame.
 */
export function legacyProgressActivity(frame: unknown, seq: number): Activity | null {
  const f = frame as { type?: unknown; toolName?: unknown; args?: unknown; _ts?: unknown } | null;
  if (f?.type !== "tool_execution_start" || typeof f.toolName !== "string" || !PROGRESS_TOOL_NAMES.includes(f.toolName)) return null;
  const host = progressActivity(f.toolName, (f.args ?? {}) as Record<string, unknown>);
  if (!host) return null;
  const ts = typeof f._ts === "string" ? f._ts : new Date().toISOString();
  return { ts, seq, kind: "check", ...host };
}

/**
 * Maps an omp frame to a feed line; `ctx.seq` is the frame's 0-based line index in events.jsonl. `ctx.starts` is shared
 * across a session so `tool_end` lines resolve their tool and duration. Progress tool calls return null: the progress
 * recorder writes their `check` lines.
 */
export function toActivity(frame: unknown, ctx: ReplayContext): Activity | null {
  if (!frame || typeof frame !== "object") return null;
  const f = frame as Record<string, unknown>;
  const { seq, starts } = ctx;
  const ts = typeof f._ts === "string" ? f._ts : new Date().toISOString();
  switch (f.type) {
    case "tool_execution_start": {
      if (typeof f.toolName !== "string") return { ts, seq, kind: "tool", text: JSON.stringify(frame).slice(0, 300) };
      const { tool, args, raw } = resolveCall(f.toolName, f.args);
      const callId = typeof f.toolCallId === "string" ? f.toolCallId : undefined;
      if (callId) starts.set(callId, { ts: Date.parse(ts), tool });
      if (PROGRESS_TOOL_NAMES.includes(tool)) return null;
      const base = { ts, seq, callId, tool, args: truncateArgs(args) };
      if (backendViolation(raw, ctx.gated)) return { ...base, kind: "warn", text: `backend violation: ${tool}` };
      const shown = typeof args === "string" ? args : JSON.stringify(args);
      return { ...base, kind: "tool", text: `${tool} ${shown.slice(0, 200)}` };
    }
    case "tool_execution_end": {
      if (typeof f.toolName !== "string") return null;
      const callId = typeof f.toolCallId === "string" ? f.toolCallId : undefined;
      const start = callId ? starts.get(callId) : undefined;
      const tool = start?.tool ?? canonicalToolName(f.toolName);
      // A successful qa_* call is already on the feed as a `check` line; a rejected one must stay visible.
      if (PROGRESS_TOOL_NAMES.includes(tool) && f.isError !== true) return null;
      const ok = f.isError !== true;
      const durationMs = start ? Math.max(0, Date.parse(ts) - start.ts) : undefined;
      const detail = ok ? "" : `: ${resultText(f.result).slice(0, 200)}`;
      const took = durationMs === undefined ? "" : ` (${formatDuration(durationMs)})`;
      return { ts, seq, kind: "tool_end", text: `${tool} ${ok ? "ok" : "failed"}${took}${detail}`, callId, tool, ok, durationMs };
    }
    case "message_end": {
      const msg = f.message as { role?: string; content?: unknown } | undefined;
      if (msg?.role !== "assistant" || !Array.isArray(msg.content)) return null;
      const text = msg.content
        .filter((c): c is { type: "text"; text: string } => c?.type === "text" && typeof c.text === "string")
        .map((c) => c.text)
        .join("\n")
        .trim();
      return text ? { ts, seq, kind: "say", text: text.slice(0, 500) } : null;
    }
    case "auto_retry_start":
      return { ts, seq, kind: "warn", text: `auto retry: ${JSON.stringify(frame).slice(0, 300)}` };
    default:
      return null;
  }
}
