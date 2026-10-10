import { EventEmitter } from "node:events";
import { statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { getBatchMeta, makeBatchId, pruneBatchMeta, saveBatchMeta } from "../batches";
import { type Config, HttpError } from "../config";
import { artemisAvailable } from "../doctor";
import { getHarness, resolveHarness } from "../harness";
import { HARNESS_IDS, type HarnessId } from "../harness/types";
import { getProject, PACKAGE_RE, type Project, resolvePersonaPath } from "../projects/registry";
import type { Device } from "../devices/devices";
import { getSuite, MAX_BRIEF_LENGTH, MAX_TITLE_LENGTH, type Suite, type SuiteCheck } from "../suites";
import { extractTickets, lookupPullRequest, resolveSource, type SourceInput, SourceInputSchema } from "./source";
import { loadPersona } from "./prompt";
import { createRun, deleteRun as deleteStoredRun, getRun, listRuns, type NewRun, saveRun } from "./store";
import { ACTIVE, type Activity, type Backend, type Check, type DeviceRequest, type Platform, type Run, type RunSource } from "./types";

export type StartTarget = { serial: string } | { bootTarget: { platform: Platform; target: string } };

export interface SchedulerDeps {
  config: Pick<Config, "maxConcurrentRuns" | "devicePool" | "agent">;
  listDevices(): Promise<Device[]>;
  /** Number of devices of this platform booted by this process (pool `booted` map). */
  bootedCount(platform: Platform): number;
  /** Manual (Devices page / API) boots of this platform still in flight; they hold a `maxBooted` slot. */
  manualBootCount(platform: Platform): number;
  isBootingSerial(serial: string): boolean;
  /** An AVD name / simulator UDID with a boot in flight (scheduler-started or manual). */
  isBootingTarget(target: string): boolean;
  markAssigned(serial: string): void;
  markReleased(serial: string): void;
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
  backend?: Backend;
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
  backend?: Backend;
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
  backend: z.enum(["mobile-mcp", "artemis"]).optional(),
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
  backend: z.enum(["mobile-mcp", "artemis"]).optional(),
  packageId,
  requestedBy,
  source: SourceInputSchema.optional(),
  harness: harnessId,
  model: optionalText(),
  thinking: thinkingLevel,
  effort: optionalText(40),
  install: installRequest.optional(),
});

function parseOrThrow<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0]!;
  const where = issue.path.map(String).join(".");
  throw new HttpError(400, where ? `${where}: ${issue.message}` : issue.message);
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

export class Scheduler {
  readonly bus = new EventEmitter();
  /** Run ids waiting for a device, FIFO by createdAt. */
  readonly queue: string[] = [];
  readonly assigned = new Map<string, string>();
  readonly booting = new Map<string, { platform: Platform; target: string }>();
  /** Authoritative in-memory copy of every non-terminal run. */
  private live = new Map<string, Run>();
  private scheduling = false;
  /** Detached PR lookups by run id; each promise never rejects and removes itself once settled. */
  private prLookups = new Map<string, Promise<void>>();
  private rerunRequested = false;
  private stopped = false;
  /** Why each queued run is still waiting, refreshed by every scheduling pass. */
  private queueReasons = new Map<string, string>();

  constructor(private deps: SchedulerDeps) {
    this.bus.setMaxListeners(0);
  }

  /** Restores persisted state after a restart: active runs become interrupted, queued runs re-queue. */
  restore(): void {
    const runs = listRuns().reverse();
    for (const run of runs) {
      if (run.status === "queued") {
        this.live.set(run.id, run);
        this.queue.push(run.id);
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

  queuePosition(id: string): number | null {
    const i = this.queue.indexOf(id);
    return i < 0 ? null : i + 1;
  }

  queueReason(id: string): string | null {
    return this.queueReasons.get(id) ?? null;
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
    const backend = input.backend ?? "mobile-mcp";
    const harness = await resolveHarness({
      run: input.harness,
      project: project.agent?.harness,
      persona: personaHarness(project),
      config: this.deps.config.agent?.harness,
    });
    const { label, capabilities } = getHarness(harness);
    if (!capabilities.backends.includes(backend)) throw new HttpError(400, `${label} does not support the ${backend} backend`);
    if (backend === "artemis" && platform === "ios") throw new HttpError(400, "Artemis backend is Android-only");
    if (backend === "artemis" && !artemisAvailable()) {
      throw new HttpError(400, "Artemis backend is not configured (set artemisPath in tapocalypse.config.json)");
    }
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
        backend,
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
    this.queue.push(run.id);
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
          backend: input.backend,
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
        backend: run.backend,
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
      backend: run.backend,
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
    this.queue.push(next.id);
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
    if (run.batchId) pruneBatchMeta(run.batchId);
  }

  /** True while the run still owns a device slot, i.e. its runner is working even if the run is already marked cancelled. */
  isHeld(id: string): boolean {
    return this.booting.has(id) || [...this.assigned.values()].includes(id);
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

  /** Serialized: concurrent triggers coalesce into one extra pass. */
  async schedule(): Promise<void> {
    if (this.stopped) return;
    if (this.scheduling) {
      this.rerunRequested = true;
      return;
    }
    this.scheduling = true;
    try {
      do {
        this.rerunRequested = false;
        await this.pass();
      } while (this.rerunRequested);
    } catch (e) {
      console.error("schedule failed:", e);
    } finally {
      this.scheduling = false;
    }
  }

  /** Runs holding a slot: assigned to a device or booting one. */
  activeCount(): number {
    return this.assigned.size + this.booting.size;
  }

  private setReason(id: string, reason: string | null): void {
    if ((this.queueReasons.get(id) ?? null) === reason) return;
    if (reason === null) this.queueReasons.delete(id);
    else this.queueReasons.set(id, reason);
    const run = this.live.get(id);
    if (run) this.bus.emit("run", run);
  }

  /** Every run still queued is waiting for a free run slot. */
  private setCapReasons(): void {
    const reason = `maxConcurrentRuns (${this.deps.config.maxConcurrentRuns}) reached`;
    for (const id of this.queue) this.setReason(id, reason);
  }

  private async pass(): Promise<void> {
    if (this.queue.length === 0) return;
    if (this.activeCount() >= this.deps.config.maxConcurrentRuns) {
      this.setCapReasons();
      return;
    }
    const devices = await this.deps.listDevices();
    if (this.stopped) return;
    const { excludeSerials, avds, maxBooted } = this.deps.config.devicePool.android;
    const usable = (d: Device) =>
      d.state === "ready" && !this.assigned.has(d.serial) && !d.artemisOwner && !this.deps.isBootingSerial(d.serial);

    for (const id of [...this.queue]) {
      if (this.stopped) break;
      if (this.activeCount() >= this.deps.config.maxConcurrentRuns) {
        this.setCapReasons();
        break;
      }
      const run = this.live.get(id);
      if (!run || run.status !== "queued") {
        this.removeFromQueue(id);
        continue;
      }
      const req = run.deviceRequest;
      if (req.serial) {
        const d = devices.find((x) => x.serial === req.serial && x.platform === req.platform);
        if (d && usable(d)) this.assign(run, d.serial);
        else if (!d) this.setReason(id, `${req.serial} is not connected`);
        else if (this.assigned.has(d.serial)) this.setReason(id, `${d.serial} is busy`);
        else if (d.artemisOwner) this.setReason(id, `${d.serial} is held by an Artemis task`);
        else this.setReason(id, `${d.serial} is booting`);
        continue;
      }
      const candidates = devices.filter(
        (d) => d.platform === req.platform && d.kind !== "physical" && isQaDevice(d) && !excludeSerials.includes(d.serial),
      );
      const free = candidates.filter(usable).sort((a, b) => a.serial.localeCompare(b.serial));
      if (run.backend === "artemis") free.sort((a, b) => Number(!!b.artemisHelper) - Number(!!a.artemisHelper));
      if (free[0]) {
        this.assign(run, free[0].serial);
        continue;
      }
      const bootingTargets = new Set([...this.booting.values()].map((b) => b.target));
      const bootable = (name: string) => !bootingTargets.has(name) && !this.deps.isBootingTarget(name);
      let target: string | undefined;
      let capped = false;
      if (req.platform === "android") {
        const inFlight = [...this.booting.values()].filter((b) => b.platform === "android").length + this.deps.manualBootCount("android");
        if (this.deps.bootedCount("android") + inFlight < maxBooted) {
          const running = new Set(devices.map((d) => d.avdName).filter(Boolean));
          target = avds.find((a) => !running.has(a) && bootable(a) && !WEARABLE_AVD.test(a));
        } else {
          capped = avds.length > 0;
        }
      } else {
        const up = new Set(devices.map((d) => d.serial));
        target = this.deps.config.devicePool.ios.simulators.find((u) => !up.has(u) && bootable(u));
      }
      if (target) {
        this.booting.set(run.id, { platform: req.platform, target });
        this.removeFromQueue(run.id);
        this.deps.startRun(run, { bootTarget: { platform: req.platform, target } });
      } else if (capped) {
        this.setReason(id, `maxBooted (${maxBooted}) reached`);
      } else if (candidates.length > 0) {
        this.setReason(id, `all ${req.platform} devices busy`);
      } else {
        this.setReason(id, `no ${req.platform} device available`);
      }
    }
  }

  private assign(run: Run, serial: string): void {
    this.assigned.set(serial, run.id);
    this.deps.markAssigned(serial);
    this.removeFromQueue(run.id);
    this.deps.startRun(run, { serial });
  }

  /** Called by the runner once a boot target is up: the run now owns that serial. */
  bootComplete(runId: string, serial: string): void {
    this.booting.delete(runId);
    this.assigned.set(serial, runId);
    this.deps.markAssigned(serial);
  }

  release(runId: string): void {
    this.booting.delete(runId);
    for (const [serial, owner] of this.assigned) {
      if (owner !== runId) continue;
      this.assigned.delete(serial);
      this.deps.markReleased(serial);
    }
    void this.schedule();
  }

  private removeFromQueue(id: string): void {
    const i = this.queue.indexOf(id);
    if (i >= 0) this.queue.splice(i, 1);
    this.queueReasons.delete(id);
  }

  async cancelRun(id: string): Promise<Run> {
    const run = this.live.get(id);
    if (!run) throw new HttpError(409, `run ${id} is not active`);
    if (run.status === "queued") {
      this.removeFromQueue(id);
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

  /** Busy/booting overlay for the device list. */
  overlay(devices: Device[], isBootedByTapocalypse: (s: string) => boolean): Device[] {
    const out: Device[] = devices.map((d) => ({
      ...d,
      busyRunId: this.assigned.get(d.serial),
      bootedByTapocalypse: isBootedByTapocalypse(d.serial),
    }));
    for (const [runId, b] of this.booting) {
      out.push({
        serial: `booting:${b.target}`,
        platform: b.platform,
        kind: b.platform === "android" ? "emulator" : "simulator",
        model: b.target,
        name: b.platform === "android" ? b.target.replace(/_/g, " ") : b.target,
        osVersion: null,
        screen: null,
        deviceType: "unknown",
        state: "booting",
        busyRunId: runId,
        idleShutdownAt: null,
      });
    }
    return out;
  }
}
