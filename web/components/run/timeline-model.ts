import type { Activity, CheckStatus } from "@/lib/api";
import { humaniseTool, parseArgs, splitToolText, type HumanisedTool } from "./humanise";

/**
 * Pure model behind the run timeline: pairs `tool`/`tool_end`, groups the stream into per-check sections and
 * implements the toolbar filters. Keeps old persisted runs (no `callId`/`checkId`, host tools logged as plain
 * tool lines) working by synthesising `check` milestones from the `qa_*` tool calls.
 */

export type ToolRow = {
  type: "tool";
  key: string;
  ts: string;
  tool: string;
  human: HumanisedTool;
  args: unknown;
  start: Activity | null;
  end: Activity | null;
};
export type TimelineRow =
  | ToolRow
  | { type: "say"; key: string; ts: string; a: Activity }
  | { type: "milestone"; key: string; ts: string; a: Activity }
  | { type: "note"; key: string; ts: string; a: Activity };

/** `check`: opened by `qa_check(running)`. `setup`: before the first check. `between`: after a check resolved. */
export interface TimelineSection {
  key: string;
  kind: "check" | "setup" | "between";
  checkId: string | null;
  startTs: string;
  endTs: string;
  rows: TimelineRow[];
}

export type TimelineFilter = "all" | "agent" | "device" | "shell" | "checks" | "problems" | "errors" | "warnings";

export const TERMINAL_CHECK_STATUSES: readonly CheckStatus[] = ["pass", "fail", "blocked", "skipped"];
const HOST_TOOLS: Record<string, true> = { qa_plan: true, qa_check: true, qa_finish: true };
const CHECK_STATUSES: readonly string[] = ["pending", "running", "pass", "fail", "blocked", "skipped"];

function isCheckStatus(v: unknown): v is CheckStatus {
  return typeof v === "string" && CHECK_STATUSES.includes(v);
}

/** Resolved tool name + args of a `tool` activity, falling back to the legacy `"<tool> <json>"` text. */
function toolOf(a: Activity): { tool: string; args: unknown } {
  if (a.tool) return { tool: a.tool, args: a.args };
  const legacy = splitToolText(a.text);
  return { tool: legacy.tool, args: a.args ?? legacy.args };
}

/** Converts a legacy `qa_*` tool line into the `check` activity newer runs record. */
function legacyCheck(a: Activity): Activity | null {
  const { tool, args } = toolOf(a);
  if (!Object.hasOwn(HOST_TOOLS, tool)) return null;
  const parsed = parseArgs(args);
  if (tool === "qa_plan") {
    const n = Array.isArray(parsed.checks) ? parsed.checks.length : null;
    return { ...a, kind: "check", text: n !== null ? `Test plan: ${n} checks` : "Test plan" };
  }
  if (tool === "qa_check") {
    const id = typeof parsed.id === "string" ? parsed.id : undefined;
    const status = isCheckStatus(parsed.status) ? parsed.status : undefined;
    return { ...a, kind: "check", checkId: id, checkStatus: status, text: `${id ?? "?"} → ${status ?? "?"}` };
  }
  const verdict = typeof parsed.verdict === "string" ? parsed.verdict : "";
  return { ...a, kind: "check", text: verdict ? `Finished: ${verdict}` : "Finished" };
}

export function buildTimeline(items: readonly Activity[]): TimelineSection[] {
  const hasCheckActivity = items.some((a) => a.kind === "check");
  const sections: TimelineSection[] = [];
  // Held in an object: TS does not see assignments made inside the closures below on a plain `let`.
  const state: { current: TimelineSection | null; closed: boolean } = { current: null, closed: false };
  const openTools = new Map<string, ToolRow>();

  function open(kind: TimelineSection["kind"], checkId: string | null, ts: string, key: string): TimelineSection {
    const section: TimelineSection = { key, kind, checkId, startTs: ts, endTs: ts, rows: [] };
    sections.push(section);
    state.current = section;
    state.closed = false;
    return section;
  }

  function push(row: TimelineRow, ts: string, ctx: { afterCheck: boolean }): void {
    let target = state.current;
    if (!target) target = open("setup", null, ts, `s${row.key}`);
    else if (state.closed && !ctx.afterCheck) target = open("between", null, ts, `s${row.key}`);
    target.rows.push(row);
    target.endTs = ts;
  }

  for (const original of items) {
    let a = original;
    if (a.kind === "tool" || a.kind === "tool_end") {
      const { tool } = toolOf(a);
      if (Object.hasOwn(HOST_TOOLS, tool)) {
        // Newer runs log host calls as `check` activities; anything else here would be a duplicate.
        if (hasCheckActivity || a.kind === "tool_end") continue;
        const converted = legacyCheck(a);
        if (!converted) continue;
        a = converted;
      }
    }

    if (a.kind === "check") {
      if (a.checkStatus === "running" && a.checkId) {
        open("check", a.checkId, a.ts, `c${a.seq}`);
      }
      push({ type: "milestone", key: `m${a.seq}`, ts: a.ts, a }, a.ts, { afterCheck: Boolean(a.checkId) });
      if (a.checkId && a.checkStatus && TERMINAL_CHECK_STATUSES.includes(a.checkStatus)) {
        const section = state.current;
        if (section?.kind === "check" && section.checkId === a.checkId) state.closed = true;
      }
      continue;
    }

    if (a.kind === "tool") {
      const { tool, args } = toolOf(a);
      const row: ToolRow = {
        type: "tool",
        key: `t${a.seq}`,
        ts: a.ts,
        tool,
        human: humaniseTool(tool, args),
        args,
        start: a,
        end: null,
      };
      if (a.callId) openTools.set(a.callId, row);
      push(row, a.ts, { afterCheck: false });
      continue;
    }

    if (a.kind === "tool_end") {
      const paired = a.callId ? openTools.get(a.callId) : undefined;
      if (paired) {
        paired.end = a;
        if (state.current) state.current.endTs = a.ts;
        continue;
      }
      // Its start lives on an earlier, not yet loaded page.
      const { tool, args } = toolOf(a);
      const row: ToolRow = {
        type: "tool",
        key: `t${a.seq}`,
        ts: a.ts,
        tool,
        human: humaniseTool(tool, args),
        args,
        start: null,
        end: a,
      };
      push(row, a.ts, { afterCheck: false });
      continue;
    }

    const type = a.kind === "say" ? "say" : "note";
    push({ type, key: `n${a.seq}`, ts: a.ts, a }, a.ts, { afterCheck: false });
  }
  return sections;
}

function rowSearchText(row: TimelineRow): string {
  if (row.type !== "tool") return row.a.text.toLowerCase();
  const args = typeof row.args === "string" ? row.args : row.args === undefined ? "" : JSON.stringify(row.args);
  return `${row.human.label} ${row.tool} ${args} ${row.end?.text ?? ""}`.toLowerCase();
}

export function isToolError(row: TimelineRow): boolean {
  return row.type === "tool" && row.end?.ok === false;
}

function matchesFilter(row: TimelineRow, filter: TimelineFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "agent":
      return row.type === "say" || (row.type === "note" && row.a.kind === "user");
    case "device":
      return row.type === "tool" && row.human.family === "device";
    case "shell":
      return row.type === "tool" && row.human.family !== "device";
    case "checks":
      return row.type === "milestone";
    case "errors":
      return isToolError(row) || (row.type === "note" && row.a.kind === "error");
    case "warnings":
      return row.type === "note" && row.a.kind === "warn";
    case "problems":
      return isToolError(row) || (row.type === "note" && (row.a.kind === "warn" || row.a.kind === "error"));
  }
}

/** Drops non-matching rows and sections left empty by the filter (a plain unfiltered view keeps empty sections). */
export function filterTimeline(
  sections: readonly TimelineSection[],
  filter: TimelineFilter,
  query: string,
): TimelineSection[] {
  const q = query.trim().toLowerCase();
  if (filter === "all" && q === "") return [...sections];
  const out: TimelineSection[] = [];
  for (const s of sections) {
    const rows = s.rows.filter((r) => matchesFilter(r, filter) && (q === "" || rowSearchText(r).includes(q)));
    if (rows.length > 0) out.push({ ...s, rows });
  }
  return out;
}

export function countProblems(sections: readonly TimelineSection[]): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const s of sections) {
    for (const r of s.rows) {
      if (matchesFilter(r, "errors")) errors++;
      else if (matchesFilter(r, "warnings")) warnings++;
    }
  }
  return { errors, warnings };
}

/** `+12:04` / `+1:02:09` offset of `ts` from `startTs`; empty string when either is not a valid date. */
export function formatOffset(ts: string, startTs: string): string {
  const ms = Date.parse(ts) - Date.parse(startTs);
  if (Number.isNaN(ms)) return "";
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `+${h}:${String(m).padStart(2, "0")}:${s}` : `+${m}:${s}`;
}
