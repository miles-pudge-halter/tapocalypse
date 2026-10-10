import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Project } from "../src/projects/registry";
import { DATA_DIR, HttpError } from "../src/config";
import { exportRun, reportFile, runArtefactDir, runImages, screenshotFile, screenshotsDir } from "../src/runs/artefacts";
import type { Run } from "../src/runs/types";

let tmp: string;
let repo: string;
const ids: string[] = [];

const project = (): Project => ({ id: "p", name: "P", repoPath: repo, reportsDir: "qa" }) as Project;

function makeRun(over: Partial<Run> = {}): Run {
  const id = `art-${Math.random().toString(36).slice(2, 10)}`;
  ids.push(id);
  return { id, projectId: "p", storage: "data", reportPath: null, checks: [], ...over } as Run;
}

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tpc-artefacts-")));
  repo = path.join(tmp, "repo");
  fs.mkdirSync(path.join(repo, "qa"), { recursive: true });
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const id of ids) fs.rmSync(runArtefactDir(id), { recursive: true, force: true });
});

describe("artefact locations", () => {
  test("screenshots live in the run's artefact folder", () => {
    expect(screenshotsDir("r1")).toBe(path.join(runArtefactDir("r1"), "screenshots"));
    expect(path.isAbsolute(runArtefactDir("r1"))).toBe(true);
  });
});

describe("reportFile", () => {
  test("data runs resolve report.md in the run folder; missing or unset report is null", () => {
    const run = makeRun({ reportPath: "report.md" });
    expect(reportFile(run, project())).toBeNull();
    fs.mkdirSync(runArtefactDir(run.id), { recursive: true });
    fs.writeFileSync(path.join(runArtefactDir(run.id), "report.md"), "# r\n");
    expect(reportFile(run, project())).toBe(fs.realpathSync(path.join(runArtefactDir(run.id), "report.md")));
    expect(reportFile({ ...run, reportPath: null }, project())).toBeNull();
  });

  test("legacy runs resolve their repo-relative report through the project", () => {
    fs.writeFileSync(path.join(repo, "qa", "QA-REPORT-old.md"), "# old\n");
    const run = makeRun({ storage: "repo", reportPath: "qa/QA-REPORT-old.md" });
    expect(reportFile(run, project())).toBe(path.join(repo, "qa", "QA-REPORT-old.md"));
    expect(reportFile(run, null)).toBeNull();
    expect(reportFile({ ...run, reportPath: "../outside.md" }, project())).toBeNull();
  });

  test("a data run's report path cannot escape the run folder", () => {
    const run = makeRun({ reportPath: "../../etc/hosts" });
    expect(reportFile(run, project())).toBeNull();
  });
});

describe("screenshotFile", () => {
  const PNG = Buffer.from("89504e470d0a1a0a", "hex");

  test("data runs serve images inside screenshots/ only", () => {
    const run = makeRun();
    fs.mkdirSync(screenshotsDir(run.id), { recursive: true });
    fs.writeFileSync(path.join(screenshotsDir(run.id), "01-home.png"), PNG);
    fs.writeFileSync(path.join(screenshotsDir(run.id), "notes.txt"), "x");
    fs.writeFileSync(path.join(runArtefactDir(run.id), "report.png"), PNG);
    fs.symlinkSync(tmp, path.join(screenshotsDir(run.id), "link"));
    const real = fs.realpathSync(path.join(screenshotsDir(run.id), "01-home.png"));
    expect(screenshotFile(run, project(), "screenshots/01-home.png")).toBe(real);
    expect(screenshotFile(run, project(), "screenshots/missing.png")).toBeNull();
    expect(screenshotFile(run, project(), "screenshots/notes.txt")).toBeNull();
    expect(screenshotFile(run, project(), "report.png")).toBeNull();
    expect(screenshotFile(run, project(), "screenshots/../report.png")).toBeNull();
    expect(screenshotFile(run, project(), "screenshots/link/x.png")).toBeNull();
    expect(screenshotFile(run, project(), "screenshots")).toBeNull();
  });

  test("legacy runs resolve repo-relative paths under the project's reports dir, defaulting to qa", () => {
    fs.mkdirSync(path.join(repo, "qa", "screenshots", "old"), { recursive: true });
    fs.writeFileSync(path.join(repo, "qa", "screenshots", "old", "a.png"), PNG);
    fs.writeFileSync(path.join(repo, "top.png"), PNG);
    const run = makeRun({ storage: "repo" });
    const real = fs.realpathSync(path.join(repo, "qa", "screenshots", "old", "a.png"));
    expect(screenshotFile(run, project(), "qa/screenshots/old/a.png")).toBe(real);
    expect(screenshotFile(run, { ...project(), reportsDir: undefined }, "qa/screenshots/old/a.png")).toBe(real);
    expect(screenshotFile(run, project(), "top.png")).toBeNull();
    expect(screenshotFile(run, null, "qa/screenshots/old/a.png")).toBeNull();
  });
});

describe("exportRun", () => {
  const PNG = Buffer.from("89504e470d0a1a0a", "hex");

  test("copies a data run's report and screenshots into a created folder", async () => {
    const run = makeRun({ reportPath: "report.md" });
    fs.mkdirSync(screenshotsDir(run.id), { recursive: true });
    fs.writeFileSync(path.join(runArtefactDir(run.id), "report.md"), "# r\n![a](screenshots/01.png)\n");
    fs.writeFileSync(path.join(screenshotsDir(run.id), "01.png"), PNG);
    fs.writeFileSync(path.join(screenshotsDir(run.id), "notes.txt"), "not exported");
    const dest = path.join(tmp, "out", run.id);
    const out = await exportRun(run, project(), dest);
    expect(out.report).toBe(path.join(dest, `QA-REPORT-${run.id}.md`));
    expect(out.screenshots).toEqual([path.join(dest, "screenshots", "01.png")]);
    expect(fs.readFileSync(out.report!, "utf8")).toContain("screenshots/01.png");
    expect(fs.readFileSync(out.screenshots[0]!)).toEqual(PNG);
    expect(fs.existsSync(path.join(dest, "screenshots", "notes.txt"))).toBe(false);
  });

  test("a run without a report exports its screenshots only; a legacy run keeps its screenshots folder layout", async () => {
    const empty = makeRun();
    const none = await exportRun(empty, project(), path.join(tmp, "out", "empty"));
    expect(none).toEqual({ report: null, screenshots: [] });

    fs.mkdirSync(path.join(repo, "qa", "screenshots", "legacy-run"), { recursive: true });
    fs.writeFileSync(path.join(repo, "qa", "QA-REPORT-legacy-run.md"), "# legacy\n");
    fs.writeFileSync(path.join(repo, "qa", "screenshots", "legacy-run", "01.png"), PNG);
    const legacy = makeRun({ id: "legacy-run", storage: "repo", reportPath: "qa/QA-REPORT-legacy-run.md" });
    const dest = path.join(tmp, "out", "legacy");
    const out = await exportRun(legacy, project(), dest);
    expect(out.report).toBe(path.join(dest, "QA-REPORT-legacy-run.md"));
    expect(out.screenshots).toEqual([path.join(dest, "screenshots", "legacy-run", "01.png")]);
  });
});

describe("image content check", () => {
  const PNG = Buffer.from("89504e470d0a1a0a", "hex");

  test("a .png whose content is not an image is neither served, listed nor exported", async () => {
    const run = makeRun();
    fs.mkdirSync(screenshotsDir(run.id), { recursive: true });
    fs.writeFileSync(path.join(screenshotsDir(run.id), "real.png"), PNG);
    fs.writeFileSync(path.join(screenshotsDir(run.id), "fake.png"), "<html>not an image</html>");
    fs.writeFileSync(path.join(screenshotsDir(run.id), "empty.jpg"), "");
    expect(screenshotFile(run, project(), "screenshots/fake.png")).toBeNull();
    expect(screenshotFile(run, project(), "screenshots/empty.jpg")).toBeNull();
    expect(runImages(run, project()).map((i) => i.name)).toEqual(["real.png"]);
    const out = await exportRun(run, project(), path.join(tmp, "out", `magic-${run.id}`));
    expect(out.screenshots.map((p) => path.basename(p))).toEqual(["real.png"]);
  });
});

describe("exportRun destination safety", () => {
  const PNG = Buffer.from("89504e470d0a1a0a", "hex");

  function runWithArtefacts(): Run {
    const run = makeRun({ reportPath: "report.md" });
    fs.mkdirSync(screenshotsDir(run.id), { recursive: true });
    fs.writeFileSync(path.join(runArtefactDir(run.id), "report.md"), "# r\n");
    fs.writeFileSync(path.join(screenshotsDir(run.id), "01.png"), PNG);
    return run;
  }

  test("a symlink planted at a destination is replaced, not followed", async () => {
    const run = runWithArtefacts();
    const dest = path.join(tmp, "out", `sym-${run.id}`);
    fs.mkdirSync(path.join(dest, "screenshots"), { recursive: true });
    const victim = path.join(tmp, `victim-${run.id}.txt`);
    const victimImage = path.join(tmp, `victim-${run.id}.png`);
    fs.writeFileSync(victim, "precious");
    fs.writeFileSync(victimImage, "precious image");
    fs.symlinkSync(victim, path.join(dest, `QA-REPORT-${run.id}.md`));
    fs.symlinkSync(victimImage, path.join(dest, "screenshots", "01.png"));
    const out = await exportRun(run, project(), dest);
    expect(fs.readFileSync(victim, "utf8")).toBe("precious");
    expect(fs.readFileSync(victimImage, "utf8")).toBe("precious image");
    expect(fs.lstatSync(out.report!).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(out.report!, "utf8")).toBe("# r\n");
    expect(fs.readFileSync(out.screenshots[0]!)).toEqual(PNG);
  });

  test("a symlinked screenshots folder leading outside the destination is refused and nothing is written through it", async () => {
    const run = runWithArtefacts();
    const dest = path.join(tmp, "out", `dirlink-${run.id}`);
    const elsewhere = path.join(tmp, `elsewhere-${run.id}`);
    fs.mkdirSync(dest, { recursive: true });
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, path.join(dest, "screenshots"));
    const err = await exportRun(run, project(), dest).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(400);
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });

  test("a destination that is an existing file is a 400, not a raw fs error", async () => {
    const run = runWithArtefacts();
    const dest = path.join(tmp, `file-${run.id}`);
    fs.writeFileSync(dest, "I am a file");
    const err = await exportRun(run, project(), dest).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(400);
    expect(fs.readFileSync(dest, "utf8")).toBe("I am a file");
  });

  test("a destination inside the data dir or inside a .git folder is refused with a 400 and not created", async () => {
    const run = runWithArtefacts();
    const inData = path.join(DATA_DIR, "runs", run.id, `export-${run.id}`);
    const inGit = path.join(repo, ".git", "hooks", `export-${run.id}`);
    for (const dest of [inData, inGit]) {
      const err = await exportRun(run, project(), dest).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(400);
      expect(fs.existsSync(dest)).toBe(false);
    }
    // through a symlink too
    const link = path.join(tmp, `datalink-${run.id}`);
    fs.symlinkSync(DATA_DIR, link);
    const err = await exportRun(run, project(), path.join(link, `export-${run.id}`)).catch((e: unknown) => e);
    expect((err as HttpError).status).toBe(400);
    expect(fs.existsSync(path.join(DATA_DIR, `export-${run.id}`))).toBe(false);
  });

  test("a destination containing a NUL byte is a 400", async () => {
    const run = runWithArtefacts();
    const err = await exportRun(run, project(), path.join(tmp, "out", "nul\0dir")).catch((e: unknown) => e);
    expect((err as HttpError).status).toBe(400);
  });

  test("exporting a legacy run into its own reports folder does not delete its screenshots", async () => {
    fs.mkdirSync(path.join(repo, "qa", "screenshots", "legacy-self"), { recursive: true });
    fs.writeFileSync(path.join(repo, "qa", "QA-REPORT-legacy-self.md"), "# legacy\n");
    fs.writeFileSync(path.join(repo, "qa", "screenshots", "legacy-self", "01.png"), PNG);
    const legacy = makeRun({ id: "legacy-self", storage: "repo", reportPath: "qa/QA-REPORT-legacy-self.md" });
    await exportRun(legacy, project(), path.join(repo, "qa"));
    expect(fs.readFileSync(path.join(repo, "qa", "screenshots", "legacy-self", "01.png"))).toEqual(PNG);
    expect(fs.readFileSync(path.join(repo, "qa", "QA-REPORT-legacy-self.md"), "utf8")).toBe("# legacy\n");
  });
});
