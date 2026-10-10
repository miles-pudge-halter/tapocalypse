import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { z } from "zod";
import pkg from "../../package.json";
import { batchView, devicesView, findRun, runDurationMs, runner, runScreenshots, scheduler } from "../app";
import { config, HttpError, MAX_STEER_CHARS } from "../config";
import { runDoctor } from "../doctor";
import { release as releaseLease, renew as renewLease, TTL } from "../devices/leases";
import { HARNESS_IDS, type HarnessId } from "../harness/types";
import { detectProject } from "../projects/detect";
import { createProject, deleteProject, getProject, listProjects, PACKAGE_RE, updateProject } from "../projects/registry";
import { exportRun, LEGACY_REPORTS_DIR, reportFile, screenshotFile, screenshotsDir } from "../runs/artefacts";
import { realpathLoose } from "../reports/reports";
import { runMatches } from "../runs/source";
import { listRuns } from "../runs/store";
import { ACTIVE, type Run } from "../runs/types";
import type { AcquireResult, LeaseGrant } from "../runs/scheduler";
import { listSuites } from "../suites";

const TERMINAL = (run: Run) => !ACTIVE.includes(run.status);

/** Ids of the project's queued or in-flight runs; live scheduler state wins over the persisted copy. */
export function activeRunIds(projectId: string): string[] {
  return listRuns({ projectId })
    .map((r) => scheduler.getLive(r.id) ?? r)
    .filter((r) => ACTIVE.includes(r.status))
    .map((r) => r.id);
}

const ProjectFields = {
  name: z.string().max(60).optional().describe("Display name, 1-60 chars"),
  defaultPackage: z.string().max(200).optional().describe("Android applicationId or iOS bundle id, e.g. com.example.app.dev"),
  defaultPlatform: z.enum(["android", "ios"]).optional(),
  personaFile: z
    .string()
    .max(500)
    .nullable()
    .optional()
    .describe("QA persona markdown, relative to the repo; null for the built-in persona"),
};

const SourceInput = z.object({
  path: z.string().max(4096).optional().describe("Absolute path of your working directory (project repo root or one of its git worktrees)"),
  branch: z.string().max(200).optional().describe("Override the detected branch"),
  commit: z.string().max(200).optional().describe("Override the detected commit sha"),
  prNumber: z.number().int().positive().optional().describe("Pull request number, if known"),
  prTitle: z.string().max(200).optional(),
  prUrl: z.string().max(2000).optional(),
  tickets: z.array(z.string().max(64)).max(20).optional().describe("Ticket keys, e.g. ABC-123"),
  labels: z.record(z.string().max(100), z.string().max(200)).optional().describe("Free-form metadata such as flavor, epic or build id"),
});

export function runSummary(run: Run) {
  const project = getProject(run.projectId);
  return {
    runId: run.id,
    projectId: run.projectId,
    status: run.status,
    verdict: run.verdict,
    summary: run.summary,
    error: run.error,
    deviceSerial: run.deviceSerial,
    queuePosition: scheduler.queuePosition(run.id),
    checks: run.checks.map(({ id, title, status, note }) => ({ id, title, status, note })),
    reportPath: reportFile(run, project ?? null),
    screenshotsDir: run.storage === "data" ? realpathLoose(screenshotsDir(run.id)) : project ? path.join(project.repoPath, project.reportsDir ?? LEGACY_REPORTS_DIR, "screenshots", run.id) : null,
    source: run.source,
    build: run.build,
    usage: run.usage,
    durationMs: runDurationMs(run),
    errorKind: run.errorKind,
    verdictSource: run.verdictSource,
    batchId: run.batchId,
    attempt: run.attempt,
    retriedBy: run.retriedBy,
  };
}

function requireRun(runId: string): Run {
  const run = findRun(runId);
  if (!run) throw new HttpError(404, `unknown run ${runId}`);
  return run;
}

/** The run itself, or its newest infra-retry attempt: a retried run is not finished until its successor is. */
function latestAttempt(run: Run): Run {
  let current = run;
  for (let hops = 0; current.retriedBy && hops < 10; hops++) {
    const next = findRun(current.retriedBy);
    if (!next) break;
    current = next;
  }
  return current;
}

function isSettled(runIds: string[], mode: "all" | "any"): boolean {
  const done = runIds.map((id) => {
    const run = findRun(id);
    return !run || TERMINAL(latestAttempt(run));
  });
  return mode === "any" ? done.some(Boolean) : done.every(Boolean);
}

/** Resolves true when `timeoutMs` elapsed before the runs settled, false once they did. */
function waitForRuns(runIds: string[], mode: "all" | "any", timeoutMs: number): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const onRun = () => {
    if (isSettled(runIds, mode)) done(false);
  };
  const timer = setTimeout(() => done(true), timeoutMs);
  function done(timedOut: boolean) {
    clearTimeout(timer);
    scheduler.bus.off("run", onRun);
    resolve(timedOut);
  }
  scheduler.bus.on("run", onRun);
  // Re-check after subscribing so a transition between the caller's check and the listener is not missed.
  onRun();
  return promise;
}

const clampWaitSeconds = (timeoutSec: number | undefined) => Math.min(110, Math.max(5, timeoutSec ?? 90));

const RunOptions = {
  harness: z
    .enum(HARNESS_IDS)
    .optional()
    .describe("Agent harness that drives the QA run: omp, claude (Claude Code) or codex (Codex CLI). Defaults to the project/config default; see qa_doctor for what is installed"),
  packageId: z.string().max(200).regex(PACKAGE_RE, "must look like com.example.app").optional().describe("App package/bundle id; defaults to the project's package"),
  model: z.string().max(200).optional().describe("Harness-native model id for the QA agent (omp: anthropic/claude-sonnet-4-5, claude: sonnet, codex: gpt-5); defaults to the suite/persona/config model"),
  thinking: z
    .enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
    .optional()
    .describe("Reasoning effort for the QA agent, in the harness's own terms (omp thinking level, Claude --effort, Codex model_reasoning_effort); unsupported levels are rejected or mapped by the harness"),
};

const SOURCE_HINT =
  "Pass source.path = your current working directory when you work in a git worktree, so the run records your branch, commit and PR.";

const runUrl = (runId: string) => `http://127.0.0.1:${config.port}/#/runs/${runId}`;

type ToolResult = { content: { type: "text"; text: string }[]; isError?: true };

async function respond(fn: () => unknown | Promise<unknown>): Promise<ToolResult> {
  try {
    const result = await fn();
    return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Errors with a stable code read "<code>: <message>" so agents can branch on the prefix.
    const text = err instanceof HttpError && err.code ? `${err.code}: ${message}` : message;
    return { isError: true, content: [{ type: "text", text }] };
  }
}

const Holder = z.string().trim().min(1).max(80);
const LeaseIdArg = z.string().min(1).max(64);
const TtlMinutes = z.number().int().min(TTL.min).max(TTL.max);

const DeviceAcquireShape = {
  serial: z.string().max(200).optional().describe("Specific device from qa_list_devices; physical devices only this way"),
  platform: z.enum(["android", "ios"]).optional().describe("Any free emulator/simulator of this platform; may boot one"),
  holder: Holder.describe("Who you are and what you work on, e.g. 'claude-code · checkout-redesign'"),
  reason: z.string().trim().max(200).optional().describe("What you need the device for; shown to people and agents who wait"),
  ttlMinutes: TtlMinutes.optional().describe(`Lease length, ${TTL.min}-${TTL.max} minutes; default ${TTL.default}. Renew with device_renew`),
  waitSeconds: z.number().min(0).max(110).optional().describe("How long to wait for a free device, 0-110; default 0. While timedOut is true, call again with the same arguments plus ticket to keep your place"),
  ticket: z.string().max(64).optional().describe("The ticket from a previous timedOut result"),
  cwd: z.string().max(4096).optional().describe("Absolute working directory of the agent"),
};
const DeviceAcquireArgs = z
  .object(DeviceAcquireShape)
  .refine((a) => Boolean(a.serial) !== Boolean(a.platform), { message: "give serial or platform, not both" });
const DeviceRenewArgs = z.object({ leaseId: LeaseIdArg, ttlMinutes: TtlMinutes.optional() });
const DeviceReleaseArgs = z.object({ leaseId: LeaseIdArg });

function parseArgs<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => i.message).join("; "), "invalid_argument");
  return parsed.data;
}
/**
 * Shared by the `device_acquire` tool and `POST /api/leases`: validates once, then asks the scheduler (long-polls up to
 * `waitSeconds`). A grant is the flat `LeaseGrant`; otherwise `{ timedOut: true, ticket, ... }`.
 */
export async function acquireDevice(input: unknown, signal?: AbortSignal): Promise<LeaseGrant | Exclude<AcquireResult, { lease: LeaseGrant }>> {
  const { waitSeconds, ...request } = parseArgs(DeviceAcquireArgs, input);
  const result = await scheduler.acquire(request, Math.min(110, Math.max(0, waitSeconds ?? 0)) * 1000, signal);
  return "lease" in result ? result.lease : result;
}

export function renewDevice(input: unknown): { serial: string; expiresAt: string | null } {
  const { leaseId, ttlMinutes } = parseArgs(DeviceRenewArgs, input);
  const lease = renewLease(leaseId, ttlMinutes);
  return { serial: lease.serial, expiresAt: lease.expiresAt };
}

export function releaseDevice(input: unknown): { released: true; serial: string } {
  const { leaseId } = parseArgs(DeviceReleaseArgs, input);
  return { released: true, serial: releaseLease(leaseId).serial };
}

function buildServer(): McpServer {
  const server = new McpServer({ name: "tapocalypse", version: pkg.version });

  server.registerTool(
    "qa_list_projects",
    {
      title: "List QA projects",
      description:
        "List the projects Tapocalypse can run mobile QA for, including status (ok/invalid) and any problems. Only status ok projects can start runs.",
    },
    () => respond(() => listProjects()),
  );

  server.registerTool(
    "qa_detect_project",
    {
      title: "Detect project settings",
      description: "Inspect a mobile app repository and suggest project settings. Call this first, then qa_create_project.",
      inputSchema: z.object({ repoPath: z.string().max(4096).describe("Absolute path of the app repository") }),
    },
    ({ repoPath }) => respond(() => detectProject(repoPath)),
  );

  server.registerTool(
    "qa_create_project",
    {
      title: "Create a QA project",
      description:
        "Register a mobile app repository for QA runs. Fields you omit are filled from the detection suggestion (see qa_detect_project); if something cannot be inferred you get the list of fields to supply.",
      inputSchema: z.object({
        id: z.string().max(64).optional().describe("Lowercase slug, letters/digits/dashes"),
        repoPath: z.string().max(4096).describe("Absolute path of the app repository"),
        ...ProjectFields,
      }),
    },
    (args) =>
      respond(async () => {
        const { exists, suggestion } = await detectProject(args.repoPath);
        if (!exists) throw new Error(`repoPath ${args.repoPath} does not exist`);
        const input = {
          id: args.id ?? suggestion.id,
          name: args.name ?? suggestion.name,
          repoPath: args.repoPath,
          defaultPlatform: args.defaultPlatform ?? suggestion.defaultPlatform,
          defaultPackage: args.defaultPackage ?? suggestion.defaultPackage,
          personaFile: args.personaFile === undefined ? suggestion.personaFile : args.personaFile,
        };
        const missing = (["id", "name", "defaultPackage", "defaultPlatform"] as const).filter((k) => !input[k]);
        if (missing.length > 0) {
          throw new Error(`could not infer ${missing.join(", ")} from the repository; supply these fields: ${missing.join(", ")}`);
        }
        return { ...createProject(input), url: `http://127.0.0.1:${config.port}/#/projects` };
      }),
  );

  server.registerTool(
    "qa_update_project",
    {
      title: "Update a QA project",
      description: "Change settings of an existing project. Only the fields you pass are changed; the id cannot change.",
      inputSchema: z.object({
        id: z.string().max(64).describe("Project id from qa_list_projects"),
        repoPath: z.string().max(4096).optional(),
        ...ProjectFields,
      }),
    },
    ({ id, ...patch }) => respond(() => updateProject(id, patch)),
  );

  server.registerTool(
    "qa_delete_project",
    {
      title: "Delete a QA project",
      description:
        "Remove a project from Tapocalypse. Fails while the project has queued or active runs. The repository is not touched; the runs' reports and screenshots in Tapocalypse's data dir stay until retention removes them.",
      inputSchema: z.object({ id: z.string().max(64).describe("Project id from qa_list_projects") }),
    },
    ({ id }) =>
      respond(() => {
        deleteProject(id, activeRunIds(id));
        return { deleted: id };
      }),
  );

  server.registerTool(
    "qa_list_devices",
    {
      title: "List devices",
      description:
        "List connected Android emulators/devices and iOS simulators, including busy (busyRunId), booting, the agent lease on each device (lease: holder, reason, expiresAt; null when free) and who is waiting for it (waiters). Call this before device_acquire to see what is free.",
    },
    () => respond(() => devicesView()),
  );

  server.registerTool(
    "device_acquire",
    {
      title: "Acquire a device",
      description:
        "Reserve an emulator/simulator before you use it: devices are shared with other agents and QA runs. Give a serial (from qa_list_devices) or a platform (any free one, may boot one). Returns the leaseId (keep it: it cannot be recovered), serial (adb/simctl) and mobileDeviceId (mobile-mcp tools). If the device is busy the result has timedOut: true, ticket, position and heldBy: call again with the same arguments plus ticket to keep your place, or tell the user who holds it. Never touch a device you do not hold. Release it with device_release when done.",
      inputSchema: z.object(DeviceAcquireShape),
    },
    (args, ctx) => respond(() => acquireDevice(args, ctx.mcpReq.signal)),
  );

  server.registerTool(
    "device_renew",
    {
      title: "Renew a device lease",
      description: `Extend your lease to now + ttlMinutes (default: the lease's own). Do it when less than 10 minutes are left. Errors with lease_not_found when the lease ended (expired, released or revoked): stop using the device and acquire again.`,
      inputSchema: z.object({
        leaseId: LeaseIdArg.describe("The leaseId from device_acquire"),
        ttlMinutes: TtlMinutes.optional().describe(`New length, ${TTL.min}-${TTL.max} minutes`),
      }),
    },
    (args) => respond(() => renewDevice(args)),
  );

  server.registerTool(
    "device_release",
    {
      title: "Release a device",
      description: "Give the device back so the next agent or QA run can use it. Always call this when you are done, also after a failure or abort.",
      inputSchema: z.object({ leaseId: LeaseIdArg.describe("The leaseId from device_acquire") }),
    },
    (args) => respond(() => releaseDevice(args)),
  );

  server.registerTool(
    "qa_doctor",
    {
      title: "Check Tapocalypse setup",
      description:
        "Report which prerequisites are installed (agent runtimes omp / Claude Code / Codex and whether they are signed in, npx, adb, emulators, simulators, git, gh) and the configured projects, with a fix for anything missing. Call this when runs fail to start.",
    },
    () => respond(() => runDoctor({ fresh: true })),
  );

  server.registerTool(
    "qa_start_run",
    {
      title: "Start a QA run",
      description:
        "Queue an agent-driven mobile QA run. Returns immediately with the run id; poll with qa_wait_run. Omit serial to let Tapocalypse pick or boot an emulator/simulator for the platform. Give either a brief, or a suiteId (see qa_list_suites) whose body becomes the brief.",
      inputSchema: z.object({
        projectId: z.string().max(64).describe("Project id from qa_list_projects"),
        title: z.string().max(200).optional().describe("Short run title (max 200 chars); defaults to the suite title"),
        brief: z.string().max(20_000).optional().describe("What the QA agent should test, in free text (max 20000 chars)"),
        suiteId: z.string().max(64).optional().describe("Saved suite id from qa_list_suites; supplies brief, check ids and model"),
        ...RunOptions,
        platform: z.enum(["android", "ios"]).optional().describe("Defaults to the project's default platform"),
        serial: z.string().max(200).optional().describe("Specific phone/tablet serial/udid from qa_list_devices"),
        install: z.string().max(4096).optional().describe("Absolute path of an .apk (android) or .app/.ipa (ios) to install before the run"),
        requester: z.string().max(200).optional().describe("Who is asking; shown in the UI"),
        source: SourceInput.optional().describe(SOURCE_HINT),
      }),
    },
    (args) =>
      respond(async () => {
        const run = await scheduler.enqueueRun({
          projectId: args.projectId,
          title: args.title,
          brief: args.brief,
          suiteId: args.suiteId,
          device: { platform: args.platform, serial: args.serial },
          harness: args.harness,
          packageId: args.packageId,
          model: args.model,
          thinking: args.thinking,
          install: args.install ? { path: args.install } : undefined,
          source: args.source,
          requestedBy: args.requester ?? "mcp",
        });
        return {
          runId: run.id,
          status: run.status,
          queuePosition: scheduler.queuePosition(run.id),
          url: runUrl(run.id),
          source: run.source,
        };
      }),
  );

  server.registerTool(
    "qa_start_batch",
    {
      title: "Start a batch of QA runs",
      description:
        "Queue the same brief (or suite) on several devices at once, one run per entry of devices (1-8). Runs go through the normal queue, so they start as devices free up. Poll with qa_wait_runs {batchId}.",
      inputSchema: z.object({
        projectId: z.string().max(64).describe("Project id from qa_list_projects"),
        title: z.string().max(200).optional().describe("Batch title; each run gets a device suffix"),
        brief: z.string().max(20_000).optional(),
        suiteId: z.string().max(64).optional(),
        devices: z
          .array(z.object({ platform: z.enum(["android", "ios"]).optional(), serial: z.string().max(200).optional() }))
          .min(1)
          .max(8)
          .describe("One entry per run: a specific serial, or just a platform to let Tapocalypse pick or boot a device"),
        ...RunOptions,
        install: z.string().max(4096).optional().describe("Absolute path of an .apk/.app/.ipa to install before each run"),
        requester: z.string().max(200).optional(),
        source: SourceInput.optional().describe(SOURCE_HINT),
      }),
    },
    (args) =>
      respond(async () => {
        const { batchId, runs } = await scheduler.enqueueBatch({
          projectId: args.projectId,
          title: args.title,
          brief: args.brief,
          suiteId: args.suiteId,
          devices: args.devices,
          harness: args.harness,
          packageId: args.packageId,
          model: args.model,
          thinking: args.thinking,
          install: args.install ? { path: args.install } : undefined,
          source: args.source,
          requestedBy: args.requester ?? "mcp",
        });
        return {
          batchId,
          url: `http://127.0.0.1:${config.port}/#/batches/${batchId}`,
          runs: runs.map((r) => ({
            runId: r.id,
            title: r.title,
            status: r.status,
            queuePosition: scheduler.queuePosition(r.id),
            url: runUrl(r.id),
          })),
        };
      }),
  );

  server.registerTool(
    "qa_rerun",
    {
      title: "Re-run a finished run",
      description:
        "Queue a new run from a finished one. only=failed re-tests just the checks that did not pass or skip (with their previous status and note); only=all repeats the whole brief. Same project, harness, package, model and source unless you override the harness.",
      inputSchema: z.object({
        runId: z.string(),
        only: z.enum(["failed", "all"]),
        platform: z.enum(["android", "ios"]).optional().describe("Override the device platform"),
        serial: z.string().max(200).optional().describe("Override the device"),
        harness: RunOptions.harness.describe("Run the repeat on a different agent harness (omp, claude, codex); default: the original run's harness"),
        requester: z.string().max(200).optional(),
      }),
    },
    ({ runId, only, platform, serial, harness, requester }) =>
      respond(async () => {
        requireRun(runId);
        const device = platform || serial ? { platform, serial } : undefined;
        const run = await scheduler.rerun(runId, { only, device, harness, requestedBy: requester ?? "mcp" });
        return { runId: run.id, status: run.status, queuePosition: scheduler.queuePosition(run.id), url: runUrl(run.id) };
      }),
  );

  server.registerTool(
    "qa_steer_run",
    {
      title: "Send a message to a running QA agent",
      description:
        "Steer a run that is currently running (not queued or finished) with an extra instruction. Fails for harnesses that cannot take mid-run messages (check capabilities.steer in GET /api/harnesses).",
      inputSchema: z.object({ runId: z.string().max(200), message: z.string().max(MAX_STEER_CHARS) }),
    },
    ({ runId, message }) =>
      respond(async () => {
        requireRun(runId);
        if (!message.trim()) throw new HttpError(400, "message is required");
        await runner.steerRun(runId, message.trim());
        return { ok: true };
      }),
  );

  server.registerTool(
    "qa_get_report",
    {
      title: "Read a run's report",
      description:
        "The markdown QA report the agent wrote for a finished run (stored in Tapocalypse's data dir; image links are relative to the run's artefact folder, see qa_get_screenshots). Errors when the run has no report.",
      inputSchema: z.object({ runId: z.string() }),
    },
    ({ runId }) =>
      respond(() => {
        const run = requireRun(runId);
        const file = reportFile(run, getProject(run.projectId) ?? null);
        if (!file || !existsSync(file)) throw new HttpError(404, `run ${runId} has no report`);
        return readFileSync(file, "utf8");
      }),
  );

  server.registerTool(
    "qa_get_screenshots",
    {
      title: "List a run's screenshots",
      description:
        "Screenshots of a run, stored in Tapocalypse's data dir: checkId (when a check points at it), name, absolute path (read it or view it directly) and the UI url path.",
      inputSchema: z.object({ runId: z.string() }),
    },
    ({ runId }) =>
      respond(() => {
        const run = requireRun(runId);
        const project = getProject(run.projectId) ?? null;
        return runScreenshots(run).flatMap((s) => {
          const abs = screenshotFile(run, project, s.path);
          return abs ? [{ checkId: s.checkId, name: s.name, path: abs, url: s.url }] : [];
        });
      }),
  );

  server.registerTool(
    "qa_export",
    {
      title: "Export a run's report and screenshots",
      description:
        "Copy a run's report (as QA-REPORT-<runId>.md) and screenshots (under screenshots/) from Tapocalypse's data dir into an absolute directory you choose, e.g. a folder in your repository you want to commit or attach to a PR. Nothing is written to the repository otherwise.",
      inputSchema: z.object({ runId: z.string(), dir: z.string().max(4096).describe("Absolute destination directory; created when missing") }),
    },
    ({ runId, dir }) =>
      respond(() => {
        const run = requireRun(runId);
        if (dir.includes("\0")) throw new HttpError(400, "dir must not contain a NUL byte");
        if (!path.isAbsolute(dir)) throw new HttpError(400, "dir must be an absolute path");
        return exportRun(run, getProject(run.projectId) ?? null, dir);
      }),
  );

  server.registerTool(
    "qa_list_suites",
    {
      title: "List saved suites",
      description:
        "Saved test suites of a project (reusable briefs with fixed check ids, stored in <repo>/.tapocalypse/suites). Pass an id as suiteId to qa_start_run / qa_start_batch.",
      inputSchema: z.object({ projectId: z.string() }),
    },
    ({ projectId }) =>
      respond(() => {
        const project = getProject(projectId);
        if (!project) throw new HttpError(404, `unknown project ${projectId}`);
        return listSuites(project);
      }),
  );

  server.registerTool(
    "qa_get_run",
    {
      title: "Get run status",
      description:
        "Current status, checks, verdict and absolute report/screenshot paths of a run (artefacts live in Tapocalypse's data dir; use qa_get_report, qa_get_screenshots or qa_export to access them).",
      inputSchema: z.object({ runId: z.string() }),
    },
    ({ runId }) => respond(() => runSummary(requireRun(runId))),
  );

  server.registerTool(
    "qa_wait_run",
    {
      title: "Wait for a run",
      description:
        "Block until the run reaches a terminal status or timeoutSec elapses (default 90, clamped 5..110). Check timedOut and call again if the run is still active. A run that failed on infrastructure and was automatically retried is followed to its newest attempt (see runId / attempt in the result).",
      inputSchema: z.object({ runId: z.string(), timeoutSec: z.number().optional() }),
    },
    ({ runId, timeoutSec }) =>
      respond(async () => {
        requireRun(runId);
        const timedOut = isSettled([runId], "all") ? false : await waitForRuns([runId], "all", clampWaitSeconds(timeoutSec) * 1000);
        return { ...runSummary(latestAttempt(requireRun(runId))), timedOut };
      }),
  );

  server.registerTool(
    "qa_wait_runs",
    {
      title: "Wait for several runs",
      description:
        "Block until all (mode=all, default) or any (mode=any) of the given runs or batch reach a terminal status, or timeoutSec elapses (default 90, clamped 5..110). Returns every run's summary; call again while timedOut is true.",
      inputSchema: z.object({
        runIds: z.array(z.string()).optional(),
        batchId: z.string().optional(),
        mode: z.enum(["all", "any"]).optional(),
        timeoutSec: z.number().optional(),
      }),
    },
    ({ runIds, batchId, mode, timeoutSec }) =>
      respond(async () => {
        const ids = new Set(runIds ?? []);
        if (batchId) {
          const batch = batchView(batchId);
          if (!batch) throw new HttpError(404, `unknown batch ${batchId}`);
          for (const r of batch.runs) ids.add(r.id);
        }
        if (ids.size === 0) throw new HttpError(400, "runIds or batchId is required");
        for (const id of ids) requireRun(id);
        const list = [...ids];
        const waitMode = mode ?? "all";
        const timedOut = isSettled(list, waitMode) ? false : await waitForRuns(list, waitMode, clampWaitSeconds(timeoutSec) * 1000);
        const latest = new Map(list.map((id) => latestAttempt(requireRun(id))).map((r) => [r.id, r] as const));
        const batch = batchId ? batchView(batchId) : null;
        return {
          timedOut,
          batch: batch && { id: batch.id, status: batch.status, verdict: batch.verdict, cost: batch.cost },
          runs: [...latest.values()].map(runSummary),
        };
      }),
  );

  server.registerTool(
    "qa_cancel_run",
    {
      title: "Cancel a run",
      description: "Cancel a queued or active run.",
      inputSchema: z.object({ runId: z.string() }),
    },
    ({ runId }) =>
      respond(async () => {
        requireRun(runId);
        return runSummary(await scheduler.cancelRun(runId));
      }),
  );

  server.registerTool(
    "qa_list_runs",
    {
      title: "List QA runs",
      description:
        "List recent runs, newest first, optionally filtered by project, git branch, PR number, ticket key (e.g. ABC-123), commit sha prefix or status. Use it to find the QA runs for the code you are working on.",
      inputSchema: z.object({
        projectId: z.string().optional(),
        branch: z.string().optional().describe("Exact git branch name"),
        prNumber: z.number().int().optional(),
        ticket: z.string().optional().describe("Ticket key such as ABC-123"),
        commit: z.string().optional().describe("Commit sha or prefix"),
        status: z.string().optional().describe("queued, preflight, running, finishing, done, error, cancelled or interrupted"),
        limit: z.number().int().optional().describe("Default 20, max 100"),
      }),
    },
    (args) =>
      respond(() => {
        const filter = { branch: args.branch, pr: args.prNumber, ticket: args.ticket, commit: args.commit };
        const bySource = Object.values(filter).some((v) => v !== undefined);
        const limit = Math.min(100, Math.max(1, args.limit ?? 20));
        return listRuns({ projectId: args.projectId })
          .map((r) => findRun(r.id) ?? r)
          .filter((r) => (!args.status || r.status === args.status) && (!bySource || runMatches(r, filter)))
          .slice(0, limit)
          .map(runSummary);
      }),
  );

  return server;
}

export interface McpStatus {
  url: string;
  lastCallAt: string | null;
  lastTool: string | null;
  lastRequester: string | null;
}

const status: McpStatus = { url: `http://127.0.0.1:${config.port}/mcp`, lastCallAt: null, lastTool: null, lastRequester: null };

export const mcpStatus = (): McpStatus => ({ ...status });

/** Records the newest `tools/call` in the request (it may be a JSON-RPC batch) for the Setup page's live status. */
async function recordToolCalls(req: Request): Promise<void> {
  let body: unknown;
  try {
    body = await req.clone().json();
  } catch {
    return;
  }
  for (const message of Array.isArray(body) ? body : [body]) {
    const m = message as { method?: unknown; params?: { name?: unknown; arguments?: { requester?: unknown } } } | null;
    if (m?.method !== "tools/call" || typeof m.params?.name !== "string") continue;
    const requester = m.params.arguments?.requester;
    status.lastCallAt = new Date().toISOString();
    status.lastTool = m.params.name;
    status.lastRequester = typeof requester === "string" && requester ? requester : null;
  }
}

/** Stateless: a fresh server + transport per request keeps parallel agent clients independent. */
export async function handleMcp(req: Request): Promise<Response> {
  await recordToolCalls(req);
  const server = buildServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  // A client that disconnects mid-call (its tool timeout fired) ends the server, which aborts the tool's `ctx.mcpReq.signal`;
  // in stateless mode the SDK's own cancel notification arrives as a separate request that could never reach this one.
  const onAbort = () => void server.close();
  req.signal.addEventListener("abort", onAbort, { once: true });
  if (req.signal.aborted) onAbort();
  try {
    return await transport.handleRequest(req);
  } finally {
    req.signal.removeEventListener("abort", onAbort);
    // enableJsonResponse: the response is complete once handleRequest resolves
    void server.close();
  }
}
