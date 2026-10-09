/** One `codex exec --json` process: argv/config building, stdout JSONL → normalized events, prompt via stdin, escalating abort. */
import { chmodSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { RunUsage } from "../../runs/types";
import { failedSession } from "../failed";
import type { HarnessExit, HarnessSession, McpServerSpec, SessionInfo, SpawnOptions } from "../types";
import { CodexTranslator, codexToolName } from "./events";

/** The slice of a child process the session uses (Bun's `Subprocess<"pipe","pipe","pipe">` satisfies it). */
export interface CodexProcess {
  stdin: { write(data: string | Uint8Array): unknown; end(): unknown };
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  signalCode?: string | null;
  kill(signal?: NodeJS.Signals): void;
}

export type CodexSpawn = (cmd: string[], opts: { cwd: string; env: Record<string, string | undefined> }) => CodexProcess;

export interface CodexTiming {
  /** How long a process gets to exit after SIGINT before SIGTERM, and after SIGTERM before SIGKILL. */
  sigintGraceMs: number;
  termGraceMs: number;
}

export const DEFAULT_TIMING: CodexTiming = { sigintGraceMs: 10_000, termGraceMs: 5_000 };

const settingsSchema = z.object({
  bin: z.string().min(1).optional(),
  sandbox: z.enum(["danger-full-access", "workspace-write"]).optional(),
});

const TOOL_TIMEOUT_SEC = 300;
const STARTUP_TIMEOUT_SEC = 60;

// ---- TOML values for `-c key=value` ---------------------------------------------------------------------------------

/** TOML basic string: escapes `\`, `"`, control characters and DEL; a lone surrogate (not representable) becomes U+FFFD. */
export function tomlString(s: string): string {
  let out = '"';
  for (const ch of s.toWellFormed()) {
    const cp = ch.codePointAt(0) ?? 0;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (cp < 0x20 || cp === 0x7f) out += `\\u${cp.toString(16).toUpperCase().padStart(4, "0")}`;
    else out += ch;
  }
  return `${out}"`;
}

/** Bare key when TOML allows it, else a quoted key. */
function tomlKey(k: string): string {
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : tomlString(k);
}

function tomlInlineTable(entries: Record<string, string>): string {
  const body = Object.entries(entries)
    .map(([k, v]) => `${tomlKey(k)} = ${tomlString(v)}`)
    .join(", ");
  return `{ ${body} }`;
}

// ---- argv -----------------------------------------------------------------------------------------------------------

/** Codex versions differ on HTTP MCP servers (`url` is newer, some need an experimental flag), and every one speaks stdio, so http servers go through this bridge. */
const STDIO_BRIDGE = path.resolve(import.meta.dir, "../../mcp/stdio-bridge.ts");

/** Writes `<runDir>/<name>-mcp.json` (`{url, token}`, owner-only) for the stdio bridge and returns its path. The token never reaches argv or env. */
function writeBridgeCredentials(runDir: string, spec: Extract<McpServerSpec, { transport: "http" }>): string {
  const authorization = Object.entries(spec.headers).find(([name]) => name.toLowerCase() === "authorization")?.[1];
  const token = authorization === undefined ? undefined : /^Bearer\s+(.+)$/i.exec(authorization)?.[1];
  if (token === undefined) throw new Error(`MCP server ${spec.name} needs an "Authorization: Bearer <token>" header`);
  const file = path.join(runDir, `${spec.name}-mcp.json`);
  writeFileSync(file, JSON.stringify({ url: spec.url, token }), { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

/** `-c mcp_servers.<name>.…` pairs for one server. */
function mcpServerConfig(spec: McpServerSpec, runDir: string): string[] {
  const key = `mcp_servers.${tomlKey(spec.name)}`;
  const kv: string[] = [];
  if (spec.transport === "http") {
    const credentials = writeBridgeCredentials(runDir, spec);
    kv.push(`${key}.command=${tomlString(process.execPath)}`);
    kv.push(`${key}.args=[${[STDIO_BRIDGE, credentials].map(tomlString).join(",")}]`);
  } else {
    kv.push(`${key}.command=${tomlString(spec.command)}`);
    kv.push(`${key}.args=[${spec.args.map(tomlString).join(",")}]`);
    if (spec.env && Object.keys(spec.env).length > 0) kv.push(`${key}.env=${tomlInlineTable(spec.env)}`);
  }
  kv.push(
    `${key}.required=true`,
    `${key}.default_tools_approval_mode=${tomlString("auto")}`,
    `${key}.tool_timeout_sec=${TOOL_TIMEOUT_SEC}`,
    `${key}.startup_timeout_sec=${STARTUP_TIMEOUT_SEC}`,
  );
  return kv;
}

export function buildCommand(opts: SpawnOptions): string[] {
  const settings = settingsSchema.parse(opts.settings);
  const bin = settings.bin ?? "codex";
  const sandbox = settings.sandbox ?? "danger-full-access";
  const config = [
    `approval_policy=${tomlString("never")}`,
    `developer_instructions=${tomlString(opts.persona)}`,
    ...(sandbox === "workspace-write" ? ["sandbox_workspace_write.network_access=true"] : []),
    ...opts.mcpServers.flatMap((s) => mcpServerConfig(s, opts.runDir)),
  ];
  const cmd = [bin, "exec", "--json", "--skip-git-repo-check", "-C", opts.cwd, "--sandbox", sandbox];
  for (const c of config) cmd.push("-c", c);
  if (opts.model) cmd.push("-m", opts.model);
  if (opts.effort) cmd.push("-c", `model_reasoning_effort=${tomlString(opts.effort)}`);
  cmd.push("-");
  return cmd;
}

// ---- session --------------------------------------------------------------------------------------------------------

export function startSession(spawn: CodexSpawn, opts: SpawnOptions, timing: CodexTiming): HarnessSession {
  let proc: CodexProcess;
  try {
    proc = spawn(buildCommand(opts), { cwd: opts.cwd, env: { ...process.env } });
  } catch (e) {
    return failedSession(
      e instanceof z.ZodError ? `invalid codex settings: ${z.prettifyError(e)}` : `codex could not start: ${(e as Error).message}`,
      codexToolName,
    );
  }

  const translator = new CodexTranslator(
    opts.mcpServers.map((s) => s.name),
    opts.model,
  );
  const decoder = new TextDecoder();
  const emit = (fn: () => void, what: string) => {
    try {
      fn();
    } catch (e) {
      console.error(`codex ${what} failed:`, e);
    }
  };
  const onLine = (line: string) => {
    if (!line.trim()) return;
    let frame: object;
    try {
      frame = JSON.parse(line) as object;
    } catch {
      frame = { type: "_raw", line };
    }
    emit(() => opts.onRaw(frame), "onRaw");
    emit(() => {
      for (const e of translator.translate(frame)) emit(() => opts.onEvent(e), `onEvent(${e.type})`);
    }, "translate");
  };
  const stdout = (async () => {
    let buf = "";
    for await (const chunk of proc.stdout) {
      buf += decoder.decode(chunk, { stream: true });
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        onLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
      }
    }
    onLine(buf + decoder.decode());
  })();
  const stderr = (async () => {
    const dec = new TextDecoder();
    for await (const chunk of proc.stderr) emit(() => opts.onStderr(dec.decode(chunk, { stream: true })), "onStderr");
  })();

  let exitedFlag = false;
  const exited: Promise<HarnessExit> = (async () => {
    const code = await proc.exited;
    // Drain the remaining output so the final frames are delivered before the exit is reported.
    await Promise.allSettled([stdout, stderr]);
    exitedFlag = true;
    const startupError = [...translator.serverErrors.values()][0] ?? null;
    return {
      code,
      signal: proc.signalCode ?? null,
      settled: translator.settled,
      // `required=true` makes a failing MCP server end the process before any turn: that is an infra failure, not an agent one.
      started: translator.settled || startupError === null,
      limit: null,
      error: translator.error ?? (translator.settled ? null : startupError),
    };
  })();

  let sent = false;
  const waitExit = (ms: number) => Promise.race([exited.then(() => true), Bun.sleep(ms).then(() => false)]);
  let aborting: Promise<void> | null = null;

  return {
    async ready(): Promise<SessionInfo> {
      // `codex exec -` reads the whole prompt before it starts a thread, so nothing can be awaited here; `required=true`
      // makes a server that fails to start fail the process, which surfaces through `exited.error`.
      return { sessionId: null, model: opts.model, mcp: opts.mcpServers.map((s) => ({ name: s.name, ok: true })) };
    },
    toolName: codexToolName,
    async send(prompt: string) {
      if (sent) throw new Error("codex already received its prompt");
      if (exitedFlag) throw new Error("codex exited before the prompt was sent");
      sent = true;
      try {
        proc.stdin.write(prompt);
        proc.stdin.end();
      } catch (e) {
        throw new Error(`codex exited before the prompt was sent: ${(e as Error).message}`);
      }
    },
    abort() {
      aborting ??= (async () => {
        if (exitedFlag) return;
        proc.kill("SIGINT");
        if (await waitExit(timing.sigintGraceMs)) return;
        proc.kill("SIGTERM");
        if (await waitExit(timing.termGraceMs)) return;
        proc.kill("SIGKILL");
        await exited;
      })();
      return aborting;
    },
    kill() {
      if (exitedFlag) return;
      proc.kill("SIGTERM");
      void waitExit(timing.termGraceMs).then((gone) => {
        if (!gone) proc.kill("SIGKILL");
      });
    },
    async usage(): Promise<RunUsage | null> {
      return translator.usageSnapshot();
    },
    exited,
  };
}
