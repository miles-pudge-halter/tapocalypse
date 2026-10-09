/**
 * Turns a raw tool call (name + JSON args as recorded in the activity feed) into a one-line description a
 * human can scan: `Tap @e23`, `Swipe up`, `Type "hello"`, `$ adb -s emulator-5556 shell wm size`.
 * Pure: no DOM, no React. `args` may be an object, a JSON string (xd:// MCP calls carry their payload as a
 * string) or a string truncated mid-JSON by the 2 KB activity cap — all three are handled.
 */

export type ToolFamily = "device" | "shell" | "code" | "file" | "check" | "other";

export interface HumanisedTool {
  family: ToolFamily;
  /** Single line, already clipped to `LABEL_MAX` chars. */
  label: string;
}

export const LABEL_MAX = 160;

type ArgRecord = Record<string, unknown>;

export function isRecord(v: unknown): v is ArgRecord {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Pulls `"key": value` pairs out of a (possibly truncated) JSON object string. */
function scanPairs(raw: string): ArgRecord {
  const out: ArgRecord = {};
  const pair = /"([\w.-]+)"\s*:\s*(-?\d+(?:\.\d+)?|true|false|null|"(?:[^"\\]|\\.)*")/g;
  for (const m of raw.matchAll(pair)) {
    const key = m[1];
    const value = m[2];
    if (key === undefined || value === undefined || key in out) continue;
    try {
      out[key] = JSON.parse(value);
    } catch {
      // unparseable literal (bad escape): skip it
    }
  }
  return out;
}

/** Normalises whatever the feed stored for `args` into a plain record (empty when nothing usable). */
export function parseArgs(args: unknown): ArgRecord {
  let value = args;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed.startsWith("{")) return {};
    try {
      value = JSON.parse(trimmed);
    } catch {
      return scanPairs(trimmed);
    }
  }
  if (!isRecord(value)) return {};
  return value;
}

export function clip(text: string, max = LABEL_MAX): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function str(a: ArgRecord, key: string): string | null {
  const v = a[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function num(a: ArgRecord, key: string): number | null {
  const v = a[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** `qa/screenshots/run-x/01-plan.png` → `…/run-x/01-plan.png` when long. */
export function shortPath(p: string, max = 64): string {
  if (p.length <= max) return p;
  const parts = p.split("/").filter(Boolean);
  return `…/${parts.slice(-2).join("/")}`;
}

function point(a: ArgRecord): string | null {
  const x = num(a, "x");
  const y = num(a, "y");
  return x !== null && y !== null ? `(${Math.round(x)}, ${Math.round(y)})` : null;
}

function target(a: ArgRecord): string | null {
  const ref = str(a, "ref");
  if (ref) return ref;
  const p = point(a);
  if (p) return p;
  const index = num(a, "target");
  return index !== null ? `element #${index}` : null;
}

function withTarget(verb: string, a: ArgRecord): string {
  const t = target(a);
  return t ? `${verb} ${t}` : verb;
}

function prettify(snake: string): string {
  const words = snake.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** `mobile_click_on_screen_at_coordinates` and `click` style actions of mobile-mcp / Artemis. */
function deviceAction(action: string, a: ArgRecord): string {
  switch (action) {
    case "click_on_screen_at_coordinates":
    case "click":
      return withTarget("Tap", a);
    case "double_tap_on_screen":
      return withTarget("Double-tap", a);
    case "long_press_on_screen_at_coordinates":
    case "long_press":
      return withTarget("Long-press", a);
    case "swipe_on_screen":
    case "swipe": {
      const dir = str(a, "direction");
      const from = point(a);
      const base = dir ? `Swipe ${dir}` : "Swipe";
      return from ? `${base} from ${from}` : base;
    }
    case "type_keys":
    case "input_text": {
      const text = str(a, "text");
      const submit = a.submit === true ? " ⏎" : "";
      return text !== null ? `Type "${clip(text, 80)}"${submit}` : "Type text";
    }
    case "press_button":
    case "press_key": {
      const key = str(a, "button") ?? str(a, "key");
      return key ? `Press ${key}` : "Press key";
    }
    case "take_screenshot":
      return "Take screenshot";
    case "save_screenshot": {
      const to = str(a, "saveTo");
      return to ? `Save screenshot → ${(to.split("/").filter(Boolean).pop() ?? to)}` : "Save screenshot";
    }
    case "list_elements_on_screen":
      return "List screen elements";
    case "get_device_state":
      return "Read device state";
    case "launch_app":
      return `Launch app${str(a, "packageName") ? ` ${str(a, "packageName")}` : ""}`;
    case "terminate_app":
      return `Stop app${str(a, "packageName") ? ` ${str(a, "packageName")}` : ""}`;
    case "install_app":
      return "Install app";
    case "uninstall_app":
      return `Uninstall app${str(a, "bundle_id") ? ` ${str(a, "bundle_id")}` : ""}`;
    case "list_apps":
      return "List installed apps";
    case "open_url": {
      const url = str(a, "url");
      return url ? `Open ${clip(url, 80)}` : "Open URL";
    }
    case "list_available_devices":
      return "List devices";
    case "get_foreground_app":
      return "Check foreground app";
    case "get_screen_size":
      return "Read screen size";
    case "get_orientation":
      return "Read orientation";
    case "set_orientation":
      return `Rotate screen${str(a, "orientation") ? ` to ${str(a, "orientation")}` : ""}`;
    case "get_device_logs":
      return "Read device logs";
    case "wait_for_delay": {
      const ms = num(a, "duration_ms") ?? num(a, "ms") ?? num(a, "delay_ms");
      return ms !== null ? `Wait ${ms >= 1000 ? `${+(ms / 1000).toFixed(1)}s` : `${ms}ms`}` : "Wait";
    }
    case "manage_app": {
      const verb = str(a, "action");
      const app = str(a, "app_name");
      return `${verb ? prettify(verb) : "Manage"} app${app ? ` ${app}` : ""}`;
    }
    case "batch_commands":
      return batchLabel(a);
    default:
      return prettify(action);
  }
}

function batchLabel(a: ArgRecord): string {
  const raw = Array.isArray(a.commands) ? a.commands : Array.isArray(a.steps) ? a.steps : [];
  const parts: string[] = [];
  for (const step of raw) {
    if (!isRecord(step)) continue;
    const name = str(step, "tool") ?? str(step, "name");
    if (!name) continue;
    const action = name.replace(/^mobile_/, "");
    parts.push(deviceAction(action, parseArgs(step.args ?? step.arguments)).toLowerCase());
  }
  if (parts.length === 0) return "Batch of device actions";
  return `Batch of ${parts.length}: ${parts.join(" → ")}`;
}

const MOBILE_MCP = /^mcp__(?:\w*?_)?mobile_mcp_mobile_(\w+)$/;
const ARTEMIS = /^mcp__artemis_mobile_(\w+)$/;

/** `ADB=$(command -v adb || …);` / `A=~/…/platform-tools/adb;` — a variable that only names the adb binary. */
const SHELL_ADB_ASSIGN = /^(\w+)=(?:\$\([^)]*\)|[^\s;]+);\s*/;
/** `perl -e 'alarm 10; exec @ARGV'` timeout wrapper agents put in front of adb. */
const SHELL_ALARM_WRAPPER = /perl -e 'alarm \d+; exec @ARGV'\s+/g;

function shellLabel(command: string): string {
  let cleaned = command;
  const assign = SHELL_ADB_ASSIGN.exec(cleaned);
  if (assign?.[1] && /adb/.test(assign[0])) {
    const name = assign[1];
    cleaned = cleaned.slice(assign[0].length).replace(new RegExp(`\\$\\{?${name}\\}?`, "g"), "adb");
  }
  cleaned = cleaned.replace(SHELL_ALARM_WRAPPER, "");
  return `$ ${clip(cleaned, LABEL_MAX - 2)}`;
}

/** First `[path#TAG]` header of a hashline `edit` input. */
function editTarget(a: ArgRecord): string | null {
  const input = str(a, "input");
  const m = input ? /^\[([^\]#]+)#/m.exec(input) : null;
  return m?.[1] ?? str(a, "path");
}

function checkLabel(tool: string, a: ArgRecord): string {
  if (tool === "qa_plan") {
    const checks = Array.isArray(a.checks) ? a.checks.length : null;
    return checks !== null ? `Declare test plan (${checks} checks)` : "Declare test plan";
  }
  if (tool === "qa_check") {
    const id = str(a, "id") ?? "?";
    const status = str(a, "status");
    return status ? `Report ${id} → ${status}` : `Report ${id}`;
  }
  const verdict = str(a, "verdict");
  return verdict ? `Finish run: ${verdict}` : "Finish run";
}

function describe(tool: string, args: unknown): HumanisedTool {
  const a = parseArgs(args);

  const mobile = MOBILE_MCP.exec(tool) ?? ARTEMIS.exec(tool);
  if (mobile?.[1]) return { family: "device", label: deviceAction(mobile[1], a) };

  switch (tool) {
    case "qa_plan":
    case "qa_check":
    case "qa_finish":
      return { family: "check", label: checkLabel(tool, a) };
    case "bash": {
      const command = str(a, "command");
      return { family: "shell", label: command ? shellLabel(command) : "Run shell command" };
    }
    case "eval": {
      const lang = str(a, "language") === "js" ? "JavaScript" : "Python";
      const title = str(a, "title");
      if (title) return { family: "code", label: `Run ${lang}: ${clip(title, 100)}` };
      const first = (str(a, "code") ?? "").split("\n").find((l) => l.trim().length > 0);
      return { family: "code", label: first ? `Run ${lang}: ${clip(first, 100)}` : `Run ${lang} snippet` };
    }
    case "read": {
      const p = str(a, "path");
      if (!p) return { family: "file", label: "Read file" };
      if (p.startsWith("xd://")) return { family: "file", label: `Read docs: ${p.slice("xd://".length)}` };
      return { family: "file", label: `Read ${shortPath(p)}` };
    }
    case "write": {
      const p = str(a, "path");
      // A raw xd:// write is the call itself; the backend normally resolves it, but stay correct if it did not.
      if (p?.startsWith("xd://")) return describe(p.slice("xd://".length), a.content);
      return { family: "file", label: p ? `Write ${shortPath(p)}` : "Write file" };
    }
    case "edit": {
      const p = editTarget(a);
      return { family: "file", label: p ? `Edit ${shortPath(p)}` : "Edit file" };
    }
    case "grep": {
      const pattern = str(a, "pattern");
      const where = str(a, "path");
      const base = pattern ? `Search "${clip(pattern, 60)}"` : "Search files";
      return { family: "file", label: where ? `${base} in ${shortPath(where, 40)}` : base };
    }
    case "search": {
      // canonical web search of the claude/codex adapters; omp's file search stays `grep`
      const query = str(a, "query");
      return { family: "other", label: query ? `Web search "${clip(query, 100)}"` : "Web search" };
    }
    case "glob": {
      const p = str(a, "path");
      return { family: "file", label: p ? `Find files ${shortPath(p)}` : "Find files" };
    }
    case "wait":
      return { family: "other", label: "Wait" };
  }

  if (tool.startsWith("mcp__")) {
    const rest = tool.slice("mcp__".length);
    const cut = rest.indexOf("_");
    const label = cut > 0 ? `${rest.slice(0, cut)} · ${rest.slice(cut + 1)}` : rest;
    return { family: "other", label: clip(label.replace(/_/g, " ")) };
  }
  return { family: "other", label: clip(tool.replace(/_/g, " ")) };
}

export function humaniseTool(tool: string, args: unknown): HumanisedTool {
  const result = describe(tool, args);
  return { family: result.family, label: clip(result.label) };
}

/** Fallback for activity lines that predate structured `tool`/`args`: split `<tool> <json…>` text. */
export function splitToolText(text: string): { tool: string; args: string } {
  const i = text.indexOf(" ");
  return i < 0 ? { tool: text, args: "" } : { tool: text.slice(0, i), args: text.slice(i + 1) };
}

/** Pretty-printed args for the expanded tool row; a truncated JSON string is shown verbatim. */
export function formatArgs(args: unknown): string {
  if (args === undefined || args === null) return "";
  if (typeof args === "string") {
    try {
      return JSON.stringify(JSON.parse(args), null, 2);
    } catch {
      return args;
    }
  }
  return JSON.stringify(args, null, 2);
}

/** `310ms`, `2.4s`, `42s`, `1m 05s`: tool calls are mostly sub-second, so the shared minute-resolution formatter is too coarse. */
export function formatToolDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s`;
}
