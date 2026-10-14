// The laptop's team-hub sync worker (research §3.5): finished runs of projects with `share: true` are packaged, their blobs
// and then the run document are uploaded to the hub, one run at a time, from a persisted outbox.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { config, DATA_DIR, type HubConfig } from "../config";
import { getProject, listProjects, type Project } from "../projects/registry";
import { getRun, listRuns, type RunChange, subscribeRuns } from "../runs/store";
import type { Run } from "../runs/types";
import { hubCredentialsPath, hubPaths, readHubConfig, type ResolvedHubCredentials, resolveHubCredentials } from "./credentials";
import { derivedHubKey, hubKeyFor } from "./identity";
import { packageRun, type PackagedRun } from "./package";
import { type BlobTypeT, BlobCheckResult, HUB_PROTOCOL, HubInfo, RunState, RunUploadResult, Sha256 } from "./protocol";

export interface HubSettings {
  url: string;
  screenshots: "webp" | "original";
  /** Static request headers from the config (the credentials file and environment add to them). */
  headers: Record<string, string>;
}

export interface HubSyncOptions {
  /** `<data>/hub-outbox.json`. */
  stateFile: string;
  settings: () => HubSettings | null;
  credentials: () => ResolvedHubCredentials;
  fetch: (req: Request) => Promise<Response>;
  getProject: (id: string) => Project | undefined;
  packageRun: (run: Run, project: Project, opts: { screenshots: "webp" | "original" }) => Promise<PackagedRun>;
  getRun: (id: string) => Run | null;
  /** Every stored run, newest first. */
  listRuns: () => Run[];
  subscribe: (fn: (change: RunChange) => void) => () => void;
  now: () => number;
  /** Packaging is debounced per run so a relink touching 20 runs is one batch. */
  debounceMs: number;
  /** While paused the worker looks again this often for changed credentials (a `hub login` run from the CLI). */
  pausePollMs: number;
}

const TERMINAL: readonly Run["status"][] = ["done", "error", "cancelled", "interrupted"];
const isTerminal = (status: Run["status"]): boolean => TERMINAL.includes(status);

const EntrySchema = z.object({
  runId: z.string(),
  queuedAt: z.string(),
  attempts: z.number().int().nonnegative(),
  nextAttemptAt: z.string(),
  lastError: z.string().nullable(),
  lastCode: z.string().nullable().default(null),
});
const UploadedSchema = z.object({ contentHash: z.string(), hubContentHash: z.string().optional(), at: z.string(), url: z.string() });
const PausedSchema = z.object({
  reason: z.enum(["protocol_unsupported", "unauthorized", "id_conflict"]),
  /** The error code behind the reason (`proxy_login` is an `unauthorized` pause). */
  code: z.string(),
  detail: z.string(),
  at: z.string(),
  /** Digest of the credentials the pause was decided with: a changed token, URL or header set resumes. */
  fingerprint: z.string(),
  /** Protocol this client spoke: a newer one (an upgrade) resumes a 426 pause. */
  protocol: z.number(),
});
const StateSchema = z.object({
  version: z.literal(1),
  queue: z.array(EntrySchema),
  uploaded: z.record(z.string(), UploadedSchema),
  /** The hub `uploaded` and `parked` refer to; another address means another hub, whose copies are not these. */
  hub: z.string().nullable().default(null),
  paused: PausedSchema.nullable().default(null),
  /** Runs the hub refused for good (409 id_conflict); never retried. */
  parked: z.record(z.string(), z.object({ detail: z.string(), at: z.string() })).default({}),
  /** Last time this worker was alive and wrote the outbox: a run that finished after it, while no worker was watching, is queued at the next start. */
  seenAt: z.string().nullable().default(null),
});
export type HubPaused = Pick<z.infer<typeof PausedSchema>, "reason" | "detail" | "at">;
type OutboxState = z.infer<typeof StateSchema>;

export type HubSyncStateName = "waiting" | "local" | "queued" | "uploading" | "uploaded" | "outdated" | "failed" | "paused" | "parked";
export interface HubSync {
  state: HubSyncStateName;
  url: string | null;
  uploadedAt: string | null;
  error: { code: string; detail: string } | null;
  attempts: number;
  nextAttemptAt: string | null;
}

let cachedHub: { file: string; mtimeMs: number; size: number; value: HubConfig | null } | null = null;

/**
 * The hub connection in force: `share.hub` of the config file, re-read whenever the file changes, so `tapocalypse hub login`
 * (a separate process) and the settings form take effect without a restart.
 */
export function activeHubConfig(): HubConfig | null {
  const file = hubPaths.configFile;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return config.share?.hub ?? null;
  }
  if (cachedHub && cachedHub.file === file && cachedHub.mtimeMs === stat.mtimeMs && cachedHub.size === stat.size) return cachedHub.value;
  let value: HubConfig | null;
  try {
    value = readHubConfig(file);
  } catch (e) {
    console.warn(`team hub: ignoring unreadable share.hub in ${file}: ${e instanceof Error ? e.message : String(e)}`);
    value = cachedHub?.value ?? config.share?.hub ?? null;
  }
  cachedHub = { file, mtimeMs: stat.mtimeMs, size: stat.size, value };
  return value;
}

/** Forgets the cached config so the next read looks at the file again. */
export function refreshHubConfig(): void {
  cachedHub = null;
}

function defaultOptions(): HubSyncOptions {
  return {
    stateFile: path.join(DATA_DIR, "hub-outbox.json"),
    settings: () => {
      const hub = activeHubConfig();
      return hub ? { url: hub.url, screenshots: hub.screenshots ?? "webp", headers: hub.headers ?? {} } : null;
    },
    credentials: () => resolveHubCredentials({ configHeaders: activeHubConfig()?.headers }),
    fetch: (req) => fetch(req),
    getProject,
    packageRun,
    getRun,
    listRuns,
    subscribe: subscribeRuns,
    now: () => Date.now(),
    debounceMs: 5000,
    pausePollMs: 30_000,
  };
}

export interface PushSelection {
  runIds?: string[];
  projectId?: string;
  /** ISO timestamp: only runs created at or after it. */
  since?: string;
  /** Re-queue runs that are already uploaded too (the hash check still sends nothing when they are unchanged). */
  all?: boolean;
  /** Retry the failed uploads now. */
  failed?: boolean;
}

export interface HubConnection {
  state: "ok" | "unauthorized" | "proxy_login" | "unreachable" | "protocol_unsupported" | "not_a_hub" | "unknown";
  machine: string | null;
  hubVersion: string | null;
  minProtocol: number | null;
  checkedAt: string | null;
  detail: string | null;
}

export interface HubQueueStatus {
  paused: HubPaused | null;
  connection: HubConnection;
  lastUploadAt: string | null;
  queue: { waiting: number; uploading: string | null; failed: number; parked: number; uploaded: number; backfill: { total: number; done: number } | null };
}

export type HubErrorCode = "unauthorized" | "proxy_login" | "protocol_unsupported" | "id_conflict" | "unreachable" | "too_large" | "not_a_hub" | "other";

/** A failed hub call, already classified. */
export class HubCallError extends Error {
  constructor(
    readonly code: HubErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** A response that is not what a hub answers, as the error the worker acts on. */
async function failureOf(res: Response, host: string): Promise<HubCallError> {
  const type = res.headers.get("content-type") ?? "";
  const isJson = type.includes("json");
  const body: unknown = isJson ? await res.json().catch(() => null) : null;
  const field = (name: string): unknown => (body !== null && typeof body === "object" && name in body ? (body as Record<string, unknown>)[name] : undefined);
  if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) return new HubCallError("proxy_login", `the access proxy in front of ${host} redirected to a login page; add its service token in Setup, or let /api/hub/v1/ through`);
  if (!isJson && res.status < 500) return new HubCallError("proxy_login", `${host} answered ${res.status} with a web page, not the hub's API: the access proxy wants a login`);
  if (res.status === 401) return new HubCallError("unauthorized", `${host} rejected the upload token`);
  if (res.status === 426) return new HubCallError("protocol_unsupported", `${host} needs protocol ${String(field("minProtocol") ?? "a newer")} or newer, this machine speaks protocol ${HUB_PROTOCOL}: update Tapocalypse`);
  if (res.status === 409 && field("code") === "id_conflict") return new HubCallError("id_conflict", "another machine already uploaded a run with this id");
  if (res.status === 413) return new HubCallError("too_large", `${host} refused the upload as too large`);
  if (res.status === 502 || res.status === 503 || res.status === 504) return new HubCallError("unreachable", `${host} is not answering (${res.status})`);
  const message = field("error") ?? field("code");
  return new HubCallError("other", `${host} answered ${res.status}${typeof message === "string" ? `: ${message}` : ""}`);
}

type HubCall = (route: string, init: RequestInit) => Promise<Response>;
interface Connection {
  call: HubCall;
  host: string;
  settings: HubSettings;
}
const MissingBlobsOrNotTerminal = z.union([z.object({ code: z.literal("missing_blobs"), missing: z.array(Sha256) }), z.object({ code: z.literal("not_terminal") })]);
const TEXT_BLOBS: readonly BlobTypeT[] = ["text/markdown", "application/x-ndjson", "text/html"];
const CHECK_BATCH = 500;

/** `check` the hashes (unless the hub already named them missing), then PUT each missing blob; text blobs travel gzipped. */
async function putMissingBlobs(call: HubCall, host: string, hashes: string[], blobs: PackagedRun["blobs"], check: boolean): Promise<void> {
  let missing = hashes;
  if (check) {
    missing = [];
    for (let i = 0; i < hashes.length; i += CHECK_BATCH) {
      const res = await call("/api/hub/v1/blobs/check", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sha256: hashes.slice(i, i + CHECK_BATCH) }) });
      if (!res.ok) throw await failureOf(res, host);
      missing.push(...BlobCheckResult.parse(await res.json()).missing);
    }
  }
  for (const hash of missing) {
    const blob = blobs.get(hash);
    if (!blob) throw new HubCallError("other", `${host} asked for blob ${hash.slice(0, 12)}, which this run does not have`);
    const gzip = TEXT_BLOBS.includes(blob.type);
    const res = await call(`/api/hub/v1/blobs/${hash}`, { method: "PUT", headers: { "content-type": blob.type, ...(gzip ? { "content-encoding": "gzip" } : {}) }, body: gzip ? Bun.gzipSync(blob.bytes) : blob.bytes });
    if (!res.ok) throw await failureOf(res, host);
  }
}

/** An authenticated caller for a hub: bearer token plus the proxy headers; redirects are not followed (a login redirect is an answer). */
export function makeConnection(settings: HubSettings, creds: Extract<ResolvedHubCredentials, { ok: true }>, doFetch: (req: Request) => Promise<Response>): Connection {
  const host = new URL(settings.url).host;
  const call: HubCall = async (route, init) => {
    try {
      return await doFetch(new Request(new URL(route, settings.url), { ...init, headers: { ...creds.headers, authorization: `Bearer ${creds.token}`, ...init.headers }, redirect: "manual" }));
    } catch (e) {
      throw new HubCallError("unreachable", `could not reach ${host}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  return { call, host, settings };
}

/** `GET /api/hub/v1/info` with the credentials: reachable, speaks the protocol, accepts the token. */
export async function probeHub(conn: Connection, checkedAt: string): Promise<HubConnection> {
  const result = (state: HubConnection["state"], detail: string | null, extra: Partial<HubConnection> = {}): HubConnection => ({ state, machine: null, hubVersion: null, minProtocol: null, ...extra, checkedAt, detail });
  try {
    const res = await conn.call("/api/hub/v1/info", { method: "GET" });
    const isJson = (res.headers.get("content-type") ?? "").includes("json");
    if (!isJson && res.status !== 401 && res.status !== 403 && (res.ok || res.status === 404)) return result("not_a_hub", `${conn.host} answered, but not like a Tapocalypse hub`);
    if (!res.ok) {
      const error = await failureOf(res, conn.host);
      const known = error.code === "unauthorized" || error.code === "proxy_login" || error.code === "protocol_unsupported" || error.code === "unreachable";
      return result(known ? error.code : res.status === 404 ? "not_a_hub" : "unknown", error.message);
    }
    const info = HubInfo.safeParse(await res.json().catch(() => null));
    if (!info.success) return result("not_a_hub", `${conn.host} answered, but not like a Tapocalypse hub`);
    const known = { machine: info.data.machine, hubVersion: info.data.version, minProtocol: info.data.minProtocol };
    if (info.data.machine === null) return result("unauthorized", `${conn.host} did not accept the upload token`, known);
    if (info.data.minProtocol > HUB_PROTOCOL) return result("protocol_unsupported", `${conn.host} needs protocol ${info.data.minProtocol} or newer, this machine speaks protocol ${HUB_PROTOCOL}: update Tapocalypse`, known);
    return result("ok", null, known);
  } catch (e) {
    return result("unreachable", e instanceof Error ? e.message : String(e));
  }
}

const DAY_MS = 86_400_000;
/** Runs younger than this are sent without asking the hub for its retention (a hub keeps at least a week). */
const MIN_RETENTION_DAYS = 7;
const RETENTION_TTL_MS = 3_600_000;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_CAP_MS = 3_600_000;
const backoffMs = (attempts: number): number => Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_CAP_MS);

export class HubSyncWorker {
  private readonly opts: HubSyncOptions;
  private state: OutboxState;
  private uploading: string | null = null;
  private draining: Promise<void> | null = null;
  private again = false;
  private unsubscribe: (() => void) | null = null;
  private readonly debounce = new Map<string, Timer>();
  private retryTimer: Timer | null = null;
  /** Runs saved again while their upload was in flight: the packaged copy being sent is already stale. */
  private readonly changedWhileUploading = new Set<string>();
  /** What the hub keeps (`retentionDays` of `GET /info`), for the hub the outbox is about; asked again after an hour. */
  private retention: { hub: string; days: number | null; at: number } | null = null;
  private readonly idleWaiters: (() => void)[] = [];
  private readonly listeners = new Set<(runId: string | null) => void>();
  private backfill: { ids: Set<string>; total: number; done: number } | null = null;
  private connection: HubConnection = { state: "unknown", machine: null, hubVersion: null, minProtocol: null, checkedAt: null, detail: null };

  constructor(opts: Partial<HubSyncOptions> = {}) {
    this.opts = { ...defaultOptions(), ...opts };
    this.state = this.load();
  }

  /** The persisted outbox; an absent file is an empty one, an unreadable file is kept as `<file>.corrupt` (not overwritten) and then also an empty one. */
  private load(): OutboxState {
    const file = this.opts.stateFile;
    const empty: OutboxState = { version: 1, queue: [], uploaded: {}, hub: null, paused: null, parked: {}, seenAt: null };
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      return empty;
    }
    try {
      return StateSchema.parse(JSON.parse(raw));
    } catch (e) {
      try {
        fs.renameSync(file, `${file}.corrupt`);
        console.warn(`team hub: ${file} is unreadable (${e instanceof Error ? e.message : String(e)}); kept as ${file}.corrupt and started a new outbox`);
      } catch {}
      return empty;
    }
  }

  private save(runId?: string): void {
    this.state.seenAt = new Date(this.opts.now()).toISOString();
    fs.mkdirSync(path.dirname(this.opts.stateFile), { recursive: true });
    const tmp = `${this.opts.stateFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, this.opts.stateFile);
    this.touch(runId);
  }

  /** Tells listeners (the SSE stream) that a run's sync state, or with no id the overall status, changed. */
  private touch(runId?: string): void {
    for (const fn of this.listeners) fn(runId ?? null);
  }

  /** `fn(runId)` after a run's sync state changed, `fn(null)` when only the queue status did. */
  onChange(fn: (runId: string | null) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Adds the run to the outbox. False when it is already waiting (a run being uploaded right now is sent again once it is done). */
  enqueue(runId: string): boolean {
    if (this.uploading === runId) this.changedWhileUploading.add(runId);
    if (this.state.queue.some((e) => e.runId === runId) || this.state.parked[runId]) return false;
    const at = new Date(this.opts.now()).toISOString();
    this.state.queue.push({ runId, queuedAt: at, attempts: 0, nextAttemptAt: at, lastError: null, lastCode: null });
    this.save(runId);
    if (this.unsubscribe) this.wake();
    return true;
  }

  /** Uploads every run that is due, one at a time. A caller arriving mid-pass shares it, and the pass looks again before it ends. */
  drain(): Promise<void> {
    if (this.draining) {
      this.again = true;
      return this.draining;
    }
    this.draining = (async () => {
      do {
        this.again = false;
        await this.runDrain();
      } while (this.again);
    })().finally(() => {
      this.draining = null;
      this.settle();
    });
    return this.draining;
  }

  private async runDrain(): Promise<void> {
    this.reconcileHub();
    this.resumeIfFixed();
    for (;;) {
      if (this.state.paused) return;
      const entry = this.state.queue.find((e) => Date.parse(e.nextAttemptAt) <= this.opts.now());
      if (!entry || (await this.attempt(entry.runId)) === "stop") return;
    }
  }

  /** Uploads one queued run. "stop" ends the pass (nothing can be sent right now); anything else moves on to the next entry. */
  private async attempt(runId: string): Promise<"next" | "stop"> {
    const run = this.opts.getRun(runId);
    const project = run ? this.opts.getProject(run.projectId) : undefined;
    // Gone, still running, or no longer shared: nothing to send. It re-enters the outbox on its next terminal save.
    if (!run || !project?.share || !isTerminal(run.status)) {
      this.finish(runId);
      return "next";
    }
    if (!this.opts.settings()) return "stop";
    this.uploading = runId;
    this.changedWhileUploading.delete(runId);
    this.touch(runId);
    try {
      const conn = this.connect();
      // A backfill reaches back years; the hub deletes what is older than its retention within hours, so sending that is wasted work.
      if (this.backfill?.ids.has(runId) && (await this.expiredOnHub(run, conn))) {
        this.finish(runId);
        return "next";
      }
      await this.upload(run, project, conn);
    } catch (e) {
      const error = e instanceof HubCallError ? e : new HubCallError("other", e instanceof Error ? e.message : String(e));
      if (error.code === "unauthorized" || error.code === "proxy_login" || error.code === "protocol_unsupported") {
        this.pause(error);
        return "stop";
      }
      if (error.code === "id_conflict") {
        this.state.parked[runId] = { detail: error.message, at: new Date(this.opts.now()).toISOString() };
        this.finish(runId);
        return "next";
      }
      this.fail(runId, error);
    } finally {
      this.uploading = null;
      this.touch(runId);
    }
    return "next";
  }

  /** Subscribes to run saves; finished runs of shared projects are queued after a short debounce and uploaded in the background. */
  start(): void {
    if (this.unsubscribe) return;
    this.queueRunsFinishedWhileAway();
    this.unsubscribe = this.opts.subscribe((change) => {
      if ("deleted" in change) this.forget(change.deleted);
      else this.onSaved(change.saved);
    });
    this.wake();
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    // A save still waiting out its debounce is queued now (not uploaded: the process is going away), so the next start sends it.
    const pending = [...this.debounce.keys()];
    for (const timer of this.debounce.values()) clearTimeout(timer);
    this.debounce.clear();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    await this.draining?.catch(() => {});
    for (const runId of pending) this.guarded("queueing a run at shutdown", () => this.enqueue(runId));
    this.guarded("saving the outbox at shutdown", () => this.save());
    this.settle();
  }

  /** Runs a background step; a failure (a full disk, a corrupt run file) is reported and never escapes into the process. */
  private guarded(what: string, step: () => void): void {
    try {
      step();
    } catch (e) {
      console.error(`team hub sync: ${what} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Runs of shared projects that ended after this worker last wrote the outbox (an interruption recovered at boot, a run
   * finished in the last moments before a crash) were never seen by the subscription: queue them. Older unuploaded runs are
   * history the user decided not to backfill, and stay local. A first start has no earlier moment and queues nothing.
   */
  private queueRunsFinishedWhileAway(): void {
    const since = this.state.seenAt;
    if (!since || !this.opts.settings()) return;
    this.guarded("looking for runs that finished while the server was down", () => {
      for (const run of this.opts.listRuns()) {
        if ((run.endedAt ?? run.createdAt) < since || !isTerminal(run.status) || !this.opts.getProject(run.projectId)?.share) continue;
        if (!this.state.uploaded[run.id]) this.enqueue(run.id);
      }
    });
  }

  private onSaved(run: Run): void {
    if (!isTerminal(run.status) || !this.opts.getProject(run.projectId)?.share || !this.opts.settings()) return;
    const pending = this.debounce.get(run.id);
    if (pending) clearTimeout(pending);
    this.debounce.set(
      run.id,
      setTimeout(() => {
        this.debounce.delete(run.id);
        this.guarded("queueing a run", () => this.enqueue(run.id));
        this.settle();
      }, this.opts.debounceMs),
    );
  }

  /** A run deleted locally leaves the outbox; the hub copy is untouched (the hub is the team record). */
  forget(runId: string): void {
    const timer = this.debounce.get(runId);
    if (timer) clearTimeout(timer);
    this.debounce.delete(runId);
    this.finish(runId);
  }

  /** Drains now, then arms a timer for the next retry. */
  private wake(): void {
    void this.drain()
      .catch((e) => console.error(`team hub sync: upload pass failed: ${e instanceof Error ? e.message : String(e)}`))
      .then(() => this.arm());
  }

  private arm(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (!this.unsubscribe || this.state.queue.length === 0) return;
    const wait = Math.min(...this.state.queue.map((e) => Date.parse(e.nextAttemptAt))) - this.opts.now();
    // An entry that is due after a pass has nothing to wait for but a change outside (a hub set in Setup, a fixed token): poll, never spin.
    this.retryTimer = setTimeout(() => this.wake(), this.state.paused || wait <= 0 ? this.opts.pausePollMs : wait);
    this.retryTimer.unref();
  }

  /** Resolves once no debounce is pending and no upload pass is running (retries waiting on a backoff do not count). */
  idle(): Promise<void> {
    if (this.debounce.size === 0 && !this.draining) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    this.idleWaiters.push(resolve);
    return promise;
  }

  private settle(): void {
    if (this.debounce.size > 0 || this.draining) return;
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }

  /** Queue state for the status route, the CLI and the doctor. */
  status(): HubQueueStatus {
    this.reconcileHub();
    const failed = this.state.queue.filter((e) => e.lastError).length;
    const { paused } = this.state;
    const times = Object.values(this.state.uploaded).map((u) => u.at);
    return {
      paused: paused && { reason: paused.reason, detail: paused.detail, at: paused.at },
      connection: this.connection,
      lastUploadAt: times.length > 0 ? times.reduce((a, b) => (a > b ? a : b)) : null,
      queue: {
        waiting: this.state.queue.length - failed,
        uploading: this.uploading,
        failed,
        parked: Object.keys(this.state.parked).length,
        uploaded: Object.keys(this.state.uploaded).length,
        backfill: this.backfill && { total: this.backfill.total, done: this.backfill.done },
      },
    };
  }

  /** Ids of every run this machine has uploaded (for `hub unpublish --project`). */
  uploadedRunIds(): string[] {
    this.reconcileHub();
    return Object.keys(this.state.uploaded);
  }

  /** The finished runs of shared projects a selection names, oldest first (uploaded ones only when named or with `all`). Pure: `hub push --dry-run` uses it. */
  candidates(sel: PushSelection): Run[] {
    this.reconcileHub();
    const named = sel.runIds !== undefined;
    const runs = sel.runIds ? sel.runIds.flatMap((id) => this.opts.getRun(id) ?? []) : this.opts.listRuns().reverse();
    return runs.filter(
      (run) =>
        (sel.projectId === undefined || run.projectId === sel.projectId) &&
        (sel.since === undefined || run.createdAt >= sel.since) &&
        isTerminal(run.status) &&
        this.opts.getProject(run.projectId)?.share === true &&
        (named || sel.all === true || !this.state.uploaded[run.id]) &&
        // Once the hub's retention is known, runs it would delete again are not offered.
        (named || !this.pastKnownRetention(run)),
    );
  }

  /**
   * Queues runs for upload and returns how many were queued. `runIds` names runs (a parked one is released); a project and/or
   * `since` selects the finished runs of shared projects, oldest first, skipping uploaded ones unless `all`; `failed` retries
   * the runs whose last attempt failed now instead of at their backoff time.
   */
  push(sel: PushSelection = {}): number {
    const explicit = sel.runIds !== undefined;
    let queued = 0;
    if (sel.failed) {
      const now = new Date(this.opts.now()).toISOString();
      for (const entry of this.state.queue) {
        if (!entry.lastError) continue;
        entry.nextAttemptAt = now;
        queued++;
      }
      this.save();
    }
    if (explicit || sel.projectId !== undefined || sel.since !== undefined || sel.all) {
      const fresh: string[] = [];
      for (const run of this.candidates(sel)) {
        if (explicit) delete this.state.parked[run.id];
        const waiting = this.state.queue.find((e) => e.runId === run.id);
        if (waiting) {
          if (explicit && waiting.lastError) {
            waiting.nextAttemptAt = new Date(this.opts.now()).toISOString();
            queued++;
          }
        } else if (this.enqueue(run.id)) {
          fresh.push(run.id);
        }
      }
      queued += fresh.length;
      if (!explicit && fresh.length > 0) {
        this.backfill = { ids: new Set([...(this.backfill?.ids ?? []), ...fresh]), total: (this.backfill?.total ?? 0) + fresh.length, done: this.backfill?.done ?? 0 };
        this.touch();
      }
      this.save();
    }
    if (queued > 0 && this.unsubscribe) this.wake();
    return queued;
  }

  /** Asks the hub (`GET …/state`) which uploaded runs it still holds in the version recorded here, and re-queues the rest (after a hub restore from backup). */
  async verify(sel: { projectId?: string; since?: string } = {}): Promise<{ checked: number; requeued: number }> {
    const conn = this.connect();
    const { call, host } = conn;
    let checked = 0;
    let requeued = 0;
    for (const [id, uploaded] of Object.entries(this.state.uploaded)) {
      const run = this.opts.getRun(id);
      if (!run || (sel.projectId !== undefined && run.projectId !== sel.projectId) || (sel.since !== undefined && run.createdAt < sel.since)) continue;
      checked++;
      const res = await call(`/api/hub/v1/runs/${id}/state`, { method: "GET" });
      if (res.status === 404) {
        delete this.state.uploaded[id];
        // Gone because of the hub's retention is not lost: sending it again would only have it deleted again.
        if (!(await this.expiredOnHub(run, conn)) && this.enqueue(id)) requeued++;
        continue;
      }
      if (!res.ok) throw await failureOf(res, host);
      if (RunState.parse(await res.json()).contentHash !== (uploaded.hubContentHash ?? uploaded.contentHash)) {
        // An empty hash never equals a fresh package, so the document is sent again; the blobs the hub still has are skipped.
        uploaded.contentHash = "";
        if (this.enqueue(id)) requeued++;
      }
    }
    this.save();
    return { checked, requeued };
  }

  /** Deletes this machine's copy of a run on the hub (an unknown copy counts as done) and forgets that it was uploaded. */
  async unpublish(runId: string): Promise<void> {
    const { call, host } = this.connect();
    const res = await call(`/api/hub/v1/runs/${runId}`, { method: "DELETE" });
    if (!res.ok && res.status !== 404) throw await failureOf(res, host);
    delete this.state.uploaded[runId];
    this.forget(runId);
  }

  /** Probes the hub with the stored credentials; a good answer also lifts a pause. */
  async testConnection(): Promise<HubConnection> {
    const checkedAt = new Date(this.opts.now()).toISOString();
    let result: HubConnection;
    try {
      result = await probeHub(this.connect(), checkedAt);
    } catch (e) {
      const error = e instanceof HubCallError ? e : new HubCallError("other", String(e));
      result = { state: error.code === "not_a_hub" ? "unknown" : "unauthorized", machine: null, hubVersion: null, minProtocol: null, checkedAt, detail: error.message };
    }
    this.connection = result;
    if (result.state === "ok" && this.state.paused) this.resume();
    this.touch();
    return result;
  }

  /** Packages the run, uploads the blobs the hub lacks, then the document. Throws a classified `HubCallError`. */
  private async upload(run: Run, project: Project, { call, host, settings }: Connection): Promise<void> {
    const packaged = await this.opts.packageRun(run, project, { screenshots: settings.screenshots });
    if (this.state.uploaded[run.id]?.contentHash === packaged.contentHash) {
      this.complete(run.id);
      return;
    }
    await putMissingBlobs(call, host, [...packaged.blobs.keys()], packaged.blobs, true);
    for (let attempt = 0; attempt < 3; attempt++) {
      const doc = { ...packaged.doc, sentAt: new Date(this.opts.now()).toISOString() };
      const res = await call(`/api/hub/v1/runs/${run.id}`, { method: "PUT", headers: { "content-type": "application/json", "content-encoding": "gzip" }, body: Bun.gzipSync(JSON.stringify(doc)) });
      if (res.ok) {
        const result = RunUploadResult.parse(await res.json());
        this.state.uploaded[run.id] = { contentHash: packaged.contentHash, hubContentHash: result.contentHash, at: new Date(this.opts.now()).toISOString(), url: new URL(result.url, settings.url).toString() };
        this.complete(run.id);
        return;
      }
      const problem = res.status === 422 ? MissingBlobsOrNotTerminal.safeParse(await res.clone().json().catch(() => null)) : null;
      if (problem?.success && problem.data.code === "not_terminal") {
        this.finish(run.id);
        return;
      }
      if (problem?.success && problem.data.code === "missing_blobs") {
        await putMissingBlobs(call, host, problem.data.missing, packaged.blobs, false);
        continue;
      }
      throw await failureOf(res, host);
    }
    throw new HubCallError("other", `${host} kept reporting missing blobs`);
  }

  /** Whether the hub would already have deleted this run again. Asks the hub for its retention (once an hour) only for runs old enough to matter. */
  private async expiredOnHub(run: Run, { call, settings }: Connection): Promise<boolean> {
    if (!(this.ageMs(run) > MIN_RETENTION_DAYS * DAY_MS)) return false;
    let known = this.retention;
    if (!known || known.hub !== settings.url || this.opts.now() - known.at >= RETENTION_TTL_MS) {
      let days = known?.hub === settings.url ? known.days : null;
      try {
        const res = await call("/api/hub/v1/info", { method: "GET" });
        const info = res.ok ? HubInfo.safeParse(await res.json().catch(() => null)) : null;
        if (info?.success) days = info.data.retentionDays ?? null;
      } catch {
        // The upload that follows fails with the real reason.
      }
      known = this.retention = { hub: settings.url, days, at: this.opts.now() };
    }
    return known.days !== null && this.ageMs(run) > known.days * DAY_MS;
  }

  private pastKnownRetention(run: Run): boolean {
    const known = this.retention;
    return known !== null && known.hub === this.opts.settings()?.url && known.days !== null && this.ageMs(run) > known.days * DAY_MS;
  }

  private ageMs(run: Run): number {
    return this.opts.now() - Date.parse(run.endedAt ?? run.createdAt);
  }

  /** An authenticated caller for the configured hub. Throws a classified error when there is no hub or no usable credentials. */
  private connect(): Connection {
    const settings = this.opts.settings();
    if (!settings) throw new HubCallError("not_a_hub", "no team hub is configured");
    const creds = this.opts.credentials();
    if (!creds.ok) throw new HubCallError("unauthorized", creds.problem);
    return makeConnection(settings, creds, this.opts.fetch);
  }

  /** Records a failed attempt and schedules the next one; a network failure delays the whole queue. */
  private fail(runId: string, error: HubCallError): void {
    const entry = this.state.queue.find((e) => e.runId === runId);
    if (!entry) return;
    entry.attempts += 1;
    entry.lastError = error.message;
    entry.lastCode = error.code;
    const next = new Date(this.opts.now() + backoffMs(entry.attempts)).toISOString();
    entry.nextAttemptAt = next;
    if (error.code === "unreachable") for (const other of this.state.queue) other.nextAttemptAt = next;
    this.save(runId);
  }

  private fingerprint(): string {
    const creds = this.opts.credentials();
    const settings = this.opts.settings();
    const credPart = creds.ok ? [creds.token, JSON.stringify(Object.entries(creds.headers).sort())] : [creds.code, creds.problem];
    return digestOf([settings?.url ?? null, ...credPart]);
  }

  /** Stops every upload until the cause is fixed (401, a proxy login, 426, unusable credentials). Nothing is lost and no attempt is counted. */
  private pause(error: HubCallError): void {
    this.state.paused = {
      reason: error.code === "protocol_unsupported" ? "protocol_unsupported" : "unauthorized",
      code: error.code,
      detail: error.message,
      at: new Date(this.opts.now()).toISOString(),
      fingerprint: this.fingerprint(),
      protocol: HUB_PROTOCOL,
    };
    this.save();
  }

  /** Clears a pause whose cause changed: other credentials or URL (a `hub login` from the CLI), or a client speaking a newer protocol. */
  private resumeIfFixed(): void {
    const paused = this.state.paused;
    if (!paused) return;
    const fixed = paused.reason === "protocol_unsupported" ? paused.protocol !== HUB_PROTOCOL : paused.fingerprint !== this.fingerprint();
    if (fixed) this.resume();
  }

  /** Clears the pause and makes every queued run due now. */
  resume(): void {
    this.state.paused = null;
    const at = new Date(this.opts.now()).toISOString();
    for (const entry of this.state.queue) entry.nextAttemptAt = at;
    this.save();
    if (this.unsubscribe) this.wake();
  }

  /** Forgets what was uploaded (and parked) when the configured hub is a different one than the records are about. */
  private reconcileHub(): void {
    const url = this.opts.settings()?.url;
    if (!url || this.state.hub === url) return;
    if (this.state.hub !== null) {
      this.state.uploaded = {};
      this.state.parked = {};
      this.backfill = null;
    }
    this.state.hub = url;
    this.save();
  }

  /** The upload of a run succeeded: off the outbox, unless it was saved again meanwhile, then it stays due now and goes out again. */
  private complete(runId: string): void {
    if (!this.changedWhileUploading.delete(runId)) {
      this.finish(runId);
      return;
    }
    const entry = this.state.queue.find((e) => e.runId === runId);
    if (!entry) return;
    Object.assign(entry, { attempts: 0, nextAttemptAt: new Date(this.opts.now()).toISOString(), lastError: null, lastCode: null });
    this.save(runId);
  }

  /** Takes the run off the outbox (uploaded, or nothing left to send). */
  private finish(runId: string): void {
    this.changedWhileUploading.delete(runId);
    this.state.queue = this.state.queue.filter((e) => e.runId !== runId);
    if (this.backfill?.ids.delete(runId)) {
      this.backfill.done += 1;
      if (this.backfill.ids.size === 0) this.backfill = null;
    }
    this.save(runId);
  }

  /** The chip state of one run, or null when the project is not shared or no hub is configured. */
  syncState(runId: string, run: Pick<Run, "status" | "projectId">): HubSync | null {
    if (!this.opts.settings() || !this.opts.getProject(run.projectId)?.share) return null;
    this.reconcileHub();
    const uploaded = this.state.uploaded[runId];
    const entry = this.state.queue.find((e) => e.runId === runId);
    const base = { url: uploaded?.url ?? null, uploadedAt: uploaded?.at ?? null, error: null, attempts: entry?.attempts ?? 0, nextAttemptAt: entry?.nextAttemptAt ?? null };
    const parked = this.state.parked[runId];
    if (parked) return { ...base, state: "parked", error: { code: "id_conflict", detail: parked.detail } };
    if (!isTerminal(run.status)) return { ...base, state: "waiting" };
    if (entry && this.state.paused) return { ...base, state: "paused", error: { code: this.state.paused.code, detail: this.state.paused.detail } };
    if (this.uploading === runId) return { ...base, state: "uploading" };
    if (entry?.lastError) return { ...base, state: "failed", error: { code: entry.lastCode ?? "other", detail: entry.lastError } };
    if (entry) return { ...base, state: uploaded ? "outdated" : "queued" };
    return { ...base, state: uploaded ? "uploaded" : "local" };
  }
}

const digestOf = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");


// ---------------------------------------------------------------------------------------------------------------
// The server's worker, and what the API and the UI read from it.

let worker: HubSyncWorker | null = null;
const listeners = new Set<(event: HubSyncEvent) => void>();
let statusTimer: Timer | null = null;

/** The UI's `hub` SSE frames: one run's chip, or the whole status. */
export type HubSyncEvent = { runId: string; sync: HubSync | null } | { status: HubStatus };

function adopt(w: HubSyncWorker): HubSyncWorker {
  w.onChange((runId) => {
    if (listeners.size === 0) return;
    if (runId !== null) {
      const run = getRun(runId);
      const sync = run ? w.syncState(runId, run) : null;
      for (const fn of listeners) fn({ runId, sync });
    }
    // Status frames are coalesced: a backfill touches the queue once per run.
    statusTimer ??= setTimeout(() => {
      statusTimer = null;
      void hubStatus().then((status) => {
        for (const fn of listeners) fn({ status });
      });
    }, 250);
  });
  return w;
}

/** The process-wide worker (created on first use, started by `startHubSync`). */
export function hubSyncWorker(): HubSyncWorker {
  worker ??= adopt(new HubSyncWorker());
  return worker;
}

/** Starts watching runs and uploading in the background. Options are for tests. */
export function startHubSync(opts?: Partial<HubSyncOptions>): HubSyncWorker {
  worker ??= adopt(new HubSyncWorker(opts));
  worker.start();
  return worker;
}

export async function stopHubSync(): Promise<void> {
  const w = worker;
  worker = null;
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = null;
  await w?.stop();
}

/** Subscribes to sync changes for the SSE stream. */
export function subscribeHubSync(fn: (event: HubSyncEvent) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** `RunView.hubSync`: pass the run when you have it (it avoids a disk read). Null when the project is not shared or no hub is set. */
export function hubSyncState(runId: string, run?: Pick<Run, "status" | "projectId">): HubSync | null {
  // No hub, no sync state: do not create the worker just to say so (run lists call this for every row).
  if (!activeHubConfig()) return null;
  const r = run ?? getRun(runId);
  return r ? hubSyncWorker().syncState(runId, r) : null;
}

export interface HubStatus extends HubQueueStatus {
  configured: boolean;
  url: string | null;
  screenshots: "webp" | "original";
  credentials: {
    /** Absolute path of `hub-credentials.json`. */
    file: string;
    token: "file" | "env" | null;
    /** Last 4 characters of the token. */
    tokenHint: string | null;
    /** Why the credentials cannot be used (a world-readable file, a malformed one), when that is the case. */
    problem: string | null;
    /** Header names only: the values never leave the server. */
    headers: { source: "file" | "env" | null; names: string[] };
  };
  sharedProjects: { id: string; name: string; hubKey: string }[];
}

/** The shared projects that can name themselves on the hub. Git is asked once per repository (the answer is remembered), not on every status frame. */
export async function sharedHubProjects(projects: Pick<Project, "id" | "name" | "repoPath" | "hubKey" | "share">[]): Promise<HubStatus["sharedProjects"]> {
  const shared: HubStatus["sharedProjects"] = [];
  for (const project of projects) {
    if (project.share !== true) continue;
    const known = project.hubKey ?? derivedHubKey(project.repoPath);
    const hubKey = known === undefined ? await hubKeyFor(project).catch(() => null) : known;
    if (hubKey) shared.push({ id: project.id, name: project.name, hubKey });
  }
  return shared;
}

/** `GET /api/hub/status`. */
export async function hubStatus(): Promise<HubStatus> {
  const w = hubSyncWorker();
  const settings = activeHubConfig();
  const creds = resolveHubCredentials({ configHeaders: settings?.headers });
  return {
    ...w.status(),
    configured: settings !== null,
    url: settings?.url ?? null,
    screenshots: settings?.screenshots ?? "webp",
    credentials: {
      file: hubCredentialsPath(),
      token: creds.ok ? creds.tokenSource : null,
      tokenHint: creds.ok ? creds.tokenHint : null,
      problem: creds.ok || creds.code === "missing" ? null : creds.problem,
      headers: { source: creds.ok ? creds.headersSource : null, names: creds.ok ? Object.keys(creds.headers) : Object.keys(settings?.headers ?? {}) },
    },
    sharedProjects: await sharedHubProjects(listProjects()),
  };
}
