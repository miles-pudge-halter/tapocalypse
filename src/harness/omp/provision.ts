// How Tapocalypse makes mobile-mcp available to the omp agent without the user editing any omp config.
//
// Findings, measured 2026-10-08 with omp 18.4.0 (throwaway RPC scripts, haiku, cwd without .omp/mcp.json):
// - omp has no per-session MCP flag/env var/RPC command. The only no-edit mechanism is `--plugin-dir <dir>`
//   containing a `.mcp.json`; the plugin name is the dir basename and its servers are namespaced `<plugin>:<server>`.
// - `--profile <name>` isolates the user-level `~/.omp/agent/mcp.json` (fresh profile = no MCP servers at all),
//   so it was used to simulate a machine that has never configured mobile-mcp:
//     fresh profile                      -> 0 MCP tools
//     fresh profile + plugin dir `tpc`   -> 33 mobile-mcp tools
//     user config with mobile-mcp + the same plugin dir -> only the user's 33 appear: omp drops a differently-named
//       server whose command/args equal a higher-priority one (no duplicates), so adding the plugin is harmless
//       when it is byte-for-byte equivalent; we still skip it when mobile-mcp is already configured.
// - MCP tools are NOT in RPC `get_state.dumpTools` (13 built-ins only). They are mounted as `xd://mcp__<server>_<tool>`
//   devices and listed in `get_state.systemPrompt` under "MCP Tool Routes"; the model calls them with
//   `write xd://mcp__… <json args>` (verified end to end: mobile_list_available_devices returned the emulator,
//   whose mobile-mcp device id was the AVD name `Pixel_7_Pro_API_34_2`).
// - Naming: user config entry `mobile-mcp` -> `mcp__mobile_mcp_mobile_list_elements_on_screen`; plugin `tpc` +
//   server `mobile-mcp` -> `mcp__tpc_mobile_mcp_mobile_list_elements_on_screen`. Tool names are capped at ~64 chars and
//   longer ones get a hash suffix (plugin `tapocalypse-mobile` + server `mobile` produced `…_click_on_screen_a_s2dijuvz`),
//   hence the deliberately short plugin name `tpc` (longest name is 62 chars, nothing truncated).
// - Startup: ready frame ~0.6 s; tools appear in `systemPrompt` ~1 s after ready with a warm npx cache, ~3.5 s when
//   npx has to resolve the package, and a prompt sent earlier than that fails with "No such tool: xd://mcp__…"
//   (observed with a cold `@1.0.8` install). So prefixes must be resolved before prompting.
// - The route list in the system prompt can be bounded ("Additional mounted MCP tool mappings omitted"); when that marker
//   is present and the tools are not listed, we fall back to the prefix derived from the config we provisioned.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DATA_DIR } from "../../config";
import type { Project } from "../../projects/registry";
import type { Backend } from "../../runs/types";
import { MOBILE_MCP_PACKAGE } from "../types";
import type { OmpRpc } from "./rpc";

export interface ToolPrefixes {
  mobileMcp: string | null;
  artemis: string | null;
}

export interface LaunchPlan {
  args: string[];
  /** Prefix the mobile-mcp tools will have according to the config we found or wrote; null for non-mobile-mcp backends. */
  expectedMobileMcp: string | null;
  /** Plugin dir passed to omp, when Tapocalypse had to provision mobile-mcp itself. */
  pluginDir: string | null;
  /** Config files that were inspected, for error messages. */
  checked: string[];
}

export interface ProvisionOptions {
  /** Defaults to `os.homedir()`; injectable so tests never read the real user config. */
  home?: string;
  /** Defaults to `OMP_PROFILE` / `PI_PROFILE`: named profiles move the user-level MCP config. */
  profile?: string | null;
  /** Defaults to `DATA_DIR/omp-plugins`. */
  pluginRoot?: string;
}

/** Short on purpose: the plugin name is part of every tool name and omp truncates names near 64 chars. */
export const PLUGIN_NAME = "tpc";
const PLUGIN_SERVER = "mobile-mcp";

const PLUGIN_MCP_JSON = `${JSON.stringify(
  {
    mcpServers: {
      [PLUGIN_SERVER]: {
        type: "stdio",
        command: "npx",
        args: ["-y", `${MOBILE_MCP_PACKAGE}@latest`],
        timeout: 120_000,
      },
    },
  },
  null,
  2,
)}\n`;

/** omp's tool-name rule as observed: `mcp__<server>_` where `<server>` (or `<plugin>:<server>`) has every non-alphanumeric char as `_`. */
const PLUGIN_TOOL_PREFIX = `mcp__${PLUGIN_NAME}_${PLUGIN_SERVER.replace(/[^A-Za-z0-9]/g, "_")}_`;

interface McpFile {
  mcpServers?: Record<string, { command?: unknown; args?: unknown; enabled?: unknown } | null>;
  disabledServers?: unknown;
}

function readJson(file: string): McpFile | null {
  try {
    const v: unknown = JSON.parse(readFileSync(file, "utf8"));
    return v && typeof v === "object" ? (v as McpFile) : null;
  } catch {
    return null;
  }
}

/** Config files omp reads MCP servers from that are tied to this machine/project (user scope first, as omp resolves it). */
function configFiles(repoPath: string, home: string, profile: string | null): string[] {
  const userDir = profile ? path.join(home, ".omp", "profiles", profile, "agent") : path.join(home, ".omp", "agent");
  return [
    path.join(userDir, "mcp.json"),
    path.join(userDir, ".mcp.json"),
    path.join(repoPath, ".omp", "mcp.json"),
    path.join(repoPath, ".omp", ".mcp.json"),
    path.join(repoPath, "mcp.json"),
    path.join(repoPath, ".mcp.json"),
  ];
}

/** Name of the first enabled server in `files` whose command/args run mobile-mcp, or null. */
function findConfiguredMobileMcp(files: string[], userFile: string): string | null {
  const disabled = new Set<string>();
  const userDisabled = readJson(userFile)?.disabledServers;
  if (Array.isArray(userDisabled)) for (const n of userDisabled) if (typeof n === "string") disabled.add(n);
  for (const file of files) {
    const servers = readJson(file)?.mcpServers;
    if (!servers) continue;
    for (const [name, entry] of Object.entries(servers)) {
      if (!entry || entry.enabled === false || disabled.has(name)) continue;
      const cmdline = [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])].join(" ");
      if (cmdline.includes(MOBILE_MCP_PACKAGE)) return name;
    }
  }
  return null;
}

/** (Re)writes the plugin dir only when its content differs, so concurrent runs never see a half-written file. */
function ensurePluginDir(pluginRoot: string): string {
  const dir = path.join(pluginRoot, PLUGIN_NAME);
  const file = path.join(dir, ".mcp.json");
  if (!existsSync(file) || readFileSync(file, "utf8") !== PLUGIN_MCP_JSON) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, PLUGIN_MCP_JSON);
  }
  return dir;
}

/**
 * Extra omp CLI args needed so the agent has mobile-mcp. Adds Tapocalypse's plugin dir only when no enabled
 * mobile-mcp server is configured in the user's or the project's omp config; only the mobile-mcp backend needs it.
 */
export async function mcpLaunchArgs(project: Pick<Project, "repoPath">, backend: Backend, opts: ProvisionOptions = {}): Promise<LaunchPlan> {
  if (backend !== "mobile-mcp") return { args: [], expectedMobileMcp: null, pluginDir: null, checked: [] };
  const home = opts.home ?? os.homedir();
  const profile = opts.profile === undefined ? (process.env.OMP_PROFILE ?? process.env.PI_PROFILE ?? null) : opts.profile;
  const files = configFiles(project.repoPath, home, profile || null);
  const configured = findConfiguredMobileMcp(files, files[0]!);
  if (configured) return { args: [], expectedMobileMcp: `mcp__${configured.replace(/[^A-Za-z0-9]/g, "_")}_`, pluginDir: null, checked: files };
  const pluginDir = ensurePluginDir(opts.pluginRoot ?? path.join(DATA_DIR, "omp-plugins"));
  return {
    args: ["--plugin-dir", pluginDir],
    expectedMobileMcp: PLUGIN_TOOL_PREFIX,
    pluginDir,
    checked: files,
  };
}

const MOBILE_MCP_MARKER = "mobile_list_elements_on_screen";
const ARTEMIS_MARKER = "mobile_run_task";
const ROUTE_RE = /xd:\/\/(mcp__[A-Za-z0-9_:.-]+)/g;
const ROUTES_OMITTED_RE = /mappings omitted/i;

function prefixOf(names: string[], marker: string): string | null {
  const hit = names.find((n) => n.startsWith("mcp__") && n.endsWith(`_${marker}`));
  return hit ? hit.slice(0, hit.length - marker.length) : null;
}

export interface StatePrefixes extends ToolPrefixes {
  /** The system prompt says some MCP route mappings were left out, so absence of a prefix is inconclusive. */
  routesOmitted: boolean;
}

/** Derives backend tool prefixes from an RPC `get_state` payload (plain tools and `xd://` routes). */
export function prefixesFromState(state: unknown): StatePrefixes {
  const data = (state && typeof state === "object" ? state : {}) as { dumpTools?: unknown; systemPrompt?: unknown };
  const names: string[] = [];
  if (Array.isArray(data.dumpTools)) {
    for (const t of data.dumpTools) {
      const name = (t as { name?: unknown } | null)?.name;
      if (typeof name === "string") names.push(name);
    }
  }
  const prompt = Array.isArray(data.systemPrompt) ? data.systemPrompt.join("\n") : typeof data.systemPrompt === "string" ? data.systemPrompt : "";
  for (const m of prompt.matchAll(ROUTE_RE)) names.push(m[1]!);
  return {
    mobileMcp: prefixOf(names, MOBILE_MCP_MARKER),
    artemis: prefixOf(names, ARTEMIS_MARKER),
    routesOmitted: ROUTES_OMITTED_RE.test(prompt),
  };
}

const MCP_WAIT_MS = 20_000;
const MCP_POLL_MS = 500;

/**
 * Discovers the real tool-name prefixes after `ready`. MCP servers connect in the background, so this polls
 * `get_state` until the backend's prefix shows up (or `timeoutMs` passes). A null prefix in the result means
 * the backend's tools are not available to the agent.
 */
export async function resolveToolPrefixes(
  rpc: OmpRpc,
  backend: Backend,
  opts: { expectedMobileMcp?: string | null; timeoutMs?: number } = {},
): Promise<ToolPrefixes> {
  const need = backend === "mobile-mcp" ? "mobileMcp" : "artemis";
  const deadline = Date.now() + (opts.timeoutMs ?? MCP_WAIT_MS);
  let latest: StatePrefixes;
  for (;;) {
    latest = prefixesFromState(await rpc.send({ type: "get_state" }));
    if (latest[need] || Date.now() >= deadline) break;
    await Bun.sleep(MCP_POLL_MS);
  }
  const { routesOmitted, ...prefixes } = latest;
  // The route list is bounded in the system prompt; absence then proves nothing, so trust what we provisioned.
  if (!prefixes.mobileMcp && routesOmitted && opts.expectedMobileMcp && backend === "mobile-mcp") {
    prefixes.mobileMcp = opts.expectedMobileMcp;
  }
  return prefixes;
}

/** The actionable error for a run whose backend tools never appeared. */
export function missingToolsMessage(backend: Backend, plan: LaunchPlan): string {
  if (backend === "artemis") {
    return "Artemis tools are not available to the agent: no MCP server exposing mobile_run_task is configured in omp (add the artemis server to ~/.omp/agent/mcp.json); see README §Prerequisites";
  }
  const how = plan.pluginDir
    ? `no mobile-mcp server in ${plan.checked.join(", ")}; tried Tapocalypse's bundled plugin ${plan.pluginDir} but its server did not connect within ${MCP_WAIT_MS / 1000}s (is \`npx\` on PATH and the network reachable?)`
    : `mobile-mcp is configured in omp (${plan.checked.join(", ")}) but its server did not connect within ${MCP_WAIT_MS / 1000}s`;
  return `mobile-mcp tools are not available to the agent: ${how}; see README §Prerequisites`;
}
