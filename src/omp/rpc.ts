import type { Subprocess } from "bun";
import { OMP_BIN } from "../config";

/** A decoded stdout frame (or a synthetic `_raw` / `_stderr` frame). */
export type Frame = { type: string; [key: string]: unknown };

export type HostToolHandler = (name: string, args: unknown) => Promise<string>;

/** Incremental `\n`-delimited JSON parser; unparseable lines become `_raw` frames. */
export class LineParser {
  private buf = "";
  private dec = new TextDecoder();

  constructor(private onFrame: (f: Frame) => void) {}

  push(chunk: Uint8Array | string): void {
    this.buf += typeof chunk === "string" ? chunk : this.dec.decode(chunk, { stream: true });
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (line.trim()) this.onFrame(parseLine(line));
    }
  }
}

function parseLine(line: string): Frame {
  try {
    const v: unknown = JSON.parse(line);
    if (v && typeof v === "object" && typeof (v as { type?: unknown }).type === "string") return v as Frame;
  } catch {}
  return { type: "_raw", line };
}

type Pending = { resolve: (data: unknown) => void; reject: (e: Error) => void };

export class OmpRpc {
  private proc: Subprocess<"pipe", "pipe", "pipe">;
  private pending = new Map<string, Pending>();
  private nextId = 0;
  private hostToolHandler: HostToolHandler | null = null;
  private readyPromise: Promise<void>;
  private exitCode: number | null = null;
  readonly exited: Promise<number>;

  constructor(opts: { args: string[]; cwd: string; onFrame: (f: Frame) => void; onExit: (code: number) => void }) {
    const proc = Bun.spawn([OMP_BIN, "--mode", "rpc", "--no-ui", ...opts.args], {
      cwd: opts.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.proc = proc;

    const { promise: readyPromise, resolve: markReady, reject: failReady } = Promise.withResolvers<void>();
    this.readyPromise = readyPromise;
    let isReady = false;
    const readyTimer = setTimeout(() => failReady(new Error("omp did not become ready")), 30_000);

    const parser = new LineParser((f) => {
      try {
        if (f.type === "ready" && !isReady) {
          isReady = true;
          clearTimeout(readyTimer);
          markReady();
        } else if (f.type === "response") this.onResponse(f);
        else if (f.type === "host_tool_call") void this.onHostToolCall(f);
      } catch (e) {
        console.error(`omp frame dispatch failed (${f.type}):`, e);
      }
      try {
        opts.onFrame(f);
      } catch (e) {
        console.error(`omp onFrame failed (${f.type}):`, e);
      }
    });

    const stdout = (async () => {
      for await (const chunk of proc.stdout) parser.push(chunk);
    })();
    const stderr = (async () => {
      const dec = new TextDecoder();
      for await (const chunk of proc.stderr) opts.onFrame({ type: "_stderr", text: dec.decode(chunk) });
    })();

    this.exited = (async () => {
      const code = await proc.exited;
      // Drain remaining output so the final frames are delivered before onExit.
      await Promise.allSettled([stdout, stderr]);
      this.exitCode = code;
      clearTimeout(readyTimer);
      if (!isReady) failReady(new Error("omp did not become ready"));
      for (const p of this.pending.values()) p.reject(new Error("omp exited"));
      this.pending.clear();
      opts.onExit(code);
      return code;
    })();
    // The ready promise may legitimately be rejected without anyone awaiting it (exit after ready failure).
    this.readyPromise.catch(() => {});
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  /** Sends a command and resolves with the matching response's `data`. */
  send(cmd: { type: string; [key: string]: unknown }): Promise<unknown> {
    if (this.exitCode !== null) return Promise.reject(new Error("omp exited"));
    const id = `req_${++this.nextId}`;
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    this.pending.set(id, { resolve, reject });
    this.write({ ...cmd, id });
    return promise;
  }

  setHostToolHandler(fn: HostToolHandler): void {
    this.hostToolHandler = fn;
  }

  closeStdin(): void {
    try {
      this.proc.stdin.end();
    } catch {}
  }

  kill(): void {
    if (this.exitCode !== null) return;
    this.proc.kill("SIGTERM");
    const t = setTimeout(() => {
      if (this.exitCode === null) this.proc.kill("SIGKILL");
    }, 5_000);
    void this.exited.then(() => clearTimeout(t));
  }

  private write(obj: unknown): void {
    if (this.exitCode !== null) return;
    try {
      this.proc.stdin.write(JSON.stringify(obj) + "\n");
      this.proc.stdin.flush();
    } catch {}
  }

  private onResponse(f: Frame): void {
    const id = typeof f.id === "string" ? f.id : "";
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    if (f.success === false) p.reject(new Error(typeof f.error === "string" ? f.error : JSON.stringify(f.error)));
    else p.resolve(f.data);
  }

  private async onHostToolCall(f: Frame): Promise<void> {
    const reply = (text: string, isError: boolean) =>
      this.write({
        type: "host_tool_result",
        id: f.id,
        result: { content: [{ type: "text", text }] },
        ...(isError ? { isError: true } : {}),
      });
    if (!this.hostToolHandler) return reply(`no handler for host tool ${String(f.toolName)}`, true);
    try {
      reply(await this.hostToolHandler(String(f.toolName), f.arguments), false);
    } catch (e) {
      reply((e as Error).message, true);
    }
  }
}
