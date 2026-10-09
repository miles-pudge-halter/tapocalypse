/**
 * stdio ⇄ HTTP bridge for the run-scoped progress server: `bun src/mcp/stdio-bridge.ts <credentials-file>`.
 *
 * Harnesses whose HTTP MCP support is missing or version-dependent (Codex CLI) start this as an ordinary stdio MCP
 * server. It proxies `tools/list` and `tools/call` to `POST /mcp/runs/<id>` with the run's bearer token, which it reads
 * from an owner-only JSON file `{ url, token }` so the token never appears in argv or the environment.
 * Exits 0 when stdin closes, 1 (one line on stderr) when the file is unusable or the upstream `initialize` fails.
 */
import { readFileSync } from "node:fs";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import pkg from "../../package.json";

const Credentials = z.object({ url: z.url(), token: z.string().min(1) });

function fail(message: string): never {
  console.error(`tapocalypse-bridge: ${message}`);
  process.exit(1);
}

function readCredentials(file: string | undefined): z.infer<typeof Credentials> {
  if (!file) fail("usage: stdio-bridge.ts <credentials-file>");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    fail(`cannot read credentials file ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = Credentials.safeParse(raw);
  if (!parsed.success) fail(`invalid credentials file ${file}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
  return parsed.data;
}

async function main(): Promise<void> {
  const { url, token } = readCredentials(process.argv[2]);

  const upstream = new Client({ name: "tapocalypse-bridge", version: pkg.version });
  try {
    await upstream.connect(
      new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
    );
  } catch (err) {
    fail(`upstream initialize failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const server = new Server({ name: "tapocalypse-bridge", version: pkg.version }, { capabilities: { tools: {} } });
  server.setRequestHandler("tools/list", (request) => upstream.listTools(request.params));
  server.setRequestHandler("tools/call", (request) => upstream.callTool(request.params));
  server.onclose = () => {
    void upstream.close().finally(() => process.exit(0));
  };
  await server.connect(new StdioServerTransport());
}

await main();
