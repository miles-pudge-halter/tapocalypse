// Level 2 device gateway: Tapocalypse hosts one mobile-mcp child per leased device and re-exposes its device tools,
// gated by a lease. This file is the core (schemas, argument rewriting, child pool, tool cache); the MCP surface lives in
// `src/mcp/server.ts`.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { Client, type JsonSchemaType } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { z } from "zod";
import pkg from "../../package.json";
import { DATA_DIR } from "../config";
import { MOBILE_MCP_PACKAGE } from "../harness/types";
import type { LeaseStore } from "./leases";

export interface JsonSchemaObject extends JsonSchemaType {
  type: "object";
  properties?: Record<string, JsonSchemaType>;
  required?: string[];
}
export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}
export interface ToolDef {
  name: string;
  title?: string;
  description?: string;
  inputSchema: JsonSchemaObject;
  annotations?: ToolAnnotations;
}
export interface ToolResult {
  content: unknown[];
  isError?: boolean;
  structuredContent?: unknown;
}

export interface GatewayClient {
  listTools(): Promise<ToolDef[]>;
  callTool(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<ToolResult>;
  close(): Promise<void>;
  /** Resolves when the child process is gone (crash or close). */
  readonly exited: Promise<void>;
  /** mobile-mcp's own version from its `initialize` result; null/absent when it did not say. */
  readonly version?: string | null;
}

export interface GatewayDeps {
  /** Starts a mobile-mcp child whose working directory is `cwd`. */
  spawnClient(cwd: string): Promise<GatewayClient>;
  /** Per-call timeout (default 300 s). */
  callTimeoutMs?: number;
  /** Cold-start tool probe timeout (default 15 s). */
  probeTimeoutMs?: number;
  /** After a failed or timed-out cold-start probe, `tools()` answers an empty list for this long before probing again (default 30 s). */
  probeRetryMs?: number;
  /** Where the tool list is cached across restarts; null (default) keeps it in memory only. */
  cacheFile?: string | null;
}

export const GATED_PREFIX_DESCRIPTION = "Tapocalypse-gated: pass the leaseId from device_acquire. ";

/** Device listing and remote-cloud tools: a gated agent only ever sees its own device, and cloud devices are billed. */
export const DROPPED_TOOLS: ReadonlySet<string> = new Set([
  "mobile_list_available_devices",
  "mobile_login_to_cloud_provider",
  "mobile_list_remote_devices",
  "mobile_allocate_remote_device",
  "mobile_release_remote_device",
]);

const BATCH_TOOL = "mobile_batch_commands";

const withoutDevice = (schema: JsonSchemaObject): JsonSchemaObject => {
  const { device: _device, ...properties } = schema.properties ?? {};
  return { ...schema, properties, required: (schema.required ?? []).filter((name) => name !== "device") };
};

/** The tool as agents see it on `/mcp`: `device` is gone, a required `leaseId` is in. Batch step schemas stay (device is overwritten at call time). */
export function gateSchema(def: ToolDef): ToolDef {
  const bare = withoutDevice(def.inputSchema);
  return {
    ...def,
    description: GATED_PREFIX_DESCRIPTION + (def.description ?? ""),
    inputSchema: {
      ...bare,
      properties: { leaseId: { type: "string", description: "The leaseId returned by device_acquire" }, ...bare.properties },
      required: ["leaseId", ...(bare.required ?? [])],
    },
  };
}

/** The tool as a QA run's agent sees it on `/mcp/runs/<id>`: `device` is gone and nothing replaces it, the run's own device is implied. */
export function pinSchema(def: ToolDef): ToolDef {
  return { ...def, inputSchema: withoutDevice(def.inputSchema) };
}

/** The only names the gateway serves: mobile-mcp's device tools. Anything else (a Tapocalypse tool name, a cloud tool) would collide with `/mcp`'s own tools or bypass the lease gate. */
export const isGatedToolName = (name: string): boolean => name.startsWith("mobile_") && !DROPPED_TOOLS.has(name);

const BatchArgs = z.looseObject({
  steps: z.array(z.looseObject({ name: z.string(), arguments: z.record(z.string(), z.unknown()).optional() })),
});

/** The names of the tools a batch would run (the batch tool runs any registered tool, so the gateway has to look inside). */
export function batchStepNames(args: Record<string, unknown>): string[] {
  const batch = BatchArgs.safeParse(args);
  return batch.success ? batch.data.steps.map((step) => step.name) : [];
}

/**
 * Child arguments for a gated call: `device` is the lease's device whatever the caller sent (also inside batch steps) and
 * `leaseId` never reaches the child. A batch the schema cannot read is left for the child to reject (it needs the same shape).
 */
export function rewriteArgs(def: ToolDef, args: Record<string, unknown>, mobileDeviceId: string): Record<string, unknown> {
  const { leaseId: _leaseId, ...rest } = args;
  const out: Record<string, unknown> = { ...rest, device: mobileDeviceId };
  if (def.name === BATCH_TOOL) {
    const batch = BatchArgs.safeParse(rest);
    if (batch.success) out.steps = batch.data.steps.map((step) => ({ ...step, arguments: { ...step.arguments, device: mobileDeviceId } }));
  }
  return out;
}

export const ToolDefSchema = z.looseObject({
  name: z.string().refine(isGatedToolName, "not a gated mobile_* tool"),
  title: z.string().optional(),
  description: z.string().optional(),
  inputSchema: z.looseObject({
    type: z.literal("object"),
    properties: z.record(z.string(), z.custom<JsonSchemaType>((value) => typeof value === "object" && value !== null)).optional(),
    required: z.array(z.string()).optional(),
  }),
  // Hints are advisory: a value of a shape this version does not know is dropped, not a reason to drop the tool.
  annotations: z
    .looseObject({
      title: z.string().optional(),
      readOnlyHint: z.boolean().optional(),
      destructiveHint: z.boolean().optional(),
      idempotentHint: z.boolean().optional(),
      openWorldHint: z.boolean().optional(),
    })
    .optional()
    .catch(undefined),
});

/** The tools of a listing that the gateway may serve; an entry that is not one (wrong name, unreadable shape) is skipped, never a reason to refuse the rest. */
export function servableTools(listed: unknown[]): ToolDef[] {
  return listed.flatMap((entry) => {
    const parsed = ToolDefSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

export const CALL_TIMEOUT_MS = 300_000;
export const PROBE_TIMEOUT_MS = 15_000;
export const PROBE_RETRY_MS = 30_000;

const ToolCache = z.object({ version: z.literal(1), mobileMcpVersion: z.string().nullable(), tools: z.array(z.unknown()) });
interface ToolSet {
  mobileMcpVersion: string | null;
  tools: ToolDef[];
}

interface PoolEntry {
  client: Promise<GatewayClient>;
}

const errorResult = (message: string): ToolResult => ({ content: [{ type: "text", text: message }], isError: true });
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * The lease's directory when it is an absolute, existing directory, else the OS temp dir (mobile-mcp only writes under its cwd
 * and the temp dir). The filesystem root and the home directory are refused too: they would let `saveTo`/`output` write anywhere.
 */
function childCwd(cwd: string | undefined): string {
  try {
    if (cwd && path.isAbsolute(cwd) && statSync(cwd).isDirectory()) {
      const resolved = path.resolve(cwd);
      if (resolved !== path.parse(resolved).root && resolved !== path.resolve(homedir())) return cwd;
    }
  } catch {
    // Missing or unreadable: fall through.
  }
  return tmpdir();
}

export class Gateway {
  private pool = new Map<string, PoolEntry>();
  /** Entries `stop` ended: a call that finds its child gone says why. */
  private stopped = new WeakSet<PoolEntry>();
  private cache: ToolSet | null = null;
  private cacheLoaded = false;
  private probing: Promise<ToolDef[]> | null = null;
  /** Probe children that are starting; `stopAll` closes them. */
  private probeSpawns = new Set<Promise<GatewayClient>>();
  private probeFailedAt = Number.NEGATIVE_INFINITY;
  private lastProbeError: string | null = null;
  private closing = false;

  constructor(private deps: GatewayDeps) {}

  /** What `/api/mcp/status` reports: never spawns anything. */
  status(): { tools: number; mobileMcpVersion: string | null } {
    const known = this.known();
    return { tools: known?.tools.length ?? 0, mobileMcpVersion: known?.mobileMcpVersion ?? null };
  }

  /** Why the device tools are unavailable: the last failed cold-start probe's reason; null while tools are known or no probe failed. */
  probeError(): string | null {
    return this.known() ? null : this.lastProbeError;
  }

  /** Forgets the in-memory tool set and any remembered probe failure, so the next `tools()` re-reads the cache file or probes again. */
  reload(): void {
    this.cache = null;
    this.cacheLoaded = false;
    this.probeFailedAt = 0;
  }

  private known(): ToolSet | null {
    if (!this.cache && !this.cacheLoaded) {
      this.cacheLoaded = true;
      this.cache = this.readCacheFile();
    }
    return this.cache;
  }

  private readCacheFile(): ToolSet | null {
    const file = this.deps.cacheFile;
    if (!file || !existsSync(file)) return null;
    try {
      const parsed = ToolCache.safeParse(JSON.parse(readFileSync(file, "utf8")));
      if (!parsed.success) return null;
      const tools = servableTools(parsed.data.tools);
      return tools.length > 0 ? { mobileMcpVersion: parsed.data.mobileMcpVersion, tools } : null;
    } catch {
      return null;
    }
  }

  private remember(mobileMcpVersion: string | null, listed: unknown[]): ToolDef[] {
    const tools = servableTools(listed);
    if (tools.length === 0) {
      console.error("gateway: mobile-mcp listed no tools the gateway can serve");
      return [];
    }
    this.cache = { mobileMcpVersion, tools };
    this.cacheLoaded = true;
    const file = this.deps.cacheFile;
    if (file) {
      try {
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(`${file}.tmp`, JSON.stringify({ version: 1, mobileMcpVersion, tools }));
        renameSync(`${file}.tmp`, file);
      } catch (e) {
        console.error("gateway: could not save the tool cache:", messageOf(e));
      }
    }
    return tools;
  }

  /** mobile-mcp's device tools as the child defines them (`device` still in), minus the dropped ones. Cached; the first ever call probes a throwaway child. */
  async tools(): Promise<ToolDef[]> {
    const known = this.known();
    if (known) return known.tools;
    if (this.closing || Date.now() - this.probeFailedAt < (this.deps.probeRetryMs ?? PROBE_RETRY_MS)) return [];
    this.probing ??= this.probe().finally(() => {
      this.probing = null;
    });
    return this.probing;
  }

  /**
   * Starts a throwaway child, lists its tools and stops it. A failure is logged and answers an empty list; nothing is cached,
   * but `tools()` does not probe again for `probeRetryMs` (a client connect would otherwise wait the full timeout every time).
   */
  private async probe(): Promise<ToolDef[]> {
    const spawned = this.deps.spawnClient(tmpdir());
    this.probeSpawns.add(spawned);
    const work = (async () => {
      const client = await spawned;
      try {
        return { tools: await client.listTools(), version: client.version ?? null };
      } finally {
        await client.close().catch(() => {});
      }
    })();
    const timeout = Promise.withResolvers<"timeout">();
    const timer = setTimeout(() => timeout.resolve("timeout"), this.deps.probeTimeoutMs ?? PROBE_TIMEOUT_MS);
    try {
      const result = await Promise.race([work, timeout.promise]);
      if (result === "timeout") {
        void spawned.then((c) => c.close()).catch(() => {});
        work.catch(() => {});
        console.error("gateway: mobile-mcp did not list its tools in time");
        this.probeFailedAt = Date.now();
        this.lastProbeError = "mobile-mcp did not list its tools in time";
        return [];
      }
      const tools = this.remember(result.version, result.tools);
      if (tools.length === 0) {
        this.probeFailedAt = Date.now();
        this.lastProbeError = "mobile-mcp listed no tools the gateway can serve";
      }
      return tools;
    } catch (e) {
      if (!this.closing) console.error("gateway: could not list mobile-mcp tools:", messageOf(e));
      this.probeFailedAt = Date.now();
      this.lastProbeError = `could not list mobile-mcp tools: ${messageOf(e)}`;
      return [];
    } finally {
      this.probeSpawns.delete(spawned);
      clearTimeout(timer);
    }
  }

  /** A freshly started child tells the version it runs; a different one than the cache holds means the tool list may have changed. */
  private async refreshTools(client: GatewayClient): Promise<void> {
    const known = this.known();
    const version = client.version ?? null;
    if (known && known.mobileMcpVersion === version) return;
    this.remember(version, await client.listTools());
  }

  private drop(key: string, entry: PoolEntry): void {
    if (this.pool.get(key) === entry) this.pool.delete(key);
  }

  private start(key: string, cwd: string | undefined): PoolEntry {
    const entry: PoolEntry = { client: this.deps.spawnClient(childCwd(cwd)) };
    this.pool.set(key, entry);
    entry.client.then(
      (client) => {
        void client.exited.then(() => this.drop(key, entry));
        this.refreshTools(client).catch((e: unknown) => console.error("gateway: could not refresh the tool list:", messageOf(e)));
      },
      () => this.drop(key, entry),
    );
    return entry;
  }

  /**
   * One gated call on the child of `key` (a lease digest), started on first use. The timeout covers starting the child as well as the call.
   * Failures of the child (cannot start, crashed, timed out, protocol error, stopped because its lease ended) come back as an `isError` result;
   * a crashed or hung child is dropped and the next call restarts it. `onChildUp` runs once the child is up, right before the call is sent
   * (a cold start can take a minute: the caller renews the lease there).
   */
  async call(
    key: string,
    mobileDeviceId: string,
    cwd: string | undefined,
    tool: string,
    args: Record<string, unknown>,
    onChildUp?: () => void,
  ): Promise<ToolResult> {
    if (DROPPED_TOOLS.has(tool) || batchStepNames(args).some((name) => DROPPED_TOOLS.has(name))) {
      return errorResult(`${tool}: not available through the Tapocalypse gateway`);
    }
    if (this.closing) return errorResult(`${tool}: Tapocalypse is shutting down`);
    const timeoutMs = this.deps.callTimeoutMs ?? CALL_TIMEOUT_MS;
    const timeout = Promise.withResolvers<{ kind: "timeout" }>();
    const timer = setTimeout(() => timeout.resolve({ kind: "timeout" }), timeoutMs);
    const timedOut = `mobile-mcp timed out after ${Math.round(timeoutMs / 1000)} s on ${tool}; it was restarted for the next call`;
    const entry = this.pool.get(key) ?? this.start(key, cwd);
    try {
      const up = await Promise.race([
        entry.client.then(
          (client) => ({ kind: "up" as const, client }),
          (error: unknown) => ({ kind: "startFailed" as const, error }),
        ),
        timeout.promise,
      ]);
      if (up.kind === "timeout") {
        this.drop(key, entry);
        void entry.client.then((client) => client.close()).catch(() => {});
        return errorResult(timedOut);
      }
      if (up.kind === "startFailed") {
        this.drop(key, entry);
        return errorResult(`mobile-mcp could not start: ${messageOf(up.error)}`);
      }
      const { client } = up;
      if (this.stopped.has(entry)) return errorResult(this.stoppedMessage(tool));
      onChildUp?.();
      const outcome = await Promise.race([
        client.callTool(tool, rewriteArgs({ name: tool, inputSchema: { type: "object" } }, args, mobileDeviceId), timeoutMs).then(
          (result) => ({ kind: "result" as const, result }),
          (error: unknown) => ({ kind: "failed" as const, error }),
        ),
        client.exited.then(() => ({ kind: "exited" as const })),
        timeout.promise,
      ]);
      switch (outcome.kind) {
        case "result":
          return outcome.result;
        case "failed":
          return errorResult(this.stopped.has(entry) ? this.stoppedMessage(tool) : `mobile-mcp: ${messageOf(outcome.error)}`);
        case "exited":
          this.drop(key, entry);
          return errorResult(this.stopped.has(entry) ? this.stoppedMessage(tool) : `mobile-mcp stopped during ${tool}; the next call starts it again`);
        case "timeout":
          this.drop(key, entry);
          void client.close().catch(() => {});
          return errorResult(timedOut);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private stoppedMessage(tool: string): string {
    return this.closing ? `mobile-mcp stopped during ${tool}: Tapocalypse is shutting down` : `The lease ended during ${tool}; mobile-mcp was stopped`;
  }

  /** Stops the child of `key` (SIGTERM through the client); idempotent. */
  async stop(key: string): Promise<void> {
    const entry = this.pool.get(key);
    if (!entry) return;
    this.pool.delete(key);
    this.stopped.add(entry);
    await entry.client.then((client) => client.close()).catch(() => {});
  }

  /** Shutdown: refuses new calls and probes, then stops every child (also one that is still starting) and a probe child in flight. */
  async stopAll(): Promise<void> {
    this.closing = true;
    while (this.pool.size > 0) await Promise.all([...this.pool.keys()].map((key) => this.stop(key)));
    await Promise.all([...this.probeSpawns].map((spawned) => spawned.then((client) => client.close()).catch(() => {})));
  }
}

/** The command that starts one mobile-mcp child: the same `npx` spec runs use, or `MOBILE_MCP_BIN` (space-separated argv, for tests and pinned installs). */
function mobileMcpCommand(): string[] {
  const bin = process.env.MOBILE_MCP_BIN?.trim();
  return bin ? bin.split(/\s+/) : ["npx", "-y", `${MOBILE_MCP_PACKAGE}@latest`];
}

/** The real child: a stdio MCP client over mobile-mcp. */
export async function spawnMobileMcp(cwd: string): Promise<GatewayClient> {
  const [command = "npx", ...args] = mobileMcpCommand();
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined) env[name] = value;
  const transport = new StdioClientTransport({ command, args, cwd, env, stderr: "pipe" });
  let stderrTail = "";
  transport.stderr?.on("data", (chunk: Buffer | string) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-500);
  });
  const exit = Promise.withResolvers<void>();
  const client = new Client({ name: "tapocalypse-gateway", version: pkg.version });
  client.onclose = () => exit.resolve();
  try {
    await client.connect(transport);
  } catch (e) {
    await client.close().catch(() => {});
    throw new Error(`${messageOf(e)}${stderrTail.trim() ? ` (${stderrTail.trim()})` : ""}`);
  }
  return {
    exited: exit.promise,
    version: client.getServerVersion()?.version ?? null,
    async listTools() {
      const tools: unknown[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined);
        tools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor);
      return servableTools(tools);
    },
    async callTool(name, toolArgs, timeoutMs) {
      // The gateway enforces `timeoutMs` itself (and restarts the child); the SDK timeout is only a backstop.
      const result = await client.callTool({ name, arguments: toolArgs }, { timeout: timeoutMs + 5_000 });
      return {
        content: result.content,
        ...(result.isError !== undefined ? { isError: result.isError } : {}),
        ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
      };
    },
    close: () => client.close(),
  };
}

/** The process-wide gateway. */
export const gateway = new Gateway({ spawnClient: spawnMobileMcp, cacheFile: path.join(DATA_DIR, "gateway-tools.json") });

/** Stops a lease's child the moment the lease ends (released, revoked, expired or gone). */
export function stopOnLeaseEnd(ends: Pick<LeaseStore["ends"], "on">, gw: Pick<Gateway, "stop">): void {
  ends.on("end", (key) => {
    gw.stop(key).catch((e: unknown) => console.error("gateway: could not stop a lease's child:", messageOf(e)));
  });
}
