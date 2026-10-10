import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { getBatchMeta, makeBatchId, pruneBatchMeta, saveBatchMeta } from "../batches";
import { type Config, HttpError } from "../config";
import { resolveHarness } from "../harness";
import { HARNESS_IDS, type HarnessId } from "../harness/types";
import { getProject, PACKAGE_RE, type Project, resolvePersonaPath } from "../projects/registry";
import { androidName, type Device, type DeviceWaiter, mobileDeviceIdOf } from "../devices/devices";
import { CLAIM_WINDOW_MS, formatClock, type Lease, leaseView, type LeaseNext, type LeaseStore, TTL } from "../devices/leases";
import { getSuite, MAX_BRIEF_LENGTH, MAX_TITLE_LENGTH, type Suite, type SuiteCheck } from "../suites";
import { extractTickets, lookupPullRequest, resolveSource, type SourceInput, SourceInputSchema } from "./source";
import { loadPersona } from "./prompt";
import { createRun, deleteRun as deleteStoredRun, getRun, listRuns, type NewRun, saveRun } from "./store";
import { ACTIVE, type Activity, type Check, type DeviceRequest, type Platform, type Run, type RunSource } from "./types";

export type StartTarget = { serial: string } | { bootTarget: { platform: Platform; target: string } };

export interface SchedulerDeps {
  config: Pick<Config, "maxConcurrentRuns" | "devicePool" | "agent">;
  /** Clock for tickets and lease expiry text; tests move it. */
  now?: () => number;
  listDevices(): Promise<Device[]>;
  /** Number of devices of this platform booted by this process (pool `booted` map). */
  bootedCount(platform: Platform): number;
  /** Manual (Devices page / API) boots of this platform still in flight; they hold a `maxBooted` slot. */
  manualBootCount(platform: Platform): number;
  /** An AVD name / simulator UDID with a boot in flight (scheduler-started or manual). */
  isBootingTarget(target: string): boolean;
  /** The one ownership store: every claim on a device (QA run or agent) is a lease in it. */
  leases: Pick<LeaseStore, "bus" | "grantRun" | "releaseRun" | "deviceOwner" | "runLease" | "runLeaseCount" | "grantAgent" | "claim" | "holdForClaim">;
  /** Boots an AVD / simulator for an agent's ticket and resolves with its serial (the pool's `bootAndroid` / `bootIos`). */
  boot(platform: Platform, target: string): Promise<string>;
  /** Starts the run detached; must eventually call `release(runId)`. */
  startRun(run: Run, target: StartTarget): void;
  /** Cancels a run in preflight/running/finishing. */
  cancelActive(runId: string): Promise<void>;
}

/** Documented shape of an `enqueueRun` request; the method itself validates an `unknown` body against `EnqueueSchema`. */
export interface EnqueueInput {
  projectId: string;
  /** Optional when `suiteId` is given (defaults to the suite title). */
  title?: string;
  /** Optional when `suiteId` is given (defaults to the suite body). */
  brief?: string;
  device?: Partial<DeviceRequest>;
  packageId?: string;
  requestedBy?: string;
  source?: SourceInput;
  /** Agent CLI; omitted = project `agent.harness`, persona `harness:`, config `agent.harness`, first installed. */
  harness?: HarnessId;
  model?: string;
  thinking?: string;
  /** Harness-native reasoning effort; `thinking` is the legacy omp spelling. */
  effort?: string;
  suiteId?: string;
  install?: { path: string };
  /** Set by `enqueueBatch`; HTTP/MCP entry points must not forward it from clients. */
  batchId?: string;
}

export interface BatchInput {
  projectId: string;
  title?: string;
  brief?: string;
  suiteId?: string;
  devices: Partial<DeviceRequest>[];
  packageId?: string;
  harness?: HarnessId;
  model?: string;
  thinking?: string;
  effort?: string;
  install?: { path: string };
  source?: SourceInput;
  requestedBy?: string;
}

/** Missing / non-string text fields count as empty so the "title and brief are required" check reports them. */
const textOrEmpty = z.unknown().optional().transform((v) => (typeof v === "string" ? v : ""));
const optionalText = (max = 200) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => v || undefined);
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const thinkingLevel = z
  .string()
  .trim()
  .optional()
  .transform((v) => v || undefined)
  .refine((v) => v === undefined || (THINKING_LEVELS as readonly string[]).includes(v), {
    message: `must be one of ${THINKING_LEVELS.join(", ")}`,
  });
const harnessId = z.enum(HARNESS_IDS).optional();
/** Same shape the project registry enforces for `defaultPackage`; empty falls back to the project's package. */
const packageId = z
  .string()
  .trim()
  .max(200)
  .refine((v) => v === "" || PACKAGE_RE.test(v), { message: "must look like com.example.app" })
  .optional();
const requestedBy = z.string().trim().max(200).optional();
const deviceRequest = z.object({ serial: z.string().max(200).optional(), platform: z.enum(["android", "ios"]).optional() });
const installRequest = z.object({ path: z.string().trim().min(1).max(4096) });

const EnqueueSchema = z.object({
  projectId: z.string(),
  title: textOrEmpty,
  brief: textOrEmpty,
  device: deviceRequest.optional(),
  packageId,
  requestedBy,
  source: SourceInputSchema.optional(),
  harness: harnessId,
  model: optionalText(),
  thinking: thinkingLevel,
  effort: optionalText(40),
  suiteId: optionalText(),
  install: installRequest.optional(),
  batchId: optionalText(),
});

const BatchSchema = z.object({
  projectId: z.string(),
  title: z.string().optional(),
  brief: z.string().optional(),
  suiteId: optionalText(),
  devices: z.array(deviceRequest).min(1, "between 1 and 8 devices are required").max(8, "between 1 and 8 devices are required"),
  packageId,
  requestedBy,
  source: SourceInputSchema.optional(),
  harness: harnessId,
  model: optionalText(),
  thinking: thinkingLevel,
  effort: optionalText(40),
  install: installRequest.optional(),
});

function parseOrThrow<T>(schema: z.ZodType<T>, body: unknown, code?: string): T {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0]!;
  const where = issue.path.map(String).join(".");
  throw new HttpError(400, where ? `${where}: ${issue.message}` : issue.message, code);
}

/** The `harness:` a project's persona names; null when it names none or the persona cannot be read (the runner reports that). */
function personaHarness(project: Project): HarnessId | null {
  try {
    return loadPersona(resolvePersonaPath(project)).harness;
  } catch {
    return null;
  }
}

/** State carried over from an existing run by `rerun`; skips suite lookup and source resolution. */
interface RerunCopy {
  rerunOf: string;
  suiteId: string | null;
  suiteChecks: SuiteCheck[] | null;
  source: RunSource | null;
}

interface PreparedRun {
  fields: NewRun;
  source: RunSource | null;
}

const RERUN_SUFFIX = " (re-run)";
/** Cap on the appended "re-run only these checks" section, so a long check list cannot push the brief past its limit. */
const RERUN_SECTION_MAX = 8000;
/** AVD names that denote wearables / TVs / cars, which must never be auto-booted for a platform-only run. */
const WEARABLE_AVD = /(^|[^a-z])(wear|watch|tv|automotive)([^a-z]|$)/i;

/** Original brief + the failed checks with their previous status and note, within `MAX_BRIEF_LENGTH`. */
function rerunBrief(brief: string, runId: string, failed: readonly Check[]): string {
  const header = `\n\nRe-run ONLY these checks from run ${runId} (previous status + note):\n`;
  const lines = failed.map((c) => `- ${c.id} ${oneLine(c.title, 200)} (${c.status}${c.note ? `: ${oneLine(c.note, 300)}` : ""})`);
  const kept: string[] = [];
  let used = header.length + 40; // room for the "… and N more" line
  for (const line of lines) {
    if (used + line.length + 1 > RERUN_SECTION_MAX) break;
    kept.push(line);
    used += line.length + 1;
  }
  if (kept.length < lines.length) kept.push(`- … and ${lines.length - kept.length} more`);
  const section = header + kept.join("\n");
  const room = MAX_BRIEF_LENGTH - section.length;
  return `${brief.length > room ? `${brief.slice(0, room - 1)}…` : brief}${section}`;
}

/** Devices that can never host a QA run (wearables / TVs). */
const UNSUPPORTED_DEVICE_TYPES = ["watch", "tv"];
export const isQaDevice = (d: Pick<Device, "deviceType">) => !UNSUPPORTED_DEVICE_TYPES.includes(d.deviceType);

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function validateInstall(install: { path: string }, platform: Platform): void {
  if (!path.isAbsolute(install.path)) throw new HttpError(400, "install.path must be an absolute path");
  const ext = path.extname(install.path).toLowerCase();
  const allowed = platform === "android" ? [".apk"] : [".app", ".ipa"];
  if (!allowed.includes(ext)) throw new HttpError(400, `install.path must be a ${allowed.join(" or ")} for ${platform}`);
  try {
    statSync(install.path);
  } catch {
    throw new HttpError(400, `install.path ${install.path} does not exist`);
  }
}

export type ActivityEvent = Activity & { runId: string };

/** Entries of the one queue that decides who gets the next free device: QA runs and agent tickets, oldest first. */
export type QueueEntry = { kind: "run"; id: string } | { kind: "ticket"; id: string };

/** The agent lease a queued run waits behind (the explicit serial's holder, or the lease that ends first for "any"). */
export interface QueueHold {
  serial: string;
  deviceName: string;
  holder: string;
  reason: string | null;
  expiresAt: string;
}

/** Documented shape of an `acquire` request; the method validates an `unknown` body against `AcquireSchema`. */
export interface AcquireInput {
  serial?: string;
  platform?: Platform;
  holder: string;
  reason?: string;
  ttlMinutes?: number;
  /** From an earlier `timedOut` result: keeps the place in the queue (or picks up a grant made meanwhile). */
  ticket?: string;
  cwd?: string;
}

export interface LeaseGrant {
  serial: string;
  platform: Platform;
  name: string;
  /** The id mobile-mcp tools take as `device` (AVD name for emulators, UDID for simulators). */
  mobileDeviceId: string;
  /** Secret capability for renew/release; returned only here. */
  leaseId: string;
  expiresAt: string;
  ttlMinutes: number;
}

export type HeldBy =
  | { kind: "agent"; holder: string; reason: string | null; expiresAt: string }
  | { kind: "run"; runId: string; title: string }
  | { kind: "booting" }
  | null;

export type AcquireResult =
  | { lease: LeaseGrant }
  | { timedOut: true; ticket: string; position: number; state: "waiting" | "booting"; heldBy: HeldBy; reason: string };

/** A waiting agent without anything secret (the ticket id resumes a place, so it is not listed). */
export interface TicketView {
  holder: string;
  reason: string | null;
  request: { serial: string } | { platform: Platform };
  position: number;
  state: "waiting" | "booting";
  enqueuedAt: string;
}

const AcquireSchema = z
  .object({
    serial: z.string().max(200).optional(),
    platform: z.enum(["android", "ios"]).optional(),
    holder: z.string().trim().min(1).max(80),
    reason: z
      .string()
      .trim()
      .max(200)
      .optional()
      .transform((v) => v || undefined),
    ttlMinutes: z.number().int().min(TTL.min).max(TTL.max).optional(),
    ticket: z.string().max(64).optional(),
    cwd: z
      .string()
      .max(4096)
      .refine((v) => path.isAbsolute(v), { message: "must be an absolute path" })
      .optional(),
  })
  .refine((a) => Boolean(a.serial) !== Boolean(a.platform), { message: "give serial or platform" });

const MAX_TICKETS = 32;

interface Ticket {
  id: string;
  holder: string;
  reason: string | null;
  request: { serial: string } | { platform: Platform };
  ttlMinutes: number | undefined;
  cwd: string | undefined;
  enqueuedAt: number;
  /** Calls currently waiting on this ticket. */
  attached: number;
  /** When the last waiting call returned; the ticket is dropped CLAIM_WINDOW_MS later. */
  detachedAt: number | null;
  /** Resolved by the pass on a grant, a boot start or a failure; replaced after each wake. */
  wake: PromiseWithResolvers<void>;
  grant: Lease | null;
  failure: HttpError | null;
  waitReason: string;
  waitHeldBy: HeldBy;
}

type Placement =
  | { kind: "device"; device: Device }
  | { kind: "boot"; platform: Platform; target: string }
  | { kind: "wait"; reason: string; hold: QueueHold | null; heldBy: HeldBy };

const agentHeldBy = (lease: Lease): HeldBy => ({ kind: "agent", holder: lease.holder, reason: lease.reason, expiresAt: lease.expiresAt ?? "" });

/** Resolves when `wake` does, after `ms`, or when `signal` aborts; whichever is first (the timer never outlives the wait). */
async function waitForWake(wake: Promise<void>, ms: number, signal?: AbortSignal): Promise<void> {
  const timer = Promise.withResolvers<void>();
  const handle = setTimeout(() => timer.resolve(), ms);
  const onAbort = () => timer.resolve();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await Promise.race([wake, timer.promise]);
  } finally {
    clearTimeout(handle);
    signal?.removeEventListener("abort", onAbort);
  }
}

export class Scheduler {
  readonly bus = new EventEmitter();
  /** Everything waiting for a device, FIFO by enqueue time: queued runs and agent tickets in one line. */
  readonly queue: QueueEntry[] = [];
  readonly booting = new Map<string, { platform: Platform; target: string }>();
  /** Authoritative in-memory copy of every non-terminal run. */
  private live = new Map<string, Run>();
  private running: Promise<void> | null = null;
  /** Detached PR lookups by run id; each promise never rejects and removes itself once settled. */
  private prLookups = new Map<string, Promise<void>>();
  private rerunRequested = false;
  private stopped = false;
  /** Why each queued run is still waiting, refreshed by every scheduling pass. */
  private queueReasons = new Map<string, string>();
  /** The agent lease a queued run waits for, when it waits for one. */
  private queueHolds = new Map<string, QueueHold>();
  /** Agents waiting for (or about to claim) a device, by ticket id. */
  private tickets = new Map<string, Ticket>();
  /** Boots started for agent tickets; they hold a maxBooted slot like a run's boot. */
  private ticketBoots = new Map<string, { platform: Platform; target: string }>();
  /** What the latest pass saw, for `nextFor`. */
  private lastDevices: Device[] = [];

  constructor(private deps: SchedulerDeps) {
    this.bus.setMaxListeners(0);
    // A lease that ends (released, revoked, expired, gone) frees a device: let the queue have it.
    deps.leases.bus.on("lease", (e) => {
      if (e.change !== "acquired" && e.change !== "renewed") void this.schedule();
    });
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Restores persisted state after a restart: active runs become interrupted, queued runs re-queue. */
  restore(): void {
    const runs = listRuns().reverse();
    for (const run of runs) {
      if (run.status === "queued") {
        this.live.set(run.id, run);
        this.queue.push({ kind: "run", id: run.id });
      } else if (ACTIVE.includes(run.status)) {
        run.status = "interrupted";
        run.error = "tapocalypse restarted while run was active";
        run.endedAt = new Date().toISOString();
        saveRun(run);
      }
    }
  }

  getLive(id: string): Run | undefined {
    return this.live.get(id);
  }

  /** Persists and broadcasts a run mutation. */
  update(run: Run): void {
    saveRun(run);
    if (ACTIVE.includes(run.status)) this.live.set(run.id, run);
    else this.live.delete(run.id);
    this.bus.emit("run", run);
  }

  activity(runId: string, a: Activity): void {
    this.bus.emit("activity", { runId, ...a } satisfies ActivityEvent);
  }

  /** 1-based position of a run in the single queue (agent tickets count too), null when it is not waiting. */
  queuePosition(id: string): number | null {
    const i = this.queue.findIndex((e) => e.kind === "run" && e.id === id);
    return i < 0 ? null : i + 1;
  }

  queueReason(id: string): string | null {
    return this.queueReasons.get(id) ?? null;
  }

  /** The agent lease a queued run waits for (an explicit serial's holder, or the lease that ends first for "any"). */
  queueHold(id: string): QueueHold | null {
    return this.queueHolds.get(id) ?? null;
  }

  async enqueueRun(body: unknown): Promise<Run> {
    return this.commit(await this.prepare(body));
  }

  /** Validates a request and builds the run fields without creating anything, so batches can be all-or-nothing. */
  private async prepare(body: unknown, copy?: RerunCopy): Promise<PreparedRun> {
    const input = parseOrThrow(EnqueueSchema, body);
    const project = getProject(input.projectId);
    if (!project) throw new HttpError(400, `unknown project ${input.projectId}`);

    let suite: Suite | null = null;
    if (!copy && input.suiteId) {
      suite = getSuite(project, input.suiteId);
      if (!suite) throw new HttpError(400, `unknown suite ${input.suiteId}`);
    }
    const title = input.title.trim() || suite?.title || "";
    const brief = input.brief.trim() || suite?.brief || "";
    if (!title || !brief) throw new HttpError(400, "title and brief are required");
    if (title.length > MAX_TITLE_LENGTH) throw new HttpError(400, `title must be at most ${MAX_TITLE_LENGTH} characters`);
    if (brief.length > MAX_BRIEF_LENGTH) throw new HttpError(400, `brief must be at most ${MAX_BRIEF_LENGTH} characters`);

    const platform = input.device?.platform ?? project.defaultPlatform;
    if (suite?.platforms && !suite.platforms.includes(platform)) {
      throw new HttpError(400, `suite ${suite.id} does not support ${platform}`);
    }
    const harness = await resolveHarness({
      run: input.harness,
      project: project.agent?.harness,
      persona: personaHarness(project),
      config: this.deps.config.agent?.harness,
    });
    if (input.install) validateInstall(input.install, platform);
    const serial = input.device?.serial || undefined;
    if (serial) {
      const devices = await this.deps.listDevices();
      const named = devices.find((d) => d.serial === serial);
      if (named && named.platform !== platform) {
        throw new HttpError(400, `device ${serial} is an ${named.platform} device; this run targets ${platform} (set device.platform)`);
      }
      if (!named) throw new HttpError(400, `device ${serial} not connected`);
      const device = named;
      if (!isQaDevice(device)) {
        throw new HttpError(400, `device ${serial} is a ${device.deviceType}; only phones and tablets can run QA`);
      }
      if (this.deps.config.devicePool.android.excludeSerials.includes(serial)) {
        throw new HttpError(400, `device ${serial} is excluded in config`);
      }
    }
    const source = copy ? structuredClone(copy.source) : await resolveSource(project, input.source, title);
    const suiteChecks = copy ? copy.suiteChecks : suite?.checks?.length ? suite.checks.map((c) => ({ ...c })) : null;
    return {
      source,
      fields: {
        projectId: project.id,
        title,
        brief,
        requestedBy: input.requestedBy || "web",
        deviceRequest: serial ? { serial, platform } : { platform },
        deviceSerial: null,
        deviceLabel: null,
        bootedByRun: false,
        packageId: input.packageId?.trim() || project.defaultPackage,
        status: "queued",
        verdict: null,
        summary: null,
        reportPath: null,
        storage: "data",
        checks: [],
        error: null,
        startedAt: null,
        endedAt: null,
        stats: null,
        transcriptHtml: false,
        source,
        build: null,
        batchId: input.batchId ?? null,
        suiteId: copy ? copy.suiteId : (suite?.id ?? null),
        suiteChecks,
        harness,
        model: input.model ?? suite?.model ?? null,
        thinking: input.thinking ?? (harness === "omp" ? (input.effort ?? null) : null),
        effort: input.effort ?? input.thinking ?? null,
        rerunOf: copy?.rerunOf ?? null,
        install: input.install ?? null,
      },
    };
  }

  /** Persists a prepared run, queues it, and kicks off the detached PR lookup + a scheduling pass. */
  private commit({ fields, source }: PreparedRun): Run {
    const run = createRun(fields);
    this.queue.push({ kind: "run", id: run.id });
    this.update(run);
    if (source && (source.prStatus === "pending" || (source.prStatus === "provided" && (!source.pr?.title || !source.pr.url)))) {
      const lookup = this.fillPullRequest(run.id, source)
        .catch((e: unknown) => console.error(`pull request lookup for ${run.id} failed:`, e))
        .finally(() => this.prLookups.delete(run.id));
      this.prLookups.set(run.id, lookup);
    }
    void this.schedule();
    return run;
  }

  /** One run per entry of `devices` (titles get a device suffix), all validated before any is queued. */
  async enqueueBatch(body: unknown): Promise<{ batchId: string; runs: Run[] }> {
    const input = parseOrThrow(BatchSchema, body);
    const project = getProject(input.projectId);
    if (!project) throw new HttpError(400, `unknown project ${input.projectId}`);
    const brief = input.brief?.trim() ?? "";
    const base = input.title?.trim() || (input.suiteId && getSuite(project, input.suiteId)?.title) || oneLine(brief.split("\n")[0] ?? "", 60);
    const baseTitle = oneLine(base, 150);

    const batchId = makeBatchId();
    const perPlatform = new Map<Platform, number>();
    // Lane titles name the device ("iPhone 17"), not its UDID; fall back to the serial if it isn't listed.
    const names = input.devices.some((d) => d.serial)
      ? new Map((await this.deps.listDevices()).map((d) => [d.serial, d.name]))
      : new Map<string, string>();
    const prepared = await Promise.all(
      input.devices.map((device, i) => {
        const platform = device.platform ?? project.defaultPlatform;
        const n = (perPlatform.get(platform) ?? 0) + 1;
        if (!device.serial) perPlatform.set(platform, n);
        const label = device.serial ? (names.get(device.serial) ?? device.serial) : `${platform} #${n}`;
        return this.prepare({
          projectId: input.projectId,
          title: baseTitle ? `${baseTitle} · ${label}` : "",
          brief: input.brief,
          suiteId: input.suiteId,
          device: { platform, serial: device.serial },
          packageId: input.packageId,
          harness: input.harness,
          model: input.model,
          thinking: input.thinking,
          effort: input.effort,
          install: input.install,
          source: input.source,
          requestedBy: input.requestedBy,
          batchId,
        }).catch((e: unknown) => {
          if (e instanceof HttpError && input.devices.length > 1) {
            throw new HttpError(e.status, `devices.${i}: ${e.message}`);
          }
          throw e;
        });
      }),
    );
    saveBatchMeta({ id: batchId, projectId: project.id, title: baseTitle, createdAt: new Date().toISOString() });
    return { batchId, runs: prepared.map((p) => this.commit(p)) };
  }

  /**
   * Queues a new run from a finished one. `only: "failed"` re-tests the checks that did not pass or skip, with the
   * previous status and note quoted in the brief; `"all"` repeats the whole brief.
   */
  async rerun(
    runId: string,
    opts: { only: "failed" | "all"; device?: Partial<DeviceRequest>; requestedBy?: string; harness?: HarnessId },
  ): Promise<Run> {
    if (opts.only !== "failed" && opts.only !== "all") throw new HttpError(400, "only must be failed or all");
    const run = this.live.get(runId) ?? getRun(runId);
    if (!run) throw new HttpError(404, `unknown run ${runId}`);
    if (ACTIVE.includes(run.status)) throw new HttpError(409, `run ${runId} is still active`);

    let brief = run.brief;
    let suiteChecks = run.suiteChecks;
    if (opts.only === "failed") {
      const failed = run.checks.filter((c) => c.status !== "pass" && c.status !== "skipped");
      if (failed.length === 0) throw new HttpError(400, `nothing to re-run: run ${runId} has no failed checks`);
      brief = rerunBrief(run.brief, runId, failed);
      if (suiteChecks) {
        const ids = new Set(failed.map((c) => c.id));
        suiteChecks = suiteChecks.filter((c) => ids.has(c.id));
      }
    }
    // A model / effort is harness-native: a different harness starts from its own defaults.
    const harness = opts.harness ?? run.harness;
    const sameHarness = harness === run.harness;
    const baseTitle = run.title.endsWith(RERUN_SUFFIX) ? run.title.slice(0, -RERUN_SUFFIX.length) : run.title;
    const prepared = await this.prepare(
      {
        projectId: run.projectId,
        title: `${baseTitle.slice(0, MAX_TITLE_LENGTH - RERUN_SUFFIX.length)}${RERUN_SUFFIX}`,
        brief,
        device: opts.device ?? run.deviceRequest,
        packageId: run.packageId,
        harness,
        model: (sameHarness ? run.model : null) ?? undefined,
        thinking: (sameHarness ? run.thinking : null) ?? undefined,
        effort: (sameHarness ? run.effort : null) ?? undefined,
        requestedBy: opts.requestedBy ?? "web",
      },
      { rerunOf: run.id, suiteId: run.suiteId, suiteChecks, source: run.source },
    );
    return this.commit(prepared);
  }

  /**
   * Infra auto-retry (called by the runner): queues a copy of `run` as the next attempt and links the two.
   * Synchronous and unvalidated on purpose: the run was already accepted once, and a vanished explicit serial just
   * leaves the retry queued with its reason shown.
   */
  retry(run: Run): Run {
    const next = createRun({
      projectId: run.projectId,
      title: run.title,
      brief: run.brief,
      requestedBy: run.requestedBy,
      deviceRequest: { ...run.deviceRequest },
      deviceSerial: null,
      deviceLabel: null,
      bootedByRun: false,
      packageId: run.packageId,
      status: "queued",
      verdict: null,
      summary: null,
      reportPath: null,
      storage: "data",
      checks: [],
      error: null,
      startedAt: null,
      endedAt: null,
      stats: null,
      transcriptHtml: false,
      source: structuredClone(run.source),
      build: null,
      batchId: run.batchId,
      suiteId: run.suiteId,
      suiteChecks: structuredClone(run.suiteChecks),
      harness: run.harness,
      model: run.model,
      thinking: run.thinking,
      effort: run.effort,
      attempt: run.attempt + 1,
      retryOf: run.id,
      rerunOf: run.rerunOf,
      install: run.install ? { ...run.install } : null,
    });
    run.retriedBy = next.id;
    this.update(run);
    this.queue.push({ kind: "run", id: next.id });
    this.update(next);
    void this.schedule();
    return next;
  }

  /** Deletes a finished run (and its run dir); active runs must be cancelled first. */
  removeRun(id: string): void {
    const run = this.live.get(id) ?? getRun(id);
    if (!run) throw new HttpError(404, `unknown run ${id}`);
    if (ACTIVE.includes(run.status)) throw new HttpError(409, `run ${id} is still active; cancel it first`);
    if (this.isHeld(id)) throw new HttpError(409, `run ${id} is still shutting down; try again in a moment`);
    deleteStoredRun(id);
    this.queueReasons.delete(id);
    this.queueHolds.delete(id);
    if (run.batchId) pruneBatchMeta(run.batchId);
  }

  /** True while the run still owns a device slot, i.e. its runner is working even if the run is already marked cancelled. */
  isHeld(id: string): boolean {
    return this.booting.has(id) || this.deps.leases.runLease(id) !== null;
  }

  /** Detached from enqueue so gh latency never delays a run; mutates the live run once the lookup settles. */
  private async fillPullRequest(runId: string, source: RunSource): Promise<void> {
    const { pr, prStatus } = await lookupPullRequest(source);
    const run = this.live.get(runId) ?? getRun(runId);
    if (!run?.source) return;
    run.source.pr = pr;
    run.source.prStatus = prStatus;
    run.source.tickets = extractTickets(...run.source.tickets, pr?.title);
    this.update(run);
  }

  /** Resolves once the run's detached PR lookup has settled (run mutated + updated), or after `timeoutMs`; immediately when none is pending. */
  async waitForPrLookup(runId: string, timeoutMs: number): Promise<void> {
    const lookup = this.prLookups.get(runId);
    if (!lookup) return;
    await Promise.race([lookup, Bun.sleep(timeoutMs)]);
  }

  /** Permanently disables scheduling (server shutdown): queued runs stay queued for the next start. */
  stop(): void {
    this.stopped = true;
  }

  /** Serialized: concurrent triggers coalesce into one extra pass; every caller resolves once the loop has drained. */
  schedule(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) {
      this.rerunRequested = true;
      return this.running;
    }
    const loop = (async () => {
      try {
        do {
          this.rerunRequested = false;
          await this.pass();
        } while (this.rerunRequested);
      } catch (e) {
        console.error("schedule failed:", e);
      } finally {
        this.running = null;
      }
    })();
    this.running = loop;
    return loop;
  }

  /** Runs holding a slot: holding a run lease or booting a device. */
  activeCount(): number {
    return this.deps.leases.runLeaseCount() + this.booting.size;
  }

  private capped(): boolean {
    return this.activeCount() >= this.deps.config.maxConcurrentRuns;
  }

  private setReason(id: string, reason: string | null, hold: QueueHold | null = null): void {
    const sameHold = JSON.stringify(this.queueHolds.get(id) ?? null) === JSON.stringify(hold);
    if ((this.queueReasons.get(id) ?? null) === reason && sameHold) return;
    if (reason === null) this.queueReasons.delete(id);
    else this.queueReasons.set(id, reason);
    if (hold === null) this.queueHolds.delete(id);
    else this.queueHolds.set(id, hold);
    const run = this.live.get(id);
    if (run) this.bus.emit("run", run);
  }

  /** Every run still queued is waiting for a free run slot. */
  private setCapReason(id: string): void {
    this.setReason(id, `maxConcurrentRuns (${this.deps.config.maxConcurrentRuns}) reached`);
  }

  private excluded(serial: string): boolean {
    return this.deps.config.devicePool.android.excludeSerials.includes(serial);
  }

  private usable(d: Device, now: number): boolean {
    return d.state === "ready" && this.deps.leases.deviceOwner(d.serial, now) === null && !this.excluded(d.serial) && isQaDevice(d);
  }

  /** A device an agent or run may be given when the request names only a platform: never physical, never watch/TV, never excluded. */
  private autoEligible(d: Device, platform: Platform): boolean {
    return d.platform === platform && d.kind !== "physical" && isQaDevice(d) && !this.excluded(d.serial);
  }

  /** The AVD / simulator a new boot would use, or `capped` when maxBooted stops one. Counts runs' and tickets' boots alike. */
  private pickBoot(platform: Platform, devices: Device[]): { target?: string; capped: boolean } {
    const { avds, maxBooted } = this.deps.config.devicePool.android;
    const inFlight = [...this.booting.values(), ...this.ticketBoots.values()];
    const bootingTargets = new Set(inFlight.map((b) => b.target));
    const bootable = (name: string) => !bootingTargets.has(name) && !this.deps.isBootingTarget(name);
    if (platform === "android") {
      const started = inFlight.filter((b) => b.platform === "android").length + this.deps.manualBootCount("android");
      if (this.deps.bootedCount("android") + started >= maxBooted) return { capped: avds.length > 0 };
      const running = new Set(devices.map((d) => d.avdName).filter(Boolean));
      return { target: avds.find((a) => !running.has(a) && bootable(a) && !WEARABLE_AVD.test(a)), capped: false };
    }
    const up = new Set(devices.map((d) => d.serial));
    return { target: this.deps.config.devicePool.ios.simulators.find((u) => !up.has(u) && bootable(u)), capped: false };
  }

  private holdOf(lease: Lease, device: Device | undefined): QueueHold {
    return {
      serial: lease.serial,
      deviceName: device?.name ?? lease.serial,
      holder: lease.holder,
      reason: lease.reason,
      expiresAt: lease.expiresAt ?? "",
    };
  }

  /** Where a request (a run's or a ticket's) can go right now: a free device, a device to boot, or why it waits. */
  private place(req: { serial?: string; platform?: Platform }, devices: Device[], now: number): Placement {
    const { leases } = this.deps;
    if (req.serial) {
      const d = devices.find((x) => x.serial === req.serial && (!req.platform || x.platform === req.platform));
      if (!d) return { kind: "wait", reason: `${req.serial} is not connected`, hold: null, heldBy: null };
      if (this.usable(d, now)) return { kind: "device", device: d };
      const owner = leases.deviceOwner(d.serial, now);
      if (owner?.kind === "run") {
        const title = this.live.get(owner.lease.runId ?? "")?.title ?? owner.lease.holder;
        return { kind: "wait", reason: `${d.serial} is busy`, hold: null, heldBy: { kind: "run", runId: owner.lease.runId ?? "", title } };
      }
      if (owner?.kind === "agent") {
        return {
          kind: "wait",
          reason: `${d.serial} is held by ${owner.lease.holder} until ${formatClock(owner.lease.expiresAt)}`,
          hold: this.holdOf(owner.lease, d),
          heldBy: agentHeldBy(owner.lease),
        };
      }
      if (d.state !== "ready" || owner?.kind === "booting") return { kind: "wait", reason: `${d.serial} is booting`, hold: null, heldBy: { kind: "booting" } };
      return { kind: "wait", reason: `${d.serial} is not available for QA`, hold: null, heldBy: null };
    }

    const platform = req.platform ?? "android";
    const candidates = devices.filter((d) => this.autoEligible(d, platform));
    const free = candidates.filter((d) => this.usable(d, now)).sort((a, b) => a.serial.localeCompare(b.serial));
    if (free[0]) return { kind: "device", device: free[0] };
    const boot = this.pickBoot(platform, devices);
    if (boot.target) return { kind: "boot", platform, target: boot.target };
    if (boot.capped) return { kind: "wait", reason: `maxBooted (${this.deps.config.devicePool.android.maxBooted}) reached`, hold: null, heldBy: null };
    if (candidates.length === 0) return { kind: "wait", reason: `no ${platform} device available`, hold: null, heldBy: null };

    const owners = candidates.map((d) => ({ d, owner: leases.deviceOwner(d.serial, now) }));
    const agents = owners.flatMap((o) => (o.owner?.kind === "agent" ? [{ d: o.d, lease: o.owner.lease }] : []));
    const running = owners.flatMap((o) => (o.owner?.kind === "run" ? [o.owner.lease] : []));
    const counts = [
      agents.length > 0 ? `${agents.length} held by agents` : "",
      running.length > 0 ? `${running.length} running QA` : "",
    ].filter(Boolean);
    const soonest = agents.sort((a, b) => Date.parse(a.lease.expiresAt ?? "") - Date.parse(b.lease.expiresAt ?? ""))[0];
    const firstRun = running[0];
    return {
      kind: "wait",
      reason: `all ${platform} devices busy${counts.length > 0 ? ` (${counts.join(", ")})` : ""}`,
      hold: soonest ? this.holdOf(soonest.lease, soonest.d) : null,
      heldBy: soonest
        ? agentHeldBy(soonest.lease)
        : firstRun
          ? { kind: "run", runId: firstRun.runId ?? "", title: this.live.get(firstRun.runId ?? "")?.title ?? firstRun.holder }
          : null,
    };
  }

  private async pass(): Promise<void> {
    this.dropStaleTickets();
    if (this.queue.length === 0) return;
    if (this.capped() && !this.queue.some((e) => e.kind === "ticket")) {
      for (const e of this.queue) this.setCapReason(e.id);
      return;
    }
    const devices = await this.deps.listDevices();
    if (this.stopped) return;
    this.lastDevices = devices;
    const now = this.now();

    for (const entry of [...this.queue]) {
      if (this.stopped) break;
      if (entry.kind === "ticket") {
        const ticket = this.tickets.get(entry.id);
        if (!ticket) this.removeEntry(entry);
        else if (!this.ticketBoots.has(ticket.id)) this.serveTicket(ticket, devices, now);
        continue;
      }
      const run = this.live.get(entry.id);
      if (!run || run.status !== "queued") {
        this.removeEntry(entry);
        continue;
      }
      // At the run cap this entry is skipped, not the rest of the queue: agents behind it still get devices.
      if (this.capped()) {
        this.setCapReason(run.id);
        continue;
      }
      const placed = this.place(run.deviceRequest, devices, now);
      if (placed.kind === "device") this.assign(run, placed.device);
      else if (placed.kind === "boot") {
        this.booting.set(run.id, { platform: placed.platform, target: placed.target });
        this.removeEntry(entry);
        this.deps.startRun(run, { bootTarget: { platform: placed.platform, target: placed.target } });
      } else this.setReason(run.id, placed.reason, placed.hold);
    }
  }

  private assign(run: Run, device: Device): void {
    this.deps.leases.grantRun(device.serial, { id: run.id, platform: device.platform }, { avdName: device.avdName ?? null });
    this.removeEntry({ kind: "run", id: run.id });
    this.deps.startRun(run, { serial: device.serial });
  }

  /** Called by the runner once a boot target is up: the run now owns that serial. */
  bootComplete(runId: string, serial: string): void {
    const boot = this.booting.get(runId);
    this.booting.delete(runId);
    const platform = boot?.platform ?? this.live.get(runId)?.deviceRequest.platform ?? "android";
    this.deps.leases.grantRun(serial, { id: runId, platform }, { avdName: platform === "android" ? (boot?.target ?? null) : null, booted: true });
  }

  release(runId: string): void {
    this.booting.delete(runId);
    this.deps.leases.releaseRun(runId);
    void this.schedule();
  }

  private removeEntry(entry: QueueEntry): void {
    const i = this.queue.findIndex((e) => e.kind === entry.kind && e.id === entry.id);
    if (i >= 0) this.queue.splice(i, 1);
    if (entry.kind === "run") {
      this.queueReasons.delete(entry.id);
      this.queueHolds.delete(entry.id);
    }
  }

  async cancelRun(id: string): Promise<Run> {
    const run = this.live.get(id);
    if (!run) throw new HttpError(409, `run ${id} is not active`);
    if (run.status === "queued") {
      this.removeEntry({ kind: "run", id });
      run.status = "cancelled";
      run.errorKind = "cancelled";
      run.endedAt = new Date().toISOString();
      this.update(run);
      void this.schedule();
      return run;
    }
    await this.deps.cancelActive(id);
    return this.live.get(id) ?? run;
  }

  // ---- Agent tickets: `acquire` shares the run queue, so one FIFO decides who gets the next free device. ----

  /**
   * Leases a device to an agent. Success returns the lease; otherwise the caller gets its place in the queue as a
   * ticket and calls again with `ticket` (a call that waits `waitMs` is *attached*: a grant while it waits is a full
   * lease; a grant while nobody waits is a claim-pending lease that the next call with the ticket picks up within 60 s).
   * `signal` aborting detaches the call, like a client that gave up.
   */
  async acquire(body: unknown, waitMs: number, signal?: AbortSignal): Promise<AcquireResult> {
    const input = parseOrThrow(AcquireSchema, body, "invalid_argument");
    if (input.ticket) {
      const claimed = this.deps.leases.claim(input.ticket);
      if (claimed) return { lease: this.toGrant(claimed) };
    }
    const resumed = input.ticket ? this.tickets.get(input.ticket) : undefined;
    if (resumed?.failure) {
      this.tickets.delete(resumed.id);
      throw resumed.failure;
    }
    let ticket: Ticket;
    if (resumed) {
      resumed.attached++;
      resumed.detachedAt = null;
      ticket = resumed;
    } else {
      ticket = await this.createTicket(input);
    }
    try {
      await this.schedule();
      const deadline = Date.now() + Math.max(0, waitMs);
      for (;;) {
        if (ticket.grant) return this.deliver(ticket, ticket.grant, signal);
        if (ticket.failure) {
          this.tickets.delete(ticket.id);
          throw ticket.failure;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0 || signal?.aborted) break;
        await waitForWake(ticket.wake.promise, remaining, signal);
        ticket.wake = Promise.withResolvers<void>();
      }
    } finally {
      ticket.attached--;
      if (ticket.attached === 0 && !ticket.grant) ticket.detachedAt = this.now();
    }
    return this.timedOut(ticket);
  }

  /** Hands a granted lease to the call that waited for it, unless that call's client has already gone: then the grant waits for its ticket. */
  private deliver(ticket: Ticket, lease: Lease, signal: AbortSignal | undefined): AcquireResult {
    if (!signal?.aborted) return { lease: this.toGrant(lease) };
    this.deps.leases.holdForClaim(lease, ticket.id);
    return { timedOut: true, ticket: ticket.id, position: 0, state: "waiting", heldBy: null, reason: "a device was granted after the call ended; resume with the ticket to claim it" };
  }

  private async createTicket(input: z.infer<typeof AcquireSchema>): Promise<Ticket> {
    const devices = await this.deps.listDevices();
    let request: Ticket["request"];
    if (input.serial) {
      const d = devices.find((x) => x.serial === input.serial);
      if (!d) throw new HttpError(404, `device ${input.serial} not connected`, "device_not_found");
      if (!isQaDevice(d)) throw new HttpError(400, `device ${input.serial} is a ${d.deviceType}; only phones and tablets can be leased`, "device_unsupported");
      if (this.excluded(input.serial)) throw new HttpError(400, `device ${input.serial} is excluded in config`, "device_excluded");
      request = { serial: input.serial };
    } else {
      const platform = input.platform ?? "android";
      if (!devices.some((d) => this.autoEligible(d, platform)) && !this.pickBoot(platform, devices).target) {
        throw new HttpError(409, `no ${platform} emulator or simulator is connected and none can be booted (see devicePool in the config)`, "no_device");
      }
      request = { platform };
    }
    if (this.tickets.size >= MAX_TICKETS) throw new HttpError(409, `${MAX_TICKETS} agents are already waiting for a device`, "queue_full");
    const ticket: Ticket = {
      id: randomBytes(12).toString("base64url"),
      holder: input.holder,
      reason: input.reason ?? null,
      request,
      ttlMinutes: input.ttlMinutes,
      cwd: input.cwd,
      enqueuedAt: this.now(),
      // Born attached: the call that created it waits on it from the moment the queue can see it.
      attached: 1,
      detachedAt: null,
      wake: Promise.withResolvers<void>(),
      grant: null,
      failure: null,
      waitReason: "waiting for a free device",
      waitHeldBy: null,
    };
    this.tickets.set(ticket.id, ticket);
    this.queue.push({ kind: "ticket", id: ticket.id });
    return ticket;
  }

  private serveTicket(ticket: Ticket, devices: Device[], now: number): void {
    const placed = this.place(ticket.request, devices, now);
    if (placed.kind === "device") {
      this.grantTicket(ticket, placed.device.serial, placed.device.platform, placed.device.avdName ?? null);
    } else if (placed.kind === "boot") {
      this.startTicketBoot(ticket, placed.platform, placed.target);
    } else {
      ticket.waitReason = placed.reason;
      ticket.waitHeldBy = placed.heldBy;
    }
  }

  /** Leases `serial` to the ticket: full when a call waits on it, claim-pending when nobody does. */
  private grantTicket(ticket: Ticket, serial: string, platform: Platform, avdName: string | null, booted = false): void {
    ticket.grant = this.deps.leases.grantAgent({
      serial,
      platform,
      avdName,
      holder: ticket.holder,
      reason: ticket.reason,
      ttlMinutes: ticket.ttlMinutes,
      cwd: ticket.cwd,
      claimTicket: ticket.attached === 0 ? ticket.id : undefined,
      booted,
    });
    this.tickets.delete(ticket.id);
    this.removeEntry({ kind: "ticket", id: ticket.id });
    ticket.wake.resolve();
  }

  private startTicketBoot(ticket: Ticket, platform: Platform, target: string): void {
    this.ticketBoots.set(ticket.id, { platform, target });
    ticket.wake.resolve();
    this.deps.boot(platform, target).then(
      (serial) => {
        this.ticketBoots.delete(ticket.id);
        if (this.tickets.has(ticket.id)) {
          try {
            this.grantTicket(ticket, serial, platform, platform === "android" ? target : null, true);
          } catch (e) {
            console.error(`booted ${serial} for an agent but could not lease it:`, e);
          }
        }
        void this.schedule();
      },
      (e: unknown) => {
        this.ticketBoots.delete(ticket.id);
        ticket.failure = new HttpError(502, `boot failed: ${e instanceof Error ? e.message : String(e)}`, "boot_failed");
        this.removeEntry({ kind: "ticket", id: ticket.id });
        ticket.wake.resolve();
        void this.schedule();
      },
    );
  }

  /** Tickets nobody has called for within the claim window are forgotten (their place goes to the next entry). */
  private dropStaleTickets(): void {
    const now = this.now();
    for (const t of [...this.tickets.values()]) {
      if (t.attached > 0 || t.detachedAt === null || this.ticketBoots.has(t.id) || now - t.detachedAt < CLAIM_WINDOW_MS) continue;
      this.tickets.delete(t.id);
      this.removeEntry({ kind: "ticket", id: t.id });
    }
  }

  private timedOut(ticket: Ticket): AcquireResult {
    const boot = this.ticketBoots.get(ticket.id);
    return {
      timedOut: true,
      ticket: ticket.id,
      position: this.queue.findIndex((e) => e.kind === "ticket" && e.id === ticket.id) + 1,
      state: boot ? "booting" : "waiting",
      heldBy: boot ? { kind: "booting" } : ticket.waitHeldBy,
      reason: boot ? `booting ${boot.target}` : ticket.waitReason,
    };
  }

  /** The reply for a granted lease, built from what is already known: nothing here may await, or a stall would strand a lease nobody was told about. */
  private toGrant(lease: Lease): LeaseGrant {
    return {
      serial: lease.serial,
      platform: lease.platform,
      name: this.lastDevices.find((d) => d.serial === lease.serial)?.name ?? androidName({ avdName: lease.avdName ?? undefined, model: "", serial: lease.serial }),
      mobileDeviceId: mobileDeviceIdOf({ serial: lease.serial, platform: lease.platform, avdName: lease.avdName }),
      leaseId: lease.leaseId,
      expiresAt: lease.expiresAt ?? "",
      ttlMinutes: lease.ttlMinutes,
    };
  }

  /** Waiting agents, in queue order, without anything secret (the ticket id resumes a place, so it is not listed). */
  ticketsView(): TicketView[] {
    this.dropStaleTickets();
    return this.queue.flatMap((e, i) => {
      const t = e.kind === "ticket" ? this.tickets.get(e.id) : undefined;
      if (!t || t.failure) return [];
      return [
        {
          holder: t.holder,
          reason: t.reason,
          request: t.request,
          position: i + 1,
          state: this.ticketBoots.has(t.id) ? ("booting" as const) : ("waiting" as const),
          enqueuedAt: new Date(t.enqueuedAt).toISOString(),
        },
      ];
    });
  }

  /** Per platform, who waits for *any* device of it (waiters for one serial show on that device). */
  waitingView(): { platform: Platform; holders: string[]; runIds: string[] }[] {
    const out = new Map<Platform, { platform: Platform; holders: string[]; runIds: string[] }>();
    const group = (platform: Platform) => {
      const g = out.get(platform) ?? { platform, holders: [], runIds: [] };
      out.set(platform, g);
      return g;
    };
    for (const e of this.queue) {
      if (e.kind === "ticket") {
        const t = this.tickets.get(e.id);
        if (t && "platform" in t.request && !group(t.request.platform).holders.includes(t.holder)) group(t.request.platform).holders.push(t.holder);
      } else {
        const run = this.live.get(e.id);
        if (run && !run.deviceRequest.serial) group(run.deviceRequest.platform).runIds.push(run.id);
      }
    }
    return [...out.values()].sort((a, b) => a.platform.localeCompare(b.platform));
  }

  /** Who waits for this specific serial, oldest first. */
  private waitersFor(serial: string): DeviceWaiter[] {
    return this.queue.flatMap((e): DeviceWaiter[] => {
      if (e.kind === "ticket") {
        const t = this.tickets.get(e.id);
        return t && "serial" in t.request && t.request.serial === serial
          ? [{ kind: "agent", holder: t.holder, since: new Date(t.enqueuedAt).toISOString() }]
          : [];
      }
      const run = this.live.get(e.id);
      return run?.deviceRequest.serial === serial ? [{ kind: "run", runId: run.id, title: run.title }] : [];
    });
  }

  /** Who the queue would hand `serial` to if it were free right now (null = nobody); used to say `next` on lease events. */
  nextFor(serial: string): LeaseNext | null {
    const device = this.lastDevices.find((d) => d.serial === serial);
    if (!device) return null;
    const capped = this.capped();
    for (const e of this.queue) {
      if (e.kind === "ticket") {
        const t = this.tickets.get(e.id);
        if (!t || this.ticketBoots.has(t.id)) continue;
        if ("serial" in t.request ? t.request.serial === serial : this.autoEligible(device, t.request.platform)) return { kind: "agent", holder: t.holder };
        continue;
      }
      const run = this.live.get(e.id);
      if (!run || run.status !== "queued" || capped) continue;
      const req = run.deviceRequest;
      if (req.serial ? req.serial === serial && req.platform === device.platform : this.autoEligible(device, req.platform)) {
        return { kind: "run", runId: run.id, title: run.title };
      }
    }
    return null;
  }

  /** Busy/booting/lease overlay for the device list. */
  overlay(devices: Device[], isBootedByTapocalypse: (s: string) => boolean): Device[] {
    const now = this.now();
    const out: Device[] = devices.map((d) => {
      const owner = this.deps.leases.deviceOwner(d.serial, now);
      return {
        ...d,
        busyRunId: owner?.kind === "run" ? owner.lease.runId : undefined,
        lease: owner?.kind === "agent" ? leaseView(owner.lease) : null,
        waiters: this.waitersFor(d.serial),
        bootedByTapocalypse: isBootedByTapocalypse(d.serial),
      };
    });
    const placeholder = (platform: Platform, target: string, busyRunId?: string): Device => ({
      serial: `booting:${target}`,
      platform,
      kind: platform === "android" ? "emulator" : "simulator",
      model: target,
      name: platform === "android" ? target.replace(/_/g, " ") : target,
      osVersion: null,
      screen: null,
      deviceType: "unknown",
      state: "booting",
      busyRunId,
      idleShutdownAt: null,
    });
    for (const [runId, b] of this.booting) out.push(placeholder(b.platform, b.target, runId));
    for (const b of this.ticketBoots.values()) out.push(placeholder(b.platform, b.target));
    return out;
  }
}
