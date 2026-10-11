import { createHash, timingSafeEqual } from "node:crypto";
import { type CallToolResult, fromJsonSchema, McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { z } from "zod";
import pkg from "../../package.json";
import { gateway as defaultGateway, type Gateway, pinSchema, type ToolDef } from "../devices/gateway";
import { runLease } from "../devices/leases";
import { PROGRESS_SERVER, type ProgressSink } from "../harness/types";
import { PROGRESS_TOOLS, type ProgressToolName, QaCheckArgs, QaFinishArgs, QaPlanArgs } from "../runs/progress";
import { runDir } from "../runs/store";

/**
 * What the runner knows about a live run: its bearer token and where its progress goes. Null for unknown or finished runs.
 * `nativeProgress`: the harness already has `qa_*` as host tools, so the endpoint serves only the device tools.
 */
export type RunLookup = (runId: string) => { token: string; sink: ProgressSink; nativeProgress?: boolean } | null;

/** What the device tools of a run need from the rest of the process; production uses the gateway, the run's lease and its run dir. */
export interface RunGatewayDeps {
  gateway: Pick<Gateway, "tools" | "call">;
  /** The id mobile-mcp addresses the run's device by; null once the run no longer holds its device lease. */
  deviceOf(runId: string): string | null;
  /** Where the run's mobile-mcp child works (it may write screenshots there). */
  cwdOf(runId: string): string;
}

const DEFAULT_DEPS: RunGatewayDeps = {
  gateway: defaultGateway,
  deviceOf: (runId) => runLease(runId)?.mobileDeviceId ?? null,
  cwdOf: runDir,
};

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

const errorResult = (text: string): CallToolResult => ({ isError: true, content: [{ type: "text", text }] });
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function registerProgressTools(server: McpServer, sink: ProgressSink): void {
  for (const tool of PROGRESS_TOOLS) {
    server.registerTool(
      tool.name,
      { title: tool.label, description: tool.description, inputSchema: INPUT_SCHEMAS[tool.name] },
      async (args: unknown) => {
        try {
          return { content: [{ type: "text", text: await sink.record(tool.name, args) }] };
        } catch (err) {
          return errorResult(messageOf(err));
        }
      },
    );
  }
}

const ToolArgs = z.record(z.string(), z.unknown());

/** The device tools of the run's own device: mobile-mcp's schemas with `device` removed, calls pinned to the run lease's device. */
async function registerDeviceTools(server: McpServer, runId: string, deps: RunGatewayDeps): Promise<void> {
  let defs: ToolDef[];
  try {
    defs = await deps.gateway.tools();
  } catch (err) {
    console.error(`tapocalypse: device tools unavailable for run ${runId}: ${messageOf(err)}`);
    return;
  }
  for (const def of defs) {
    const pinned = pinSchema(def);
    try {
      server.registerTool(
        def.name,
        { title: pinned.title, description: pinned.description, annotations: pinned.annotations, inputSchema: fromJsonSchema(pinned.inputSchema) },
        async (input: unknown): Promise<CallToolResult> => {
          const args = ToolArgs.safeParse(input);
          if (!args.success) return errorResult(args.error.issues.map((i) => i.message).join("; "));
          const device = deps.deviceOf(runId);
          if (device === null) return errorResult("This run no longer holds its device, so the device tools are unavailable.");
          // Reason: the gateway forwards the child's already-validated MCP CallToolResult; its content is typed loosely there.
          return (await deps.gateway.call(runId, device, deps.cwdOf(runId), def.name, args.data)) as CallToolResult;
        },
      );
    } catch (err) {
      console.error(`tapocalypse: skipped device tool ${def.name} for run ${runId}: ${messageOf(err)}`);
    }
  }
}

const RpcMessage = z.looseObject({ method: z.unknown().optional(), params: z.looseObject({ name: z.unknown().optional() }).optional() });

/** Only a tool listing or a `mobile_*` call needs the device tools; the others must not wait for the first-ever probe of mobile-mcp. */
async function needsDeviceTools(req: Request): Promise<boolean> {
  let body: unknown;
  try {
    body = await req.clone().json();
  } catch {
    return false;
  }
  const messages = z.array(RpcMessage).safeParse(Array.isArray(body) ? body : [body]);
  return (
    messages.success &&
    messages.data.some(
      (m) => m.method === "tools/list" || (m.method === "tools/call" && typeof m.params?.name === "string" && m.params.name.startsWith("mobile_")),
    )
  );
}

/**
 * Run-scoped endpoint (`POST /mcp/runs/<runId>`): the qa_plan / qa_check / qa_finish progress tools (unless the harness has them
 * natively) and every mobile-mcp device tool pinned to the run's own device, so the agent drives its device through the gateway.
 * Stateless like `handleMcp`; authorised by the run's bearer token.
 */
export async function handleRunMcp(req: Request, runId: string, lookup: RunLookup, deps: RunGatewayDeps = DEFAULT_DEPS): Promise<Response> {
  const entry = lookup(runId);
  const presented = bearer(req);
  // Compare even when the run is unknown so both failures cost the same.
  const match = tokenMatches(presented ?? "", entry?.token ?? "");
  if (!entry || presented === null || !match) return unauthorized();

  // Tools are registered per request (only what this request needs), so declare the capability up front: a client that sees
  // no `tools` capability at initialize never asks for the list, and omp drops the server as empty.
  const server = new McpServer({ name: PROGRESS_SERVER, version: pkg.version }, { capabilities: { tools: {} } });
  if (!entry.nativeProgress) registerProgressTools(server, entry.sink);
  if (await needsDeviceTools(req)) await registerDeviceTools(server, runId, deps);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    void server.close();
  }
}
