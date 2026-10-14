import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { hubRetention, setHubMode } from "../src/hub/mode";
import { applyRetention, retentionPolicy, selectExpiredRuns } from "../src/retention";
import { getRun, runDir, saveRun } from "../src/runs/store";
import type { Run, RunStatus } from "../src/runs/types";

const DAY = 86_400_000;
const NOW = Date.parse("2026-06-30T12:00:00Z");

function run(id: string, status: RunStatus, daysAgo: number): Run {
  const at = new Date(NOW - daysAgo * DAY).toISOString();
  return { id, status, createdAt: at, endedAt: status === "queued" || status === "running" ? null : at } as Run;
}

describe("selectExpiredRuns", () => {
  const runs = [run("new", "done", 1), run("mid", "error", 10), run("old", "cancelled", 40), run("live", "running", 90), run("wait", "queued", 90)];

  test("an empty policy deletes nothing", () => {
    expect(selectExpiredRuns(runs, {}, NOW)).toEqual([]);
  });

  test("days removes finished runs older than the window and never active ones", () => {
    expect(selectExpiredRuns(runs, { days: 30 }, NOW)).toEqual(["old"]);
    expect(selectExpiredRuns(runs, { days: 5 }, NOW).sort()).toEqual(["mid", "old"]);
  });

  test("maxRuns keeps the newest and spares active runs beyond the cap", () => {
    expect(selectExpiredRuns(runs, { maxRuns: 1 }, NOW).sort()).toEqual(["mid", "old"]);
  });

  test("age is measured from the end time, falling back to creation", () => {
    const longRunning = { ...run("x", "done", 40), endedAt: new Date(NOW - DAY).toISOString() };
    expect(selectExpiredRuns([longRunning], { days: 30 }, NOW)).toEqual([]);
  });

  test("days and maxRuns combine without listing a run twice", () => {
    expect(selectExpiredRuns(runs, { days: 30, maxRuns: 1 }, NOW).sort()).toEqual(["mid", "old"]);
  });

  test("finished members of a batch that still has an active run are kept", () => {
    const batched = (id: string, status: RunStatus, daysAgo: number) => ({ ...run(id, status, daysAgo), batchId: "b-x" }) as Run;
    const batch = [batched("b-old", "done", 60), batched("b-live", "running", 60), run("plain-old", "done", 60)];
    expect(selectExpiredRuns(batch, { days: 30 }, NOW)).toEqual(["plain-old"]);
    const finishedBatch = [batched("b-old", "done", 60), batched("b-old2", "error", 60)];
    expect(selectExpiredRuns(finishedBatch, { days: 30 }, NOW).sort()).toEqual(["b-old", "b-old2"]);
  });
});

describe("applyRetention", () => {
  const ids = ["20200101-000000-aaaa-ret-old", "20260629-000000-bbbb-ret-new", "20200101-000001-cccc-ret-live"];
  afterEach(() => {
    for (const id of ids) fs.rmSync(runDir(id), { recursive: true, force: true });
  });

  test("removes expired run directories and keeps recent and active ones", () => {
    for (const [i, status] of (["done", "done", "running"] as const).entries()) {
      const id = ids[i]!;
      fs.mkdirSync(runDir(id), { recursive: true });
      saveRun({ ...run(id, status, i === 1 ? 1 : 400), id, projectId: "p" } as Run);
    }
    const deleted = applyRetention({ now: NOW + 0, policy: { days: 30 } });
    // The data dir is shared with other test files, so only assert on this test's runs.
    expect(deleted.filter((id) => ids.includes(id))).toEqual([ids[0]!]);
    expect(getRun(ids[0]!)).toBeNull();
    expect(getRun(ids[1]!)).not.toBeNull();
    expect(getRun(ids[2]!)).not.toBeNull();
  });

  test("an expired data run takes its report and screenshots with it", () => {
    const id = ids[0]!;
    const dir = runDir(id);
    fs.mkdirSync(path.join(dir, "screenshots"), { recursive: true });
    fs.writeFileSync(path.join(dir, "report.md"), "# r\n");
    fs.writeFileSync(path.join(dir, "screenshots", "01.png"), "x");
    saveRun({ ...run(id, "done", 400), id, projectId: "p", storage: "data", reportPath: "report.md" } as Run);
    expect(applyRetention({ now: NOW, policy: { days: 30 } })).toContain(id);
    expect(fs.existsSync(dir)).toBe(false);
  });

  test("a run whose runner still holds its device is skipped", () => {
    const id = ids[0]!;
    fs.mkdirSync(runDir(id), { recursive: true });
    saveRun({ ...run(id, "cancelled", 400), id, projectId: "p" } as Run);
    expect(applyRetention({ now: NOW, policy: { days: 30 }, isHeld: (x) => x === id })).not.toContain(id);
    expect(getRun(id)).not.toBeNull();
    expect(applyRetention({ now: NOW, policy: { days: 30 } })).toContain(id);
    expect(getRun(id)).toBeNull();
  });
});

describe("hub retention policy", () => {
  const saved = process.env.TAPOCALYPSE_HUB_RETENTION_DAYS;
  const savedMax = process.env.TAPOCALYPSE_HUB_RETENTION_MAX_RUNS;
  afterEach(() => {
    setHubMode(null);
    if (saved === undefined) delete process.env.TAPOCALYPSE_HUB_RETENTION_DAYS;
    else process.env.TAPOCALYPSE_HUB_RETENTION_DAYS = saved;
    if (savedMax === undefined) delete process.env.TAPOCALYPSE_HUB_RETENTION_MAX_RUNS;
    else process.env.TAPOCALYPSE_HUB_RETENTION_MAX_RUNS = savedMax;
  });

  test("a hub keeps a year by default; 0 keeps everything; a count cap is optional", () => {
    expect(hubRetention({})).toEqual({ days: 365 });
    expect(hubRetention({ TAPOCALYPSE_HUB_RETENTION_DAYS: "90" })).toEqual({ days: 90 });
    expect(hubRetention({ TAPOCALYPSE_HUB_RETENTION_DAYS: "0" })).toEqual({});
    expect(hubRetention({ TAPOCALYPSE_HUB_RETENTION_DAYS: "0", TAPOCALYPSE_HUB_RETENTION_MAX_RUNS: "5000" })).toEqual({ maxRuns: 5000 });
    expect(hubRetention({ TAPOCALYPSE_HUB_RETENTION_DAYS: "soon" })).toEqual({});
  });

  test("the policy in force is the hub's on a hub and the config's on a laptop", () => {
    process.env.TAPOCALYPSE_HUB_RETENTION_DAYS = "30";
    delete process.env.TAPOCALYPSE_HUB_RETENTION_MAX_RUNS;
    setHubMode(true);
    expect(retentionPolicy()).toEqual({ days: 30 });
    setHubMode(false);
    expect(retentionPolicy()).toEqual({});
  });
});
