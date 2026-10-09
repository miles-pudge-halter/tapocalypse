import { createHash, timingSafeEqual } from "node:crypto";
import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import type { z } from "zod";
import pkg from "../../package.json";
import { PROGRESS_SERVER, type ProgressSink } from "../harness/types";
import { PROGRESS_TOOLS, type ProgressToolName, QaCheckArgs, QaFinishArgs, QaPlanArgs } from "../runs/progress";

/** What the runner knows about a live run: its bearer token and where its progress goes. Null for unknown or finished runs. */
export type RunLookup = (runId: string) => { token: string; sink: ProgressSink } | null;

const INPUT_SCHEMAS: Record<ProgressToolName, z.ZodType> = { qa_plan: QaPlanArgs, qa_check: QaCheckArgs, qa_finish: QaFinishArgs };

/** Digests make the comparison constant-time whatever the lengths. */
function tokenMatches(presented: string, expected: string): boolean {
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(presented), digest(expected));
}

function bearer(req: Request): string | null {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get("authorization") ?? "");
  return m ? m[1]! : null;
}

/** One answer for unknown run, finished run and wrong token, so a caller cannot probe which run ids exist. */
function unauthorized(): Response {
  return Response.json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null }, { status: 401 });
}

function buildServer(sink: ProgressSink): McpServer {
  const server = new McpServer({ name: PROGRESS_SERVER, version: pkg.version });
  for (const tool of PROGRESS_TOOLS) {
    server.registerTool(
      tool.name,
      { title: tool.label, description: tool.description, inputSchema: INPUT_SCHEMAS[tool.name] },
      async (args: unknown) => {
        try {
          return { content: [{ type: "text", text: await sink.record(tool.name, args) }] };
        } catch (err) {
          return { isError: true, content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }] };
        }
      },
    );
  }
  return server;
}

/**
 * Run-scoped progress endpoint (`POST /mcp/runs/<runId>`): the same qa_plan / qa_check / qa_finish tools omp gets as host
 * tools, for harnesses that only speak MCP. Stateless like `handleMcp`; authorised by the run's bearer token.
 */
export async function handleRunMcp(req: Request, runId: string, lookup: RunLookup): Promise<Response> {
  const entry = lookup(runId);
  const presented = bearer(req);
  // Compare even when the run is unknown so both failures cost the same.
  const match = tokenMatches(presented ?? "", entry?.token ?? "");
  if (!entry || presented === null || !match) return unauthorized();

  const server = buildServer(entry.sink);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    void server.close();
  }
}
