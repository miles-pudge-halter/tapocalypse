import path from "node:path";
import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { z } from "zod";
import { devicesView, findRun, scheduler } from "../app";
import { config, HttpError } from "../config";
import { runDoctor } from "../doctor";
import { detectProject } from "../projects/detect";
import { createProject, deleteProject, getProject, listProjects, updateProject } from "../projects/registry";
import { runMatches } from "../runs/source";
import { listRuns } from "../runs/store";
import { ACTIVE, type Run } from "../runs/types";

const TERMINAL = (run: Run) => !ACTIVE.includes(run.status);

/** Ids of the project's queued or in-flight runs; live scheduler state wins over the persisted copy. */
export function activeRunIds(projectId: string): string[] {
  return listRuns({ projectId })
    .map((r) => scheduler.getLive(r.id) ?? r)
    .filter((r) => ACTIVE.includes(r.status))
    .map((r) => r.id);
}

const ProjectFields = {
  name: z.string().optional().describe("Display name, 1-60 chars"),
  defaultPackage: z.string().optional().describe("Android applicationId or iOS bundle id, e.g. com.example.app.dev"),
  defaultPlatform: z.enum(["android", "ios"]).optional(),
  personaFile: z
    .string()
    .nullable()
    .optional()
    .describe("QA persona markdown, relative to the repo; null for the built-in persona"),
  reportsDir: z.string().optional().describe("Reports folder relative to the repo; default qa"),
};

const SourceInput = z.object({
  path: z.string().optional().describe("Absolute path of your working directory (project repo root or one of its git worktrees)"),
  branch: z.string().optional().describe("Override the detected branch"),
  commit: z.string().optional().describe("Override the detected commit sha"),
  prNumber: z.number().int().positive().optional().describe("Pull request number, if known"),
  prTitle: z.string().optional(),
  prUrl: z.string().optional(),
  tickets: z.array(z.string()).optional().describe("Ticket keys, e.g. ABC-123"),
  labels: z.record(z.string(), z.string()).optional().describe("Free-form metadata such as flavor, epic or build id"),
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
    backend: run.backend,
    queuePosition: scheduler.queuePosition(run.id),
    checks: run.checks.map(({ id, title, status, note }) => ({ id, title, status, note })),
    reportPath: project && run.reportPath ? path.join(project.repoPath, run.reportPath) : null,
    screenshotsDir: project ? path.join(project.repoPath, project.reportsDir, "screenshots", run.id) : null,
    source: run.source,
    build: run.build,
  };
}

function requireRun(runId: string): Run {
  const run = findRun(runId);
  if (!run) throw new HttpError(404, `unknown run ${runId}`);
  return run;
}

function waitForTerminal(runId: string, timeoutMs: number): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const onRun = (run: Run) => {
    if (run.id === runId && TERMINAL(run)) done(false);
  };
  const timer = setTimeout(() => done(true), timeoutMs);
  function done(timedOut: boolean) {
    clearTimeout(timer);
    scheduler.bus.off("run", onRun);
    resolve(timedOut);
  }
  scheduler.bus.on("run", onRun);
  // Re-check after subscribing so a transition between the caller's check and the listener is not missed.
  const current = findRun(runId);
  if (current && TERMINAL(current)) done(false);
  return promise;
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: true };

async function respond(fn: () => unknown | Promise<unknown>): Promise<ToolResult> {
  try {
    const result = await fn();
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: message }] };
  }
}

function buildServer(): McpServer {
  const server = new McpServer({ name: "tapocalypse", version: "0.1.0" });

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
      inputSchema: z.object({ repoPath: z.string().describe("Absolute path of the app repository") }),
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
        id: z.string().optional().describe("Lowercase slug, letters/digits/dashes"),
        repoPath: z.string().describe("Absolute path of the app repository"),
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
          reportsDir: args.reportsDir ?? suggestion.reportsDir,
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
        id: z.string().describe("Project id from qa_list_projects"),
        repoPath: z.string().optional(),
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
        "Remove a project from Tapocalypse. Fails while the project has queued or active runs. The repository and its reports are not touched.",
      inputSchema: z.object({ id: z.string().describe("Project id from qa_list_projects") }),
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
        "List connected Android emulators/devices and iOS simulators, including busy (busyRunId), booting and Artemis-owner flags.",
    },
    () => respond(() => devicesView()),
  );

  server.registerTool(
    "qa_doctor",
    {
      title: "Check Tapocalypse setup",
      description:
        "Report which prerequisites are installed (omp, npx, adb, emulators, simulators, git, gh), configured projects, and which driver backends are available, with a fix for anything missing. Call this when runs fail to start.",
    },
    () => respond(() => runDoctor({ fresh: true })),
  );

  server.registerTool(
    "qa_start_run",
    {
      title: "Start a QA run",
      description:
        "Queue an agent-driven mobile QA run. Returns immediately with the run id; poll with qa_wait_run. Omit serial to let Tapocalypse pick or boot an emulator/simulator for the platform.",
      inputSchema: z.object({
        projectId: z.string().describe("Project id from qa_list_projects"),
        title: z.string().describe("Short run title"),
        brief: z.string().describe("What the QA agent should test, in free text"),
        platform: z.enum(["android", "ios"]).optional().describe("Defaults to the project's default platform"),
        serial: z.string().optional().describe("Specific device serial/udid from qa_list_devices"),
        backend: z
          .enum(["mobile-mcp", "artemis"])
          .optional()
          .describe(
            "Driver backend; default mobile-mcp. artemis is optional, Android-only, and only available when the operator configured artemisPath (see qa_doctor)",
          ),
        packageId: z.string().optional().describe("App package/bundle id; defaults to the project's package"),
        requester: z.string().optional().describe("Who is asking; shown in the UI"),
        source: SourceInput.optional().describe(
          "Pass source.path = your current working directory when you work in a git worktree, so the run records your branch, commit and PR.",
        ),
      }),
    },
    (args) =>
      respond(async () => {
        const run = await scheduler.enqueueRun({
          projectId: args.projectId,
          title: args.title,
          brief: args.brief,
          device: { platform: args.platform, serial: args.serial },
          backend: args.backend,
          packageId: args.packageId,
          source: args.source,
          requestedBy: args.requester ?? "mcp",
        });
        return {
          runId: run.id,
          status: run.status,
          queuePosition: scheduler.queuePosition(run.id),
          url: `http://127.0.0.1:${config.port}/#/runs/${run.id}`,
          source: run.source,
        };
      }),
  );

  server.registerTool(
    "qa_get_run",
    {
      title: "Get run status",
      description: "Current status, checks, verdict and absolute report/screenshot paths of a run.",
      inputSchema: z.object({ runId: z.string() }),
    },
    ({ runId }) => respond(() => runSummary(requireRun(runId))),
  );

  server.registerTool(
    "qa_wait_run",
    {
      title: "Wait for a run",
      description:
        "Block until the run reaches a terminal status or timeoutSec elapses (default 90, clamped 5..110). Check timedOut and call again if the run is still active.",
      inputSchema: z.object({ runId: z.string(), timeoutSec: z.number().optional() }),
    },
    ({ runId, timeoutSec }) =>
      respond(async () => {
        const run = requireRun(runId);
        const seconds = Math.min(110, Math.max(5, timeoutSec ?? 90));
        const timedOut = TERMINAL(run) ? false : await waitForTerminal(runId, seconds * 1000);
        return { ...runSummary(requireRun(runId)), timedOut };
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

/** Stateless: a fresh server + transport per request keeps parallel agent clients independent. */
export async function handleMcp(req: Request): Promise<Response> {
  const server = buildServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    // enableJsonResponse: the response is complete once handleRequest resolves
    void server.close();
  }
}
