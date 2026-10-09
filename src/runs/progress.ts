import { realpathSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ProgressSink } from "../harness/types";
import { resolveUnder } from "../reports/reports";
import { type Activity, type Check, type CheckStatus, type Run, VERDICTS } from "./types";

export const QaPlanArgs = z.object({ checks: z.array(z.object({ id: z.string(), title: z.string() })).min(1) });
export const QaCheckArgs = z.object({
  id: z.string(),
  status: z.enum(["running", "pass", "fail", "blocked", "skipped"]),
  note: z.string().optional(),
  screenshot: z.string().optional().describe("Path relative to the repo root."),
});
export const QaFinishArgs = z.object({
  verdict: z.enum(VERDICTS),
  summary: z.string(),
  reportPath: z.string().describe("Path relative to the repo root."),
});

/** The progress tools: omp host tool definitions (`set_host_tools`) and the descriptions the run-scoped MCP server lists. */
export const PROGRESS_TOOLS = [
  {
    name: "qa_plan",
    label: "QA plan",
    description: "Declare every check you will execute, before the first device action.",
    parameters: {
      type: "object",
      properties: {
        checks: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: { id: { type: "string" }, title: { type: "string" } },
            required: ["id", "title"],
            additionalProperties: false,
          },
        },
      },
      required: ["checks"],
      additionalProperties: false,
    },
    loadMode: "essential",
  },
  {
    name: "qa_check",
    label: "QA check",
    description: "Report a check's status as it changes; attach the screenshot that proves it.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        status: { type: "string", enum: ["running", "pass", "fail", "blocked", "skipped"] },
        note: { type: "string" },
        screenshot: { type: "string", description: "Path relative to the repo root." },
      },
      required: ["id", "status"],
      additionalProperties: false,
    },
    loadMode: "essential",
  },
  {
    name: "qa_finish",
    label: "QA finish",
    description: "Call exactly once, after the report file is written.",
    parameters: {
      type: "object",
      properties: {
        verdict: { type: "string", enum: ["PASS", "FAIL", "PASS WITH ISSUES", "BLOCKED", "PARTIAL"] },
        summary: { type: "string" },
        reportPath: { type: "string", description: "Path relative to the repo root." },
      },
      required: ["verdict", "summary", "reportPath"],
      additionalProperties: false,
    },
    loadMode: "essential",
  },
] as const;

export type ProgressToolName = (typeof PROGRESS_TOOLS)[number]["name"];
export const PROGRESS_TOOL_NAMES: readonly ProgressToolName[] = PROGRESS_TOOLS.map((t) => t.name);

/** The slice of a run the recorder reads and writes; a full `Run` satisfies it. */
export type ProgressRun = Pick<Run, "status" | "checks" | "verdict" | "verdictSource" | "summary" | "reportPath">;

export interface ProgressRecorderOptions {
  getRun(): ProgressRun;
  /** Applies `mutator` to the live run and persists it. The recorder validates first, so the mutator never throws. */
  update(mutator: (run: ProgressRun) => void): void;
  log(kind: Activity["kind"], text: string, extra?: { checkId?: string; checkStatus?: CheckStatus }): void;
  repoPath: string;
}

const NOTE_SHOWN_CHARS = 300;

/** Records qa_plan / qa_check / qa_finish into a run; shared by omp host tools and the run-scoped MCP endpoint. */
export class ProgressRecorder implements ProgressSink {
  constructor(private readonly options: ProgressRecorderOptions) {}

  async record(tool: ProgressToolName, args: unknown): Promise<string> {
    switch (tool) {
      case "qa_plan":
        this.plan(this.parse(tool, QaPlanArgs, args));
        break;
      case "qa_check":
        this.check(this.parse(tool, QaCheckArgs, args));
        break;
      case "qa_finish":
        this.finish(this.parse(tool, QaFinishArgs, args));
        break;
      default:
        throw new Error(`unknown progress tool ${String(tool)}`);
    }
    return "recorded";
  }

  private parse<S extends z.ZodType>(tool: string, schema: S, args: unknown): z.infer<S> {
    const r = schema.safeParse(args);
    if (!r.success) throw new Error(`invalid ${tool} arguments: ${z.prettifyError(r.error)}`);
    return r.data;
  }

  private repoRelative(p: string, what: string): string {
    const resolved = resolveUnder(this.options.repoPath, p);
    if (!resolved) throw new Error(`${what} must be inside the repo`);
    return path.relative(realpathSync(this.options.repoPath), resolved).split(path.sep).join("/");
  }

  private plan({ checks }: z.infer<typeof QaPlanArgs>): void {
    const now = new Date().toISOString();
    this.options.update((run) => {
      run.checks = checks.map((c): Check => ({ id: c.id, title: c.title, status: "pending", updatedAt: now }));
    });
    this.options.log("check", `Test plan: ${checks.length} check${checks.length === 1 ? "" : "s"}`);
  }

  private check(a: z.infer<typeof QaCheckArgs>): void {
    const screenshot = a.screenshot === undefined ? undefined : this.repoRelative(a.screenshot, "screenshot path");
    const now = new Date().toISOString();
    this.options.update((run) => {
      let check = run.checks.find((c) => c.id === a.id);
      if (!check) {
        check = { id: a.id, title: a.id, status: a.status, updatedAt: now };
        run.checks.push(check);
      }
      check.status = a.status;
      if (a.status === "running") check.startedAt ??= now;
      else check.endedAt ??= now;
      if (a.note !== undefined) check.note = a.note;
      if (screenshot !== undefined) check.screenshot = screenshot;
      check.updatedAt = now;
    });
    const note = a.note ? ` — ${a.note.slice(0, NOTE_SHOWN_CHARS)}` : "";
    this.options.log("check", `${a.id}: ${a.status}${note}`, { checkId: a.id, checkStatus: a.status });
  }

  private finish(a: z.infer<typeof QaFinishArgs>): void {
    if (this.options.getRun().verdict !== null) throw new Error("qa_finish already recorded");
    const reportPath = this.repoRelative(a.reportPath, "reportPath");
    this.options.update((run) => {
      run.verdict = a.verdict;
      run.verdictSource = "agent";
      run.summary = a.summary;
      run.reportPath = reportPath;
      if (run.status === "running") run.status = "finishing";
    });
    this.options.log("check", `Finished: ${a.verdict}`);
  }
}
