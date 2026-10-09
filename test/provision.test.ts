import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mcpLaunchArgs, PLUGIN_NAME, prefixesFromState } from "../src/harness/omp/provision";

const MOBILE_MCP = { type: "stdio", command: "npx", args: ["-y", "@mobilenext/mobile-mcp@latest"] };

let root: string;
let home: string;
let repo: string;
let pluginRoot: string;

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

const launch = (backend: "mobile-mcp" | "artemis" = "mobile-mcp") =>
  mcpLaunchArgs({ repoPath: repo }, backend, { home, pluginRoot, profile: null });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tapocalypse-provision-"));
  home = path.join(root, "home");
  repo = path.join(root, "repo");
  pluginRoot = path.join(root, "plugins");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(repo, { recursive: true });
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("mcpLaunchArgs", () => {
  test("no mobile-mcp anywhere → bundled plugin dir is added and written", async () => {
    const plan = await launch();
    const dir = path.join(pluginRoot, PLUGIN_NAME);
    expect(plan.args).toEqual(["--plugin-dir", dir]);
    expect(plan.expectedMobileMcp).toBe("mcp__tpc_mobile_mcp_");
    const written = JSON.parse(fs.readFileSync(path.join(dir, ".mcp.json"), "utf8"));
    expect(written.mcpServers["mobile-mcp"]).toMatchObject({ command: "npx", args: ["-y", "@mobilenext/mobile-mcp@latest"] });
  });

  test("user config already has mobile-mcp (any server name) → no plugin args, expected prefix follows the name", async () => {
    writeJson(path.join(home, ".omp", "agent", "mcp.json"), { mcpServers: { "mobile-mcp": MOBILE_MCP } });
    const plan = await launch();
    expect(plan.args).toEqual([]);
    expect(plan.expectedMobileMcp).toBe("mcp__mobile_mcp_");
    expect(fs.existsSync(pluginRoot)).toBe(false);

    writeJson(path.join(home, ".omp", "agent", "mcp.json"), { mcpServers: { phone: MOBILE_MCP } });
    expect((await launch()).expectedMobileMcp).toBe("mcp__phone_");
  });

  test("project .omp/mcp.json or root .mcp.json with mobile-mcp → no plugin args", async () => {
    writeJson(path.join(repo, ".omp", "mcp.json"), { mcpServers: { mm: MOBILE_MCP } });
    expect((await launch()).args).toEqual([]);
    fs.rmSync(path.join(repo, ".omp"), { recursive: true });
    writeJson(path.join(repo, ".mcp.json"), { mcpServers: { mm: { command: "npx", args: ["-y", "@mobilenext/mobile-mcp@1.0.8"] } } });
    expect((await launch()).args).toEqual([]);
  });

  test("a disabled mobile-mcp, or one hidden by disabledServers, does not count", async () => {
    writeJson(path.join(repo, ".omp", "mcp.json"), { mcpServers: { mm: { ...MOBILE_MCP, enabled: false } } });
    expect((await launch()).args).toHaveLength(2);
    writeJson(path.join(repo, ".omp", "mcp.json"), { mcpServers: { mm: MOBILE_MCP } });
    writeJson(path.join(home, ".omp", "agent", "mcp.json"), { disabledServers: ["mm"] });
    expect((await launch()).args).toHaveLength(2);
  });

  test("unrelated servers and malformed files do not count as mobile-mcp", async () => {
    writeJson(path.join(home, ".omp", "agent", "mcp.json"), { mcpServers: { other: { command: "npx", args: ["-y", "some-server"] } } });
    fs.mkdirSync(path.join(repo, ".omp"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".omp", "mcp.json"), "{ not json");
    expect((await launch()).args).toHaveLength(2);
  });

  test("a named omp profile reads that profile's user config, not the default one", async () => {
    writeJson(path.join(home, ".omp", "agent", "mcp.json"), { mcpServers: { mm: MOBILE_MCP } });
    const plan = await mcpLaunchArgs({ repoPath: repo }, "mobile-mcp", { home, pluginRoot, profile: "qa" });
    expect(plan.args).toHaveLength(2);
    writeJson(path.join(home, ".omp", "profiles", "qa", "agent", "mcp.json"), { mcpServers: { mm: MOBILE_MCP } });
    expect((await mcpLaunchArgs({ repoPath: repo }, "mobile-mcp", { home, pluginRoot, profile: "qa" })).args).toEqual([]);
  });

  test("the artemis backend never provisions mobile-mcp", async () => {
    expect(await launch("artemis")).toMatchObject({ args: [], expectedMobileMcp: null, pluginDir: null });
    expect(fs.existsSync(pluginRoot)).toBe(false);
  });

  test("rewriting is idempotent and repairs a stale plugin file", async () => {
    const file = path.join(pluginRoot, PLUGIN_NAME, ".mcp.json");
    await launch();
    const first = fs.statSync(file).mtimeMs;
    await launch();
    expect(fs.statSync(file).mtimeMs).toBe(first);
    fs.writeFileSync(file, "stale");
    await launch();
    expect(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers["mobile-mcp"]).toBeDefined();
  });
});

describe("prefixesFromState", () => {
  const prompt = (routes: string[]) => ({ systemPrompt: ["intro", ...routes.map((r) => `- "x" → \`xd://${r}\` — doc`)] });

  test("reads both naming forms from the MCP route list", () => {
    expect(prefixesFromState(prompt(["mcp__mobile_mcp_mobile_list_elements_on_screen", "mcp__artemis_mobile_run_task"]))).toMatchObject({
      mobileMcp: "mcp__mobile_mcp_",
      artemis: "mcp__artemis_",
    });
    expect(prefixesFromState(prompt(["mcp__tpc_mobile_mcp_mobile_list_elements_on_screen"]))).toMatchObject({
      mobileMcp: "mcp__tpc_mobile_mcp_",
      artemis: null,
    });
  });

  test("finds tools mounted as plain tools via dumpTools and reports nothing for unrelated servers", () => {
    expect(prefixesFromState({ dumpTools: [{ name: "mcp__tpc_mobile_mcp_mobile_list_elements_on_screen" }, { name: "read" }] }).mobileMcp).toBe(
      "mcp__tpc_mobile_mcp_",
    );
    expect(prefixesFromState(prompt(["mcp__atlassian_search"]))).toMatchObject({ mobileMcp: null, artemis: null });
    expect(prefixesFromState(null)).toMatchObject({ mobileMcp: null, artemis: null });
  });

  test("flags a bounded route list so absence is not treated as proof", () => {
    const state = { systemPrompt: ["Additional mounted MCP tool mappings omitted: prompt bounded."] };
    expect(prefixesFromState(state)).toMatchObject({ mobileMcp: null, routesOmitted: true });
  });
});
