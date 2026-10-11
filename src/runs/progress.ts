import { closeSync, constants, copyFileSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { ProgressSink } from "../harness/types";
import { resolveUnder } from "../reports/reports";
import { hasImageMagic, isImagePath, readHead } from "./artefacts";
import { type Activity, type Check, type CheckStatus, type Run, VERDICTS } from "./types";

export const QaPlanArgs = z.object({
  checks: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        was: z.string().optional().describe("Id of a check under 'Previous checks' in your prompt that this check re-tests; omit for new checks."),
      }),
    )
    .min(1),
});
export const QaCheckArgs = z.object({
  id: z.string(),
  status: z.enum(["running", "pass", "fail", "blocked", "skipped"]),
  note: z.string().optional(),
  screenshot: z
    .string()
    .optional()
    .describe("Absolute path of the image file (png, jpg, webp or gif, max 25 MB), or a path relative to the repo root. It is copied into the run's screenshot folder."),
});
export const QaFinishArgs = z.object({
  verdict: z.enum(VERDICTS),
  summary: z.string(),
  reportMarkdown: z.string().optional().describe("The full QA report as markdown (max 2 MB). Reference screenshots as screenshots/<name>, the name qa_check returned."),
  reportPath: z
    .string()
    .optional()
    .describe("Alternative to reportMarkdown: absolute path (inside the repo or the temp folder) or path relative to the repo root of a .md or .txt report file you wrote, max 2 MB. It is copied; the original stays where it is."),
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
            properties: {
              id: { type: "string" },
              title: { type: "string" },
              was: {
                type: "string",
                description: "Id of a check under 'Previous checks' in your prompt that this check re-tests; omit for new checks.",
              },
            },
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
        screenshot: {
          type: "string",
          description: "Absolute path of the image file (png, jpg, webp or gif, max 25 MB), or a path relative to the repo root. It is copied into the run's screenshot folder.",
        },
      },
      required: ["id", "status"],
      additionalProperties: false,
    },
    loadMode: "essential",
  },
  {
    name: "qa_finish",
    label: "QA finish",
    description:
      "Call exactly once, last. Pass the whole report as reportMarkdown (or reportPath of a report file you wrote), never both. Tapocalypse stores it with the run's screenshots.",
    parameters: {
      type: "object",
      properties: {
        verdict: { type: "string", enum: ["PASS", "FAIL", "PASS WITH ISSUES", "BLOCKED", "PARTIAL"] },
        summary: { type: "string" },
        reportMarkdown: {
          type: "string",
          description: "The full QA report as markdown (max 2 MB). Reference screenshots as screenshots/<name>, the name qa_check returned.",
        },
        reportPath: {
          type: "string",
          description: "Alternative to reportMarkdown: absolute path (inside the repo or the temp folder) or path relative to the repo root of a .md or .txt report file you wrote, max 2 MB. It is copied; the original stays where it is.",
        },
      },
      required: ["verdict", "summary"],
      additionalProperties: false,
    },
    loadMode: "essential",
  },
] as const;

export type ProgressToolName = (typeof PROGRESS_TOOLS)[number]["name"];
export const PROGRESS_TOOL_NAMES: readonly ProgressToolName[] = PROGRESS_TOOLS.map((t) => t.name);

/** The slice of a run the recorder reads and writes; a full `Run` satisfies it. */
export type ProgressRun = Pick<Run, "status" | "checks" | "verdict" | "verdictSource" | "summary" | "reportPath"> & Partial<Pick<Run, "checkHints">>;

export interface ProgressRecorderOptions {
  getRun(): ProgressRun;
  /** Applies `mutator` to the live run and persists it. The recorder validates first, so the mutator never throws. */
  update(mutator: (run: ProgressRun) => void): void;
  log(kind: Activity["kind"], text: string, extra?: { checkId?: string; checkStatus?: CheckStatus }): void;
  repoPath: string;
  /** The run's artefact folder (`<data dir>/runs/<id>`): screenshots are copied into `<runDir>/screenshots`, the report is stored as `<runDir>/report.md`. */
  runDir: string;
}

const NOTE_SHOWN_CHARS = 300;
const MAX_REPORT_BYTES = 2 * 1024 * 1024;
const MAX_SCREENSHOT_BYTES = 25 * 1024 * 1024;
const COMPARE_CHUNK_BYTES = 64 * 1024;
const REPORT_FILE = "report.md";
const REPORT_EXTENSIONS = new Set([".md", ".markdown", ".txt"]);

/** True when both files have the same size (`size` is the first one's) and bytes; compares in bounded chunks. */
function sameContent(first: string, size: number, second: string): boolean {
  if (statSync(second).size !== size) return false;
  const a = openSync(first, "r");
  try {
    const b = openSync(second, "r");
    try {
      const bufA = Buffer.alloc(COMPARE_CHUNK_BYTES);
      const bufB = Buffer.alloc(COMPARE_CHUNK_BYTES);
      for (let pos = 0; pos < size; pos += COMPARE_CHUNK_BYTES) {
        const n = readSync(a, bufA, 0, COMPARE_CHUNK_BYTES, pos);
        if (n !== readSync(b, bufB, 0, COMPARE_CHUNK_BYTES, pos) || !bufA.subarray(0, n).equals(bufB.subarray(0, n))) return false;
        if (n === 0) break;
      }
      return true;
    } finally {
      closeSync(b);
    }
  } finally {
    closeSync(a);
  }
}

/** Records qa_plan / qa_check / qa_finish into a run; shared by omp host tools and the run-scoped MCP endpoint. */
export class ProgressRecorder implements ProgressSink {
  constructor(private readonly options: ProgressRecorderOptions) {}

  async record(tool: ProgressToolName, args: unknown): Promise<string> {
    switch (tool) {
      case "qa_plan":
        this.plan(this.parse(tool, QaPlanArgs, args));
        break;
      case "qa_check":
        return this.check(this.parse(tool, QaCheckArgs, args));
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

  /**
   * Real path of a regular file the agent names: relative paths resolve against the repo and may not leave it; absolute paths must
   * (after symlinks) lie in the repo, the run folder or the temp folder. Returns its size.
   */
  private agentFile(p: string, what: string): { file: string; size: number } {
    let resolved: string | null;
    if (path.isAbsolute(p)) {
      try {
        resolved = realpathSync(p);
      } catch {
        throw new Error(`${what} not found: ${p}`);
      }
      const real = resolved;
      const roots = [this.options.repoPath, this.options.runDir, os.tmpdir()];
      if (!roots.some((root) => resolveUnder(root, real))) throw new Error(`${what} must be inside the repo, the run folder or the temp folder`);
    } else {
      resolved = resolveUnder(this.options.repoPath, p);
      if (!resolved) throw new Error(`${what} must be inside the repo`);
    }
    try {
      const st = statSync(resolved);
      if (st.isFile()) return { file: resolved, size: st.size };
    } catch {
      // fall through
    }
    throw new Error(`${what} not found: ${p}`);
  }

  /** Validates the image and makes sure it sits in the run's screenshots folder; returns its name there (`screenshots/<name>`). */
  private storeScreenshot(p: string): string {
    const { file: source, size } = this.agentFile(p, "screenshot path");
    if (!isImagePath(source)) throw new Error("screenshot must be a .png, .jpg, .jpeg, .webp or .gif file");
    if (size > MAX_SCREENSHOT_BYTES) throw new Error("screenshot is larger than 25 MB");
    const head = readHead(source);
    if (!head || !hasImageMagic(head)) throw new Error("screenshot is not a valid image (png, jpg, webp or gif)");

    const dir = path.join(this.options.runDir, "screenshots");
    mkdirSync(dir, { recursive: true });
    const realDir = realpathSync(dir);
    if (source.startsWith(realDir + path.sep)) return `screenshots/${path.relative(realDir, source).split(path.sep).join("/")}`;

    const ext = path.extname(source).toLowerCase();
    const stem = path.basename(source, path.extname(source)).replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "") || "screenshot";
    for (let n = 1; ; n++) {
      const name = n === 1 ? `${stem}${ext}` : `${stem}-${n}${ext}`;
      const target = path.join(dir, name);
      try {
        copyFileSync(source, target, constants.COPYFILE_EXCL);
        return `screenshots/${name}`;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        // Re-attaching the same image reuses its stored copy; a different image under the same name gets the next suffix.
        if (sameContent(source, size, target)) return `screenshots/${name}`;
      }
    }
  }

  /** The report file the agent wrote, with images linked in the old `screenshots/<run id>/` layout pointed at the flat stored names. */
  private readReportFile(p: string): string {
    const { file, size } = this.agentFile(p, "reportPath");
    if (!REPORT_EXTENSIONS.has(path.extname(file).toLowerCase())) throw new Error("reportPath must be a .md, .markdown or .txt file");
    if (size > MAX_REPORT_BYTES) throw new Error("report is larger than 2 MB");
    const runId = path.basename(this.options.runDir);
    return readFileSync(file, "utf8").replaceAll(`screenshots/${runId}/`, "screenshots/");
  }

  private plan({ checks }: z.infer<typeof QaPlanArgs>): void {
    const now = new Date().toISOString();
    this.options.update((run) => {
      run.checks = checks.map((c): Check => ({ id: c.id, title: c.title, status: "pending", updatedAt: now, ...(c.was === undefined ? {} : { was: c.was }) }));
    });
    this.options.log("check", `Test plan: ${checks.length} check${checks.length === 1 ? "" : "s"}`);
    this.logIgnoredClaims(checks);
  }

  /** `was` only counts when it names a hinted check nobody claimed before; the rest stays on the check for audit and is noted here. */
  private logIgnoredClaims(checks: z.infer<typeof QaPlanArgs>["checks"]): void {
    const hinted = this.options.getRun().checkHints?.checks;
    if (!hinted) return;
    const claimedBy = new Map<string, string>();
    for (const c of checks) {
      if (c.was === undefined) continue;
      const first = claimedBy.get(c.was);
      if (!hinted.some((h) => h.id === c.was)) this.options.log("info", `${c.id}: was ${JSON.stringify(c.was)} is not one of the previous checks; ignored`);
      else if (first !== undefined) this.options.log("info", `${c.id}: was ${JSON.stringify(c.was)} is already claimed by ${first}; ignored`);
      else claimedBy.set(c.was, c.id);
    }
  }

  private check(a: z.infer<typeof QaCheckArgs>): string {
    const screenshot = a.screenshot === undefined ? undefined : this.storeScreenshot(a.screenshot);
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
    return screenshot === undefined
      ? "recorded"
      : `recorded ${a.id} ${a.status}; screenshot stored as ${screenshot} (reference it in the report as ${screenshot})`;
  }

  private finish(a: z.infer<typeof QaFinishArgs>): void {
    if (this.options.getRun().verdict !== null) throw new Error("qa_finish already recorded");
    if ((a.reportMarkdown === undefined) === (a.reportPath === undefined)) {
      throw new Error("qa_finish needs exactly one of reportMarkdown or reportPath");
    }
    const markdown = a.reportMarkdown ?? this.readReportFile(a.reportPath!);
    if (Buffer.byteLength(markdown) > MAX_REPORT_BYTES) throw new Error("report is larger than 2 MB");
    mkdirSync(this.options.runDir, { recursive: true });
    writeFileSync(path.join(this.options.runDir, REPORT_FILE), markdown);
    this.options.update((run) => {
      run.verdict = a.verdict;
      run.verdictSource = "agent";
      run.summary = a.summary;
      run.reportPath = REPORT_FILE;
      if (run.status === "running") run.status = "finishing";
    });
    this.options.log("check", `Finished: ${a.verdict}`);
  }
}
