import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const SEED = path.join(ROOT, "scripts", "seed-demo.ts");

let tmp: string;
let dataDir: string;
let configFile: string;

interface Instance {
  dataDir: string;
  configFile: string;
}

/** Runs a script in a fresh Bun process whose config and data dir are the seeded demo ones, and returns its JSON output. */
async function inspect<T>(code: string, at: Instance = { dataDir, configFile }): Promise<T> {
  const proc = Bun.spawn([process.execPath, "-e", code], {
    cwd: ROOT,
    env: { ...process.env, TAPOCALYPSE_CONFIG: at.configFile, TAPOCALYPSE_DATA_DIR: at.dataDir },
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
    expect(summary.total).toBe(30);
    expect(summary.verdicts).toMatchObject({ PASS: 13, "PASS WITH ISSUES": 8, FAIL: 5, BLOCKED: 1, PARTIAL: 1 });
    expect(summary.statuses).toMatchObject({ done: 28, error: 1, cancelled: 1 });
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
    expect(res.data).toBe(28);
    expect(res.withReport).toBe(25);
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

  test("two recurring tests have runs on main and on PR #142, a rerun lineage, a same-commit flip pattern and a device that disagrees", async () => {
    const res = await inspect<{
      tests: Record<string, { main: number; pr: { branch: string; number: number; base: string }[]; total: number }>;
      rerun: { parentFound: boolean; sameCommit: boolean; briefNamesParent: boolean; idsSubset: boolean; checks: number };
      flips: { statuses: string[]; dirty: (boolean | null)[]; devices: string[] };
      sensitive: { passDevices: string[]; failDevices: string[]; platforms: string[] };
    }>(`
      import { listRuns } from "./src/runs/store";
      const runs = listRuns().slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const baseBrief = (r) => r.brief.split("\\n\\nRe-run ONLY")[0];
      const START = { checkout: "Smoke-test the happy path", dark: "Switch the app to the dark theme" };
      const tests = {};
      for (const [name, prefix] of Object.entries(START)) {
        const mine = runs.filter((r) => baseBrief(r).startsWith(prefix));
        tests[name] = {
          total: mine.length,
          main: mine.filter((r) => r.source.branch === "main").length,
          pr: mine.filter((r) => r.source.pr).map((r) => ({ branch: r.source.branch, number: r.source.pr.number, base: r.source.pr.baseBranch })),
        };
      }
      const checkout = runs.filter((r) => baseBrief(r).startsWith(START.checkout));
      const child = checkout.find((r) => r.rerunOf);
      const parent = child && runs.find((r) => r.id === child.rerunOf);
      const rerun = {
        parentFound: Boolean(parent),
        sameCommit: Boolean(parent) && parent.source.commit === child.source.commit,
        briefNamesParent: Boolean(parent) && child.brief.includes("Re-run ONLY these checks from run " + parent.id),
        idsSubset: Boolean(parent) && child.checks.every((c) => parent.checks.some((p) => p.id === c.id)),
        checks: child ? child.checks.length : 0,
      };
      // Newest main commit on the Pixel 8: one check passes, fails, passes again on the same clean code.
      const mainPixel = checkout.filter((r) => r.source.branch === "main" && r.deviceName === "Pixel 8");
      const code = mainPixel[mainPixel.length - 1].source.commit;
      const sameCode = mainPixel.filter((r) => r.source.commit === code);
      const quantity = sameCode.map((r) => ({ r, c: r.checks.find((c) => c.title === "Quantity change recalculates totals") })).filter((x) => x.c);
      const flips = { statuses: quantity.map((x) => x.c.status), dirty: quantity.map((x) => x.r.source.dirty), devices: [...new Set(quantity.map((x) => x.r.deviceName))] };
      // The same code on two Android devices: one passes the catalog check, the other fails it.
      const catalog = checkout.filter((r) => r.source.commit === code && r.deviceRequest.platform === "android").map((r) => ({ r, c: r.checks.find((c) => c.title === "Catalog loads with four products") })).filter((x) => x.c);
      const names = (status) => [...new Set(catalog.filter((x) => x.c.status === status).map((x) => x.r.deviceName))];
      const sensitive = { passDevices: names("pass"), failDevices: names("fail"), platforms: [...new Set(catalog.map((x) => x.r.deviceRequest.platform))] };
      console.log(JSON.stringify({ tests, rerun, flips, sensitive }));
    `);
    for (const test of Object.values(res.tests)) {
      expect(test.total).toBeGreaterThanOrEqual(3);
      expect(test.main).toBeGreaterThanOrEqual(2);
      expect(test.pr).toContainEqual({ branch: "feat/cart-badge", number: 142, base: "main" });
    }
    expect(res.rerun).toMatchObject({ parentFound: true, sameCommit: true, briefNamesParent: true, idsSubset: true });
    expect(res.rerun.checks).toBeGreaterThan(0);
    expect(res.flips.statuses).toEqual(["pass", "fail", "pass"]);
    expect(res.flips.dirty.every((d) => d === false)).toBe(true);
    expect(res.flips.devices).toEqual(["Pixel 8"]);
    expect(res.sensitive.platforms).toEqual(["android"]);
    expect(res.sensitive.passDevices).toContain("Pixel 8");
    expect(res.sensitive.failDevices.length).toBeGreaterThan(0);
    expect(res.sensitive.failDevices).not.toContain("Pixel 8");
  });

  test("after the boot backfill the PR run compares against main with a newly failing, a fixed and a flaky check, and the paraphrased title is an inferred match", async () => {
    const instance: Instance = { dataDir: path.join(tmp, "regression", "data"), configFile: path.join(tmp, "regression", "config.json") };
    const seeded = await seed(["--dir", instance.dataDir, "--config", instance.configFile]);
    expect(seeded.exit).toBe(0);
    const res = await inspect<{
      baseline: { auto: boolean; tier: string; branch: string | null };
      counts: Record<string, number>;
      rows: Record<string, { current: string; baseline: string | null }[]>;
      inferred: { current: string; baseline: string | null; transition: string; confidence: string | null }[];
      flaky: { title: string; confidence: string }[];
      sensitive: boolean;
    }>(
      `
      import { backfill } from "./src/regression/index";
      import { listRuns } from "./src/runs/store";
      import { compareView, flakyView, historyView } from "./src/app";
      await backfill();
      const head = listRuns().filter((r) => r.brief.startsWith("Smoke-test the happy path") && r.source.pr?.number === 142 && !r.rerunOf)[0];
      const { comparison } = compareView(head.id, { baseline: "auto", includeFlaky: false });
      const rows = {};
      for (const p of comparison.pairs) (rows[p.transition] ??= []).push({ current: p.current?.title ?? "", baseline: p.baseline?.title ?? null });
      const inferred = comparison.pairs.filter((p) => p.match === "inferred").map((p) => ({ current: p.current?.title ?? "", baseline: p.baseline?.title ?? null, transition: p.transition, confidence: p.confidence }));
      const flaky = flakyView(head.projectId, { window: 20 }).checks.map((c) => ({ title: c.title, confidence: c.confidence }));
      const catalog = comparison.pairs.find((p) => p.current?.title === "Catalog loads with four products");
      const history = historyView({ projectId: head.projectId, checkKey: catalog.checkKey }, { limit: 30 });
      console.log(JSON.stringify({
        baseline: { auto: comparison.baseline.auto, tier: comparison.baseline.tier, branch: comparison.baseline.branch },
        counts: comparison.counts, rows, inferred, flaky, sensitive: history.deviceSensitive,
      }));
    `,
      instance,
    );
    expect(res.baseline).toEqual({ auto: true, tier: "pr-base", branch: "main" });
    expect(res.counts).toMatchObject({ newly_failing: 1, fixed: 1, flaky: 1 });
    expect(res.rows.newly_failing?.map((r) => r.current)).toEqual(["Checkout reaches the order summary"]);
    expect(res.rows.fixed?.map((r) => r.current)).toEqual(["Add to cart updates the cart"]);
    expect(res.rows.flaky?.map((r) => r.current)).toEqual(["Quantity change recalculates totals"]);
    expect(res.flaky.map((c) => c.title)).toContain("Quantity change recalculates totals");
    expect(res.flaky.find((c) => c.title === "Quantity change recalculates totals")?.confidence).toBe("flaky");
    expect(res.inferred).toHaveLength(1);
    expect(res.inferred[0]).toMatchObject({ transition: "unchanged", confidence: "inferred", baseline: "Product detail opens from the catalog" });
    expect(res.inferred[0]!.current).not.toBe(res.inferred[0]!.baseline);
    expect(res.sensitive).toBe(true);
  });
});
