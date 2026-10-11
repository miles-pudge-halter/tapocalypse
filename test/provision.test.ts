import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PLUGIN_NAME, PLUGIN_TOOL_PREFIX, prefixesFromState, resolveToolPrefixes, writePlugin } from "../src/harness/omp/provision";
import type { OmpRpc } from "../src/harness/omp/rpc";
import type { McpServerSpec } from "../src/harness/types";

const BRIDGE = path.resolve(import.meta.dir, "../src/mcp/stdio-bridge.ts");
const TPC: Extract<McpServerSpec, { transport: "http" }> = {
  name: "tpc",
  transport: "http",
  url: "http://127.0.0.1:4310/mcp/runs/r1",
  headers: { Authorization: "Bearer secret-run-token" },
};

let runDir: string;

beforeEach(() => {
  runDir = fs.mkdtempSync(path.join(os.tmpdir(), "tapocalypse-provision-"));
});

afterEach(() => fs.rmSync(runDir, { recursive: true, force: true }));

describe("writePlugin", () => {
  test("mounts the run's tpc endpoint through the stdio bridge in a per-run plugin dir", () => {
    const plan = writePlugin(runDir, [TPC]);

    const pluginDir = path.join(runDir, "plugin", PLUGIN_NAME);
    expect(plan.args).toEqual(["--plugin-dir", pluginDir]);
    const mcp = JSON.parse(fs.readFileSync(path.join(pluginDir, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, { type: string; command: string; args: string[] }>;
    };
    expect(Object.keys(mcp.mcpServers)).toEqual(["qa"]);
    expect(mcp.mcpServers.qa).toMatchObject({ type: "stdio", command: process.execPath, args: [BRIDGE, path.join(runDir, "tpc-mcp.json")] });
  });

  test("the run token lives only in the owner-only credentials file, never in the plugin config", () => {
    writePlugin(runDir, [TPC]);

    const creds = path.join(runDir, "tpc-mcp.json");
    expect(JSON.parse(fs.readFileSync(creds, "utf8"))).toEqual({ url: TPC.url, token: "secret-run-token" });
    expect(fs.statSync(creds).mode & 0o777).toBe(0o600);
    const mcpFile = path.join(runDir, "plugin", PLUGIN_NAME, ".mcp.json");
    expect(fs.readFileSync(mcpFile, "utf8")).not.toContain("secret-run-token");
    expect(fs.statSync(mcpFile).mode & 0o777).toBe(0o600);
  });

  test("a run without a tpc endpoint cannot be provisioned", () => {
    expect(() => writePlugin(runDir, [])).toThrow(/tpc/);
  });
});

describe("prefixesFromState", () => {
  const prompt = (routes: string[]) => ({ systemPrompt: ["intro", ...routes.map((r) => `- "x" → \`xd://${r}\` — doc`)] });

  test("reads the bridge's prefix from the MCP route list", () => {
    expect(prefixesFromState(prompt(["mcp__tpc_qa_mobile_list_elements_on_screen"])).mobileMcp).toBe("mcp__tpc_qa_");
  });

  test("finds tools mounted as plain tools via dumpTools and reports nothing for unrelated servers", () => {
    expect(prefixesFromState({ dumpTools: [{ name: "mcp__tpc_qa_mobile_list_elements_on_screen" }, { name: "read" }] }).mobileMcp).toBe("mcp__tpc_qa_");
    expect(prefixesFromState(prompt(["mcp__atlassian_search"])).mobileMcp).toBeNull();
    expect(prefixesFromState(null).mobileMcp).toBeNull();
  });

  test("a mobile-mcp the user configured themselves is never adopted as the device prefix", () => {
    const own = "mcp__tpc_qa_mobile_list_elements_on_screen";
    const foreign = "mcp__mobile_mcp_mobile_list_elements_on_screen";
    expect(prefixesFromState(prompt([foreign, own])).mobileMcp).toBe("mcp__tpc_qa_");
    expect(prefixesFromState(prompt([foreign])).mobileMcp).toBeNull();
  });

  test("flags a bounded route list so absence is not treated as proof", () => {
    const state = { systemPrompt: ["Additional mounted MCP tool mappings omitted: prompt bounded."] };
    expect(prefixesFromState(state)).toMatchObject({ mobileMcp: null, routesOmitted: true });
  });
});

describe("resolveToolPrefixes", () => {
  /** A `get_state` whose system prompt says routes were omitted (a machine with many MCP servers) and lists the bridge only from poll `appearsAt`. */
  function rpcWithBridgeAppearingAt(appearsAt: number) {
    let polls = 0;
    const rpc = {
      send: async () => {
        polls++;
        const routes = polls >= appearsAt ? `xd://${PLUGIN_TOOL_PREFIX}mobile_list_elements_on_screen` : "xd://mcp__mobile_mcp_mobile_list_elements_on_screen";
        return { systemPrompt: [`${routes}\nAdditional mounted MCP tool mappings omitted: prompt bounded.`] };
      },
    } as unknown as OmpRpc; // only `send` is exercised
    return { rpc, polls: () => polls };
  }

  test("keeps polling while routes are omitted until the bridge itself is listed, instead of trusting the plan early", async () => {
    const { rpc, polls } = rpcWithBridgeAppearingAt(3);
    const prefixes = await resolveToolPrefixes(rpc, { timeoutMs: 5_000 });
    expect(prefixes.mobileMcp).toBe(PLUGIN_TOOL_PREFIX);
    expect(polls()).toBe(3);
  });

  test("reports the bridge as not connected when the deadline passes with routes still omitted: the marker proves nothing", async () => {
    const { rpc, polls } = rpcWithBridgeAppearingAt(Number.MAX_SAFE_INTEGER);
    const prefixes = await resolveToolPrefixes(rpc, { timeoutMs: 1_200 });
    expect(prefixes.mobileMcp).toBeNull();
    expect(prefixes.routesOmitted).toBe(true);
    expect(polls()).toBeGreaterThan(1);
  });
});
