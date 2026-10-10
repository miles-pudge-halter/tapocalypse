import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const SEED = path.join(ROOT, "scripts", "seed-demo.ts");

let tmp: string;
let dataDir: string;
let configFile: string;

/** Runs a script in a fresh Bun process whose config and data dir are the seeded demo ones, and returns its JSON output. */
async function inspect<T>(code: string): Promise<T> {
  const proc = Bun.spawn([process.execPath, "-e", code], {
    cwd: ROOT,
    env: { ...process.env, TAPOCALYPSE_CONFIG: configFile, TAPOCALYPSE_DATA_DIR: dataDir },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (exit !== 0) throw new Error(err || out);
  return JSON.parse(out) as T;
}

async function seed(args: string[], env: Record<string, string> = {}): Promise<{ exit: number; out: string; err: string }> {
  const proc = Bun.spawn([process.execPath, SEED, ...args], { cwd: ROOT, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [out, err, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { exit, out, err };
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tapocalypse-seed-"));
  dataDir = path.join(tmp, "data");
  configFile = path.join(tmp, "config.json");
  const res = await seed(["--dir", dataDir, "--config", configFile]);
  if (res.exit !== 0) throw new Error(res.err || res.out);
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("demo seed", () => {
  test("seeds a data dir that loads through the run store with the planned verdict mix", async () => {
    const summary = await inspect<{ total: number; verdicts: Record<string, number>; statuses: Record<string, number> }>(`
      import { listRuns } from "./src/runs/store";
      const verdicts = {}; const statuses = {};
      for (const r of listRuns()) {
        statuses[r.status] = (statuses[r.status] ?? 0) + 1;
        if (r.verdict) verdicts[r.verdict] = (verdicts[r.verdict] ?? 0) + 1;
      }
      console.log(JSON.stringify({ total: listRuns().length, verdicts, statuses }));
    `);
    expect(summary.total).toBe(22);
    expect(summary.verdicts).toMatchObject({ PASS: 12, "PASS WITH ISSUES": 3, FAIL: 3, BLOCKED: 1, PARTIAL: 1 });
    expect(summary.statuses).toMatchObject({ done: 20, error: 1, cancelled: 1 });
  });

  test("every harness's raw frames replay into a timeline with device tool rows and check milestones", async () => {
    const byHarness = await inspect<Record<string, { tools: string[]; ends: number; checks: number; says: number }>>(`
      import { listRuns, readActivity } from "./src/runs/store";
      const out = {};
      for (const run of listRuns()) {
        if (run.status !== "done" || out[run.harness]) continue;
        const { items } = readActivity(run.id, { limit: 1000 });
        out[run.harness] = {
          tools: items.filter((a) => a.kind === "tool").map((a) => a.tool),
          ends: items.filter((a) => a.kind === "tool_end" && a.ok === true && a.durationMs > 0).length,
          checks: items.filter((a) => a.kind === "check").length,
          says: items.filter((a) => a.kind === "say").length,
        };
      }
      console.log(JSON.stringify(out));
    `);
    expect(Object.keys(byHarness).sort()).toEqual(["claude", "codex", "omp"]);
    for (const { tools, ends, checks, says } of Object.values(byHarness)) {
      expect(tools).toContain("mcp__mobile_mcp_mobile_click_on_screen_at_coordinates");
      expect(tools).toContain("mcp__mobile_mcp_mobile_save_screenshot");
      expect(tools).toContain("bash");
      expect(ends).toBeGreaterThan(5);
      expect(checks).toBeGreaterThan(4);
      expect(says).toBeGreaterThan(2);
    }
  });

  test("data runs keep their report and screenshots in the run dir with run-relative links, and the temp repo holds nothing of theirs", async () => {
    const res = await inspect<{ problems: string[]; data: number; withReport: number; projectHasReportsDir: boolean; repoEntries: string[] }>(`
      import fs from "node:fs";
      import path from "node:path";
      import { DATA_DIR } from "./src/config";
      import { extractVerdict } from "./src/reports/reports";
      const cfg = JSON.parse(fs.readFileSync(process.env.TAPOCALYPSE_CONFIG, "utf8"));
      const repo = cfg.projects[0].repoPath;
      const runsDir = path.join(DATA_DIR, "runs");
      const problems = [];
      let data = 0, withReport = 0;
      const dataIds = [];
      for (const id of fs.readdirSync(runsDir)) {
        const run = JSON.parse(fs.readFileSync(path.join(runsDir, id, "run.json"), "utf8"));
        if (run.storage !== "data") continue;
        data++; dataIds.push(id);
        for (const c of run.checks) {
          if (!c.screenshot) continue;
          if (!c.screenshot.startsWith("screenshots/")) problems.push(id + " screenshot " + c.screenshot);
          else if (!fs.existsSync(path.join(runsDir, id, c.screenshot))) problems.push(id + " missing " + c.screenshot);
        }
        if (run.reportPath === null) { if (fs.existsSync(path.join(runsDir, id, "report.md"))) problems.push(id + " stray report.md"); continue; }
        withReport++;
        if (run.reportPath !== "report.md") { problems.push(id + " reportPath " + run.reportPath); continue; }
        const file = path.join(runsDir, id, "report.md");
        if (!fs.existsSync(file)) { problems.push(id + " missing report.md"); continue; }
        const md = fs.readFileSync(file, "utf8");
        if (extractVerdict(md) !== run.verdict) problems.push(id + " report verdict " + extractVerdict(md) + " != " + run.verdict);
        const images = [...md.matchAll(/!\\[[^\\]]*\\]\\(([^)]+)\\)/g)].map((m) => m[1]);
        for (const rel of images) {
          if (!rel.startsWith("screenshots/") || !fs.existsSync(path.join(runsDir, id, rel))) problems.push(id + " broken image " + rel);
        }
      }
      const repoEntries = fs.readdirSync(repo, { recursive: true }).map(String).filter((f) => dataIds.some((id) => f.includes(id)));
      console.log(JSON.stringify({ problems, data, withReport, projectHasReportsDir: "reportsDir" in cfg.projects[0], repoEntries }));
    `);
    expect(res.problems).toEqual([]);
    expect(res.data).toBe(20);
    expect(res.withReport).toBe(17);
    expect(res.projectHasReportsDir).toBe(false);
    expect(res.repoEntries).toEqual([]);
  });

  test("two legacy repo runs keep report and screenshots under the temp repo's qa/ and still carry their verdict", async () => {
    const res = await inspect<{ problems: string[]; legacy: number; gitRepo: boolean }>(`
      import fs from "node:fs";
      import path from "node:path";
      import { DATA_DIR } from "./src/config";
      import { extractVerdict } from "./src/reports/reports";
      const cfg = JSON.parse(fs.readFileSync(process.env.TAPOCALYPSE_CONFIG, "utf8"));
      const repo = cfg.projects[0].repoPath;
      const runsDir = path.join(DATA_DIR, "runs");
      const problems = [];
      let legacy = 0;
      for (const id of fs.readdirSync(runsDir)) {
        const run = JSON.parse(fs.readFileSync(path.join(runsDir, id, "run.json"), "utf8"));
        if (run.storage === "data") continue;
        if (run.storage !== "repo") { problems.push(id + " storage " + run.storage); continue; }
        legacy++;
        if (fs.existsSync(path.join(runsDir, id, "report.md"))) problems.push(id + " has a run-dir report");
        if (fs.existsSync(path.join(runsDir, id, "screenshots"))) problems.push(id + " has run-dir screenshots");
        let shots = 0;
        for (const c of run.checks) {
          if (!c.screenshot) continue;
          shots++;
          if (!fs.existsSync(path.join(repo, c.screenshot))) problems.push(id + " missing " + c.screenshot);
        }
        if (shots === 0) problems.push(id + " has no screenshots");
        if (run.reportPath !== "qa/QA-REPORT-" + id + ".md") { problems.push(id + " reportPath " + run.reportPath); continue; }
        const file = path.join(repo, run.reportPath);
        if (!fs.existsSync(file)) { problems.push(id + " missing report"); continue; }
        const md = fs.readFileSync(file, "utf8");
        if (extractVerdict(md) !== run.verdict) problems.push(id + " report verdict " + extractVerdict(md) + " != " + run.verdict);
        for (const m of md.matchAll(/!\\[[^\\]]*\\]\\(([^)]+)\\)/g)) {
          if (!fs.existsSync(path.join(repo, "qa", m[1]))) problems.push(id + " broken image " + m[1]);
        }
      }
      console.log(JSON.stringify({ problems, legacy, gitRepo: fs.existsSync(path.join(repo, ".git")) }));
    `);
    expect(res.problems).toEqual([]);
    expect(res.legacy).toBe(2);
    expect(res.gitRepo).toBe(true);
  });

  test("the batch has one Android and one iOS lane, and the infra failure, retry and derived verdict are linked as the app expects", async () => {
    const res = await inspect<{
      lanes: { platform: string; verdict: string | null; batchId: string | null }[];
      batchMeta: boolean;
      failed: { status: string; errorKind: string | null; retriedBy: string | null; hasChecks: boolean };
      retry: { attempt: number; verdict: string | null; retryOf: string | null; failedId: string; id: string };
      derived: { verdict: string | null; verdictSource: string | null; errorKind: string | null; running: number };
    }>(`
      import { listRuns } from "./src/runs/store";
      import { getBatchMeta } from "./src/batches";
      const runs = listRuns();
      const lanes = runs.filter((r) => r.batchId).map((r) => ({ platform: r.deviceRequest.platform, verdict: r.verdict, batchId: r.batchId }));
      const failed = runs.find((r) => r.status === "error");
      const retry = runs.find((r) => r.retryOf === failed.id);
      const derived = runs.find((r) => r.verdictSource === "derived");
      console.log(JSON.stringify({
        lanes,
        batchMeta: getBatchMeta(lanes[0].batchId) !== null,
        failed: { status: failed.status, errorKind: failed.errorKind, retriedBy: failed.retriedBy, hasChecks: failed.checks.length > 0 },
        retry: { attempt: retry.attempt, verdict: retry.verdict, retryOf: retry.retryOf, failedId: failed.id, id: retry.id },
        derived: { verdict: derived.verdict, verdictSource: derived.verdictSource, errorKind: derived.errorKind, running: derived.checks.filter((c) => c.status === "running").length },
      }));
    `);
    expect(res.lanes.map((l) => l.platform).sort()).toEqual(["android", "ios"]);
    expect(new Set(res.lanes.map((l) => l.batchId)).size).toBe(1);
    expect(res.batchMeta).toBe(true);
    expect(res.failed).toMatchObject({ status: "error", errorKind: "infra", hasChecks: false });
    expect(res.failed.retriedBy).toBe(res.retry.id);
    expect(res.retry).toMatchObject({ attempt: 2, verdict: "PASS", retryOf: res.retry.failedId });
    expect(res.derived).toMatchObject({ verdict: "PARTIAL", verdictSource: "derived", errorKind: "timeout", running: 1 });
  });

  test("refuses to seed into a data dir that already has runs, and defaults to a throwaway dir instead of the real one", async () => {
    const again = await seed(["--dir", dataDir, "--config", path.join(tmp, "other.json")]);
    expect(again.exit).toBe(1);
    expect(again.err).toContain("already has runs");
    expect(fs.existsSync(path.join(tmp, "other.json"))).toBe(false);

    const fresh = path.join(tmp, "tmpdir");
    fs.mkdirSync(fresh);
    const bare = await seed([], { TMPDIR: fresh });
    expect(bare.exit).toBe(0);
    const created = fs.readdirSync(fresh);
    expect(created).toHaveLength(1);
    expect(fs.existsSync(path.join(fresh, created[0]!, "runs"))).toBe(true);
    expect(fs.existsSync(path.join(fresh, created[0]!, "config.json"))).toBe(true);
  });
});
