import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config, HttpError, MAX_STEER_CHARS, XCRUN_BIN } from "../config";
import { adb, appVersion, artemisLockOwner, type Device, ensureArtemisHelper, exec, listDevices, mobileMcpDeviceId, stopMobileMcpDeviceServer } from "../devices/devices";
import { bootAndroid, bootIos } from "../devices/pool";
import { getHarness as registryHarness, harnessBin } from "../harness";
import {
  ARTEMIS_SERVER,
  type Harness,
  type HarnessEvent,
  type HarnessExit,
  type HarnessId,
  type HarnessSession,
  MOBILE_MCP_PACKAGE,
  MOBILE_MCP_SERVER,
  type McpServerSpec,
  PROGRESS_SERVER,
  type ProgressSink,
  type ReplayContext,
} from "../harness/types";
import { getProject, type Project, resolvePersonaPath } from "../projects/registry";
import { screenshotsDir } from "./artefacts";
import { type Outcome, classifyExit, deriveVerdict, hasResolvedCheck, parseDurationMs, UsageTotals } from "./outcome";
import { ProgressRecorder } from "./progress";
import { buildPrompt, loadPersona, type Persona, splitThinking } from "./prompt";
import { isQaDevice, type Scheduler, type StartTarget } from "./scheduler";
import { appendEvent, appendStderr, runDir } from "./store";
import { type Activity, type CheckStatus, type ErrorKind, type Run, type RunUsage } from "./types";

export interface Runner {
  startRun(run: Run, target: StartTarget): void;
  cancelActive(id: string): Promise<void>;
  steerRun(id: string, message: string): Promise<void>;
  isLive(id: string): boolean;
  /** Synchronously SIGTERMs (then SIGKILLs) every live agent process; used on server shutdown. */
  killAll(): void;
  /** Bearer token and progress sink of a live run's `POST /mcp/runs/<id>` endpoint; null once the run is over or unknown. */
  progressLookup(runId: string): { token: string; sink: ProgressSink } | null;
}

/** The scheduler surface the runner uses. */
export type RunnerScheduler = Pick<Scheduler, "activity" | "update" | "release" | "retry" | "bootComplete" | "getLive" | "waitForPrLookup">;

/** Injection points for tests; production uses the harness registry and real device discovery. */
export interface RunnerDeps {
  getHarness?: (id: HarnessId) => Harness;
  listDevices?: () => Promise<Device[]>;
}

interface RunContext {
  run: Run;
  project: Project;
  harness: Harness;
  session: HarnessSession | null;
  /** Set once cancellation was requested; the run then ends `cancelled` whatever the process does. */
  cancelRequested: boolean;
  /** The harness reported its turn over (post-processing started). */
  settled: boolean;
  /** `finalize` ran: terminal status set, device released. Exactly-once guard. */
  finalized: boolean;
  /** Post-settle housekeeping (usage, transcript); the exit handler waits for it so nothing is lost to a fast exit. */
  completion: Promise<void> | null;
  /** Tool calls seen so far, for `tool_end` pairing during live activity mapping. */
  starts: ReplayContext["starts"];
  /** Fallback usage totals from live events, for runs that end before the harness can report final usage. */
  usage: UsageTotals;
  /** `Date.now()` when the agent was spawned; null before. */
  spawnedAt: number | null;
  /** Parsed `config.runMaxTime`; null when unparseable. */
  budgetMs: number | null;
  /** Pending timers (post-close kill, time-budget nudges); cleared by `finalize`. */
  timers: Set<NodeJS.Timeout>;
  recorder: ProgressRecorder;
  /** Bearer token of the run-scoped progress endpoint; set at spawn, dropped at finalize. */
  token: string | null;
}

const STEP_TIMEOUT_MS = 15_000;
/** Upper bound on delaying the prompt for a still-pending pull request lookup. */
const PR_LOOKUP_WAIT_MS = 15_000;
/** After the turn ended and the session was released, how long the process may take to exit before it is killed. */
const DRAIN_KILL_MS = 60_000;
/** Harnesses enforce the time budget themselves where they can; if one still runs this long after it, Tapocalypse kills it. */
const HARD_KILL_GRACE_MS = 5 * 60_000;
/** Upper bound on a graceful abort before the session is killed. */
const ABORT_HARD_MS = 30_000;
/** Fraction of the time budget after which the agent is told to wrap up. */
const WRAP_UP_AT = 0.8;
const CANCEL_USAGE_TIMEOUT_MS = 5_000;
const INSTALL_TIMEOUT_MS = 180_000;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, Bun.sleep(ms).then((): never => {
    throw new Error(`timed out after ${ms / 1000}s`);
  })]);
}

function failure(error: string, errorKind: ErrorKind = "infra"): Outcome {
  return { status: "error", errorKind, error, derived: null };
}

function formatVersion(v: { versionName: string | null; versionCode: string | null }): string {
  return `${v.versionName ?? "unknown"} (${v.versionCode ?? "unknown"})`;
}

export function createRunner(scheduler: RunnerScheduler, deps: RunnerDeps = {}): Runner {
  const harnessFor = deps.getHarness ?? registryHarness;
  const contexts = new Map<string, RunContext>();
  let shuttingDown = false;

  function log(run: Run, kind: Activity["kind"], text: string, extra?: { checkId?: string; checkStatus?: CheckStatus }): void {
    const seq = appendEvent(run.id, { type: "_activity", kind, text, ...extra });
    scheduler.activity(run.id, { ts: new Date().toISOString(), seq, kind, text, ...extra });
  }

  /**
   * Sets the terminal state, releases the device and persists — exactly once per run. `noRetry` opts an infra failure
   * out of the automatic retry.
   */
  function finalize(ctx: RunContext, outcome: Outcome & { noRetry?: boolean }): void {
    if (ctx.finalized) return;
    ctx.finalized = true;
    const { run } = ctx;
    contexts.delete(run.id);
    ctx.token = null;
    for (const t of ctx.timers) clearTimeout(t);
    ctx.timers.clear();
    if (shuttingDown) {
      // Server is going down: leave the persisted run.json untouched (restore() marks it interrupted) and
      // do not release, which would start the next queued run.
      return;
    }
    if (ctx.cancelRequested) {
      run.status = "cancelled";
      run.errorKind = "cancelled";
    } else {
      run.status = outcome.status === "cancelled" ? "error" : outcome.status;
      run.errorKind = outcome.errorKind;
      if (outcome.error) run.error = outcome.error;
      if (outcome.derived) {
        run.verdict = outcome.derived.verdict;
        run.verdictSource = "derived";
        run.summary = outcome.derived.summary;
      }
    }
    run.usage ??= ctx.usage.snapshot(run.model);
    run.endedAt ??= new Date().toISOString();
    try {
      scheduler.update(run);
      const retriable =
        run.status === "error" &&
        run.errorKind === "infra" &&
        !outcome.noRetry &&
        !hasResolvedCheck(run.checks) &&
        run.attempt <= config.retry.infra;
      if (retriable) {
        try {
          const next = scheduler.retry(run);
          log(run, "info", `infrastructure failure; retrying as ${next.id} (attempt ${next.attempt})`);
          scheduler.update(run);
        } catch (e) {
          log(run, "warn", `retry not scheduled: ${errorMessage(e)}`);
        }
      }
    } finally {
      scheduler.release(run.id);
    }
  }

  /** Reads the installed app version into `run.build`; never fails the run. */
  async function captureBuild(ctx: RunContext, serial: string): Promise<void> {
    const { run } = ctx;
    try {
      const version = await appVersion({ serial, platform: run.deviceRequest.platform }, run.packageId);
      if (!version) {
        log(run, "warn", `${run.packageId} is not installed on ${serial}`);
        return;
      }
      run.build = { packageId: run.packageId, ...version, capturedAt: new Date().toISOString() };
      scheduler.update(run);
      log(run, "info", `build under test: ${run.packageId} ${formatVersion(version)}`);
    } catch (e) {
      log(run, "warn", `build capture failed: ${errorMessage(e)}`);
    }
  }

  /** Post-settle best-effort re-read; records the change if the app was upgraded during the run. */
  async function recaptureBuild(ctx: RunContext): Promise<void> {
    const { run } = ctx;
    if (!run.deviceSerial) return;
    try {
      const version = await appVersion({ serial: run.deviceSerial, platform: run.deviceRequest.platform }, run.packageId);
      if (!version || ctx.finalized || shuttingDown || ctx.cancelRequested) return;
      const before = run.build;
      if (before && before.versionName === version.versionName && before.versionCode === version.versionCode) return;
      run.build = { packageId: run.packageId, ...version, capturedAt: new Date().toISOString() };
      scheduler.update(run);
      log(run, "info", `build changed during run: ${before ? formatVersion(before) : "not installed"} → ${formatVersion(version)}`);
    } catch {
      // best-effort
    }
  }

  /** Reads the harness's final usage (and raw stats, when it has them) into the run; never fails the run. */
  async function captureUsage(ctx: RunContext, session: HarnessSession, timeoutMs: number): Promise<void> {
    const { run } = ctx;
    try {
      const [usage, stats] = await withTimeout(Promise.all([session.usage(), session.rawStats?.() ?? null]), timeoutMs);
      if (ctx.finalized) return;
      if (usage) run.usage = { ...usage, model: usage.model ?? run.model } satisfies RunUsage;
      if (stats !== null) run.stats = stats;
    } catch (e) {
      log(run, "warn", `usage capture failed: ${errorMessage(e)}`);
    }
  }

  /** Post-settle housekeeping: usage, transcript, then release the session so it can drain and exit. */
  async function complete(ctx: RunContext, session: HarnessSession): Promise<void> {
    const { run } = ctx;
    await captureUsage(ctx, session, STEP_TIMEOUT_MS);
    if (session.exportTranscript) {
      try {
        const written = await withTimeout(session.exportTranscript(path.join(runDir(run.id), "transcript.html")), STEP_TIMEOUT_MS);
        if (written && !ctx.finalized) run.transcriptHtml = true;
      } catch (e) {
        log(run, "warn", `transcript export failed: ${errorMessage(e)}`);
      }
    }
    if (!ctx.finalized) scheduler.update(run);
    if (!shuttingDown && !ctx.cancelRequested && !ctx.finalized) await recaptureBuild(ctx);
    if (ctx.finalized) return;
    ctx.timers.add(setTimeout(() => session.kill(), DRAIN_KILL_MS));
    session.abort().catch(() => {});
  }

  /** Runs the completion path once, when the harness reports its turn over. */
  function settle(ctx: RunContext): void {
    if (ctx.settled || ctx.finalized || !ctx.session) return;
    ctx.settled = true;
    ctx.completion = complete(ctx, ctx.session);
  }

  function onRaw(ctx: RunContext, frame: object): void {
    const { run } = ctx;
    const seq = appendEvent(run.id, frame);
    const activity = ctx.harness.toActivity(frame, { backend: run.backend, seq, starts: ctx.starts });
    if (activity) scheduler.activity(run.id, activity);
  }

  function onEvent(ctx: RunContext, e: HarnessEvent): void {
    switch (e.type) {
      case "session":
        // Claude only reports its model on `system/init`; an explicitly requested model (or alias) stays as asked.
        if (e.model && !ctx.run.model) {
          ctx.run.model = e.model;
          scheduler.update(ctx.run);
        }
        break;
      case "tool_call":
        ctx.usage.toolCall();
        break;
      case "usage":
        ctx.usage.add(e.usage, e.cumulative);
        break;
      case "notice":
        log(ctx.run, e.level, e.text);
        break;
      case "turn_end":
        settle(ctx);
        break;
      default:
        break;
    }
  }

  async function onExit(ctx: RunContext, exit: HarnessExit): Promise<void> {
    const { run } = ctx;
    // A harness that exits right after its last turn must not outrun the usage/transcript capture.
    if (ctx.completion) await ctx.completion.catch(() => {});
    finalize(
      ctx,
      classifyExit({
        cancelled: ctx.cancelRequested,
        verdictRecorded: run.verdict !== null,
        checks: run.checks,
        exit,
        harnessLabel: ctx.harness.label,
        elapsedMs: ctx.spawnedAt === null ? null : Date.now() - ctx.spawnedAt,
        budgetMs: ctx.budgetMs,
        budgetLabel: config.runMaxTime,
      }),
    );
  }

  /** Installs `run.install` on the assigned device; throws with the tool's last output line on failure. */
  async function installApp(ctx: RunContext, serial: string): Promise<void> {
    const { run } = ctx;
    if (!run.install) return;
    const file = run.install.path;
    const name = path.basename(file);
    if (!existsSync(file)) throw new Error(`install failed: ${file} does not exist`);
    log(run, "info", `installing ${name} on ${serial}`);
    const r =
      run.deviceRequest.platform === "android"
        ? await adb(serial, ["install", "-r", "-d", file], INSTALL_TIMEOUT_MS)
        : await exec([XCRUN_BIN, "simctl", "install", serial, file], { timeoutMs: INSTALL_TIMEOUT_MS });
    const output = `${r.text}\n${r.stderr}`.trim();
    if (r.code !== 0 || /\bFailure\b/.test(output)) {
      const last = output.split("\n").map((l) => l.trim()).filter(Boolean).at(-1) ?? `exit code ${r.code}`;
      throw new Error(`install failed: ${last}`);
    }
    log(run, "info", `installed ${name}`);
  }

  /** The listed device behind `serial` (for its friendly name and type); undefined when it cannot be listed. */
  async function findDevice(serial: string): Promise<Device | undefined> {
    try {
      return (await (deps.listDevices ?? listDevices)()).find((d) => d.serial === serial);
    } catch {
      return undefined;
    }
  }

  async function preflight(ctx: RunContext, target: StartTarget): Promise<boolean> {
    const { run } = ctx;
    run.status = "preflight";
    scheduler.update(run);

    let serial: string;
    if ("bootTarget" in target) {
      const { platform, target: name } = target.bootTarget;
      log(run, "info", `booting ${name}`);
      try {
        serial = platform === "android" ? await bootAndroid(name, (m) => log(run, "info", m)) : await bootIos(name);
      } catch (e) {
        finalize(ctx, failure(errorMessage(e)));
        return false;
      }
      scheduler.bootComplete(run.id, serial);
      run.bootedByRun = true;
      log(run, "info", `booted ${name} as ${serial}`);
    } else {
      serial = target.serial;
    }
    if (ctx.cancelRequested) {
      finalize(ctx, failure("cancelled", "cancelled"));
      return false;
    }
    run.deviceSerial = serial;
    const device = await findDevice(serial);
    run.deviceName = device?.name ?? null;
    scheduler.update(run);
    if (device && !isQaDevice(device)) {
      finalize(ctx, { ...failure(`device ${serial} is a ${device.deviceType}; only phones and tablets can run QA`), noRetry: true });
      return false;
    }

    try {
      await installApp(ctx, serial);
    } catch (e) {
      finalize(ctx, { ...failure(errorMessage(e)), noRetry: true });
      return false;
    }
    await captureBuild(ctx, serial);

    const owner = artemisLockOwner(serial);
    if (owner) {
      finalize(ctx, failure(`Artemis task ${owner.sessionId ?? owner.pid} holds ${serial}; stop it in the Artemis console first`));
      return false;
    }

    if (run.backend === "artemis") {
      log(run, "info", `installing/upgrading Artemis helper on ${serial}`);
      await ensureArtemisHelper(serial);
      const pids = await stopMobileMcpDeviceServer(serial);
      log(run, "info", `stopped mobile-mcp DeviceServer pids: ${pids.length ? pids.join(", ") : "none"}`);
    } else {
      run.deviceLabel = await mobileMcpDeviceId({ serial, platform: run.deviceRequest.platform });
      scheduler.update(run);
      log(run, "info", `mobile-mcp device id: ${run.deviceLabel}`);
    }
    if (ctx.cancelRequested) {
      finalize(ctx, failure("cancelled", "cancelled"));
      return false;
    }
    return true;
  }

  /** Tells the agent to wrap up at 80% of the time budget, and stops it when it outlives the budget (plus a grace period for harnesses that enforce the limit themselves). */
  function watchTimeBudget(ctx: RunContext, session: HarnessSession): void {
    const { budgetMs } = ctx;
    if (budgetMs === null) return;
    const { run } = ctx;
    const label = ctx.harness.label;
    ctx.timers.add(
      setTimeout(() => {
        if (ctx.finalized || ctx.settled || ctx.cancelRequested || run.status !== "running") return;
        if (!session.steer) {
          log(run, "info", `80% of the ${config.runMaxTime} time budget used; ${label} cannot be steered, so it was not asked to wrap up`);
          return;
        }
        const message = `Time is almost up (80% of ${config.runMaxTime} used): stop testing now, write the report with the results you have and call ${session.toolName(PROGRESS_SERVER, "qa_finish")}.`;
        session.steer(message).then(
          () => log(run, "info", `80% of the ${config.runMaxTime} time budget used; asked the agent to wrap up`),
          (e: unknown) => log(run, "warn", `time budget steer failed: ${errorMessage(e)}`),
        );
      }, budgetMs * WRAP_UP_AT),
    );
    // Harnesses that enforce the limit themselves (omp `--max-time`) get a grace period; the others are stopped at the budget.
    const killAfterMs = budgetMs + (ctx.harness.capabilities.limits.maxTime ? HARD_KILL_GRACE_MS : 0);
    ctx.timers.add(
      setTimeout(() => {
        if (ctx.finalized) return;
        log(run, "warn", `${label} still running at the ${config.runMaxTime} time budget${killAfterMs > budgetMs ? ` plus ${HARD_KILL_GRACE_MS / 60_000} min` : ""}; stopping it`);
        session.kill();
      }, killAfterMs),
    );
  }

  /**
   * Model and effort are harness-native strings. Precedence: run (incl. suite) > project `agent` > persona (only when it
   * names this harness; none counts as omp) > `agent.harnesses[id]` > legacy `agent.model` / `agent.thinking` (omp only).
   */
  function resolveModel(run: Run, project: Project, persona: Persona, id: HarnessId): { model: string | null; effort: string | null } {
    const omp = id === "omp";
    const settings = config.agent?.harnesses?.[id];
    // omp accepts a trailing `:<thinking>` on the model id.
    const requested = run.model ? (omp ? splitThinking(run.model) : { model: run.model, thinking: null }) : null;
    const personaApplies = (persona.harness ?? "omp") === id;
    const model =
      requested?.model ?? project.agent?.model ?? (personaApplies ? persona.model : null) ?? settings?.model ?? (omp ? config.agent?.model : undefined) ?? null;
    const effort =
      run.effort ??
      (omp ? run.thinking : null) ??
      requested?.thinking ??
      project.agent?.effort ??
      (personaApplies ? persona.thinking : null) ??
      settings?.effort ??
      (omp ? config.agent?.thinking : undefined) ??
      null;
    return { model, effort };
  }

  /** Device driver and progress servers mounted for this session only. Artemis comes from the user's own omp config. */
  function buildMcpServers(ctx: RunContext, token: string): McpServerSpec[] {
    const { run, harness } = ctx;
    const servers: McpServerSpec[] = [];
    if (run.backend === "mobile-mcp") {
      servers.push({ name: MOBILE_MCP_SERVER, transport: "stdio", command: "npx", args: ["-y", `${MOBILE_MCP_PACKAGE}@latest`] });
    }
    if (!harness.capabilities.nativeProgressTools) {
      servers.push({
        name: PROGRESS_SERVER,
        transport: "http",
        url: `http://127.0.0.1:${config.port}/mcp/runs/${run.id}`,
        headers: { Authorization: `Bearer ${token}` },
      });
    }
    return servers;
  }

  async function execute(ctx: RunContext, target: StartTarget): Promise<void> {
    const { run, project, harness } = ctx;
    if (!(await preflight(ctx, target))) return;

    const dir = runDir(run.id);
    const persona = loadPersona(resolvePersonaPath(project));
    const { model, effort } = resolveModel(run, project, persona, harness.id);
    run.model = model;
    run.effort = effort;
    if (harness.id === "omp") run.thinking = effort;
    mkdirSync(path.join(dir, "session"), { recursive: true });
    mkdirSync(screenshotsDir(run.id), { recursive: true });
    // A run queued by an older version still says "repo", but it has no artefacts yet and the agent is told to write into the data dir.
    run.storage = "data";
    writeFileSync(path.join(dir, "brief.md"), run.brief);
    const personaFile = path.join(dir, "persona.md");
    writeFileSync(personaFile, persona.body);

    if (ctx.cancelRequested) {
      finalize(ctx, failure("cancelled", "cancelled"));
      return;
    }
    // Shutting down: leave run.json as-is (preflight) so restore() marks it interrupted; never spawn the agent.
    if (shuttingDown) {
      finalize(ctx, failure("shutting down"));
      return;
    }

    run.status = "running";
    run.startedAt = new Date().toISOString();
    scheduler.update(run);

    const token = randomBytes(32).toString("hex");
    ctx.token = token;
    const session = harness.spawn({
      runId: run.id,
      cwd: project.repoPath,
      runDir: dir,
      persona: persona.body,
      personaFile,
      model,
      effort,
      mcpServers: buildMcpServers(ctx, token),
      backend: run.backend,
      limits: { maxTime: config.runMaxTime, maxTurns: config.agent?.maxTurns ?? null, maxBudgetUsd: config.agent?.maxBudgetUsd ?? null },
      settings: { ...config.agent?.harnesses?.[harness.id], bin: harnessBin(harness.id) },
      onEvent: (e) => onEvent(ctx, e),
      onRaw: (f) => onRaw(ctx, f),
      onStderr: (text) => appendStderr(run.id, text),
      ...(harness.capabilities.nativeProgressTools ? { onProgress: ctx.recorder } : {}),
    });
    ctx.session = session;
    ctx.spawnedAt = Date.now();
    void session.exited.then((exit) => onExit(ctx, exit)).catch((e: unknown) => {
      console.error(`run ${run.id}: exit handling failed:`, e);
      scheduler.release(run.id);
    });
    watchTimeBudget(ctx, session);

    // MCP servers connect in the background; prompting before they are up makes the agent fail with "No such tool".
    const info = await session.ready();
    if (info.model) run.model = info.model;
    scheduler.update(run);
    const deviceServer = run.backend === "mobile-mcp" ? MOBILE_MCP_SERVER : ARTEMIS_SERVER;
    const required = [deviceServer, ...(harness.capabilities.nativeProgressTools ? [] : [PROGRESS_SERVER])];
    for (const name of required) {
      const server = info.mcp.find((m) => m.name === name);
      if (!server?.ok) {
        finalize(ctx, failure(`MCP server ${name} failed: ${server?.error ?? "it was not mounted by the agent"}`));
        session.kill();
        return;
      }
    }
    // The detached `gh pr view` may still be running; give it a bounded chance so the prompt carries the PR.
    if (!ctx.cancelRequested && !shuttingDown) {
      await scheduler.waitForPrLookup(run.id, PR_LOOKUP_WAIT_MS);
      const live = scheduler.getLive(run.id);
      if (live && live !== run && live.source) run.source = live.source;
    }
    // A cancel, shutdown or exit (session that never ran) during ready()/the PR wait must not start a paid turn.
    if (ctx.cancelRequested || shuttingDown || ctx.finalized) return;
    await session.send(
      buildPrompt(run, (server, tool) => session.toolName(server, tool), {
        runMaxTime: config.runMaxTime,
        prependPersona: harness.capabilities.appendSystemPrompt ? null : persona.body,
      }),
    );
  }

  function startRun(run: Run, target: StartTarget): void {
    const project = getProject(run.projectId);
    if (!project) {
      run.status = "error";
      run.errorKind = "infra";
      run.error = `unknown project ${run.projectId}`;
      run.endedAt = new Date().toISOString();
      scheduler.update(run);
      scheduler.release(run.id);
      return;
    }
    if (shuttingDown) return;
    const ctx: RunContext = {
      run,
      project,
      harness: harnessFor(run.harness),
      session: null,
      cancelRequested: false,
      settled: false,
      finalized: false,
      completion: null,
      starts: new Map(),
      usage: new UsageTotals(),
      spawnedAt: null,
      budgetMs: parseDurationMs(config.runMaxTime),
      timers: new Set(),
      recorder: new ProgressRecorder({
        getRun: () => run,
        update: (mutate) => {
          mutate(run);
          scheduler.update(run);
        },
        log: (kind, text, extra) => log(run, kind, text, extra),
        repoPath: project.repoPath,
        runDir: runDir(run.id),
      }),
      token: null,
    };
    contexts.set(run.id, ctx);
    void execute(ctx, target)
      .catch((e: unknown) => {
        const message = errorMessage(e);
        if (!ctx.finalized && !ctx.cancelRequested && !shuttingDown) log(run, "error", message);
        const derived = deriveVerdict(run.checks);
        finalize(ctx, derived ? { status: "done", errorKind: "agent", error: message, derived } : failure(message));
        ctx.session?.kill();
      })
      .catch((e: unknown) => {
        // Last resort: a failure while recording a failure must never become an unhandled rejection that kills the server.
        console.error(`run ${run.id}: finalize failed:`, e);
        scheduler.release(run.id);
        ctx.session?.kill();
      });
  }

  async function cancelActive(id: string): Promise<void> {
    const ctx = contexts.get(id);
    if (!ctx || ctx.finalized) throw new HttpError(409, `run ${id} is not active`);
    const { run } = ctx;
    const alreadyRequested = ctx.cancelRequested;
    ctx.cancelRequested = true;
    const session = ctx.session;
    if (!session) {
      // Preflight (possibly mid-boot): the startRun flow notices the flag, releases the device and stops.
      if (alreadyRequested) return;
      run.status = "cancelled";
      run.errorKind = "cancelled";
      run.endedAt = new Date().toISOString();
      scheduler.update(run);
      return;
    }
    log(run, "info", "cancelling run");
    // Usage must survive the abort: read it while the session still answers.
    await captureUsage(ctx, session, CANCEL_USAGE_TIMEOUT_MS);
    const stopped = await Promise.race([session.abort().then(() => true), Bun.sleep(ABORT_HARD_MS).then(() => false)]);
    if (!stopped) {
      session.kill();
      await session.exited;
    }
  }

  async function steerRun(id: string, message: string): Promise<void> {
    const ctx = contexts.get(id);
    if (!ctx || !ctx.session || ctx.run.status !== "running") throw new HttpError(409, `run ${id} is not running`);
    if (ctx.settled) throw new HttpError(409, `run ${id} already finished its turn`);
    if (!ctx.session.steer) throw new HttpError(409, `steering is not supported by ${ctx.harness.label}`);
    if (message.length > MAX_STEER_CHARS) throw new HttpError(400, `message must be at most ${MAX_STEER_CHARS} characters`);
    await ctx.session.steer(message);
    log(ctx.run, "user", message);
  }

  function killAll(): void {
    shuttingDown = true;
    for (const ctx of contexts.values()) ctx.session?.kill();
  }

  function progressLookup(runId: string): { token: string; sink: ProgressSink } | null {
    const ctx = contexts.get(runId);
    if (!ctx || ctx.finalized || ctx.token === null) return null;
    return { token: ctx.token, sink: ctx.recorder };
  }

  return { startRun, cancelActive, steerRun, isLive: (id) => contexts.get(id)?.session != null, killAll, progressLookup };
}
