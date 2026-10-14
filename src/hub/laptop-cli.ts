// `tapocalypse hub login|status|push|unpublish|pack`: the laptop side of the team hub.
// `login` and `pack` work on this machine alone; `status`, `push` and `unpublish` ask the running server, which owns the outbox.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { EXIT } from "../cli";
import { HUB_URL_PROBLEM, isSecureHubUrl } from "../config";
import { getRun } from "../runs/store";
import { getProject, type Project } from "../projects/registry";
import type { Run } from "../runs/types";
import { readHubConfig } from "./credentials";
import { packageRun, type PackagedRun } from "./package";
import { HubSyncWorker, type PushSelection } from "./sync";

export interface HubCliApi {
  request<T>(method: "GET" | "POST" | "PUT", pathname: string, body?: unknown): Promise<T>;
}

export interface HubCliDeps {
  io: { out(text: string): void; err(text: string): void };
  env: Record<string, string | undefined>;
  /** A client for the running Tapocalypse server at `base` (`ApiClient` from `cli.ts`). */
  api: (base: string) => HubCliApi;
  /** Asks for the upload token on the terminal when it was not given. Defaults to a masked prompt (a line from stdin when piped). */
  readToken?: () => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
  /** This machine's runs and projects (`pack`, `push --dry-run`); tests replace parts. */
  local?: { getProject?: (id: string) => Project | undefined };
}

export const HUB_LAPTOP_USAGE = `  tapocalypse hub login <hub-url> [--token <token>] [--header "Name: value"]... [--screenshots webp|original]
      Connect the running Tapocalypse server to a team hub: the server checks the address and the upload token against the
      hub, then saves the address in its config and the token (and optional access-proxy headers) in hub-credentials.json,
      readable only by you. The token comes from --token, TAPOCALYPSE_HUB_TOKEN or a prompt. The server must be running.
  tapocalypse hub status [--json] [--url <server>]
      The connection, the upload queue and the projects that are shared.
  tapocalypse hub push [<runId>...] [--all] [--project <id>] [--since <date>] [--failed] [--verify] [--wait] [--dry-run] [--json] [--url <server>]
      Upload finished runs of shared projects now (backfill, or retry): oldest first, in the background of the running server.
      --verify asks the hub which runs it still has (after a restore from backup); --dry-run packages locally and prints what
      would be sent, including how much was redacted, without sending anything; --wait follows the queue until it is empty.
  tapocalypse hub unpublish <runId> | --project <id> [--url <server>]
      Remove this machine's copy of a run (or of every run of a project) from the hub. The local runs stay.
  tapocalypse hub pack <runId> --out <dir> [--json]
      Write exactly what would be uploaded for a run (the document and its files) to <dir>, for inspection.`;

class UsageProblem extends Error {}

const StatusWire = z.object({
  configured: z.boolean(),
  url: z.string().nullable(),
  connection: z.object({ state: z.string(), machine: z.string().nullable(), hubVersion: z.string().nullable(), checkedAt: z.string().nullable(), detail: z.string().nullable() }),
  queue: z.object({ waiting: z.number(), uploading: z.string().nullable(), failed: z.number(), parked: z.number(), uploaded: z.number(), backfill: z.object({ total: z.number(), done: z.number() }).nullable() }),
  paused: z.object({ reason: z.string(), detail: z.string(), at: z.string() }).nullable(),
  lastUploadAt: z.string().nullable(),
  sharedProjects: z.array(z.object({ id: z.string(), name: z.string(), hubKey: z.string() })),
});
type StatusWire = z.infer<typeof StatusWire>;
/** `PUT /api/hub/connection` answers the hub status plus where the server keeps the token. */
const ConnectedWire = StatusWire.extend({ credentials: z.object({ file: z.string() }) });
const ProgressWire = StatusWire.pick({ queue: true, paused: true });
const UploadedWire = z.object({ runIds: z.array(z.string()) });
const PushWire = z.object({ queued: z.number(), verified: z.object({ checked: z.number(), requeued: z.number() }).optional() });

const serverBase = (url: string | undefined, env: Record<string, string | undefined>): string => {
  const raw = url ?? env.TAPOCALYPSE_URL ?? `http://127.0.0.1:${env.TAPOCALYPSE_PORT ?? 4310}`;
  try {
    return new URL(raw).origin;
  } catch {
    throw new UsageProblem(`invalid --url "${raw}"`);
  }
};

function options<T extends Record<string, { type: "string" | "boolean"; multiple?: boolean; short?: string }>>(args: string[], spec: T) {
  try {
    return parseArgs({ args, options: spec, allowPositionals: true });
  } catch (e) {
    throw new UsageProblem(e instanceof Error ? e.message : String(e));
  }
}

function isoDate(text: string): string {
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) throw new UsageProblem(`invalid date "${text}" (use for example 2026-03-01)`);
  return new Date(ms).toISOString();
}

/** A hub address: https, or plain http for this machine only. Returns it without a trailing slash. */
function hubUrl(text: string | undefined): string {
  if (!text) throw new UsageProblem("usage: tapocalypse hub login <hub-url>");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new UsageProblem(`invalid hub address "${text}"`);
  }
  if (!isSecureHubUrl(url.href)) throw new UsageProblem(HUB_URL_PROBLEM);
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

/** Reads a secret from the terminal without echo, or one line from a pipe. */
async function promptToken(): Promise<string> {
  if (!process.stdin.isTTY) return (await Bun.stdin.text()).split("\n")[0].trim();
  process.stderr.write("Upload token: ");
  const { promise, resolve } = Promise.withResolvers<string>();
  let typed = "";
  process.stdin.setRawMode(true);
  process.stdin.resume();
  const onData = (chunk: Buffer): void => {
    for (const ch of chunk.toString("utf8")) {
      if (ch === "\r" || ch === "\n" || ch === "\u0004") {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.off("data", onData);
        process.stderr.write("\n");
        resolve(typed.trim());
        return;
      }
      if (ch === "\u0003") process.exit(130);
      if (ch === "\u007f") typed = typed.slice(0, -1);
      else typed += ch;
    }
  };
  process.stdin.on("data", onData);
  return promise;
}

/**
 * `hub login <url>`: the running server saves the connection (address in its config, token in its mode-600 credentials file)
 * and tests it. The CLI never writes those files itself: it may resolve a different config than the server (another
 * TAPOCALYPSE_CONFIG, a background service), and a login the server cannot see would report success and upload nothing.
 */
async function login(args: string[], deps: HubCliDeps): Promise<number> {
  const { values, positionals } = options(args, { token: { type: "string" }, header: { type: "string", multiple: true }, screenshots: { type: "string" }, url: { type: "string" } });
  const url = hubUrl(positionals[0]);
  const shots = z.enum(["webp", "original"]).optional().safeParse(values.screenshots);
  if (!shots.success) throw new UsageProblem("--screenshots must be webp or original");
  const headers: Record<string, string> = {};
  for (const line of values.header ?? []) {
    const at = line.indexOf(":");
    if (at < 1) throw new UsageProblem(`--header must look like "Name: value", got "${line.split(":")[0]}"`);
    headers[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  const token = values.token?.trim() || deps.env.TAPOCALYPSE_HUB_TOKEN?.trim() || (deps.readToken ? await deps.readToken() : process.stdin.isTTY ? await promptToken() : "");
  if (!token) throw new UsageProblem("no upload token: pass --token, set TAPOCALYPSE_HUB_TOKEN, or run this in a terminal to be asked");

  const body = { url, token, ...(Object.keys(headers).length > 0 ? { headers } : {}), ...(shots.data ? { screenshots: shots.data } : {}) };
  let saved: z.infer<typeof ConnectedWire>;
  try {
    saved = ConnectedWire.parse(await deps.api(serverBase(values.url, deps.env)).request<unknown>("PUT", "/api/hub/connection", body));
  } catch (e) {
    deps.io.err(`could not save the connection: ${e instanceof Error ? e.message : String(e)}`);
    return EXIT.ERROR;
  }
  const c = saved.connection;
  if (c.state !== "ok") {
    deps.io.err(`saved, but the hub could not be reached as configured: ${c.detail ?? c.state}${c.state === "proxy_login" ? "\nIf the hub sits behind an access proxy, pass its service token with --header \"Name: value\"." : ""}`);
    return EXIT.ERROR;
  }
  deps.io.out(`Connected to ${new URL(url).host} as ${c.machine ?? "this machine"} (hub ${c.hubVersion ?? "?"}).`);
  deps.io.out(`The server saved the address in its config and the token in ${saved.credentials.file} (readable only by you).`);
  deps.io.out("Turn on \"Share with team hub\" for a project to start uploading its finished runs; `tapocalypse hub status` shows the queue.");
  return EXIT.OK;
}

const relative = (iso: string | null): string => (iso ? iso.replace("T", " ").replace(/\.\d+Z$/, "Z") : "never");

async function status(args: string[], deps: HubCliDeps): Promise<number> {
  const { values } = options(args, { json: { type: "boolean" }, url: { type: "string" } });
  const api = deps.api(serverBase(values.url, deps.env));
  let raw = await api.request<unknown>("GET", "/api/hub/status");
  // The server has not probed the hub since it started: do it now so the answer is current.
  const first = StatusWire.safeParse(raw);
  if (first.success && first.data.configured && first.data.connection.state === "unknown") raw = await api.request<unknown>("POST", "/api/hub/test", {});
  if (values.json) {
    deps.io.out(JSON.stringify(raw, null, 2));
    return EXIT.OK;
  }
  const s: StatusWire = StatusWire.parse(raw);
  if (!s.configured) {
    deps.io.out("No team hub is set up on this machine.\nConnect one with: tapocalypse hub login <hub-url>");
    return EXIT.OK;
  }
  const c = s.connection;
  deps.io.out(`Team hub: ${s.url}`);
  deps.io.out(`Connection: ${c.state}${c.machine ? ` as ${c.machine}` : ""}${c.hubVersion ? ` (hub ${c.hubVersion})` : ""}${c.detail ? ` - ${c.detail}` : ""}${c.checkedAt ? ` [checked ${relative(c.checkedAt)}]` : ""}`);
  const q = s.queue;
  deps.io.out(`Uploads: ${q.uploaded} uploaded, ${q.waiting} waiting, ${q.failed} failed${q.parked > 0 ? `, ${q.parked} not uploaded (id conflict)` : ""}${q.uploading ? `, uploading ${q.uploading}` : ""}`);
  if (q.backfill) deps.io.out(`Backfill: ${q.backfill.done} of ${q.backfill.total} existing runs`);
  deps.io.out(`Last upload: ${relative(s.lastUploadAt)}`);
  if (s.paused) {
    const fix = s.paused.reason === "protocol_unsupported" ? "update Tapocalypse on this machine" : "check the token: tapocalypse hub login <hub-url>";
    deps.io.out(`Paused (${s.paused.reason}): ${s.paused.detail}\n  Uploads resume on their own once fixed: ${fix}.`);
  }
  deps.io.out(s.sharedProjects.length > 0 ? `Shared projects: ${s.sharedProjects.map((p) => `${p.id} (${p.hubKey})`).join(", ")}` : "Shared projects: none. Turn on \"Share with team hub\" in a project's settings.");
  return EXIT.OK;
}

async function push(args: string[], deps: HubCliDeps): Promise<number> {
  const { values, positionals } = options(args, { all: { type: "boolean" }, project: { type: "string" }, since: { type: "string" }, failed: { type: "boolean" }, verify: { type: "boolean" }, wait: { type: "boolean" }, "dry-run": { type: "boolean" }, json: { type: "boolean" }, url: { type: "string" } });
  const selection: PushSelection = {
    ...(positionals.length > 0 ? { runIds: positionals } : {}),
    ...(values.project ? { projectId: values.project } : {}),
    ...(values.since ? { since: isoDate(values.since) } : {}),
    ...(values.all ? { all: true } : {}),
    ...(values.failed ? { failed: true } : {}),
  };
  if (Object.keys(selection).length === 0) throw new UsageProblem("say what to push: a run id, --all, --project <id>, --since <date> or --failed");
  if (values["dry-run"]) return dryRun(selection, values.json === true, deps);

  const api = deps.api(serverBase(values.url, deps.env));
  const result = PushWire.parse(await api.request<unknown>("POST", "/api/hub/push", { ...selection, ...(values.verify ? { verify: true } : {}) }));
  if (values.json) deps.io.out(JSON.stringify(result));
  else {
    if (result.verified) deps.io.out(`Checked ${result.verified.checked} uploaded runs against the hub: ${result.verified.requeued} to send again.`);
    deps.io.out(`Queued ${result.queued} run${result.queued === 1 ? "" : "s"}. They upload one at a time in the background of the running server; \`tapocalypse hub status\` shows progress.`);
  }
  if (!values.wait) return EXIT.OK;

  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  for (;;) {
    await sleep(1000);
    const s = ProgressWire.parse(await api.request<unknown>("GET", "/api/hub/status"));
    if (s.paused) {
      deps.io.err(`uploads are paused: ${s.paused.detail}`);
      return EXIT.VERDICT;
    }
    if (s.queue.waiting + (s.queue.uploading ? 1 : 0) === 0) {
      deps.io.out(`Done: ${s.queue.uploaded} uploaded${s.queue.failed > 0 ? `, ${s.queue.failed} failed (they retry on their own)` : ""}.`);
      return s.queue.failed > 0 ? EXIT.VERDICT : EXIT.OK;
    }
    deps.io.err(`${s.queue.uploaded} uploaded, ${s.queue.waiting} waiting...`);
  }
}

const EXT: Record<string, string> = { "image/webp": "webp", "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "text/markdown": "md", "application/x-ndjson": "ndjson", "text/html": "html" };
const bytesText = (n: number): string => (n < 1024 ? `${n} B` : n < 1_048_576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1_048_576).toFixed(1)} MB`);

function redactionText(replaced: Record<string, number>): string {
  const kinds = Object.entries(replaced).filter(([, n]) => n > 0);
  return kinds.length === 0 ? "nothing needed redacting" : kinds.map(([kind, n]) => `${kind} x${n}`).join(", ");
}

/** What a package amounts to on the wire: the gzipped document plus the blobs the hub does not have yet are at most these sizes. */
function sizes(packaged: PackagedRun): { docBytes: number; docGzip: number; blobBytes: number } {
  const body = JSON.stringify(packaged.doc);
  return { docBytes: Buffer.byteLength(body), docGzip: Bun.gzipSync(body).length, blobBytes: [...packaged.blobs.values()].reduce((n, b) => n + b.bytes.length, 0) };
}

async function dryRun(selection: PushSelection, json: boolean, deps: HubCliDeps): Promise<number> {
  const worker = new HubSyncWorker({ getProject: deps.local?.getProject ?? getProject });
  const runs = worker.candidates(selection);
  const total = { docGzip: 0, blobBytes: 0, blobs: new Set<string>() };
  const redactions: Record<string, number> = {};
  const failures: string[] = [];
  for (const run of runs) {
    const project = (deps.local?.getProject ?? getProject)(run.projectId);
    if (!project) continue;
    try {
      const packaged = await packageRun(run, project, {});
      const s = sizes(packaged);
      total.docGzip += s.docGzip;
      for (const [sha, blob] of packaged.blobs) {
        if (!total.blobs.has(sha)) total.blobBytes += blob.bytes.length;
        total.blobs.add(sha);
      }
      for (const [kind, n] of Object.entries(packaged.doc.redaction.replaced)) redactions[kind] = (redactions[kind] ?? 0) + n;
    } catch (e) {
      failures.push(`${run.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (json) {
    deps.io.out(JSON.stringify({ runs: runs.map((r) => r.id), documentBytesGzip: total.docGzip, blobs: total.blobs.size, blobBytes: total.blobBytes, redactions, failures }, null, 2));
    return EXIT.OK;
  }
  deps.io.out(`Dry run: ${runs.length} run${runs.length === 1 ? "" : "s"} would be uploaded (nothing was sent).`);
  for (const run of runs.slice(0, 20)) deps.io.out(`  ${run.id}  ${run.title}`);
  if (runs.length > 20) deps.io.out(`  ... and ${runs.length - 20} more`);
  deps.io.out(`Size: ${bytesText(total.docGzip)} of documents (gzipped) and ${total.blobs.size} files, ${bytesText(total.blobBytes)}.`);
  deps.io.out(`Redactions: ${redactionText(redactions)}.`);
  for (const f of failures) deps.io.err(`cannot package ${f}`);
  return failures.length > 0 ? EXIT.ERROR : EXIT.OK;
}

async function unpublish(args: string[], deps: HubCliDeps): Promise<number> {
  const { values, positionals } = options(args, { project: { type: "string" }, url: { type: "string" } });
  if (positionals.length === 0 && !values.project) throw new UsageProblem("usage: tapocalypse hub unpublish <runId> | --project <id>");
  const api = deps.api(serverBase(values.url, deps.env));
  const ids = [...positionals];
  // The outbox knows what this machine put on the hub, whatever state the runs or the project are in now.
  if (values.project) ids.push(...UploadedWire.parse(await api.request<unknown>("GET", `/api/hub/uploaded?project=${encodeURIComponent(values.project)}`)).runIds);
  for (const id of ids) await api.request<unknown>("POST", `/api/runs/${encodeURIComponent(id)}/unpublish`, {});
  deps.io.out(ids.length === 1 ? `Removed ${ids[0]} from the hub.` : `Removed ${ids.length} runs from the hub.`);
  return EXIT.OK;
}

async function pack(args: string[], deps: HubCliDeps): Promise<number> {
  const { values, positionals } = options(args, { out: { type: "string" }, json: { type: "boolean" } });
  if (positionals.length !== 1 || !values.out) throw new UsageProblem("usage: tapocalypse hub pack <runId> --out <dir>");
  const run: Run | null = getRun(positionals[0]);
  const project = run ? (deps.local?.getProject ?? getProject)(run.projectId) : undefined;
  if (!run || !project) {
    deps.io.err(run ? `project ${run.projectId} of run ${run.id} is not on this machine's list` : `unknown run ${positionals[0]}`);
    return EXIT.USAGE;
  }
  let packaged: PackagedRun;
  try {
    packaged = await packageRun(run, project, { screenshots: readHubConfig()?.screenshots ?? "webp" });
  } catch (e) {
    deps.io.err(e instanceof Error ? e.message : String(e));
    return EXIT.ERROR;
  }
  const out = path.resolve(values.out);
  fs.mkdirSync(path.join(out, "blobs"), { recursive: true });
  fs.writeFileSync(path.join(out, "upload.json"), `${JSON.stringify(packaged.doc, null, 2)}\n`);
  for (const [sha, blob] of packaged.blobs) fs.writeFileSync(path.join(out, "blobs", `${sha}.${EXT[blob.type] ?? "bin"}`), blob.bytes);
  const s = sizes(packaged);
  if (values.json) {
    deps.io.out(JSON.stringify({ out, runId: run.id, documentBytes: s.docBytes, documentBytesGzip: s.docGzip, blobs: packaged.blobs.size, blobBytes: s.blobBytes, redactions: packaged.doc.redaction.replaced }, null, 2));
    return EXIT.OK;
  }
  deps.io.out(`Wrote what would be uploaded for ${run.id} to ${out}`);
  deps.io.out(`  upload.json  the run document (${bytesText(s.docBytes)}, ${bytesText(s.docGzip)} gzipped)`);
  deps.io.out(`  blobs/       ${packaged.blobs.size} file${packaged.blobs.size === 1 ? "" : "s"}, ${bytesText(s.blobBytes)}: the report, the activity feed and ${packaged.doc.screenshots.length} screenshot(s)`);
  deps.io.out(`Redactions: ${redactionText(packaged.doc.redaction.replaced)}.`);
  deps.io.out("Raw agent events, session files, stderr, the run's MCP token and device serials are never uploaded.");
  return EXIT.OK;
}

const COMMANDS = { login, status, push, unpublish, pack } as const;
export type HubLaptopCommand = keyof typeof COMMANDS;
export const HUB_LAPTOP_COMMANDS: readonly string[] = Object.keys(COMMANDS);

/** Runs `tapocalypse hub <sub> ...args` and returns the exit code. Server and hub errors propagate for the caller's error mapping. */
export async function runHubLaptopCommand(sub: HubLaptopCommand, args: string[], deps: HubCliDeps): Promise<number> {
  try {
    return await COMMANDS[sub](args, deps);
  } catch (e) {
    if (!(e instanceof UsageProblem)) throw e;
    deps.io.err(`error: ${e.message}`);
    return EXIT.USAGE;
  }
}
