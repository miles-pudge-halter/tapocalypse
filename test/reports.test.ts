import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DATA_DIR } from "../src/config";
import type { Project } from "../src/projects/registry";
import {
  extractVerdict,
  listReports,
  renderReport,
  reportFilePath,
  resolveUnder,
  rewriteLinks,
} from "../src/reports/reports";
import { runArtefactDir } from "../src/runs/artefacts";
import { createRun, deleteRun } from "../src/runs/store";
import type { Run } from "../src/runs/types";

let tmp: string;
let root: string;
let outside: string;
let project: Project;
const RUN_ID = "20260101-120000-abcd-reports-test";

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tapocalypse-reports-")));
  root = path.join(tmp, "repo");
  outside = path.join(tmp, "outside");
  fs.mkdirSync(path.join(root, "qa", "screenshots"), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
  fs.writeFileSync(path.join(root, "secret.md"), "# Secret\n");
  fs.writeFileSync(path.join(root, "qa", "screenshots", "a.png"), "png");
  fs.writeFileSync(path.join(root, "qa", "notes.sh"), "echo");
  fs.symlinkSync(outside, path.join(root, "qa", "link"));
  fs.writeFileSync(path.join(root, "qa", "old.md"), "# Old report\n\nNo verdict here.\n");
  fs.writeFileSync(
    path.join(root, "qa", "new.md"),
    "# New report\n\n**Verdict: PASS WITH ISSUES — two nits**\n\n![shot](screenshots/a.png)\n\n[old](old.md)\n",
  );
  fs.writeFileSync(
    path.join(root, "qa", "hostile.md"),
    [
      "# **Hostile** `report`",
      "",
      "<script>alert(1)</script>",
      '<img src="shots/x.png" onerror="alert(1)">',
      '<iframe src="https://evil.example"></iframe>',
      "<style>body{display:none}</style>",
      '<a href="javascript:alert(1)">js</a> <a href="https://ok.example">ok</a>',
      '<p onclick="x()" style="color:red">text</p>',
      "",
      "## Summary",
      "## Summary",
      "### Café & Co",
      '<h2 id="root" onclick="x()">Mine</h2>',
      "",
      "- [x] done",
      "",
      "![shot](shots/a.png)",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(root, "qa", `QA-REPORT-${RUN_ID}.md`), "# Run report\n\n## Findings\n");
  fs.writeFileSync(path.join(root, "qa", "QA-REPORT-20200101-000000-dead-gone.md"), "# Gone run\n");
  fs.mkdirSync(path.join(DATA_DIR, "runs", RUN_ID), { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, "runs", RUN_ID, "run.json"), JSON.stringify({ id: RUN_ID, projectId: "pid", createdAt: "2026-01-01T12:00:00.000Z", checks: [] }));
  fs.utimesSync(path.join(root, "qa", "old.md"), new Date(2020, 0, 1), new Date(2020, 0, 1));
  project = {
    id: "pid",
    name: "P",
    repoPath: root,
    personaFile: ".omp/agents/x.md",
    reportsDir: "qa",
    defaultPackage: "x.y",
    defaultPlatform: "android",
  };
});

afterAll(() => {
  fs.rmSync(path.join(DATA_DIR, "runs", RUN_ID), { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("resolveUnder", () => {
  test("accepts nested inside path, existing or not", () => {
    expect(resolveUnder(root, "qa/screenshots/a.png")).toBe(path.join(root, "qa", "screenshots", "a.png"));
    expect(resolveUnder(root, "qa/new-file.md")).toBe(path.join(root, "qa", "new-file.md"));
  });

  test("rejects traversal, outside absolute paths, empty and NUL", () => {
    expect(resolveUnder(root, "../x")).toBeNull();
    expect(resolveUnder(root, "qa/../../outside/secret.txt")).toBeNull();
    expect(resolveUnder(root, path.join(outside, "secret.txt"))).toBeNull();
    expect(resolveUnder(root, "")).toBeNull();
    expect(resolveUnder(root, "qa/a\0.png")).toBeNull();
  });

  test("rejects an inside symlink pointing outside", () => {
    expect(resolveUnder(root, "qa/link/secret.txt")).toBeNull();
    expect(resolveUnder(root, "qa/link")).toBeNull();
  });

  test("a file with several hard links stays at the path asked for, whichever link the OS names", () => {
    // The hub stores uploaded artefacts as hard links of one blob: macOS answers a realpath of such a file with any of its links.
    const dir = path.join(tmp, "hard");
    fs.mkdirSync(path.join(dir, "run"), { recursive: true });
    fs.writeFileSync(path.join(dir, "blob"), "blob");
    for (let i = 0; i < 100; i++) fs.linkSync(path.join(dir, "blob"), path.join(dir, "run", `r${i}.md`));
    for (let i = 0; i < 100; i++) expect(resolveUnder(path.join(dir, "run"), `r${i}.md`)).toBe(path.join(dir, "run", `r${i}.md`));
  });

  test("a symlink to a file is judged by its target", () => {
    const dir = path.join(tmp, "links");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "inside.png"), "png");
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(dir, "to-outside.txt"));
    fs.symlinkSync(path.join(dir, "inside.png"), path.join(dir, "to-inside.png"));
    expect(resolveUnder(dir, "to-outside.txt")).toBeNull();
    expect(resolveUnder(dir, "to-inside.png")).toBe(path.join(dir, "inside.png"));
  });
});

describe("extractVerdict", () => {
  test("parses verdicts", () => {
    expect(extractVerdict("**Verdict: PASS WITH ISSUES — two nits**")).toBe("PASS WITH ISSUES");
    expect(extractVerdict("Verdict: FAIL")).toBe("FAIL");
    expect(extractVerdict("**Verdict:** pass")).toBe("PASS");
    expect(extractVerdict("nothing to see")).toBeNull();
  });
});

describe("rewriteLinks", () => {
  test("rewrites relative links, leaves absolute ones", () => {
    const out = rewriteLinks(
      '<img src="screenshots/a/01.png"><a href="x.md">x</a><a href="https://e.com">e</a><a href="#top">t</a><img src="/files/pid/z.png"><a href="../../etc/passwd">p</a>',
      "pid",
    );
    expect(out).toContain('src="/files/pid/screenshots/a/01.png"');
    expect(out).toContain('href="#/p/pid/reports/x.md"');
    expect(out).toContain('href="https://e.com"');
    expect(out).toContain('href="#top"');
    expect(out).toContain('src="/files/pid/z.png"');
    expect(out).toContain('href="../../etc/passwd"');
  });

  test("keeps fragment on md links and normalizes ./ prefixes", () => {
    const out = rewriteLinks('<a href="./x.md#sec">x</a><img src="./s/a.png">', "pid");
    expect(out).toContain('href="#/p/pid/reports/x.md#sec"');
    expect(out).toContain('src="/files/pid/s/a.png"');
  });
});

describe("listReports", () => {
  test("lists top-level md newest first with title and verdict", () => {
    const list = listReports(project);
    expect(list.map((r) => r.name).filter((n) => ["new.md", "old.md"].includes(n))).toEqual(["new.md", "old.md"]);
    expect(list.find((r) => r.name === "new.md")).toMatchObject({ title: "New report", verdict: "PASS WITH ISSUES" });
    expect(list.find((r) => r.name === "old.md")).toMatchObject({ title: "Old report", verdict: null });
  });

  test("runId is set only when QA-REPORT-<runId>.md names a run that exists in this project", () => {
    const byName = Object.fromEntries(listReports(project).map((r) => [r.name, r.runId]));
    expect(byName[`QA-REPORT-${RUN_ID}.md`]).toBe(RUN_ID);
    expect(byName["QA-REPORT-20200101-000000-dead-gone.md"]).toBeNull();
    expect(byName["new.md"]).toBeNull();
    expect(listReports({ ...project, id: "other" }).find((r) => r.name === `QA-REPORT-${RUN_ID}.md`)?.runId).toBeNull();
  });

  test("titles are plain text", () => {
    expect(listReports(project).find((r) => r.name === "hostile.md")?.title).toBe("Hostile report");
  });

  test("missing reports dir yields empty list", () => {
    expect(listReports({ ...project, reportsDir: "nope" })).toEqual([]);
  });
});

describe("renderReport", () => {
  test("renders verdict and rewritten links; the h1 that repeats the title is dropped", () => {
    const r = renderReport(project, "new.md");
    expect(r.title).toBe("New report");
    expect(r.verdict).toBe("PASS WITH ISSUES");
    expect(r.html).not.toContain("<h1");
    expect(r.html).toContain('src="/files/pid/screenshots/a.png"');
    expect(r.html).toContain('href="#/p/pid/reports/old.md"');
  });

  test("hostile raw HTML is reduced to inert markdown output", () => {
    const { html } = renderReport(project, "hostile.md");
    for (const bad of ["<script", "alert(1)</", "onerror", "onclick", "<iframe", "<style", "display:none", "javascript:", "style="]) {
      expect(html).not.toContain(bad);
    }
    expect(html).toContain('href="https://ok.example"');
    expect(html).toContain('<input type="checkbox" disabled="disabled" checked="checked" />');
    expect(html).toContain('src="/files/pid/shots/x.png"');
  });

  test("external images become their alt text; relative images stay", () => {
    fs.writeFileSync(
      path.join(root, "qa", "external.md"),
      '# E\n\n![remote](https://evil.example/x.png)\n\n<img src="//evil.example/y.png">\n\n![local](shots/a.png)\n',
    );
    const r = renderReport(project, "external.md");
    expect(r.html).not.toContain("evil.example");
    expect(r.html).toContain("[image: remote]");
    expect(r.images).toEqual([{ src: "/files/pid/shots/a.png", alt: "local" }]);
  });

  test("an h1 that differs from the title is kept", () => {
    fs.writeFileSync(path.join(root, "qa", "two-h1.md"), "# Title\n\n# Another\n");
    const { html } = renderReport(project, "two-h1.md");
    expect(html).not.toContain(">Title<");
    expect(html).toContain('<h1 id="another">Another</h1>');
  });

  test("headings get unique slug ids and h2/h3 feed the table of contents; author ids are stripped", () => {
    const r = renderReport(project, "hostile.md");
    expect(r.headings).toEqual([
      { level: 2, id: "summary", text: "Summary" },
      { level: 2, id: "summary-2", text: "Summary" },
      { level: 3, id: "cafe-co", text: "Café & Co" },
      { level: 2, id: "mine", text: "Mine" },
    ]);
    expect(r.html).toContain('<h3 id="cafe-co">');
    expect(r.html).not.toContain('id="root"');
  });

  test("images lists every rendered image with its rewritten src and alt", () => {
    expect(renderReport(project, "hostile.md").images).toEqual([
      { src: "/files/pid/shots/x.png", alt: "" },
      { src: "/files/pid/shots/a.png", alt: "shot" },
    ]);
  });

  test("runId links a QA-REPORT file to its run", () => {
    expect(renderReport(project, `QA-REPORT-${RUN_ID}.md`).runId).toBe(RUN_ID);
    expect(renderReport(project, "new.md").runId).toBeNull();
  });

  test("rejects traversal and missing reports with 404", () => {
    for (const name of ["../secret.md", "..\\secret.md", "missing.md", "notes.txt"]) {
      expect(() => renderReport(project, name)).toThrow(expect.objectContaining({ status: 404 }));
    }
  });
});

describe("reports of runs stored in the data dir", () => {
  const dataProject = (): Project => ({ ...project, id: "pid-data" });
  const created: string[] = [];

  function dataRun(md: string | null, over: Partial<Run> = {}): Run {
    const run = createRun({
      projectId: "pid-data",
      title: "Data run",
      brief: "b",
      requestedBy: "test",
      deviceRequest: { platform: "android" },
      deviceSerial: null,
      bootedByRun: false,
      packageId: "com.x",
      status: "done",
      verdict: "PASS",
      summary: "s",
      reportPath: md === null ? null : "report.md",
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
    if (md !== null) fs.writeFileSync(path.join(runArtefactDir(run.id), "report.md"), md);
    return run;
  }

  afterAll(() => {
    for (const id of created) deleteRun(id);
  });

  test("listReports merges data runs (named by run id) with the legacy folder, newest first", () => {
    const withReport = dataRun("# Data report\n\n**Verdict: FAIL**\n", { title: "Data report", verdict: "FAIL" });
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(runArtefactDir(withReport.id), "report.md"), later, later);
    fs.writeFileSync(path.join(root, "qa", "legacy-only.md"), "# Legacy only\n");
    const list = listReports(dataProject());
    expect(list[0]).toMatchObject({
      name: withReport.id,
      title: "Data report",
      verdict: "FAIL",
      runId: withReport.id,
      path: path.join(runArtefactDir(withReport.id), "report.md"),
    });
    expect(list.map((r) => r.name)).toContain("legacy-only.md");
    expect(list.find((r) => r.name === "legacy-only.md")).toMatchObject({ runId: null, path: path.join(root, "qa", "legacy-only.md") });
  });

  test("runs without a stored report, legacy-storage runs and other projects' runs are not listed", () => {
    const none = dataRun(null);
    const noFile = dataRun("# gone\n");
    fs.rmSync(path.join(runArtefactDir(noFile.id), "report.md"));
    const legacy = dataRun("# legacy storage\n", { storage: "repo" });
    const other = dataRun("# other\n", { projectId: "someone-else" });
    const names = listReports(dataProject()).map((r) => r.name);
    for (const run of [none, noFile, legacy, other]) expect(names).not.toContain(run.id);
  });

  test("a data report's title and verdict come from the run record, not from the markdown", () => {
    const run = dataRun("# Heading in the file\n\n**Verdict: FAIL**\n", { title: "Checkout flow", verdict: "BLOCKED" });
    expect(listReports(dataProject()).find((r) => r.name === run.id)).toMatchObject({ title: "Checkout flow", verdict: "BLOCKED" });
  });

  test("a run without a title is listed under the first heading of its report", () => {
    const run = dataRun("Intro line\n\n# **Real** title\n\nbody\n", { title: "", verdict: null });
    expect(listReports(dataProject()).find((r) => r.name === run.id)).toMatchObject({ title: "Real title", verdict: null });
    const bare = dataRun("No heading at all.\n", { title: "" });
    expect(listReports(dataProject()).find((r) => r.name === bare.id)?.title).toBe(bare.id);
  });

  test("renderReport takes a run id and serves its images from the run's files route", () => {
    const run = dataRun("# Shots\n\n**Verdict: PASS**\n\n![home](screenshots/01-home.png)\n\n[other](other.md)\n");
    const r = renderReport(dataProject(), run.id);
    expect(r).toMatchObject({ name: run.id, title: "Shots", verdict: "PASS", runId: run.id });
    expect(r.path).toBe(fs.realpathSync(path.join(runArtefactDir(run.id), "report.md")));
    expect(r.images).toEqual([{ src: `/api/runs/${run.id}/files/screenshots/01-home.png`, alt: "home" }]);
    expect(r.html).not.toContain("/files/pid-data/");
  });

  test("renderReport rejects unknown run ids, runs of another project and runs without a report", () => {
    const mine = dataRun(null);
    const foreign = dataRun("# f\n", { projectId: "someone-else" });
    for (const name of ["20200101-000000-dead-nothing", mine.id, foreign.id, "..", "a/b"]) {
      expect(() => renderReport(dataProject(), name)).toThrow(expect.objectContaining({ status: 404 }));
    }
  });

  test("rewriteLinks points a data run's images at its run files route and leaves legacy links alone", () => {
    const html = '<img src="screenshots/a b.png"><a href="screenshots/../../etc/passwd">p</a><a href="https://e.com">e</a>';
    const out = rewriteLinks(html, "pid", "run-1");
    expect(out).toContain('src="/api/runs/run-1/files/screenshots/a%20b.png"');
    expect(out).toContain('href="screenshots/../../etc/passwd"');
    expect(out).toContain('href="https://e.com"');
    expect(rewriteLinks('<img src="screenshots/a.png">', "pid")).toContain('src="/files/pid/screenshots/a.png"');
  });
});

describe("reportFilePath", () => {
  test("serves allowlisted existing files only", () => {
    expect(reportFilePath(project, "screenshots/a.png")).toBe(path.join(root, "qa", "screenshots", "a.png"));
    fs.writeFileSync(path.join(root, "qa", "screenshots", "b.PNG"), "png");
    expect(reportFilePath(project, "screenshots/b.PNG")).toBe(path.join(root, "qa", "screenshots", "b.PNG"));
  });

  test("rejects disallowed extension, traversal, symlink escape and missing files", () => {
    expect(reportFilePath(project, "notes.sh")).toBeNull();
    expect(reportFilePath(project, "new.md")).toBeNull();
    expect(reportFilePath(project, "../secret.md")).toBeNull();
    expect(reportFilePath(project, "link/secret.txt")).toBeNull();
    expect(reportFilePath(project, "screenshots/missing.png")).toBeNull();
  });
});
