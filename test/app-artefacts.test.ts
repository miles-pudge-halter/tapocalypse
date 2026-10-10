import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { runScreenshots, runView } from "../src/app";
import { getProject } from "../src/projects/registry";
import { runArtefactDir, screenshotsDir } from "../src/runs/artefacts";
import { createRun, deleteRun } from "../src/runs/store";
import type { Check, Run } from "../src/runs/types";

const PNG = Buffer.from("89504e470d0a1a0a", "hex");
const created: string[] = [];
const repoPath = getProject("test-proj")!.repoPath;

function makeRun(over: Partial<Run> = {}): Run {
  const run = createRun({
    projectId: "test-proj",
    title: "app artefacts",
    brief: "b",
    requestedBy: "test",
    deviceRequest: { platform: "android" },
    deviceSerial: null,
    bootedByRun: false,
    packageId: "com.example.app",
    status: "done",
    verdict: "PASS",
    summary: "s",
    reportPath: null,
    checks: [],
    error: null,
    startedAt: null,
    endedAt: null,
    stats: null,
    transcriptHtml: false,
    source: null,
    build: null,
    storage: "data",
    ...over,
  });
  created.push(run.id);
  return run;
}

const check = (id: string, screenshot: string): Check => ({ id, title: id, status: "pass", screenshot, updatedAt: "2026-01-01T00:00:00.000Z" });

afterAll(() => {
  for (const id of created) {
    deleteRun(id);
    fs.rmSync(path.join(repoPath, "qa", "screenshots", id), { recursive: true, force: true });
  }
});

describe("runScreenshots", () => {
  test("data runs list the run's screenshots folder and check images, served from the run's files route", () => {
    const run = makeRun();
    run.checks = [check("C1", "screenshots/01-home.png"), check("C2", "screenshots/missing.png"), check("C3", "../run.json")];
    fs.mkdirSync(screenshotsDir(run.id), { recursive: true });
    fs.writeFileSync(path.join(screenshotsDir(run.id), "01-home.png"), PNG);
    fs.writeFileSync(path.join(screenshotsDir(run.id), "extra shot.png"), PNG);
    fs.writeFileSync(path.join(screenshotsDir(run.id), "notes.md"), "not an image");

    const shots = runScreenshots(run);
    expect(shots.map((s) => [s.path, s.url, s.name, s.checkId]).sort()).toEqual(
      [
        ["screenshots/01-home.png", `/api/runs/${run.id}/files/screenshots/01-home.png`, "01-home.png", "C1"],
        ["screenshots/extra shot.png", `/api/runs/${run.id}/files/screenshots/extra%20shot.png`, "extra shot.png", null],
      ].sort(),
    );
  });

  test("legacy runs keep listing the repo's reports folder through the project files route", () => {
    const run = makeRun({ storage: "repo" });
    const dir = path.join(repoPath, "qa", "screenshots", run.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "01-home.png"), PNG);
    run.checks = [check("C1", `qa/screenshots/${run.id}/01-home.png`), check("C4", "../outside.png")];
    expect(runScreenshots(run).map((s) => [s.path, s.url, s.checkId])).toEqual([
      [`qa/screenshots/${run.id}/01-home.png`, `/files/test-proj/screenshots/${run.id}/01-home.png`, "C1"],
    ]);
  });
});

describe("runView", () => {
  test("carries the absolute run folder and report file, null when the run has no report", () => {
    const withReport = makeRun({ reportPath: "report.md" });
    fs.mkdirSync(runArtefactDir(withReport.id), { recursive: true });
    fs.writeFileSync(path.join(runArtefactDir(withReport.id), "report.md"), "# r\n");
    const view = runView(withReport);
    expect(view.runDir).toBe(runArtefactDir(withReport.id));
    expect(view.reportFile).toBe(path.join(runArtefactDir(withReport.id), "report.md"));

    const without = runView(makeRun());
    expect(without.reportFile).toBeNull();
    expect(without.runDir).toBe(runArtefactDir(without.id));
  });
});
