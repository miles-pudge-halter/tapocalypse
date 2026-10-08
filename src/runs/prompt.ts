import { readFileSync } from "node:fs";
import type { ToolPrefixes } from "../omp/provision";
import type { Project } from "../projects/registry";
import type { Activity, Backend, CheckStatus, Run } from "./types";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export interface Persona {
  body: string;
  model: string | null;
  thinking: string | null;
}

/** Splits a trailing `:<thinking level>` off a model id (`anthropic/claude-opus-5-5:high`); other colons stay in the model. */
export function splitThinking(raw: string): { model: string; thinking: string | null } {
  const idx = raw.lastIndexOf(":");
  const suffix = idx >= 0 ? raw.slice(idx + 1) : "";
  if (THINKING_LEVELS.includes(suffix)) return { model: raw.slice(0, idx), thinking: suffix };
  return { model: raw, thinking: null };
}

/** Parses a persona file: optional frontmatter `model:` (optionally `:<thinking>` suffixed) + body. */
export function parsePersona(text: string): Persona {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { body: text, model: null, thinking: null };
  const body = text.slice(m[0].length);
  const modelLine = m[1]!.split(/\r?\n/).find((l) => /^model:\s*/.test(l));
  const raw = modelLine?.replace(/^model:\s*/, "").trim().replace(/^["']|["']$/g, "");
  if (!raw) return { body, model: null, thinking: null };
  return { body, ...splitThinking(raw) };
}

export function loadPersona(file: string): Persona {
  return parsePersona(readFileSync(file, "utf8"));
}

export const hostTools = [
  {
    name: "qa_plan",
    label: "QA plan",
    description: "Declare every check you will execute, before the first device action.",
    parameters: {
      type: "object",
      properties: {
        checks: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: { id: { type: "string" }, title: { type: "string" } },
            required: ["id", "title"],
            additionalProperties: false,
          },
        },
      },
      required: ["checks"],
      additionalProperties: false,
    },
    loadMode: "essential",
  },
  {
    name: "qa_check",
    label: "QA check",
    description: "Report a check's status as it changes; attach the screenshot that proves it.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        status: { type: "string", enum: ["running", "pass", "fail", "blocked", "skipped"] },
        note: { type: "string" },
        screenshot: { type: "string", description: "Path relative to the repo root." },
      },
      required: ["id", "status"],
      additionalProperties: false,
    },
    loadMode: "essential",
  },
  {
    name: "qa_finish",
    label: "QA finish",
    description: "Call exactly once, after the report file is written.",
    parameters: {
      type: "object",
      properties: {
        verdict: { type: "string", enum: ["PASS", "FAIL", "PASS WITH ISSUES", "BLOCKED", "PARTIAL"] },
        summary: { type: "string" },
        reportPath: { type: "string", description: "Path relative to the repo root." },
      },
      required: ["verdict", "summary", "reportPath"],
      additionalProperties: false,
    },
    loadMode: "essential",
  },
];

/** Backend rules and driving guidance, naming the tool prefixes omp actually mounted for this run. */
function backendRules(backend: Backend, prefixes: ToolPrefixes): string {
  const mobile = prefixes.mobileMcp ?? "mcp__mobile_mcp_";
  const artemis = prefixes.artemis ?? "mcp__artemis_";
  if (backend === "artemis") {
    return `Driver backend: Artemis direct tools. Use ${artemis}mobile_click/swipe/input_text/press_key/long_press/get_device_state/manage_app (package names only) plus adb. NEVER call any ${mobile}* tool and NEVER call ${artemis}mobile_run_task.`;
  }
  return `Driver backend: mobile-mcp. Use the ${mobile}* tools plus adb/simctl. NEVER call any ${artemis}* tool.
mobile-mcp: call mobile_list_elements_on_screen once per screen and tap by its @ref; re-list only after navigation or a visible change.
Group known sequences (tap, type, tap) in mobile_batch_commands. Use mobile_take_screenshot only for what the element list cannot show.`;
}

function deviceLine(run: Run): string {
  const target = `Target device: ${run.deviceSerial} (${run.deviceRequest.platform})`;
  const rules = "NEVER touch, boot, shut down or reconfigure any other device, NEVER run `adb kill-server`, and do not boot your own emulator — this device was assigned to you.";
  if (run.backend === "artemis") return `${target}. Pass it explicitly to every adb / device tool call. ${rules}`;
  const id = run.deviceLabel ?? run.deviceSerial;
  return `${target}; mobile-mcp device id: "${id}". Use the serial for every adb / simctl call and the device id as the device argument of every mobile-mcp tool (never the adb serial for an emulator). ${rules}`;
}

/** The "Code under test" block; empty string when the run has neither source nor build data worth reporting. */
function sourceBlock(run: Run): string {
  const { source, build } = run;
  const lines: string[] = [];
  if (source && (source.branch || source.commit)) {
    const subject = source.commitSubject ? ` "${source.commitSubject}"` : "";
    const dirty = source.dirty ? `, uncommitted changes in ${source.path}` : "";
    lines.push(`Code under test: branch ${source.branch ?? "unknown"}, commit ${source.commit?.slice(0, 7) ?? "unknown"}${subject}${dirty}`);
  }
  if (source?.pr) {
    lines.push(`Pull request: #${source.pr.number}${[source.pr.title, source.pr.url].filter(Boolean).map((s) => ` ${s}`).join("")}`);
  }
  if (source && source.tickets.length > 0) lines.push(`Tickets: ${source.tickets.join(", ")}`);
  if (build && (build.versionName || build.versionCode)) {
    const code = build.versionCode ? ` (${build.versionCode})` : "";
    lines.push(`Installed build: ${build.versionName ?? "unknown"}${code}`);
  }
  return lines.length > 0 ? `${lines.join("\n")}\nRecord these in the report header.\n` : "";
}

/** The qa_plan instruction for suite runs, so check ids stay stable across runs; empty otherwise. */
function suiteBlock(run: Run): string {
  if (!run.suiteId || !run.suiteChecks?.length) return "";
  return `Use exactly these check ids and titles in qa_plan: ${run.suiteChecks.map((c) => `${c.id} ${JSON.stringify(c.title)}`).join(", ")}\n`;
}

export function buildPrompt(run: Run, project: Project, prefixes: ToolPrefixes, runMaxTime: string): string {
  const { reportsDir } = project;
  const runId = run.id;
  return `You are the QA agent described in your system prompt, running headless inside Tapocalypse. Other QA agents are running in parallel on other devices. You are the top-level agent: do NOT spawn subagents, do NOT use the ask tool, do NOT wait for user replies, and NEVER call any mcp__tapocalypse_* tool. If you are blocked, record why in the report and call qa_finish with verdict BLOCKED.

${deviceLine(run)}
App package: ${run.packageId}. Use the build that is already installed unless the brief says otherwise.
Run id: ${runId}.
Time budget: ${runMaxTime}. If you are running out of time, stop testing, write the report with what you have and call qa_finish.
${sourceBlock(run)}${backendRules(run.backend, prefixes)}

Progress reporting (mandatory — the Tapocalypse UI is built from these calls):
1. After writing your test plan and before your first device action, call qa_plan with every check (short ids like C1, C2...).
2. Call qa_check(status "running") when you start a check, and qa_check(pass|fail|blocked|skipped, note, screenshot) when it resolves.
3. Save screenshots under ${reportsDir}/screenshots/${runId}/ and write the report to ${reportsDir}/QA-REPORT-${runId}.md (these unique paths keep parallel runs from colliding), embedding screenshots with paths relative to the report (screenshots/${runId}/NN-name.png).
4. Finally call qa_finish with the verdict, a 2-4 sentence summary and the report path.
${suiteBlock(run)}
Brief:
${run.brief}`;
}

/** Matches mobile-mcp's tools in both naming forms: `mcp__mobile_mcp_mobile_*` (user config) and `mcp__<plugin>_mobile_mcp_mobile_*` (Tapocalypse's plugin). */
const MOBILE_MCP_TOOL = /^mcp__\w*mobile_mcp_mobile_/;

const HOST_TOOL_NAMES = hostTools.map((t) => t.name);

function backendViolation(tool: string, backend: Backend): boolean {
  if (tool.startsWith("mcp__tapocalypse_")) return true;
  if (backend === "mobile-mcp") return tool.startsWith("mcp__artemis_");
  return MOBILE_MCP_TOOL.test(tool) || tool === "mcp__artemis_mobile_run_task";
}

/** Tool calls awaiting their `tool_execution_end`: lets the end line name the resolved tool and time the call. */
export type ToolStarts = Map<string, { ts: number; tool: string }>;

const ARGS_LIMIT = 2048;
const CHECK_STATUSES: readonly CheckStatus[] = ["pending", "running", "pass", "fail", "blocked", "skipped"];

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
function resultText(result: unknown): string {
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

/** Feed line for a host tool call (qa_plan / qa_check / qa_finish); null when its arguments are malformed. */
function hostToolActivity(tool: string, args: Record<string, unknown>): Pick<Activity, "text" | "checkId" | "checkStatus"> | null {
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
 * Maps an omp frame (live or replayed from events.jsonl) to a feed line; `seq` is the frame's 0-based line index in
 * events.jsonl. Pass the same `starts` map across a session so `tool_end` lines resolve their tool and duration.
 */
export function frameToActivity(frame: unknown, backend: Backend, seq: number, starts?: ToolStarts): Activity | null {
  if (!frame || typeof frame !== "object") return null;
  const f = frame as Record<string, unknown>;
  const ts = typeof f._ts === "string" ? f._ts : new Date().toISOString();
  switch (f.type) {
    case "_activity":
      return { ts, seq, kind: f.kind as Activity["kind"], text: String(f.text) };
    case "tool_execution_start": {
      if (typeof f.toolName !== "string") return { ts, seq, kind: "tool", text: JSON.stringify(frame).slice(0, 300) };
      // omp mounts MCP tools as xd:// devices: a `write xd://mcp__x` is the actual call of tool `mcp__x`
      // (a `read` of it only fetches its docs). Attribute the call to the MCP tool.
      const args = (f.args ?? {}) as Record<string, unknown>;
      const xdTool = typeof args.path === "string" && args.path.startsWith("xd://") ? args.path.slice(5) : null;
      const [tool, detail] =
        f.toolName === "write" && xdTool ? [xdTool, args.content ?? {}] : [f.toolName, args];
      const callId = typeof f.toolCallId === "string" ? f.toolCallId : undefined;
      if (callId) starts?.set(callId, { ts: Date.parse(ts), tool });
      let parsedDetail = detail;
      if (typeof detail === "string") {
        try {
          parsedDetail = JSON.parse(detail);
        } catch {}
      }
      const base = { ts, seq, callId, tool, args: truncateArgs(parsedDetail) };
      if (backendViolation(tool, backend)) return { ...base, kind: "warn", text: `backend violation: ${tool}` };
      const host = hostToolActivity(tool, args);
      if (host) return { ...base, kind: "check", ...host };
      const shown = typeof detail === "string" ? detail : JSON.stringify(detail);
      return { ...base, kind: "tool", text: `${tool} ${shown.slice(0, 200)}` };
    }
    case "tool_execution_end": {
      if (typeof f.toolName !== "string") return null;
      const callId = typeof f.toolCallId === "string" ? f.toolCallId : undefined;
      const start = callId ? starts?.get(callId) : undefined;
      const tool = start?.tool ?? f.toolName;
      // A successful qa_* call already has its "check" line from the start frame; a rejected one must stay visible.
      if (HOST_TOOL_NAMES.includes(tool) && f.isError !== true) return null;
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
