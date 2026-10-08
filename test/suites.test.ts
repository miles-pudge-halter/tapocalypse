import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getProject } from "../src/projects/registry";
import { getSuite, listSuites, listTemplates, parseFrontmatter, saveSuite } from "../src/suites";
import { emulator, setup, settle } from "./support/scheduler-env";

const project = getProject("test-proj")!;

describe("frontmatter", () => {
  test("parses scalars, inline lists, quoted values and block lists of maps", () => {
    const { meta, body } = parseFrontmatter(
      [
        "---",
        "title: Login flow",
        'model: "anthropic/claude-x: fast"',
        "platforms: [android, 'ios']",
        "tags:",
        "  - a",
        "  - b",
        "checks:",
        "  - id: C1",
        "    title: Sign in",
        '  - id: C2',
        '    title: "Sign out: clean"',
        "---",
        "",
        "Test the login.",
        "",
      ].join("\n"),
    );
    expect(meta).toEqual({
      title: "Login flow",
      model: "anthropic/claude-x: fast",
      platforms: ["android", "ios"],
      tags: ["a", "b"],
      checks: [
        { id: "C1", title: "Sign in" },
        { id: "C2", title: "Sign out: clean" },
      ],
    });
    expect(body).toBe("Test the login.");
  });

  test("text without a closing delimiter has no frontmatter", () => {
    expect(parseFrontmatter("---\ntitle: x\nbody")).toEqual({ meta: {}, body: "---\ntitle: x\nbody" });
    expect(parseFrontmatter("just a brief")).toEqual({ meta: {}, body: "just a brief" });
  });
});

describe("suites", () => {
  test("save → get → list round-trips every field, including awkward characters", () => {
    const saved = saveSuite(project, {
      id: "round-trip",
      title: 'Checkout: "happy" path #1',
      brief: "Buy an item.\n\nUse the saved card.",
      checks: [
        { id: "C1", title: "Add to cart" },
        { id: "C2", title: "Pay: card" },
      ],
      platforms: ["android"],
      model: "anthropic/claude-opus-5-5",
    });
    expect(saved).toEqual({
      id: "round-trip",
      title: 'Checkout: "happy" path #1',
      brief: "Buy an item.\n\nUse the saved card.",
      checks: [
        { id: "C1", title: "Add to cart" },
        { id: "C2", title: "Pay: card" },
      ],
      platforms: ["android"],
      model: "anthropic/claude-opus-5-5",
    });
    expect(getSuite(project, "round-trip")).toEqual(saved);
    expect(listSuites(project).map((s) => s.id)).toContain("round-trip");
  });

  test("optional fields stay absent", () => {
    const saved = saveSuite(project, { id: "minimal", title: "Minimal", brief: "Smoke it." });
    expect(saved).toEqual({ id: "minimal", title: "Minimal", brief: "Smoke it." });
  });

  test("an existing suite is a 409 unless overwrite is set", () => {
    saveSuite(project, { id: "twice", title: "First", brief: "one" });
    expect(() => saveSuite(project, { id: "twice", title: "Second", brief: "two" })).toThrow(
      expect.objectContaining({ status: 409 }),
    );
    expect(saveSuite(project, { id: "twice", title: "Second", brief: "two", overwrite: true }).title).toBe("Second");
  });

  test("invalid input is a 400 and writes nothing", () => {
    for (const bad of [
      { id: "Bad_Id", title: "t", brief: "b" },
      { id: "../escape", title: "t", brief: "b" },
      { id: "no-title", title: " ", brief: "b" },
      { id: "dup-checks", title: "t", brief: "b", checks: [{ id: "C1", title: "a" }, { id: "C1", title: "b" }] },
    ]) {
      expect(() => saveSuite(project, bad)).toThrow(expect.objectContaining({ status: 400 }));
    }
    expect(getSuite(project, "no-title")).toBeNull();
    expect(getSuite(project, "../escape")).toBeNull();
  });

  test("a suite file edited by hand without a title falls back to its id", () => {
    const dir = path.join(project.repoPath, ".tapocalypse", "suites");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "hand-written.md"), "Only a body.\n");
    expect(getSuite(project, "hand-written")).toEqual({ id: "hand-written", title: "hand-written", brief: "Only a body." });
  });
});

describe("suite → run", () => {
  test("suiteId supplies title, brief, check ids and model; an explicit brief wins", async () => {
    saveSuite(project, {
      id: "run-suite",
      title: "Suite title",
      brief: "Suite brief",
      checks: [{ id: "C1", title: "First" }],
      platforms: ["android"],
      model: "anthropic/suite-model",
    });
    const env = setup({ devices: [emulator("emulator-5556")] });
    const run = await env.scheduler.enqueueRun({ projectId: "test-proj", suiteId: "run-suite" });
    expect(run).toMatchObject({
      title: "Suite title",
      brief: "Suite brief",
      suiteId: "run-suite",
      suiteChecks: [{ id: "C1", title: "First" }],
      model: "anthropic/suite-model",
    });
    const override = await env.scheduler.enqueueRun({ projectId: "test-proj", suiteId: "run-suite", brief: "Mine", model: "anthropic/mine" });
    expect(override).toMatchObject({ brief: "Mine", suiteId: "run-suite", model: "anthropic/mine" });
    await settle(env.scheduler);
  });

  test("unknown suites and unsupported platforms are rejected", async () => {
    saveSuite(project, { id: "android-only", title: "A", brief: "b", platforms: ["android"] });
    const env = setup();
    const unknown = await env.scheduler.enqueueRun({ projectId: "test-proj", suiteId: "nope" }).catch((e: unknown) => e);
    expect(unknown).toMatchObject({ status: 400, message: "unknown suite nope" });
    const wrongPlatform = await env.scheduler
      .enqueueRun({ projectId: "test-proj", suiteId: "android-only", device: { platform: "ios" } })
      .catch((e: unknown) => e);
    expect(wrongPlatform).toMatchObject({ status: 400, message: "suite android-only does not support ios" });
  });
});

describe("suite platforms", () => {
  const write = (id: string, platforms: string) => {
    const dir = path.join(project.repoPath, ".tapocalypse", "suites");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.md`), `---\ntitle: T\nplatforms: ${platforms}\n---\nbrief\n`);
  };

  test("a scalar, a comma list and mixed case all restrict the suite", () => {
    write("plat-scalar", "android");
    write("plat-case", "[Android, iOS]");
    write("plat-comma", "ios, android");
    expect(getSuite(project, "plat-scalar")?.platforms).toEqual(["android"]);
    expect(getSuite(project, "plat-case")?.platforms).toEqual(["android", "ios"]);
    expect(getSuite(project, "plat-comma")?.platforms).toEqual(["ios", "android"]);
  });

  test("an unknown platform is an error, not an unrestricted suite", async () => {
    write("plat-bad", "[android, windows]");
    expect(() => getSuite(project, "plat-bad")).toThrow(/unknown platform "windows"/);
    expect(listSuites(project).some((s) => s.id === "plat-bad")).toBe(false);
    const env = setup();
    const err = await env.scheduler.enqueueRun({ projectId: "test-proj", suiteId: "plat-bad" }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 400 });
  });

  test("saveSuite caps the number and title length of checks", () => {
    const many = Array.from({ length: 51 }, (_, i) => ({ id: `C${i + 1}`, title: "t" }));
    expect(() => saveSuite(project, { id: "too-many", title: "T", brief: "b", checks: many })).toThrow(/at most 50 checks/);
    expect(() => saveSuite(project, { id: "long-check", title: "T", brief: "b", checks: [{ id: "C1", title: "x".repeat(201) }] })).toThrow(
      /at most 200 characters/,
    );
  });
});

describe("templates", () => {
  test("lists markdown files with title, description and body", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tapocalypse-templates-"));
    try {
      fs.writeFileSync(path.join(dir, "smoke.md"), "---\ntitle: Smoke test\ndescription: Launch and look around\n---\nLaunch the app.\n");
      fs.writeFileSync(path.join(dir, "bare.md"), "Just a brief.\n");
      fs.writeFileSync(path.join(dir, "notes.txt"), "ignored");
      expect(listTemplates(dir)).toEqual([
        { id: "bare", title: "bare", description: "", brief: "Just a brief." },
        { id: "smoke", title: "Smoke test", description: "Launch and look around", brief: "Launch the app." },
      ]);
      expect(listTemplates(path.join(dir, "missing"))).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
