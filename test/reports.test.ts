import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Project } from "../src/projects/registry";
import {
  extractVerdict,
  listReports,
  renderReport,
  reportFilePath,
  resolveUnder,
  rewriteLinks,
} from "../src/reports/reports";

let tmp: string;
let root: string;
let outside: string;
let project: Project;

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
    expect(list.map((r) => r.name)).toEqual(["new.md", "old.md"]);
    expect(list[0]).toMatchObject({ title: "New report", verdict: "PASS WITH ISSUES" });
    expect(list[1]).toMatchObject({ title: "Old report", verdict: null });
  });

  test("missing reports dir yields empty list", () => {
    expect(listReports({ ...project, reportsDir: "nope" })).toEqual([]);
  });
});

describe("renderReport", () => {
  test("renders heading, verdict and rewritten links", () => {
    const r = renderReport(project, "new.md");
    expect(r.title).toBe("New report");
    expect(r.verdict).toBe("PASS WITH ISSUES");
    expect(r.html).toContain("<h1");
    expect(r.html).toContain('src="/files/pid/screenshots/a.png"');
    expect(r.html).toContain('href="#/p/pid/reports/old.md"');
  });

  test("rejects traversal and missing reports with 404", () => {
    for (const name of ["../secret.md", "..\\secret.md", "missing.md", "notes.txt"]) {
      expect(() => renderReport(project, name)).toThrow(expect.objectContaining({ status: 404 }));
    }
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
