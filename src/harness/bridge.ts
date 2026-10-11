import { chmodSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { McpServerSpec } from "./types";

/**
 * Harnesses whose HTTP MCP support is missing or version-dependent (Codex CLI, omp plugin dirs) reach the run's HTTP endpoint
 * through this stdio bridge: `<bun> src/mcp/stdio-bridge.ts <credentials-file>`.
 */
export const STDIO_BRIDGE = path.resolve(import.meta.dir, "../mcp/stdio-bridge.ts");

/** Writes `<runDir>/<name>-mcp.json` (`{url, token}`, owner-only) for the stdio bridge and returns its path. The token never reaches argv or env. */
export function writeBridgeCredentials(runDir: string, spec: Extract<McpServerSpec, { transport: "http" }>): string {
  const authorization = Object.entries(spec.headers).find(([name]) => name.toLowerCase() === "authorization")?.[1];
  const token = authorization === undefined ? undefined : /^Bearer\s+(.+)$/i.exec(authorization)?.[1];
  if (token === undefined) throw new Error(`MCP server ${spec.name} needs an "Authorization: Bearer <token>" header`);
  const file = path.join(runDir, `${spec.name}-mcp.json`);
  writeFileSync(file, JSON.stringify({ url: spec.url, token }), { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}
