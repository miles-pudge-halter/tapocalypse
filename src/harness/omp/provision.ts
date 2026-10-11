// How Tapocalypse gives the omp agent its device tools without the user editing any omp config.
//
// Findings (omp 18.4.0, throwaway RPC scripts):
// - omp has no per-session MCP flag/env var/RPC command. The only no-edit mechanism is `--plugin-dir <dir>` containing a
//   `.mcp.json`; the plugin name is the dir basename and its servers are namespaced `mcp__<plugin>_<server>_<tool>`.
// - Since the device gateway, every run reaches its device through the run endpoint `POST /mcp/runs/<id>`, which serves the
//   gated `mobile_*` tools pinned to the run's device. omp cannot speak to that endpoint directly, so the plugin's server is
//   the stdio bridge (`src/mcp/stdio-bridge.ts`, credentials in an owner-only file under the run dir): plugin `tpc` + server
//   `qa` give `mcp__tpc_qa_mobile_take_screenshot`. The plugin dir lives under the run dir, so nothing is shared between runs.
// - MCP tools are NOT in RPC `get_state.dumpTools` (13 built-ins only). They are mounted as `xd://mcp__<server>_<tool>`
//   devices and listed in `get_state.systemPrompt` under "MCP Tool Routes"; the model calls them with
//   `write xd://mcp__… <json args>`.
// - Tool names are capped at ~64 chars and longer ones get a hash suffix, hence the deliberately short plugin name `tpc`.
// - Startup: ready frame ~0.6 s; the bridge's tools appear in `systemPrompt` ~1-3.5 s later (it waits for the gateway's tool
//   list), and a prompt sent earlier fails with "No such tool: xd://mcp__…". So the prefix must be resolved before prompting.
// - The route list in the system prompt can be bounded ("Additional mounted MCP tool mappings omitted"). omp RPC has no
//   host-initiated tool call to probe with, so when the bridge is not listed the run counts it as not connected (infra, retried)
//   instead of trusting the plan: a dead bridge must never become a paid prompt with no device tools.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { STDIO_BRIDGE, writeBridgeCredentials } from "../bridge";
import { PROGRESS_SERVER, type McpServerSpec } from "../types";
import type { OmpRpc } from "./rpc";

export interface ToolPrefixes {
  /** Prefix of the bridge's `mobile_*` tools (`mcp__tpc_qa_`), null when they never appeared. */
  mobileMcp: string | null;
}

export interface LaunchPlan {
  args: string[];
  /** Per-run plugin dir passed to omp. */
  pluginDir: string;
}

/** Short on purpose: the plugin name is part of every tool name and omp truncates names near 64 chars. */
export const PLUGIN_NAME = "tpc";
const PLUGIN_SERVER = "qa";
/** The bridge's tool calls can take a while (element lists on large trees); matches the gateway's own call timeout. */
const PLUGIN_TIMEOUT_MS = 300_000;

/** omp's tool-name rule as observed: `mcp__<plugin>_<server>_` with every non-alphanumeric char as `_`. */
export const PLUGIN_TOOL_PREFIX = `mcp__${PLUGIN_NAME}_${PLUGIN_SERVER}_`;

/**
 * Writes `<runDir>/plugin/tpc/.mcp.json` (stdio bridge to the run's `tpc` endpoint) plus the owner-only bridge credentials
 * `<runDir>/tpc-mcp.json`, and returns the omp args that mount it.
 */
export function writePlugin(runDir: string, servers: McpServerSpec[]): LaunchPlan {
  const spec = servers.find((s): s is Extract<McpServerSpec, { transport: "http" }> => s.name === PROGRESS_SERVER && s.transport === "http");
  if (!spec) throw new Error(`the run's "${PROGRESS_SERVER}" MCP endpoint is missing from the spawn options`);
  mkdirSync(runDir, { recursive: true });
  const credentials = writeBridgeCredentials(runDir, spec);
  const pluginDir = path.join(runDir, "plugin", PLUGIN_NAME);
  mkdirSync(pluginDir, { recursive: true });
  const config = {
    mcpServers: { [PLUGIN_SERVER]: { type: "stdio", command: process.execPath, args: [STDIO_BRIDGE, credentials], timeout: PLUGIN_TIMEOUT_MS } },
  };
  const file = path.join(pluginDir, ".mcp.json");
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return { args: ["--plugin-dir", pluginDir], pluginDir };
}

const MOBILE_MARKER = "mobile_list_elements_on_screen";
const ROUTE_RE = /xd:\/\/(mcp__[A-Za-z0-9_:.-]+)/g;
const ROUTES_OMITTED_RE = /mappings omitted/i;

/** Only Tapocalypse's own plugin counts: a `mobile-mcp` the user configured themselves must never be adopted. */
function prefixOf(names: string[], marker: string): string | null {
  const own = `mcp__${PLUGIN_NAME}_`;
  const hit = names.find((n) => n.startsWith(own) && n.endsWith(`_${marker}`));
  return hit ? hit.slice(0, hit.length - marker.length) : null;
}

export interface StatePrefixes extends ToolPrefixes {
  /** The system prompt says some MCP route mappings were left out, so absence of a prefix is inconclusive. */
  routesOmitted: boolean;
}

/** Derives the bridge's tool prefix from an RPC `get_state` payload (plain tools and `xd://` routes). */
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
    mobileMcp: prefixOf(names, MOBILE_MARKER),
    routesOmitted: ROUTES_OMITTED_RE.test(prompt),
  };
}

// The runner warms the gateway before spawning, so the bridge lists its tools from memory; 20 s covers a slow omp start.
const MCP_WAIT_MS = 20_000;
const MCP_POLL_MS = 500;

/**
 * Discovers the real tool-name prefix after `ready`. MCP servers connect in the background, so this polls `get_state`
 * until the bridge's prefix shows up (or `timeoutMs` passes). A null prefix in the result means the device tools are not
 * confirmed: omp has no host-initiated tool call to probe with, so even when its prompt bounds the route list the bridge
 * counts as not connected rather than trusting the plan.
 */
export async function resolveToolPrefixes(rpc: OmpRpc, opts: { timeoutMs?: number } = {}): Promise<StatePrefixes> {
  const deadline = Date.now() + (opts.timeoutMs ?? MCP_WAIT_MS);
  for (;;) {
    const state = prefixesFromState(await rpc.send({ type: "get_state" }));
    if (state.mobileMcp || Date.now() >= deadline) return state;
    await Bun.sleep(MCP_POLL_MS);
  }
}

/** The actionable error for a run whose device tools never appeared. */
export function missingToolsMessage(plan: LaunchPlan, routesOmitted: boolean): string {
  const bounded = routesOmitted ? "; omp bounds the MCP route list in its prompt, so the bridge could not be confirmed, and an unconfirmed bridge counts as not connected" : "";
  return `the device tools are not available to the agent: Tapocalypse's plugin ${plan.pluginDir} (stdio bridge to the run's MCP endpoint) did not connect within ${MCP_WAIT_MS / 1000}s${bounded}; see the run's stderr and README §Prerequisites`;
}
