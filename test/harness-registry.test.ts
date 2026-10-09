import { beforeEach, describe, expect, test } from "bun:test";
import type { ExecResult } from "../src/devices/devices";
import { detectInstalled, detectReadiness, getHarness, harnessBin, resetProbeCache, resolveHarness, resolveHarnessId } from "../src/harness";
import { HARNESS_IDS, type Harness, type HarnessId } from "../src/harness/types";

const result = (code: number): ExecResult => ({ code, stdout: new Uint8Array(), text: "", stderr: "" });

beforeEach(resetProbeCache);

describe("resolveHarnessId", () => {
  test("run request > project > persona > config", () => {
    const all = { run: "codex", project: "claude", persona: "omp", config: "claude" } as const;
    expect(resolveHarnessId(all)).toBe("codex");
    expect(resolveHarnessId({ ...all, run: undefined })).toBe("claude");
    expect(resolveHarnessId({ persona: "claude", config: "codex" })).toBe("claude");
    expect(resolveHarnessId({ config: "codex" })).toBe("codex");
  });

  test("nothing explicit: installed and signed in first, else installed, else omp", () => {
    const ready = { installed: true, signedIn: true };
    const unsigned = { installed: true, signedIn: false };
    const missing = { installed: false, signedIn: false };
    expect(resolveHarnessId({ readiness: { omp: unsigned, claude: ready, codex: ready } })).toBe("claude");
    expect(resolveHarnessId({ readiness: { omp: ready, claude: ready, codex: missing } })).toBe("omp");
    expect(resolveHarnessId({ readiness: { omp: missing, claude: unsigned, codex: unsigned } })).toBe("claude");
    expect(resolveHarnessId({ readiness: { omp: missing, claude: missing, codex: missing } })).toBe("omp");
    expect(resolveHarnessId({})).toBe("omp");
  });
});

describe("detectInstalled", () => {
  test("probes every harness once and caches the answer", async () => {
    const probes: string[][] = [];
    const run = async (cmd: string[]) => {
      probes.push(cmd);
      return result(cmd[0]!.endsWith("no-claude") ? 0 : 127);
    };
    const first = await detectInstalled(run);
    expect(first).toEqual({ omp: false, claude: true, codex: false });
    expect(probes).toHaveLength(HARNESS_IDS.length);
    expect(probes.every((p) => p[1] === "--version")).toBe(true);
    expect(await detectInstalled(run)).toBe(first);
    expect(probes).toHaveLength(HARNESS_IDS.length);
  });

  test("resolveHarness: an explicit layer wins; otherwise the preload bins (all missing) fall back to omp", async () => {
    expect(await resolveHarness({ run: "codex" })).toBe("codex");
    expect(await resolveHarness({})).toBe("omp");
  });
});

describe("detectReadiness", () => {
  /** Adapters whose doctor rows follow a scenario; counts how often each was probed. */
  function scenario(state: Record<HarnessId, { installed: boolean; signedIn: boolean }>) {
    const probed: HarnessId[] = [];
    const adapter = (id: HarnessId): Pick<Harness, "doctor"> => ({
      doctor: async () => {
        probed.push(id);
        const s = state[id];
        return [
          { id, label: id, status: s.installed ? "ok" : "warn", detail: "", required: false },
          { id: `${id}-auth`, label: id, status: !s.installed ? "skip" : s.signedIn ? "ok" : "warn", detail: "", required: false },
        ];
      },
    });
    return { adapter, probed };
  }
  const run = async () => result(0);

  test("reads install and sign-in from each adapter's own doctor rows and caches them like detectInstalled", async () => {
    const { adapter, probed } = scenario({
      omp: { installed: true, signedIn: false },
      claude: { installed: true, signedIn: true },
      codex: { installed: false, signedIn: false },
    });
    const first = await detectReadiness(run, adapter);
    expect(first).toEqual({
      omp: { installed: true, signedIn: false },
      claude: { installed: true, signedIn: true },
      codex: { installed: false, signedIn: false },
    });
    expect(await detectReadiness(run, adapter)).toBe(first);
    expect(probed).toHaveLength(HARNESS_IDS.length);
  });

  test("a throwing doctor counts as not installed", async () => {
    const adapter = (): Pick<Harness, "doctor"> => ({
      doctor: async () => {
        throw new Error("boom");
      },
    });
    expect(await detectReadiness(run, adapter)).toEqual({
      omp: { installed: false, signedIn: false },
      claude: { installed: false, signedIn: false },
      codex: { installed: false, signedIn: false },
    });
  });
});

describe("harnessBin", () => {
  test("env override > config bin > default name", () => {
    const cfg = { agent: { harnesses: { claude: { bin: "/opt/claude" } } } };
    expect(harnessBin("claude", cfg, { CLAUDE_BIN: "/env/claude" })).toBe("/env/claude");
    expect(harnessBin("claude", cfg, {})).toBe("/opt/claude");
    expect(harnessBin("codex", cfg, {})).toBe("codex");
    expect(harnessBin("omp", {}, { OMP_BIN: "/x/omp" })).toBe("/x/omp");
  });
});

describe("registry", () => {
  test("every id resolves to an adapter with its own id and the contract capabilities", () => {
    for (const id of HARNESS_IDS) expect(getHarness(id).id).toBe(id);
    expect(getHarness("omp").capabilities).toMatchObject({ nativeProgressTools: true, transcriptExport: true, steer: true });
    expect(getHarness("omp").capabilities.backends).toEqual(["mobile-mcp", "artemis"]);
    expect(getHarness("codex").capabilities.steer).toBe(false);
    expect(getHarness("claude").capabilities.backends).not.toContain("artemis");
  });
});
