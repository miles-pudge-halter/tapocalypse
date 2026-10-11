import { readFileSync } from "node:fs";
import { HARNESS_IDS, type HarnessId, PROGRESS_SERVER } from "../harness/types";
import { screenshotsDir } from "./artefacts";
import type { Run } from "./types";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export interface Persona {
  body: string;
  model: string | null;
  thinking: string | null;
  /** Harness the persona's `model:` is written for; null = unspecified (counts as omp). */
  harness: HarnessId | null;
}

/** Splits a trailing `:<thinking level>` off a model id (`anthropic/claude-opus-5-5:high`); other colons stay in the model. */
export function splitThinking(raw: string): { model: string; thinking: string | null } {
  const idx = raw.lastIndexOf(":");
  const suffix = idx >= 0 ? raw.slice(idx + 1) : "";
  if (THINKING_LEVELS.includes(suffix)) return { model: raw.slice(0, idx), thinking: suffix };
  return { model: raw, thinking: null };
}

/** Parses a persona file: optional frontmatter `harness:` and `model:` (optionally `:<thinking>` suffixed) + body. */
export function parsePersona(text: string): Persona {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { body: text, model: null, thinking: null, harness: null };
  const body = text.slice(m[0].length);
  const lines = m[1]!.split(/\r?\n/);
  const value = (key: string): string | undefined =>
    lines.find((l) => l.startsWith(`${key}:`))?.slice(key.length + 1).trim().replace(/^["']|["']$/g, "") || undefined;
  const harnessText = value("harness")?.toLowerCase();
  const harness = HARNESS_IDS.find((id) => id === harnessText) ?? null;
  const raw = value("model");
  if (!raw) return { body, model: null, thinking: null, harness };
  return { body, ...splitThinking(raw), harness };
}

export function loadPersona(file: string): Persona {
  return parsePersona(readFileSync(file, "utf8"));
}

/** The callable name the harness gives `tool` of the MCP server `server` (see `HarnessSession.toolName`). */
export type ToolNamer = (server: string, tool: string) => string;

/** Driving guidance, naming the mobile tools exactly as this harness mounted them for this run (they come from the run's own `tpc` server). */
function driverRules(toolName: ToolNamer): string {
  const mobile = (tool: string) => toolName(PROGRESS_SERVER, tool);
  return `Driver: the ${mobile("")}* tools plus adb/simctl.
Call ${mobile("mobile_list_elements_on_screen")} once per screen and tap by its @ref; re-list only after navigation or a visible change.
Group known sequences (tap, type, tap) in ${mobile("mobile_batch_commands")}. Use ${mobile("mobile_take_screenshot")} only for what the element list cannot show.`;
}

function deviceLine(run: Run, toolName: ToolNamer): string {
  const target = `Target device: ${run.deviceSerial} (${run.deviceRequest.platform})`;
  const label = run.deviceName ? `${run.deviceName} (${run.deviceSerial})` : run.deviceSerial;
  // The exact prefix matters: an agent whose harness also mounts a mobile-mcp of its own sees two `mobile_*` sets.
  const prefix = toolName(PROGRESS_SERVER, "mobile_");
  const only = prefix === "mobile_" ? "" : " Use ONLY those: any other mobile_* tool (for example one named mcp__mobile_mcp_mobile_…) belongs to a different server and must not be called.";
  const bound = `The ${prefix}* tools are already bound to your device ${label}; call them without a device argument.${only} Use ${run.deviceSerial} for every adb / simctl call. NEVER mount or call another mobile-mcp server.`;
  const rules = "NEVER touch, boot, shut down or reconfigure any other device, NEVER run `adb kill-server`, and do not boot your own emulator — this device was assigned to you.";
  return `${target}. ${bound} ${rules}`;
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
function suiteBlock(run: Run, planTool: string): string {
  if (!run.suiteId || !run.suiteChecks?.length) return "";
  return `Use exactly these check ids and titles in ${planTool}: ${run.suiteChecks.map((c) => `${c.id} ${JSON.stringify(c.title)}`).join(", ")}\n`;
}

export interface PromptOptions {
  /** The run's time budget as configured (`runMaxTime`). */
  runMaxTime: string;
  /** Persona body to put in front of the prompt, for harnesses that cannot append a system prompt; omit to leave it out. */
  prependPersona?: string | null;
}

export function buildPrompt(run: Run, toolName: ToolNamer, opts: PromptOptions): string {
  const runId = run.id;
  const shots = screenshotsDir(runId);
  const plan = toolName(PROGRESS_SERVER, "qa_plan");
  const check = toolName(PROGRESS_SERVER, "qa_check");
  const finish = toolName(PROGRESS_SERVER, "qa_finish");
  const persona = opts.prependPersona ? `Your system instructions (follow them for the whole session):\n${opts.prependPersona.trim()}\n\n---\n\n` : "";
  return `${persona}You are the QA agent described in your system instructions, running headless inside Tapocalypse. Other QA agents are running in parallel on other devices. You are the top-level agent: do NOT spawn subagents, do NOT ask the user questions or wait for replies, and NEVER call a tool of any MCP server named "tapocalypse". If you are blocked, record why in the report and call ${finish} with verdict BLOCKED.

${deviceLine(run, toolName)}
App package: ${run.packageId}. Use the build that is already installed unless the brief says otherwise.
Run id: ${runId}.
Time budget: ${opts.runMaxTime}. If you are running out of time, stop testing, write the report with what you have and call ${finish}.
${sourceBlock(run)}${driverRules(toolName)}

Progress reporting (mandatory — the Tapocalypse UI is built from these calls):
1. After writing your test plan and before your first device action, call ${plan} with every check (short ids like C1, C2...).
2. Call ${check}(status "running") when you start a check, and ${check}(pass|fail|blocked|skipped, note, screenshot) when it resolves.
3. Screenshot directory: ${shots}
   Save every screenshot there, e.g. ${shots}/01-launch.png (Android: \`adb -s <serial> exec-out screencap -p > ${shots}/01-launch.png\`; iOS: \`xcrun simctl io <udid> screenshot ${shots}/01-launch.png\`). Never write into the repository: it is the app under test. Tapocalypse stores your screenshots and report itself, and ${check} tells you the stored name (screenshots/<name>) of the screenshot you attach.
4. Finally call ${finish} with the verdict, a 2-4 sentence summary and the whole report as reportMarkdown (do not write a report file). Embed screenshots in it as ![alt](screenshots/<name>), using the stored names.
${suiteBlock(run, plan)}
Brief:
${run.brief}`;
}

/**
 * True when `tool` reaches something a run's agent must never use: Tapocalypse's own run-management MCP server, or (on a `gated`
 * run only) a mobile-mcp server it mounted itself: a gated run gets its device tools from the run's `tpc` server, pinned to the
 * assigned device. Runs from before the gateway mounted mobile-mcp themselves, so their `mobile_mcp` calls are legitimate.
 * Pass the name as the agent's harness reported it, before the adapter maps tpc's `mobile_*` tools to their canonical
 * `mcp__mobile_mcp_mobile_*` form: only a tool that did not come through `tpc` still carries a `mobile_mcp` server name.
 */
export function backendViolation(tool: string, gated: boolean): boolean {
  return tool.startsWith("mcp__tapocalypse_") || (gated && (tool.startsWith("mcp__mobile_mcp_") || tool.startsWith("mcp__mobile-mcp_")));
}
