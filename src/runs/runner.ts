import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { config, HttpError } from "../config";
import { appVersion, artemisLockOwner, ensureArtemisHelper, mobileMcpDeviceId, stopMobileMcpDeviceServer } from "../devices/devices";
import { bootAndroid, bootIos } from "../devices/pool";
import { mcpLaunchArgs, missingToolsMessage, resolveToolPrefixes } from "../omp/provision";
import { type Frame, OmpRpc } from "../omp/rpc";
import { getProject, type Project, resolvePersonaPath } from "../projects/registry";
import { resolveUnder } from "../reports/reports";
import { buildPrompt, frameToActivity, hostTools, loadPersona } from "./prompt";
import type { Scheduler, StartTarget } from "./scheduler";
import { appendEvent, appendStderr, runDir } from "./store";
import { type Activity, type Check, type Run, VERDICTS } from "./types";

export interface Runner {
  startRun(run: Run, target: StartTarget): void;
  cancelActive(id: string): Promise<void>;
  steerRun(id: string, message: string): Promise<void>;
  isLive(id: string): boolean;
  /** Synchronously SIGTERMs (then SIGKILLs) every live omp process; used on server shutdown. */
  killAll(): void;
}

interface RunContext {
  run: Run;
  project: Project;
  rpc: OmpRpc | null;
  /** Set once cancellation was requested; the run then ends `cancelled` whatever the process does. */
  cancelRequested: boolean;
  /** The agent signalled the session settled (post-processing started). */
  settled: boolean;
  /** `finalize` ran: terminal status set, device released. Exactly-once guard. */
  finalized: boolean;
  promptResult: { status: string; error: string | null } | null;
  /** Pending timers (settle fallback, post-close kill); cleared by `finalize`. */
  timers: Set<NodeJS.Timeout>;
}

const QaPlanArgs = z.object({ checks: z.array(z.object({ id: z.string(), title: z.string() })).min(1) });
const QaCheckArgs = z.object({
  id: z.string(),
  status: z.enum(["running", "pass", "fail", "blocked", "skipped"]),
  note: z.string().optional(),
  screenshot: z.string().optional(),
});
const QaFinishArgs = z.object({ verdict: z.enum(VERDICTS), summary: z.string(), reportPath: z.string() });

const STEP_TIMEOUT_MS = 15_000;
const CANCEL_GRACE_MS = 10_000;
/** Upper bound on delaying the prompt for a still-pending pull request lookup. */
const PR_LOOKUP_WAIT_MS = 15_000;
/** After `prompt_result`/`agent_end`, how long to wait for `session_settled` before completing anyway. */
const SETTLE_FALLBACK_MS = 30_000;
/** After stdin closes, how long omp may take to exit before it is killed. */
const DRAIN_KILL_MS = 60_000;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, Bun.sleep(ms).then((): never => {
    throw new Error(`timed out after ${ms / 1000}s`);
  })]);
}

function promptResultError(frame: Frame): string | null {
  const err = frame.error;
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return null;
}

function formatVersion(v: { versionName: string | null; versionCode: string | null }): string {
  return `${v.versionName ?? "unknown"} (${v.versionCode ?? "unknown"})`;
}

export function createRunner(scheduler: Scheduler): Runner {
  const rpcByRun = new Map<string, OmpRpc>();
  const contexts = new Map<string, RunContext>();
  let shuttingDown = false;

  function log(run: Run, kind: Activity["kind"], text: string): void {
    appendEvent(run.id, { type: "_activity", kind, text });
    scheduler.activity(run.id, { ts: new Date().toISOString(), kind, text });
  }

  /** Sets the terminal status, releases the device and persists — exactly once per run. */
  function finalize(ctx: RunContext, outcome: { status: "done" | "error"; error?: string }): void {
    if (ctx.finalized) return;
    if (shuttingDown) {
      // Server is going down: leave the persisted run.json untouched (restore() marks it interrupted) and
      // do not release, which would start the next queued run.
      ctx.finalized = true;
      rpcByRun.delete(ctx.run.id);
      contexts.delete(ctx.run.id);
      for (const t of ctx.timers) clearTimeout(t);
      ctx.timers.clear();
      return;
    }
    ctx.finalized = true;
    const { run } = ctx;
    if (ctx.cancelRequested) {
      run.status = "cancelled";
    } else {
      run.status = outcome.status;
      if (outcome.status === "error") run.error = outcome.error ?? "run failed";
    }
    run.endedAt ??= new Date().toISOString();
    rpcByRun.delete(run.id);
    contexts.delete(run.id);
    for (const t of ctx.timers) clearTimeout(t);
    ctx.timers.clear();
    try {
      scheduler.update(run);
    } finally {
      scheduler.release(run.id);
    }
  }

  function repoRelative(ctx: RunContext, p: string, what: string): string {
    const resolved = resolveUnder(ctx.project.repoPath, p);
    if (!resolved) throw new Error(`${what} must be inside the repo`);
    return path.relative(realpathSync(ctx.project.repoPath), resolved).split(path.sep).join("/");
  }

  function handleHostTool(ctx: RunContext, name: string, args: unknown): string {
    const { run } = ctx;
    const parse = <S extends z.ZodType>(schema: S): z.infer<S> => {
      const r = schema.safeParse(args);
      if (!r.success) throw new Error(`invalid ${name} arguments: ${z.prettifyError(r.error)}`);
      return r.data;
    };
    const now = new Date().toISOString();
    switch (name) {
      case "qa_plan": {
        const { checks } = parse(QaPlanArgs);
        run.checks = checks.map((c): Check => ({ id: c.id, title: c.title, status: "pending", updatedAt: now }));
        break;
      }
      case "qa_check": {
        const a = parse(QaCheckArgs);
        const screenshot = a.screenshot === undefined ? undefined : repoRelative(ctx, a.screenshot, "screenshot path");
        let check = run.checks.find((c) => c.id === a.id);
        if (!check) {
          check = { id: a.id, title: a.id, status: a.status, updatedAt: now };
          run.checks.push(check);
        }
        check.status = a.status;
        if (a.note !== undefined) check.note = a.note;
        if (screenshot !== undefined) check.screenshot = screenshot;
        check.updatedAt = now;
        break;
      }
      case "qa_finish": {
        const a = parse(QaFinishArgs);
        if (run.verdict !== null) throw new Error("qa_finish already recorded");
        const reportPath = repoRelative(ctx, a.reportPath, "reportPath");
        run.verdict = a.verdict;
        run.summary = a.summary;
        run.reportPath = reportPath;
        if (run.status === "running") run.status = "finishing";
        break;
      }
      default:
        throw new Error(`unknown host tool ${name}`);
    }
    scheduler.update(run);
    return "recorded";
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

  /** Post-settle housekeeping: stats, transcript, then let the process drain and exit. */
  async function complete(ctx: RunContext, rpc: OmpRpc): Promise<void> {
    const { run } = ctx;
    try {
      const stats = await withTimeout(rpc.send({ type: "get_session_stats" }), STEP_TIMEOUT_MS);
      if (!ctx.finalized) run.stats = stats;
    } catch (e) {
      log(run, "warn", `get_session_stats failed: ${errorMessage(e)}`);
    }
    try {
      await withTimeout(rpc.send({ type: "export_html", outputPath: path.join(runDir(run.id), "transcript.html") }), STEP_TIMEOUT_MS);
      if (!ctx.finalized) run.transcriptHtml = true;
    } catch (e) {
      log(run, "warn", `transcript export failed: ${errorMessage(e)}`);
    }
    if (!ctx.finalized) scheduler.update(run);
    if (!shuttingDown && !ctx.cancelRequested && !ctx.finalized) await recaptureBuild(ctx);
    rpc.closeStdin();
    if (!ctx.finalized) ctx.timers.add(setTimeout(() => rpc.kill(), DRAIN_KILL_MS));
  }

  /** Runs the completion path once, whichever signal (settle event or fallback timer) gets there first. */
  function settle(ctx: RunContext): void {
    if (ctx.settled || ctx.finalized || !ctx.rpc) return;
    ctx.settled = true;
    void complete(ctx, ctx.rpc);
  }

  function onFrame(ctx: RunContext, frame: Frame): void {
    const { run } = ctx;
    if (frame.type === "_stderr") {
      appendStderr(run.id, typeof frame.text === "string" ? frame.text : "");
      return;
    }
    if (frame.type !== "message_update") appendEvent(run.id, frame);
    const activity = frameToActivity(frame, run.backend);
    if (activity) scheduler.activity(run.id, activity);

    if (frame.type === "prompt_result") {
      ctx.promptResult = { status: typeof frame.status === "string" ? frame.status : "", error: promptResultError(frame) };
    }
    const settled = frame.type === "session_settled" || (frame.type === "prompt_result" && frame.sessionSettled === true);
    if (settled) {
      settle(ctx);
    } else if (frame.type === "prompt_result" || frame.type === "agent_end") {
      // Safety net: some sessions never emit session_settled; don't leave the run hanging.
      const timer = setTimeout(() => {
        ctx.timers.delete(timer);
        settle(ctx);
      }, SETTLE_FALLBACK_MS);
      ctx.timers.add(timer);
    }
  }

  function onExit(ctx: RunContext, code: number): void {
    const { run } = ctx;
    if (run.verdict !== null) return finalize(ctx, { status: "done" });
    if (ctx.promptResult?.status === "error") {
      return finalize(ctx, { status: "error", error: ctx.promptResult.error ?? "agent run failed" });
    }
    if (!ctx.settled && code !== 0) {
      return finalize(ctx, { status: "error", error: `omp exited with code ${code}; see stderr.log` });
    }
    finalize(ctx, { status: "error", error: "agent ended without qa_finish" });
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
        finalize(ctx, { status: "error", error: errorMessage(e) });
        return false;
      }
      scheduler.bootComplete(run.id, serial);
      run.bootedByRun = true;
      log(run, "info", `booted ${name} as ${serial}`);
    } else {
      serial = target.serial;
    }
    if (ctx.cancelRequested) {
      finalize(ctx, { status: "error" });
      return false;
    }
    run.deviceSerial = serial;
    scheduler.update(run);

    await captureBuild(ctx, serial);

    const owner = artemisLockOwner(serial);
    if (owner) {
      finalize(ctx, {
        status: "error",
        error: `Artemis task ${owner.sessionId ?? owner.pid} holds ${serial}; stop it in the Artemis console first`,
      });
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
      finalize(ctx, { status: "error" });
      return false;
    }
    return true;
  }

  async function execute(ctx: RunContext, target: StartTarget): Promise<void> {
    const { run, project } = ctx;
    if (!(await preflight(ctx, target))) return;

    const dir = runDir(run.id);
    const persona = loadPersona(resolvePersonaPath(project));
    const model = persona.model ?? config.agent?.model ?? null;
    const thinking = persona.thinking ?? config.agent?.thinking ?? null;
    mkdirSync(path.join(dir, "session"), { recursive: true });
    mkdirSync(path.join(project.repoPath, project.reportsDir), { recursive: true });
    writeFileSync(path.join(dir, "brief.md"), run.brief);
    const personaFile = path.join(dir, "persona.md");
    writeFileSync(personaFile, persona.body);

    if (ctx.cancelRequested) {
      finalize(ctx, { status: "error" });
      return;
    }
    // Shutting down: leave run.json as-is (preflight) so restore() marks it interrupted; never spawn omp.
    if (shuttingDown) {
      finalize(ctx, { status: "error" });
      return;
    }

    run.status = "running";
    run.startedAt = new Date().toISOString();
    scheduler.update(run);

    const launch = await mcpLaunchArgs(project, run.backend);
    const rpc = new OmpRpc({
      cwd: project.repoPath,
      args: [
        ...launch.args,
        ...(model ? ["--model", model] : []),
        ...(thinking ? ["--thinking", thinking] : []),
        "--append-system-prompt",
        personaFile,
        "--session-dir",
        path.join(dir, "session"),
        "--auto-approve",
        "--max-time",
        config.runMaxTime,
        "--no-title",
      ],
      onFrame: (f) => onFrame(ctx, f),
      onExit: (code) => onExit(ctx, code),
    });
    ctx.rpc = rpc;
    rpcByRun.set(run.id, rpc);
    rpc.setHostToolHandler(async (name, args) => handleHostTool(ctx, name, args));

    await rpc.ready();
    // MCP servers connect in the background; prompting before they are up makes the agent fail with "No such tool".
    const prefixes = await resolveToolPrefixes(rpc, run.backend, { expectedMobileMcp: launch.expectedMobileMcp });
    const backendPrefix = run.backend === "mobile-mcp" ? prefixes.mobileMcp : prefixes.artemis;
    if (!backendPrefix) throw new Error(missingToolsMessage(run.backend, launch));
    log(run, "info", `${run.backend} tools: ${backendPrefix}*${launch.pluginDir ? " (provisioned by Tapocalypse)" : ""}`);
    await rpc.send({ type: "set_host_tools", tools: hostTools });
    // The detached `gh pr view` may still be running; give it a bounded chance so the prompt carries the PR.
    if (!ctx.cancelRequested && !shuttingDown) {
      await scheduler.waitForPrLookup(run.id, PR_LOOKUP_WAIT_MS);
      const live = scheduler.getLive(run.id);
      if (live && live !== run && live.source) run.source = live.source;
    }
    await rpc.send({ type: "prompt", message: buildPrompt(run, project, prefixes) });
  }

  function startRun(run: Run, target: StartTarget): void {
    const project = getProject(run.projectId);
    if (!project) {
      run.status = "error";
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
      rpc: null,
      cancelRequested: false,
      settled: false,
      finalized: false,
      promptResult: null,
      timers: new Set(),
    };
    contexts.set(run.id, ctx);
    void execute(ctx, target).catch((e: unknown) => {
      const message = errorMessage(e);
      if (!ctx.finalized && !ctx.cancelRequested && !shuttingDown) log(run, "error", message);
      finalize(ctx, { status: "error", error: message });
      ctx.rpc?.kill();
    });
  }

  async function cancelActive(id: string): Promise<void> {
    const ctx = contexts.get(id);
    if (!ctx || ctx.finalized) throw new HttpError(409, `run ${id} is not active`);
    const { run } = ctx;
    const alreadyRequested = ctx.cancelRequested;
    ctx.cancelRequested = true;
    const rpc = ctx.rpc;
    if (!rpc) {
      // Preflight (possibly mid-boot): the startRun flow notices the flag, releases the device and stops.
      if (alreadyRequested) return;
      run.status = "cancelled";
      run.endedAt = new Date().toISOString();
      scheduler.update(run);
      return;
    }
    log(run, "info", "cancelling run");
    rpc.send({ type: "abort" }).catch(() => {});
    rpc.closeStdin();
    const exited = await Promise.race([rpc.exited.then(() => true), Bun.sleep(CANCEL_GRACE_MS).then(() => false)]);
    if (!exited) {
      rpc.kill();
      await rpc.exited;
    }
  }

  async function steerRun(id: string, message: string): Promise<void> {
    const ctx = contexts.get(id);
    if (!ctx || !ctx.rpc || ctx.run.status !== "running") throw new HttpError(409, `run ${id} is not running`);
    await ctx.rpc.send({ type: "steer", message });
    log(ctx.run, "user", message);
  }

  function killAll(): void {
    shuttingDown = true;
    for (const rpc of rpcByRun.values()) rpc.kill();
  }

  return { startRun, cancelActive, steerRun, isLive: (id) => rpcByRun.has(id), killAll };
}
