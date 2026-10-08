import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { artemisAvailable, buildReport, type DoctorCheck, type DoctorEnv } from "../src/doctor";

const MISSING = "/nonexistent/bin";

type Responder = (cmd: string[]) => { code: number; text?: string; stderr?: string } | undefined;

/** Fake command runner: every probe succeeds unless `respond` says otherwise; binaries in `missing` exit 127. */
function fakeRun(missing: readonly string[] = [], respond: Responder = () => undefined): DoctorEnv["run"] {
  return async (cmd) => {
    const out = missing.includes(cmd[0])
      ? { code: 127 }
      : (respond(cmd) ?? { code: 0, text: cmd[1] === "-list-avds" ? "AVD_A\n" : cmd[1] === "devices" ? "List of devices attached\n" : "tool 1.0.0\n" });
    const text = "text" in out ? (out.text ?? "") : "";
    return { code: out.code, text, stdout: new TextEncoder().encode(text), stderr: "stderr" in out ? (out.stderr ?? "") : "" };
  };
}

/** A fully hermetic environment: no real binary is ever spawned. */
function envWith(over: Partial<DoctorEnv>): DoctorEnv {
  return {
    ompBin: "omp",
    adbBin: "adb",
    gitBin: "git",
    ghBin: "gh",
    emulatorBin: "emulator",
    artemisPath: undefined,
    platform: "linux",
    configPath: path.join(os.tmpdir(), "tapocalypse-doctor-missing-config.json"),
    configuredAvds: [],
    projects: () => [],
    run: fakeRun(),
    ...over,
  };
}

const byId = (checks: DoctorCheck[], id: string): DoctorCheck => {
  const found = checks.find((c) => c.id === id);
  if (!found) throw new Error(`no check ${id}`);
  return found;
};

describe("buildReport", () => {
  test("every check has the contract shape and a unique id", async () => {
    const { checks } = await buildReport(envWith({}));
    expect(new Set(checks.map((c) => c.id)).size).toBe(checks.length);
    for (const c of checks) {
      expect(c.label).toBeTruthy();
      expect(["ok", "warn", "error", "skip"]).toContain(c.status);
      expect(typeof c.detail).toBe("string");
      expect(typeof c.required).toBe("boolean");
    }
    // Bun is running this test, so the Bun check cannot fail.
    expect(byId(checks, "bun").status).toBe("ok");
  });

  test("a missing omp binary is a required error with an install fix, not a throw", async () => {
    const { checks } = await buildReport(envWith({ ompBin: MISSING, run: fakeRun([MISSING]) }));
    const omp = byId(checks, "omp");
    expect(omp.status).toBe("error");
    expect(omp.required).toBe(true);
    expect(omp.fix).toContain("https://github.com/can1357/oh-my-pi");
  });

  test("missing optional binaries (git, gh) warn without failing the report", async () => {
    const { checks } = await buildReport(envWith({ gitBin: MISSING, ghBin: MISSING, run: fakeRun([MISSING]) }));
    expect(byId(checks, "git").status).toBe("warn");
    expect(byId(checks, "gh").status).toBe("warn");
    expect(byId(checks, "git").required).toBe(false);
  });

  test("a missing adb is an error only when iOS simulators are not an alternative", async () => {
    const { checks: noIos } = await buildReport(envWith({ adbBin: MISSING, platform: "linux", run: fakeRun([MISSING]) }));
    expect(byId(noIos, "adb").status).toBe("error");
    expect(byId(noIos, "xcrun").status).toBe("skip");
  });

  test("a missing emulator binary warns", async () => {
    const { checks } = await buildReport(envWith({ emulatorBin: null }));
    expect(byId(checks, "emulator").status).toBe("warn");
    const broken = await buildReport(envWith({ emulatorBin: MISSING, run: fakeRun([MISSING]) }));
    expect(byId(broken.checks, "emulator").status).toBe("warn");
  });

  test("zero projects warn with a pointer to #/projects", async () => {
    const { checks } = await buildReport(envWith({ projects: () => [] }));
    const projects = byId(checks, "projects");
    expect(projects.status).toBe("warn");
    expect(projects.fix).toContain("#/projects");
  });

  test("invalid projects are listed with their problems", async () => {
    const bad = {
      id: "broken",
      name: "Broken",
      repoPath: "/nope",
      personaFile: null,
      reportsDir: "qa",
      defaultPackage: "a.b",
      defaultPlatform: "android" as const,
      status: "invalid" as const,
      problems: ["repoPath: does not exist"],
    };
    const { checks } = await buildReport(envWith({ projects: () => [bad] }));
    const projects = byId(checks, "projects");
    expect(projects.status).toBe("warn");
    expect(projects.detail).toContain("broken");
    expect(projects.detail).toContain("repoPath: does not exist");
  });
});

describe("artemis status", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tapocalypse-doctor-"));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cases: [string, string | undefined, DoctorCheck["status"], boolean][] = [
    ["unset", undefined, "skip", false],
    ["set but missing", path.join(dir, "absent"), "error", false],
    ["set and exists", dir, "ok", true],
  ];

  for (const [name, artemisPath, status, available] of cases) {
    test(`${name} → ${status}, backends ${available ? "include" : "exclude"} artemis`, async () => {
      const report = await buildReport(envWith({ artemisPath }));
      const artemis = byId(report.checks, "artemis");
      expect(artemis.status).toBe(status);
      expect(artemis.required).toBe(false);
      expect(report.backends).toEqual(available ? ["mobile-mcp", "artemis"] : ["mobile-mcp"]);
      expect(artemisAvailable(artemisPath)).toBe(available);
    });
  }

  test("a file at artemisPath does not count as available", () => {
    const file = path.join(dir, "file.txt");
    fs.writeFileSync(file, "x");
    expect(artemisAvailable(file)).toBe(false);
  });
});
