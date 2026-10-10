import { readFileSync } from "node:fs";
import { ARTEMIS_SERVER, HARNESS_IDS, type HarnessId, MOBILE_MCP_SERVER, PROGRESS_SERVER } from "../harness/types";
import { screenshotsDir } from "./artefacts";
import type { Backend, Run } from "./types";

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

/** Backend rules and driving guidance, naming the tools exactly as this harness mounted them for this run. */
function backendRules(backend: Backend, toolName: ToolNamer): string {
  const mobile = (tool: string) => toolName(MOBILE_MCP_SERVER, tool);
  const artemis = (tool: string) => toolName(ARTEMIS_SERVER, tool);
  if (backend === "artemis") {
    const direct = ["mobile_click", "mobile_swipe", "mobile_input_text", "mobile_press_key", "mobile_long_press", "mobile_get_device_state", "mobile_manage_app"];
    return `Driver backend: Artemis direct tools. Use ${direct.map(artemis).join(", ")} (package names only) plus adb. NEVER call any ${mobile("")}* tool and NEVER call ${artemis("mobile_run_task")}.`;
  }
  return `Driver backend: mobile-mcp. Use the ${mobile("")}* tools plus adb/simctl. NEVER call any ${artemis("")}* tool.
mobile-mcp: call ${mobile("mobile_list_elements_on_screen")} once per screen and tap by its @ref; re-list only after navigation or a visible change.
Group known sequences (tap, type, tap) in ${mobile("mobile_batch_commands")}. Use ${mobile("mobile_take_screenshot")} only for what the element list cannot show.`;
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

${deviceLine(run)}
App package: ${run.packageId}. Use the build that is already installed unless the brief says otherwise.
Run id: ${runId}.
Time budget: ${opts.runMaxTime}. If you are running out of time, stop testing, write the report with what you have and call ${finish}.
${sourceBlock(run)}${backendRules(run.backend, toolName)}

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

/** Canonical `mcp__mobile_mcp_*` names (adapters strip plugin namespaces, so user-config and Tapocalypse-provisioned servers look alike). */
const MOBILE_MCP_TOOL = /^mcp__mobile_mcp_/;

/** True when `tool` (canonical name) breaks the run's backend rule or reaches Tapocalypse's own MCP server. */
export function backendViolation(tool: string, backend: Backend): boolean {
  if (tool.startsWith("mcp__tapocalypse_")) return true;
  if (backend === "mobile-mcp") return tool.startsWith("mcp__artemis_");
  return MOBILE_MCP_TOOL.test(tool) || tool === "mcp__artemis_mobile_run_task";
}
