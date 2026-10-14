import { existsSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ADB_BIN, CONFIG_PATH, config, DATA_DIR, EMULATOR_BIN, GH_BIN, GIT_BIN } from "./config";
import { type ExecResult, exec, parseAdbDevices } from "./devices/devices";
import { getHarness, type HarnessReadiness, harnessBin, pickDefaultHarness, readinessOf } from "./harness";
import { HARNESS_IDS, type Harness, type HarnessId } from "./harness/types";
import { hubChecks } from "./hub/laptop-doctor";
import { hubHosts, HUB_STORE_WARN_RUNS, hubIdentityHeader, hubRetention, isHub } from "./hub/mode";
import { hubMachines, type HubMachine } from "./hub/status";
import { listTokens } from "./hub/tokens";
import { listProjects, projectEvents, type ProjectStatus } from "./projects/registry";
import { listRuns } from "./runs/store";

export interface DoctorCheck {
  id: string;
  label: string;
  status: "ok" | "warn" | "error" | "skip";
  detail: string;
  fix?: string;
  required: boolean;
}

export interface DoctorReport {
  checks: DoctorCheck[];
}

/** Everything the checks read from the outside world; tests inject their own. */
export interface DoctorEnv {
  /** Binary per agent harness (config / `<ID>_BIN` / default name). */
  harnessBins: Record<HarnessId, string>;
  /** `agent.harness` from the config; unset = the first ready harness is the required one. */
  configuredHarness: HarnessId | undefined;
  /** Adapter lookup; tests inject fakes. */
  harness: (id: HarnessId) => Pick<Harness, "label" | "doctor">;
  adbBin: string;
  gitBin: string;
  ghBin: string;
  emulatorBin: string | null;
  platform: NodeJS.Platform;
  configPath: string;
  configuredAvds: readonly string[];
  projects: () => ProjectStatus[];
  /** Runs a probe command to completion; never throws (a missing binary is exit code 127). */
  run: (cmd: string[]) => Promise<ExecResult>;
  /** The team-hub rows (laptop side); absent = none. */
  hubChecks?: () => Promise<DoctorCheck[]>;
}

const PROBE_TIMEOUT_MS = 8_000;
const OVERALL_TIMEOUT_MS = 20_000;
const CACHE_TTL_MS = 10_000;
const MIN_BUN = [1, 3, 0] as const;
const INSTALL_LINKS = [
  "omp: https://github.com/can1357/oh-my-pi",
  "Claude Code: https://docs.anthropic.com/en/docs/claude-code/overview",
  "Codex CLI: https://github.com/openai/codex",
];

export function defaultEnv(): DoctorEnv {
  return {
    harnessBins: { omp: harnessBin("omp"), claude: harnessBin("claude"), codex: harnessBin("codex") },
    configuredHarness: config.agent?.harness,
    harness: getHarness,
    adbBin: ADB_BIN,
    gitBin: GIT_BIN,
    ghBin: GH_BIN,
    emulatorBin: EMULATOR_BIN,
    platform: process.platform,
    configPath: CONFIG_PATH,
    configuredAvds: config.devicePool.android.avds,
    projects: listProjects,
    run: (cmd) => exec(cmd, { timeoutMs: PROBE_TIMEOUT_MS }),
    hubChecks: () => hubChecks(),
  };
}

const firstLine = (s: string) => s.split(/\r?\n/).find((l) => l.trim())?.trim() ?? "";

const lastLines = (s: string, n = 3) => s.trim().split(/\r?\n/).slice(-n).join(" ").trim();

const notFound = (code: number) => code === 127;

function versionAtLeast(version: string, min: readonly number[]): boolean {
  const parts = version.split(".").map((p) => Number.parseInt(p, 10) || 0);
  for (let i = 0; i < min.length; i++) {
    if ((parts[i] ?? 0) !== min[i]) return (parts[i] ?? 0) > min[i];
  }
  return true;
}

/** Runs one check; a throw or a hang becomes an error row instead of failing the whole report. */
async function guarded(
  base: Pick<DoctorCheck, "id" | "label" | "required">,
  fn: () => Promise<Omit<DoctorCheck, "id" | "label" | "required">> | Omit<DoctorCheck, "id" | "label" | "required">,
): Promise<DoctorCheck> {
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(() => timeout.reject(new Error(`timed out after ${OVERALL_TIMEOUT_MS / 1000}s`)), OVERALL_TIMEOUT_MS);
  try {
    return { ...base, ...(await Promise.race([Promise.resolve().then(fn), timeout.promise])) };
  } catch (e) {
    return { ...base, status: "error", detail: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

function checkBun(): Promise<DoctorCheck> {
  return guarded({ id: "bun", label: "Bun", required: true }, () => {
    const ok = versionAtLeast(Bun.version, MIN_BUN);
    return ok
      ? { status: "ok", detail: `Bun ${Bun.version}` }
      : {
          status: "error",
          detail: `Bun ${Bun.version} is older than ${MIN_BUN.join(".")}`,
          fix: "Upgrade with `bun upgrade` (https://bun.sh)",
        };
  });
}

const authId = (id: HarnessId) => `${id}-auth`;

/** Runs one adapter's checks; a throwing adapter becomes an error row (plus a skipped sign-in row) rather than failing the report. */
async function harnessChecks(env: DoctorEnv, id: HarnessId): Promise<DoctorCheck[]> {
  const adapter = env.harness(id);
  try {
    return await adapter.doctor({ bin: env.harnessBins[id], platform: env.platform, run: env.run, selected: id === env.configuredHarness });
  } catch (e) {
    return [
      { id, label: adapter.label, status: "error", detail: e instanceof Error ? e.message : String(e), required: false },
      { id: authId(id), label: `${adapter.label} signed in`, status: "skip", detail: `Needs ${adapter.label} installed first`, required: false },
    ];
  }
}

/** At least one harness must be installed and signed in for any run to start. */
function agentRuntimeCheck(env: DoctorEnv, readiness: Record<HarnessId, HarnessReadiness>): DoctorCheck {
  const base = { id: "agent-runtime", label: "Agent runtime (omp, Claude Code or Codex)", required: true };
  const installed = HARNESS_IDS.filter((id) => readiness[id].installed);
  const ready = HARNESS_IDS.filter((id) => readiness[id].signedIn);
  const names = (ids: readonly HarnessId[]) => ids.map((id) => env.harness(id).label).join(", ");
  if (ready.length > 0) return { ...base, status: "ok", detail: `Ready: ${names(ready)}` };
  if (installed.length > 0) {
    return {
      ...base,
      status: "warn",
      detail: `${names(installed)} installed but not confirmed signed in; runs cannot start until one is`,
      fix: "Sign in to one of them (see its row below), then re-check",
    };
  }
  return {
    ...base,
    status: "error",
    detail: "No agent runtime found; Tapocalypse needs one of omp, Claude Code or Codex CLI",
    fix: `Install at least one, sign in, then re-check — ${INSTALL_LINKS.join("; ")}`,
  };
}

function checkOs(env: DoctorEnv): Promise<DoctorCheck> {
  return guarded({ id: "os", label: "Operating system", required: true }, () => {
    if (env.platform === "darwin") return { status: "ok", detail: "macOS (Android and iOS)" };
    if (env.platform === "linux") return { status: "ok", detail: "Linux (Android only; iOS simulators need macOS)" };
    if (env.platform === "win32") {
      return { status: "error", detail: "Windows is not supported", fix: "Run Tapocalypse on macOS or Linux (or inside WSL2 with adb reaching your devices)" };
    }
    return { status: "warn", detail: `${env.platform} is untested; macOS and Linux are supported` };
  });
}

function checkNode(env: DoctorEnv): Promise<DoctorCheck> {
  return guarded({ id: "node", label: "Node.js / npx (runs mobile-mcp)", required: true }, async () => {
    const r = await env.run(["npx", "--version"]);
    if (notFound(r.code) || r.code !== 0) {
      return {
        status: "error",
        detail: notFound(r.code) ? "`npx` not found on PATH" : `\`npx --version\` failed: ${lastLines(r.stderr || r.text)}`,
        fix: "Install Node.js 18+ from https://nodejs.org — agents start mobile-mcp with `npx -y @mobilenext/mobile-mcp@latest`",
      };
    }
    return { status: "ok", detail: `npx ${firstLine(r.text)}` };
  });
}

function checkGit(env: DoctorEnv): Promise<DoctorCheck> {
  return guarded({ id: "git", label: "git", required: false }, async () => {
    const r = await env.run([env.gitBin, "--version"]);
    if (r.code !== 0) {
      return { status: "warn", detail: "git not found; runs cannot record branch/commit metadata", fix: "Install git (https://git-scm.com)" };
    }
    return { status: "ok", detail: firstLine(r.text) };
  });
}

function checkGh(env: DoctorEnv): Promise<DoctorCheck> {
  return guarded({ id: "gh", label: "GitHub CLI (gh)", required: false }, async () => {
    const version = await env.run([env.ghBin, "--version"]);
    if (version.code !== 0) {
      return { status: "warn", detail: "gh not found; PR metadata unavailable", fix: "Optional: install https://cli.github.com and run `gh auth login`" };
    }
    const auth = await env.run([env.ghBin, "auth", "status"]);
    if (auth.code !== 0) {
      return { status: "warn", detail: "gh is not authenticated; PR metadata unavailable", fix: "Run `gh auth login`" };
    }
    return { status: "ok", detail: `${firstLine(version.text)}; authenticated` };
  });
}

function checkXcrun(env: DoctorEnv): Promise<DoctorCheck> {
  return guarded({ id: "xcrun", label: "Xcode simulators (xcrun simctl)", required: false }, async () => {
    if (env.platform !== "darwin") return { status: "skip", detail: "iOS simulators need macOS" };
    const r = await env.run(["xcrun", "--find", "simctl"]);
    if (r.code !== 0) {
      return {
        status: "warn",
        detail: "`xcrun simctl` unavailable; iOS runs are disabled",
        fix: "Install Xcode, then run `sudo xcode-select --switch /Applications/Xcode.app` (ignore if you only test Android)",
      };
    }
    return { status: "ok", detail: firstLine(r.text) };
  });
}

function checkAdb(env: DoctorEnv, xcrun: Promise<DoctorCheck>): Promise<DoctorCheck> {
  return guarded({ id: "adb", label: "adb (Android platform-tools)", required: true }, async () => {
    const r = await env.run([env.adbBin, "version"]);
    if (r.code === 0) return { status: "ok", detail: firstLine(r.text) };
    const iosOk = (await xcrun).status === "ok";
    return {
      status: iosOk ? "warn" : "error",
      detail: notFound(r.code) ? `\`${env.adbBin}\` not found on PATH` : `\`${env.adbBin} version\` failed: ${lastLines(r.stderr || r.text)}`,
      fix:
        env.platform === "linux"
          ? "Install Android platform-tools (Android Studio → SDK Manager, or your distro's `android-tools-adb` package) and add it to PATH, or set ADB_BIN"
          : "Install Android platform-tools (Android Studio → SDK Manager, or `brew install --cask android-platform-tools`) and add it to PATH, or set ADB_BIN",
    };
  });
}

function checkEmulator(env: DoctorEnv): Promise<DoctorCheck> {
  return guarded({ id: "emulator", label: "Android emulator", required: false }, async () => {
    if (!env.emulatorBin) {
      return {
        status: "warn",
        detail: "Android emulator binary not found; Tapocalypse cannot auto-boot emulators",
        fix: "Install the Android Emulator in Android Studio → SDK Manager (looked in ANDROID_HOME, ~/Library/Android/sdk and ~/Android/Sdk), or set EMULATOR_BIN / ANDROID_HOME",
      };
    }
    const r = await env.run([env.emulatorBin, "-list-avds"]);
    if (r.code !== 0) {
      return { status: "warn", detail: `\`${env.emulatorBin} -list-avds\` failed: ${lastLines(r.stderr || r.text)}`, fix: "Check the Android SDK install" };
    }
    const avds = r.text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("INFO") && !/\s/.test(l));
    if (avds.length === 0) {
      return { status: "warn", detail: "No Android Virtual Devices found", fix: "Create an AVD in Android Studio → Device Manager" };
    }
    const missing = env.configuredAvds.filter((a) => !avds.includes(a));
    if (missing.length > 0) {
      return {
        status: "warn",
        detail: `${avds.length} AVD(s) available (${avds.join(", ")}); devicePool.android.avds lists unknown: ${missing.join(", ")}`,
        fix: `Fix devicePool.android.avds in ${env.configPath} to names from \`emulator -list-avds\``,
      };
    }
    return { status: "ok", detail: `${avds.length} AVD(s): ${avds.join(", ")}` };
  });
}

async function countDevices(env: DoctorEnv): Promise<string[]> {
  const found: string[] = [];
  const [adb, sim] = await Promise.all([
    env.run([env.adbBin, "devices", "-l"]),
    env.platform === "darwin" ? env.run(["xcrun", "simctl", "list", "devices", "booted", "-j"]) : null,
  ]);
  if (adb.code === 0) found.push(...parseAdbDevices(adb.text).map((d) => d.serial));
  if (sim?.code === 0) {
    try {
      const data = JSON.parse(sim.text) as { devices: Record<string, { udid: string; state: string }[]> };
      found.push(...Object.values(data.devices).flat().filter((s) => s.state === "Booted").map((s) => s.udid));
    } catch {
      // unparseable simctl output counts as no simulators
    }
  }
  return found;
}

function checkDevices(env: DoctorEnv): Promise<DoctorCheck> {
  return guarded({ id: "devices", label: "Connected devices", required: false }, async () => {
    const devices = await countDevices(env);
    if (devices.length === 0) {
      return {
        status: "warn",
        detail: "No booted emulator, simulator or device",
        fix: "Boot an emulator or simulator, or list AVDs in devicePool.android.avds for auto-boot",
      };
    }
    return { status: "ok", detail: `${devices.length} connected: ${devices.slice(0, 5).join(", ")}${devices.length > 5 ? ", …" : ""}` };
  });
}

function checkConfig(env: DoctorEnv): Promise<DoctorCheck> {
  return guarded({ id: "config", label: "Configuration", required: true }, () =>
    existsSync(env.configPath)
      ? { status: "ok", detail: env.configPath }
      : { status: "error", detail: `${env.configPath} does not exist`, fix: "Start Tapocalypse once to create a starter config, or set TAPOCALYPSE_CONFIG" },
  );
}

function checkProjects(env: DoctorEnv): Promise<DoctorCheck> {
  return guarded({ id: "projects", label: "Projects", required: false }, () => {
    const projects = env.projects();
    if (projects.length === 0) {
      return { status: "warn", detail: "No projects registered", fix: "Add one at #/projects (or ask an agent to call qa_create_project)" };
    }
    const invalid = projects.filter((p) => p.status === "invalid");
    if (invalid.length > 0) {
      const problems = invalid.map((p) => `${p.id || "(no id)"}: ${p.problems.join("; ")}`);
      return { status: "warn", detail: `${projects.length - invalid.length} of ${projects.length} project(s) usable. Invalid — ${problems.join(" | ")}`, fix: "Fix them at #/projects" };
    }
    return { status: "ok", detail: `${projects.length} project(s): ${projects.map((p) => p.id).join(", ")}` };
  });
}

/** The laptop side of the team hub (connection, credentials, queue, shared projects); a probe that throws is one error row. */
async function teamHubChecks(env: DoctorEnv): Promise<DoctorCheck[]> {
  if (!env.hubChecks) return [];
  try {
    return await env.hubChecks();
  } catch (e) {
    return [{ id: "hub", label: "Team hub", status: "error", detail: e instanceof Error ? e.message : String(e), required: false }];
  }
}

/** Uncached report for an explicit environment. */
export async function buildReport(env: DoctorEnv): Promise<DoctorReport> {
  const xcrun = checkXcrun(env);
  const [os, bun, harnessRows, ...rest] = await Promise.all([
    checkOs(env),
    checkBun(),
    Promise.all(HARNESS_IDS.map(async (id) => [id, await harnessChecks(env, id)] as const)),
    checkNode(env),
    checkGit(env),
    checkGh(env),
    checkAdb(env, xcrun),
    checkEmulator(env),
    xcrun,
    checkDevices(env),
    checkConfig(env),
    checkProjects(env),
  ]);
  const byHarness = new Map<HarnessId, DoctorCheck[]>(harnessRows);
  const readiness = Object.fromEntries(HARNESS_IDS.map((id) => [id, readinessOf(id, byHarness.get(id) ?? [])])) as Record<HarnessId, HarnessReadiness>;
  const selected = env.configuredHarness ?? pickDefaultHarness(readiness);
  const harnessList = HARNESS_IDS.flatMap((id) =>
    (byHarness.get(id) ?? []).map((c) => (c.id === id || c.id === authId(id) ? { ...c, required: id === selected } : c)),
  );
  const checks = [os, bun, agentRuntimeCheck(env, readiness), ...harnessList, ...rest, ...(await teamHubChecks(env))];
  return { checks };
}

// ---------------------------------------------------------------------------------------------------------------
// Hub: nothing here touches a device or an agent, so the laptop checklist does not apply
// ---------------------------------------------------------------------------------------------------------------

/** Everything the hub checks read from the outside world; tests inject their own. */
export interface HubDoctorEnv {
  dataDir: string;
  hosts: string[];
  identityHeader: string | null;
  retention: { days?: number; maxRuns?: number };
  runCount: () => number;
  activeTokens: () => number;
  machines: () => HubMachine[];
  /** Free bytes on the volume holding `dir`; null when the platform cannot say. */
  freeBytes: (dir: string) => number | null;
  now: () => number;
}

export function defaultHubEnv(): HubDoctorEnv {
  return {
    dataDir: DATA_DIR,
    hosts: hubHosts(),
    identityHeader: hubIdentityHeader(),
    retention: hubRetention(),
    runCount: () => listRuns().length,
    activeTokens: () => listTokens().filter((t) => t.revokedAt === null).length,
    machines: () => hubMachines(),
    freeBytes: (dir) => {
      try {
        const fs = statfsSync(dir);
        return fs.bavail * fs.bsize;
      } catch {
        return null;
      }
    },
    now: () => Date.now(),
  };
}

const WARN_FREE_BYTES = 1024 ** 3;
const MIN_FREE_BYTES = 100 * 1024 ** 2;

function ago(ms: number): string {
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

/** The hub's checklist: data dir writable, free disk, store size against the 8k-run tripwire, tokens, proxy hosts, last upload per machine. */
export async function buildHubReport(env: HubDoctorEnv): Promise<DoctorReport> {
  const checks = await Promise.all([
    guarded({ id: "data-dir", label: "Data directory writable", required: true }, () => {
      const probe = path.join(env.dataDir, `.doctor-${process.pid}`);
      try {
        writeFileSync(probe, "ok");
        rmSync(probe, { force: true });
        return { status: "ok", detail: env.dataDir };
      } catch (e) {
        return {
          status: "error",
          detail: `${env.dataDir} is not writable: ${e instanceof Error ? e.message : String(e)}`,
          fix: "Mount a writable volume at the data directory (the container runs as the non-root `bun` user, uid 1000)",
        };
      }
    }),
    guarded({ id: "disk", label: "Free disk space", required: true }, () => {
      const free = env.freeBytes(env.dataDir);
      if (free === null) return { status: "skip", detail: "Free space is not reported on this platform" };
      const detail = `${(free / 1024 ** 3).toFixed(1)} GB free`;
      if (free < MIN_FREE_BYTES) return { status: "error", detail, fix: "Uploads will fail: free space on the data volume or enlarge it" };
      if (free < WARN_FREE_BYTES) return { status: "warn", detail, fix: "Under 1 GB left: free space, enlarge the volume or lower TAPOCALYPSE_HUB_RETENTION_DAYS" };
      return { status: "ok", detail };
    }),
    guarded({ id: "store", label: "Run store size", required: false }, () => {
      const runs = env.runCount();
      if (runs < HUB_STORE_WARN_RUNS) return { status: "ok", detail: `${runs} run(s)` };
      return {
        status: "warn",
        detail: `${runs} runs: the in-memory store boots slowly past about 10,000 runs`,
        fix: "Shorten retention (TAPOCALYPSE_HUB_RETENTION_DAYS / _MAX_RUNS); a SQLite run index is the planned fix beyond that",
      };
    }),
    guarded({ id: "tokens", label: "Upload tokens", required: false }, () => {
      const n = env.activeTokens();
      return n > 0
        ? { status: "ok", detail: `${n} active token(s)` }
        : { status: "warn", detail: "No active upload token: no machine can upload", fix: "Run `bun src/cli.ts hub token create <machine-name>` on the hub" };
    }),
    guarded({ id: "hosts", label: "Public host names", required: false }, () =>
      env.hosts.length > 0
        ? { status: "ok", detail: env.hosts.join(", ") }
        : {
            status: "warn",
            detail: "TAPOCALYPSE_HUB_HOSTS is not set: only localhost is accepted, so requests that arrive through the access proxy get 403",
            fix: "Set TAPOCALYPSE_HUB_HOSTS to the host name(s) the proxy forwards, e.g. qa.example.com",
          },
    ),
    guarded({ id: "retention", label: "Retention", required: false }, () => {
      const { days, maxRuns } = env.retention;
      const parts = [days === undefined ? null : `${days} days`, maxRuns === undefined ? null : `newest ${maxRuns} runs`].filter((p) => p !== null);
      return { status: "ok", detail: parts.length > 0 ? `keeps ${parts.join(", ")}` : "keeps everything" };
    }),
    guarded({ id: "uploads", label: "Last upload per machine", required: false }, () => {
      const machines = env.machines().filter((m) => !m.revoked);
      if (machines.length === 0) return { status: "ok", detail: "no machine has uploaded yet" };
      const now = env.now();
      const detail = machines.map((m) => `${m.name} ${m.lastUploadAt ? ago(now - Date.parse(m.lastUploadAt)) : "never"}`).join(", ");
      const skewed = machines.filter((m) => m.clockSkewMs !== null);
      if (skewed.length === 0) return { status: "ok", detail };
      return {
        status: "warn",
        detail: `${detail}. Clock more than 5 minutes off: ${skewed.map((m) => m.name).join(", ")}`,
        fix: "Fix the clock on those machines (ordering of uploaded runs uses the uploader's time)",
      };
    }),
  ]);
  return { checks };
}

let cache: { at: number; report: Promise<DoctorReport> } | null = null;

// Project edits change the "Projects" row immediately; do not make users wait out the TTL.
projectEvents.on("change", () => {
  cache = null;
});

/** Cached for 10 s; `fresh` bypasses the cache (the "Re-check" button). Never throws. A hub runs its own, much shorter checklist. */
export function runDoctor(opts: { fresh?: boolean } = {}): Promise<DoctorReport> {
  if (isHub()) return buildHubReport(defaultHubEnv());
  if (!opts.fresh && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.report;
  const report = buildReport(defaultEnv());
  cache = { at: Date.now(), report };
  return report;
}
