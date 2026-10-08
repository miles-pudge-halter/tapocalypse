import { EventEmitter } from "node:events";
import { z } from "zod";
import { type Config, HttpError } from "../config";
import { artemisAvailable } from "../doctor";
import { getProject } from "../projects/registry";
import type { Device } from "../devices/devices";
import { extractTickets, lookupPullRequest, resolveSource, type SourceInput, SourceInputSchema } from "./source";
import { createRun, getRun, listRuns, saveRun } from "./store";
import { ACTIVE, type Activity, type Backend, type DeviceRequest, type Platform, type Run, type RunSource } from "./types";

export type StartTarget = { serial: string } | { bootTarget: { platform: Platform; target: string } };

export interface SchedulerDeps {
  config: Pick<Config, "maxConcurrentRuns" | "devicePool">;
  listDevices(): Promise<Device[]>;
  /** Number of devices of this platform booted by this process (pool `booted` map). */
  bootedCount(platform: Platform): number;
  isBootingSerial(serial: string): boolean;
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
  title: string;
  brief: string;
  device?: Partial<DeviceRequest>;
  backend?: Backend;
  packageId?: string;
  requestedBy?: string;
  source?: SourceInput;
}

/** Missing / non-string text fields count as empty so the "title and brief are required" check reports them. */
const textOrEmpty = z.unknown().transform((v) => (typeof v === "string" ? v : ""));

const EnqueueSchema = z.object({
  projectId: z.string(),
  title: textOrEmpty,
  brief: textOrEmpty,
  device: z.object({ serial: z.string().optional(), platform: z.enum(["android", "ios"]).optional() }).optional(),
  backend: z.enum(["mobile-mcp", "artemis"]).optional(),
  packageId: z.string().optional(),
  requestedBy: z.string().optional(),
  source: SourceInputSchema.optional(),
});

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

  async enqueueRun(body: unknown): Promise<Run> {
    const parsed = EnqueueSchema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      const where = issue.path.map(String).join(".");
      throw new HttpError(400, where ? `${where}: ${issue.message}` : issue.message);
    }
    const input = parsed.data;
    const project = getProject(input.projectId);
    if (!project) throw new HttpError(400, `unknown project ${input.projectId}`);
    const title = input.title.trim();
    const brief = input.brief.trim();
    if (!title || !brief) throw new HttpError(400, "title and brief are required");
    const platform = input.device?.platform ?? project.defaultPlatform;
    const backend = input.backend ?? "mobile-mcp";
    if (backend === "artemis" && platform === "ios") throw new HttpError(400, "Artemis backend is Android-only");
    if (backend === "artemis" && !artemisAvailable()) {
      throw new HttpError(400, "Artemis backend is not configured (set artemisPath in tapocalypse.config.json)");
    }
    const serial = input.device?.serial || undefined;
    if (serial) {
      const devices = await this.deps.listDevices();
      if (!devices.some((d) => d.serial === serial && d.platform === platform)) {
        throw new HttpError(400, `device ${serial} not connected`);
      }
      if (this.deps.config.devicePool.android.excludeSerials.includes(serial)) {
        throw new HttpError(400, `device ${serial} is excluded in config`);
      }
    }
    const source = await resolveSource(project, input.source, title);
    const run = createRun({
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
      checks: [],
      error: null,
      startedAt: null,
      endedAt: null,
      stats: null,
      transcriptHtml: false,
      source,
      build: null,
    });
    this.queue.push(run.id);
    this.update(run);
    if (source.prStatus === "pending" || (source.prStatus === "provided" && (!source.pr?.title || !source.pr.url))) {
      const lookup = this.fillPullRequest(run.id, source)
        .catch((e: unknown) => console.error(`pull request lookup for ${run.id} failed:`, e))
        .finally(() => this.prLookups.delete(run.id));
      this.prLookups.set(run.id, lookup);
    }
    void this.schedule();
    return run;
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

  private activeCount(): number {
    return this.assigned.size + this.booting.size;
  }

  private async pass(): Promise<void> {
    if (this.queue.length === 0 || this.activeCount() >= this.deps.config.maxConcurrentRuns) return;
    const devices = await this.deps.listDevices();
    if (this.stopped) return;
    const { excludeSerials, avds, maxBooted } = this.deps.config.devicePool.android;
    const usable = (d: Device) =>
      d.state === "ready" && !this.assigned.has(d.serial) && !d.artemisOwner && !this.deps.isBootingSerial(d.serial);

    for (const id of [...this.queue]) {
      if (this.stopped || this.activeCount() >= this.deps.config.maxConcurrentRuns) break;
      const run = this.live.get(id);
      if (!run || run.status !== "queued") {
        this.removeFromQueue(id);
        continue;
      }
      const req = run.deviceRequest;
      if (req.serial) {
        const d = devices.find((x) => x.serial === req.serial && x.platform === req.platform);
        if (d && usable(d)) this.assign(run, d.serial);
        continue;
      }
      const free = devices
        .filter((d) => d.platform === req.platform && d.kind !== "physical" && !excludeSerials.includes(d.serial) && usable(d))
        .sort((a, b) => a.serial.localeCompare(b.serial));
      if (run.backend === "artemis") free.sort((a, b) => Number(!!b.artemisHelper) - Number(!!a.artemisHelper));
      if (free[0]) {
        this.assign(run, free[0].serial);
        continue;
      }
      const bootingTargets = new Set([...this.booting.values()].map((b) => b.target));
      let target: string | undefined;
      if (req.platform === "android") {
        const inFlight = [...this.booting.values()].filter((b) => b.platform === "android").length;
        if (this.deps.bootedCount("android") + inFlight < maxBooted) {
          const running = new Set(devices.map((d) => d.avdName).filter(Boolean));
          target = avds.find((a) => !running.has(a) && !bootingTargets.has(a));
        }
      } else {
        const up = new Set(devices.map((d) => d.serial));
        target = this.deps.config.devicePool.ios.simulators.find((u) => !up.has(u) && !bootingTargets.has(u));
      }
      if (target) {
        this.booting.set(run.id, { platform: req.platform, target });
        this.removeFromQueue(run.id);
        this.deps.startRun(run, { bootTarget: { platform: req.platform, target } });
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
  }

  async cancelRun(id: string): Promise<Run> {
    const run = this.live.get(id);
    if (!run) throw new HttpError(409, `run ${id} is not active`);
    if (run.status === "queued") {
      this.removeFromQueue(id);
      run.status = "cancelled";
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
        state: "booting",
        busyRunId: runId,
      });
    }
    return out;
  }
}
