import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { ProgressSink } from "../src/harness/types";
import { handleRunMcp } from "../src/mcp/run-server";

const BRIDGE = path.resolve(import.meta.dir, "../src/mcp/stdio-bridge.ts");
const RUN_ID = "bridge-run";
const TOKEN = "bridge-test-token";

const cleanups: Array<() => void | Promise<void>> = [];
afterAll(async () => {
  for (const c of cleanups.reverse()) await c();
});

/** The real run-scoped MCP endpoint behind a real HTTP server; progress calls land in `calls`. */
function startUpstream() {
  const calls: Array<{ tool: string; args: unknown }> = [];
  const sink: ProgressSink = {
    async record(tool, args) {
      calls.push({ tool, args });
      return `recorded ${tool}`;
    },
  };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => {
      const m = /^\/mcp\/runs\/([^/]+)$/.exec(new URL(req.url).pathname);
      if (!m || req.method !== "POST") return new Response("not found", { status: 404 });
      return handleRunMcp(req, m[1]!, (id) => (id === RUN_ID ? { token: TOKEN, sink } : null));
    },
  });
  cleanups.push(() => server.stop(true));
  return { calls, url: `http://127.0.0.1:${server.port}/mcp/runs/${RUN_ID}` };
}

function credentialsFile(creds: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), "tpc-bridge-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "tpc-mcp.json");
  Bun.write(file, typeof creds === "string" ? creds : JSON.stringify(creds));
  return file;
}

async function connectClient(file: string) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [BRIDGE, file] });
  const client = new Client({ name: "bridge-test", version: "0.0.0" });
  await client.connect(transport);
  cleanups.push(() => client.close());
  return { client, transport };
}

describe("stdio bridge", () => {
  test("lists the run's progress tools through the HTTP endpoint", async () => {
    const { url } = startUpstream();
    const { client } = await connectClient(credentialsFile({ url, token: TOKEN }));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["qa_check", "qa_finish", "qa_plan"]);
  });

  test("tools/call reaches the run's progress sink and returns its text", async () => {
    const { url, calls } = startUpstream();
    const { client } = await connectClient(credentialsFile({ url, token: TOKEN }));
    const args = { checks: [{ id: "C1", title: "Login" }] };
    const result = await client.callTool({ name: "qa_plan", arguments: args });
    expect(calls).toEqual([{ tool: "qa_plan", args }]);
    expect(result.content).toEqual([{ type: "text", text: "recorded qa_plan" }]);
  });

  test("a wrong token fails the upstream initialize: one stderr line, exit 1, nothing reaches the sink", async () => {
    const { url, calls } = startUpstream();
    const proc = Bun.spawn([process.execPath, BRIDGE, credentialsFile({ url, token: "wrong" })], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(1);
    const stderr = (await new Response(proc.stderr).text()).trim();
    expect(stderr.split("\n")).toHaveLength(1);
    expect(stderr).toContain("initialize");
    expect(stderr).not.toContain("wrong");
    expect(calls).toEqual([]);
  });

  test.each([
    ["is missing", () => path.join(tmpdir(), "tpc-bridge-does-not-exist.json")],
    ["is not JSON", () => credentialsFile("not json")],
    ["lacks a token", () => credentialsFile({ url: "http://127.0.0.1:1/mcp" })],
  ])("a credentials file that %s exits 1 with a one-line message", async (_name, file) => {
    const proc = Bun.spawn([process.execPath, BRIDGE, file()], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    expect(await proc.exited).toBe(1);
    expect((await new Response(proc.stderr).text()).trim().split("\n")).toHaveLength(1);
  });

  test("closing the client ends the bridge process with exit 0", async () => {
    const { url } = startUpstream();
    const proc = Bun.spawn([process.execPath, BRIDGE, credentialsFile({ url, token: TOKEN })], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    cleanups.push(() => void proc.kill());
    const init = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    });
    proc.stdin.write(`${init}\n`);
    await proc.stdin.flush();
    const reader = proc.stdout.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain("tapocalypse-bridge");
    await proc.stdin.end();
    expect(await proc.exited).toBe(0);
  });

  test("closing the SDK client leaves no bridge process behind", async () => {
    const { url } = startUpstream();
    const { client, transport } = await connectClient(credentialsFile({ url, token: TOKEN }));
    const pid = transport.pid;
    expect(pid).not.toBeNull();
    const alive = () => {
      try {
        process.kill(pid!, 0);
        return true;
      } catch {
        return false;
      }
    };
    expect(alive()).toBe(true);
    await client.close();
    for (let i = 0; i < 100 && alive(); i++) await Bun.sleep(20);
    expect(alive()).toBe(false);
  });
});
