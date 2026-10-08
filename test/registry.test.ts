import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONFIG_PATH, HttpError } from "../src/config";
import {
  createProject,
  deleteProject,
  getProject,
  initProjects,
  listProjects,
  projectEvents,
  resolvePersonaPath,
  updateProject,
  validateProject,
} from "../src/projects/registry";

const baseConfig = {
  port: 4399,
  maxConcurrentRuns: 2,
  runMaxTime: "10m",
  marker: { keep: "me" },
  projects: [],
  devicePool: {
    android: {
      avds: [],
      basePort: 5560,
      maxBooted: 1,
      minSize: "720x1280",
      minDensity: 320,
      idleShutdownMinutes: 20,
      excludeSerials: [],
    },
    ios: { simulators: [], idleShutdownMinutes: 20 },
  },
};

let tmp: string;
let repo: string;
let originalConfig: string;

const input = (over: Record<string, unknown> = {}) => ({
  id: "my-app",
  name: "My App",
  repoPath: repo,
  defaultPackage: "com.example.app",
  defaultPlatform: "android",
  ...over,
});

const readFileConfig = () => JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as Record<string, unknown>;

function resetConfig(projects: unknown[] = []): void {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ ...baseConfig, projects }, null, 2));
  initProjects();
}

function thrown(fn: () => unknown): HttpError {
  try {
    fn();
  } catch (e) {
    return e as HttpError;
  }
  throw new Error("expected throw");
}

beforeAll(() => {
  originalConfig = fs.readFileSync(CONFIG_PATH, "utf8");
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tapocalypse-registry-"));
  repo = path.join(tmp, "repo");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.mkdirSync(path.join(repo, "agents"));
  fs.writeFileSync(path.join(repo, "agents", "qa.md"), "---\nmodel: a/b\n---\nBody\n");
});

beforeEach(() => resetConfig());

afterAll(() => {
  fs.writeFileSync(CONFIG_PATH, originalConfig);
  initProjects();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("project CRUD", () => {
  test("create persists, preserves other config keys, and applies defaults", () => {
    let changes = 0;
    const onChange = () => changes++;
    projectEvents.on("change", onChange);
    const created = createProject(input());
    projectEvents.off("change", onChange);

    expect(created).toMatchObject({ id: "my-app", status: "ok", problems: [], personaFile: null, reportsDir: "qa" });
    expect(changes).toBe(1);
    const file = readFileConfig();
    expect(file.marker).toEqual({ keep: "me" });
    expect(file.port).toBe(4399);
    expect(file.projects).toEqual([
      {
        id: "my-app",
        name: "My App",
        repoPath: repo,
        personaFile: null,
        reportsDir: "qa",
        defaultPackage: "com.example.app",
        defaultPlatform: "android",
      },
    ]);
    expect(fs.readFileSync(CONFIG_PATH, "utf8")).toContain('\n  "projects": [\n    {');
    expect(fs.existsSync(`${CONFIG_PATH}.tmp`)).toBe(false);
    expect(getProject("my-app")?.name).toBe("My App");
  });

  test("a reloaded registry sees what was written", () => {
    createProject(input());
    initProjects();
    expect(listProjects().map((p) => p.id)).toEqual(["my-app"]);
  });

  test("duplicate id is 409", () => {
    createProject(input());
    expect(thrown(() => createProject(input({ name: "Other" })))).toMatchObject({
      status: 409,
      message: "project my-app already exists",
    });
  });

  test("create expands ~ in repoPath before storing", () => {
    const rel = path.relative(os.homedir(), repo);
    if (rel.startsWith("..")) return; // temp dir outside $HOME on this host
    const created = createProject(input({ repoPath: `~/${rel}` }));
    expect(created.repoPath).toBe(repo);
  });

  test("update patches fields, keeps the rest, and persists", () => {
    createProject(input());
    const updated = updateProject("my-app", { name: "Renamed", personaFile: "agents/qa.md", reportsDir: "docs/qa" });
    expect(updated).toMatchObject({ name: "Renamed", personaFile: "agents/qa.md", reportsDir: "docs/qa", defaultPackage: "com.example.app" });
    expect((readFileConfig().projects as { name: string }[])[0]!.name).toBe("Renamed");
    expect(updateProject("my-app", { personaFile: null }).personaFile).toBeNull();
  });

  test("update cannot change the id, and unknown ids are 404", () => {
    createProject(input());
    expect(thrown(() => updateProject("my-app", { id: "other" }))).toMatchObject({ status: 400 });
    expect(thrown(() => updateProject("nope", { name: "x" }))).toMatchObject({ status: 404 });
    expect(updateProject("my-app", { id: "my-app", name: "Same id ok" }).name).toBe("Same id ok");
  });

  test("a failed update leaves the file and registry untouched", () => {
    createProject(input());
    const before = fs.readFileSync(CONFIG_PATH, "utf8");
    expect(thrown(() => updateProject("my-app", { defaultPackage: "nope" }))).toMatchObject({ status: 400 });
    expect(fs.readFileSync(CONFIG_PATH, "utf8")).toBe(before);
    expect(getProject("my-app")?.defaultPackage).toBe("com.example.app");
  });

  test("delete removes the project; active runs block it with 409", () => {
    createProject(input());
    expect(thrown(() => deleteProject("my-app", ["run-1", "run-2"]))).toMatchObject({
      status: 409,
      message: "project my-app has active runs: run-1, run-2",
    });
    expect(getProject("my-app")).toBeDefined();
    deleteProject("my-app", []);
    expect(getProject("my-app")).toBeUndefined();
    expect(readFileConfig().projects).toEqual([]);
    expect(readFileConfig().marker).toEqual({ keep: "me" });
    expect(thrown(() => deleteProject("my-app", []))).toMatchObject({ status: 404 });
  });
});

describe("validation", () => {
  const errorsFor = (over: Record<string, unknown>) => validateProject(input(over), "create").errors;

  test("a valid input has no errors", () => {
    expect(validateProject(input(), "create")).toMatchObject({ ok: true, errors: {} });
  });

  test("id format", () => {
    expect(errorsFor({ id: "Bad_Id" }).id).toBeDefined();
    expect(errorsFor({ id: "-lead" }).id).toBeDefined();
    expect(errorsFor({ id: "a".repeat(41) }).id).toBeDefined();
    expect(errorsFor({ id: "a".repeat(40) }).id).toBeUndefined();
  });

  test("id uniqueness is a create-mode error", () => {
    createProject(input());
    expect(errorsFor({}).id).toContain("already exists");
    expect(validateProject(input(), "update", "my-app").errors.id).toBeUndefined();
  });

  test("name length 1-60", () => {
    expect(errorsFor({ name: "  " }).name).toBeDefined();
    expect(errorsFor({ name: "x".repeat(61) }).name).toBeDefined();
    expect(errorsFor({ name: "x".repeat(60) }).name).toBeUndefined();
  });

  test("repoPath must be absolute, existing, and a directory", () => {
    expect(errorsFor({ repoPath: "relative/dir" }).repoPath).toContain("absolute");
    expect(errorsFor({ repoPath: path.join(tmp, "missing") }).repoPath).toContain("does not exist");
    expect(errorsFor({ repoPath: path.join(repo, "agents", "qa.md") }).repoPath).toContain("not a directory");
  });

  test("personaFile must be relative, inside the repo, existing", () => {
    expect(errorsFor({ personaFile: path.join(repo, "agents", "qa.md") }).personaFile).toContain("relative");
    expect(errorsFor({ personaFile: "../outside.md" }).personaFile).toContain("inside");
    expect(errorsFor({ personaFile: "agents/missing.md" }).personaFile).toContain("does not exist");
    expect(errorsFor({ personaFile: "agents/qa.md" }).personaFile).toBeUndefined();
    expect(errorsFor({ personaFile: null }).personaFile).toBeUndefined();
  });

  test("reportsDir must be relative with no .. segments", () => {
    expect(errorsFor({ reportsDir: "/abs" }).reportsDir).toContain("relative");
    expect(errorsFor({ reportsDir: "a/../b" }).reportsDir).toContain("..");
    expect(errorsFor({ reportsDir: "docs/qa" }).reportsDir).toBeUndefined();
  });

  test("defaultPackage and defaultPlatform", () => {
    expect(errorsFor({ defaultPackage: "nodots" }).defaultPackage).toBeDefined();
    expect(errorsFor({ defaultPackage: "1bad.pkg" }).defaultPackage).toBeDefined();
    expect(errorsFor({ defaultPackage: "com.example.shop.dev" }).defaultPackage).toBeUndefined();
    expect(errorsFor({ defaultPlatform: "windows" }).defaultPlatform).toBeDefined();
  });

  test("non-object input never throws and flags the required fields", () => {
    const r = validateProject("garbage", "create");
    expect(r.ok).toBe(false);
    expect(Object.keys(r.errors).sort()).toEqual(["defaultPackage", "defaultPlatform", "id", "name", "repoPath"]);
  });

  test("create surfaces the first error as `field: message` with 400", () => {
    expect(thrown(() => createProject(input({ id: "BAD", name: "" })))).toMatchObject({
      status: 400,
      message: expect.stringMatching(/^id: /),
    });
  });

  test("warnings: non-git repo and missing reports dir", () => {
    const plain = path.join(tmp, "plain");
    fs.mkdirSync(plain);
    const w = validateProject(input({ repoPath: plain }), "create").warnings.join("\n");
    expect(w).toContain("Not a git repository");
    expect(w).toContain("qa/ does not exist yet");
    expect(validateProject(input(), "create").warnings.join("\n")).not.toContain("Not a git repository");
  });

  test("update-mode validation fills unspecified fields from the existing project", () => {
    createProject(input());
    expect(validateProject({ name: "Only name" }, "update", "my-app")).toMatchObject({ ok: true });
    expect(validateProject({ id: "other" }, "update", "my-app").errors.id).toContain("cannot be changed");
  });
});

describe("invalid projects on disk", () => {
  test("are listed with problems but not returned by getProject", () => {
    resetConfig([
      { ...input({ id: "good" }) },
      { ...input({ id: "gone", repoPath: path.join(tmp, "missing") }) },
    ]);
    const list = listProjects();
    expect(list.map((p) => [p.id, p.status])).toEqual([
      ["good", "ok"],
      ["gone", "invalid"],
    ]);
    expect(list[1]!.problems[0]).toContain("repoPath: does not exist");
    expect(getProject("gone")).toBeUndefined();
    expect(getProject("good")).toBeDefined();
  });

  test("a persona deleted after startup flips the project to invalid", () => {
    const persona = path.join(repo, "agents", "temp.md");
    fs.writeFileSync(persona, "Body\n");
    createProject(input({ personaFile: "agents/temp.md" }));
    expect(getProject("my-app")).toBeDefined();
    fs.rmSync(persona);
    expect(getProject("my-app")).toBeUndefined();
    expect(listProjects()[0]!.problems[0]).toContain("personaFile");
  });

  test("invalid entries survive a mutation of another project untouched", () => {
    const bad = { id: "legacy", name: "Legacy", repoPath: path.join(tmp, "missing"), personaFile: "x.md", defaultPackage: "a.b", defaultPlatform: "android" };
    resetConfig([bad]);
    createProject(input());
    expect((readFileConfig().projects as unknown[])[0]).toEqual(bad);
  });

  test("duplicate ids: only the first is usable", () => {
    resetConfig([input(), input({ name: "Dupe" })]);
    const list = listProjects();
    expect(list.map((p) => p.status)).toEqual(["ok", "invalid"]);
    expect(getProject("my-app")?.name).toBe("My App");
  });
});

describe("resolvePersonaPath", () => {
  test("null persona resolves to the bundled default, which exists", () => {
    const p = createProject(input());
    const resolved = resolvePersonaPath(p);
    expect(path.basename(resolved)).toBe("default-mobile-qa.md");
    expect(fs.readFileSync(resolved, "utf8")).toContain("QA");
  });

  test("custom persona resolves inside the repo", () => {
    const p = createProject(input({ personaFile: "agents/qa.md" }));
    expect(resolvePersonaPath(p)).toBe(path.join(repo, "agents", "qa.md"));
  });
});
