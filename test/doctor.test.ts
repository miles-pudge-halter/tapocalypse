import { describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { buildReport, type DoctorCheck, type DoctorEnv } from "../src/doctor";
import { getHarness } from "../src/harness";
import { HARNESS_IDS, type HarnessId, MOBILE_MCP_VERSION } from "../src/harness/types";

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
    harnessBins: { omp: "omp", claude: "claude", codex: "codex" },
    configuredHarness: "omp",
    harness: getHarness,
    adbBin: "adb",
    gitBin: "git",
    ghBin: "gh",
    emulatorBin: "emulator",
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

  test("the team-hub rows come from the laptop hub checks, after the others, and a throwing probe is an error row", async () => {
    const row: DoctorCheck = { id: "hub", label: "Team hub", status: "skip", detail: "not connected (optional)", required: false };
    const { checks } = await buildReport(envWith({ hubChecks: async () => [row] }));
    expect(checks.at(-1)).toEqual(row);
    const broken = await buildReport(envWith({ hubChecks: async () => Promise.reject(new Error("boom")) }));
    expect(broken.checks.at(-1)).toMatchObject({ id: "hub", status: "error", required: false, detail: "boom" });
  });

  test("a missing omp binary is a required error with an install fix, not a throw", async () => {
    const { checks } = await buildReport(envWith({ harnessBins: { omp: MISSING, claude: "claude", codex: "codex" }, run: fakeRun([MISSING]) }));
    const omp = byId(checks, "omp");
    expect(omp.status).toBe("error");
    expect(omp.required).toBe(true);
    expect(omp.fix).toContain("https://github.com/can1357/oh-my-pi");
  });

  test("omp and Codex that are missing or signed out only warn while another harness is selected, and error once selected", async () => {
    const signedOut: Responder = (cmd) => (cmd[1] === "login" ? { code: 1, text: "Not logged in" } : undefined);
    const absent = { harnessBins: { omp: MISSING, claude: "claude", codex: MISSING }, run: fakeRun([MISSING], signedOut) };
    const elsewhere = await buildReport(envWith({ ...absent, configuredHarness: "claude" }));
    for (const id of ["omp", "codex"]) expect(byId(elsewhere.checks, id).status).toBe("warn");
    for (const id of ["omp", "codex"] as const) {
      const selected = await buildReport(envWith({ ...absent, configuredHarness: id }));
      expect(byId(selected.checks, id).status).toBe("error");
    }

    const present = { run: fakeRun([], signedOut) };
    expect(byId((await buildReport(envWith({ ...present, configuredHarness: "claude" }))).checks, "codex-auth").status).toBe("warn");
    expect(byId((await buildReport(envWith({ ...present, configuredHarness: "codex" }))).checks, "codex-auth").status).toBe("error");
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

describe("omp sign-in", () => {
  const models = (list: unknown[]): Responder => (cmd) => (cmd[1] === "models" ? { code: 0, text: JSON.stringify({ models: list }) } : undefined);

  test("signed in: at least one model listed", async () => {
    const { checks } = await buildReport(envWith({ run: fakeRun([], models([{ id: "m" }, { id: "n" }])) }));
    const auth = byId(checks, "omp-auth");
    expect(auth.status).toBe("ok");
    expect(auth.required).toBe(true);
  });

  test("not signed in: an empty model list is an error with `omp login` when omp is selected, a warning otherwise", async () => {
    const { checks } = await buildReport(envWith({ run: fakeRun([], models([])) }));
    const auth = byId(checks, "omp-auth");
    expect(auth.status).toBe("error");
    expect(auth.fix).toContain("omp login");
    const other = await buildReport(envWith({ configuredHarness: "claude", run: fakeRun([], models([])) }));
    expect(byId(other.checks, "omp-auth").status).toBe("warn");
  });

  test("a failing or garbled `omp models` warns instead of throwing", async () => {
    const failing = await buildReport(envWith({ run: fakeRun([], (cmd) => (cmd[1] === "models" ? { code: 1, stderr: "boom" } : undefined)) }));
    expect(byId(failing.checks, "omp-auth").status).toBe("warn");
    expect(byId(failing.checks, "omp-auth").detail).toContain("boom");
    const garbled = await buildReport(envWith({ run: fakeRun([], (cmd) => (cmd[1] === "models" ? { code: 0, text: "not json" } : undefined)) }));
    expect(byId(garbled.checks, "omp-auth").status).toBe("warn");
  });

  test("is skipped when omp itself is missing, and never shells out to omp then", async () => {
    const calls: string[][] = [];
    const base = fakeRun([MISSING]);
    const run: DoctorEnv["run"] = (cmd) => {
      calls.push(cmd);
      return base(cmd);
    };
    const { checks } = await buildReport(envWith({ harnessBins: { omp: MISSING, claude: "claude", codex: "codex" }, run }));
    expect(byId(checks, "omp-auth").status).toBe("skip");
    expect(calls.some((c) => c[1] === "models")).toBe(false);
  });
});

describe("node check", () => {
  test("the fix names the pinned mobile-mcp version Tapocalypse really starts, not a moving tag", async () => {
    const { checks } = await buildReport(envWith({ run: fakeRun(["npx"]) }));
    const node = byId(checks, "node");
    expect(node.status).toBe("error");
    expect(node.fix).toContain(`@mobilenext/mobile-mcp@${MOBILE_MCP_VERSION}`);
    expect(node.fix).not.toContain("@latest");
  });
});

describe("operating system", () => {
  test.each([
    ["darwin", "ok"],
    ["linux", "ok"],
    ["win32", "error"],
    ["freebsd", "warn"],
  ] as const)("%s → %s", async (platform, status) => {
    const { checks } = await buildReport(envWith({ platform: platform as NodeJS.Platform }));
    const os = byId(checks, "os");
    expect(os.status).toBe(status);
    expect(os.required).toBe(true);
  });
});

describe("agent runtimes", () => {
  type Fake = { installed: boolean; signedIn?: boolean };

  /** Fake adapters: `<id>` / `<id>-auth` rows reflect the scenario and echo the `selected` flag they were given. */
  function fakeHarnesses(scenario: Record<HarnessId, Fake>, seen: Partial<Record<HarnessId, { bin: string; selected: boolean }>> = {}): DoctorEnv["harness"] {
    return (id) => ({
      label: `Label ${id}`,
      doctor: async (env) => {
        seen[id] = { bin: env.bin, selected: env.selected };
        const s = scenario[id];
        return [
          { id, label: id, status: s.installed ? "ok" : "error", detail: "", required: env.selected },
          { id: `${id}-auth`, label: `${id} auth`, status: !s.installed ? "skip" : s.signedIn ? "ok" : "warn", detail: "", required: env.selected },
        ];
      },
    });
  }

  const none: Record<HarnessId, Fake> = { omp: { installed: false }, claude: { installed: false }, codex: { installed: false } };

  test("every harness is probed with its own bin; only the configured one is selected", async () => {
    const seen: Partial<Record<HarnessId, { bin: string; selected: boolean }>> = {};
    const bins = { omp: "omp-x", claude: "claude-x", codex: "codex-x" };
    await buildReport(envWith({ harnessBins: bins, configuredHarness: "claude", harness: fakeHarnesses(none, seen) }));
    expect(seen).toEqual({
      omp: { bin: "omp-x", selected: false },
      claude: { bin: "claude-x", selected: true },
      codex: { bin: "codex-x", selected: false },
    });
  });

  test("agent-runtime is ok and names every installed, signed-in harness", async () => {
    const { checks } = await buildReport(
      envWith({
        configuredHarness: undefined,
        harness: fakeHarnesses({ omp: { installed: false }, claude: { installed: true, signedIn: true }, codex: { installed: true, signedIn: true } }),
      }),
    );
    const runtime = byId(checks, "agent-runtime");
    expect(runtime.status).toBe("ok");
    expect(runtime.required).toBe(true);
    expect(runtime.detail).toContain("Label claude");
    expect(runtime.detail).toContain("Label codex");
    expect(runtime.detail).not.toContain("Label omp");
  });

  test("agent-runtime warns when a harness is installed but not signed in, and errors with install links when none is", async () => {
    const unsigned = await buildReport(envWith({ harness: fakeHarnesses({ ...none, codex: { installed: true, signedIn: false } }) }));
    expect(byId(unsigned.checks, "agent-runtime").status).toBe("warn");

    const { checks } = await buildReport(envWith({ harness: fakeHarnesses(none) }));
    const runtime = byId(checks, "agent-runtime");
    expect(runtime.status).toBe("error");
    expect(runtime.required).toBe(true);
    expect(runtime.fix).toContain("https://github.com/can1357/oh-my-pi");
    expect(runtime.fix).toMatch(/Claude Code/);
    expect(runtime.fix).toMatch(/Codex/);
  });

  test("with no configured harness the first ready one is the required one, so a Codex-only machine is not blocked by omp", async () => {
    const { checks } = await buildReport(
      envWith({ configuredHarness: undefined, harness: fakeHarnesses({ ...none, codex: { installed: true, signedIn: true } }) }),
    );
    for (const id of HARNESS_IDS) {
      expect(byId(checks, id).required).toBe(id === "codex");
      expect(byId(checks, `${id}-auth`).required).toBe(id === "codex");
    }
    expect(byId(checks, "agent-runtime").status).toBe("ok");
  });

  test("a configured harness stays required even when another one is ready", async () => {
    const { checks } = await buildReport(
      envWith({ configuredHarness: "claude", harness: fakeHarnesses({ ...none, codex: { installed: true, signedIn: true } }) }),
    );
    expect(byId(checks, "claude").required).toBe(true);
    expect(byId(checks, "claude").status).toBe("error");
    expect(byId(checks, "codex").required).toBe(false);
  });

  test("a throwing adapter becomes an error row instead of failing the report", async () => {
    const boom: DoctorEnv["harness"] = (id) => ({
      label: id,
      doctor: async () => {
        throw new Error("probe exploded");
      },
    });
    const { checks } = await buildReport(envWith({ harness: boom }));
    expect(byId(checks, "omp").status).toBe("error");
    expect(byId(checks, "omp").detail).toContain("probe exploded");
    expect(byId(checks, "agent-runtime").status).toBe("error");
  });
});
