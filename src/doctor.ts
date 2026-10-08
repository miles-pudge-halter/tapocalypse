import { existsSync, statSync } from "node:fs";
import {
  ADB_BIN,
  CONFIG_PATH,
  config,
  EMULATOR_BIN,
  GH_BIN,
  GIT_BIN,
  OMP_BIN,
} from "./config";
import { type ExecResult, exec, parseAdbDevices } from "./devices/devices";
import { listProjects, projectEvents, type ProjectStatus } from "./projects/registry";
import type { Backend } from "./runs/types";

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
  backends: Backend[];
}

/** Everything the checks read from the outside world; tests inject their own. */
export interface DoctorEnv {
  ompBin: string;
  adbBin: string;
  gitBin: string;
  ghBin: string;
  emulatorBin: string | null;
  artemisPath: string | undefined;
  platform: NodeJS.Platform;
  configPath: string;
  configuredAvds: readonly string[];
  projects: () => ProjectStatus[];
  /** Runs a probe command to completion; never throws (a missing binary is exit code 127). */
  run: (cmd: string[]) => Promise<ExecResult>;
}

const PROBE_TIMEOUT_MS = 8_000;
const OVERALL_TIMEOUT_MS = 20_000;
const CACHE_TTL_MS = 10_000;
const MIN_BUN = [1, 3, 0] as const;
const OMP_URL = "https://github.com/can1357/oh-my-pi";

export function defaultEnv(): DoctorEnv {
  return {
    ompBin: OMP_BIN,
    adbBin: ADB_BIN,
    gitBin: GIT_BIN,
    ghBin: GH_BIN,
    emulatorBin: EMULATOR_BIN,
    artemisPath: config.artemisPath,
    platform: process.platform,
    configPath: CONFIG_PATH,
    configuredAvds: config.devicePool.android.avds,
    projects: listProjects,
    run: (cmd) => exec(cmd, { timeoutMs: PROBE_TIMEOUT_MS }),
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

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
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

function checkOmp(env: DoctorEnv): Promise<DoctorCheck> {
  return guarded({ id: "omp", label: "omp (agent runtime)", required: true }, async () => {
    const r = await env.run([env.ompBin, "--version"]);
    if (notFound(r.code)) {
      return { status: "error", detail: `\`${env.ompBin}\` not found on PATH`, fix: `Install omp: ${OMP_URL}, then make sure \`omp\` is on your PATH (or set OMP_BIN)` };
    }
    if (r.code !== 0) {
      return { status: "error", detail: `\`${env.ompBin} --version\` failed: ${lastLines(r.stderr || r.text)}`, fix: `Reinstall omp: ${OMP_URL}` };
    }
    return { status: "ok", detail: firstLine(r.text) || "installed" };
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
      fix: "Install Android platform-tools (Android Studio → SDK Manager, or `brew install --cask android-platform-tools`) and add it to PATH, or set ADB_BIN",
    };
  });
}

function checkEmulator(env: DoctorEnv): Promise<DoctorCheck> {
  return guarded({ id: "emulator", label: "Android emulator", required: false }, async () => {
    if (!env.emulatorBin) {
      return {
        status: "warn",
        detail: "Android emulator binary not found; Tapocalypse cannot auto-boot emulators",
        fix: "Install the Android Emulator in Android Studio → SDK Manager, or set EMULATOR_BIN / ANDROID_HOME",
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

function checkArtemis(env: DoctorEnv): Promise<DoctorCheck> {
  return guarded({ id: "artemis", label: "Artemis backend", required: false }, () => {
    if (!env.artemisPath) return { status: "skip", detail: "Not configured; agents drive devices with mobile-mcp" };
    if (!isDir(env.artemisPath)) {
      return {
        status: "error",
        detail: `artemisPath ${env.artemisPath} does not exist`,
        fix: `Clone Artemis there, or remove artemisPath from ${env.configPath}`,
      };
    }
    return { status: "ok", detail: env.artemisPath };
  });
}

/** Artemis is offered only when `artemisPath` is set and the directory exists. */
export function artemisAvailable(artemisPath: string | undefined = config.artemisPath): boolean {
  return !!artemisPath && isDir(artemisPath);
}

/** Uncached report for an explicit environment. */
export async function buildReport(env: DoctorEnv): Promise<DoctorReport> {
  const xcrun = checkXcrun(env);
  const checks = await Promise.all([
    checkBun(),
    checkOmp(env),
    checkNode(env),
    checkGit(env),
    checkGh(env),
    checkAdb(env, xcrun),
    checkEmulator(env),
    xcrun,
    checkDevices(env),
    checkConfig(env),
    checkProjects(env),
    checkArtemis(env),
  ]);
  return { checks, backends: artemisAvailable(env.artemisPath) ? ["mobile-mcp", "artemis"] : ["mobile-mcp"] };
}

let cache: { at: number; report: Promise<DoctorReport> } | null = null;

// Project edits change the "Projects" row immediately; do not make users wait out the TTL.
projectEvents.on("change", () => {
  cache = null;
});

/** Cached for 10 s; `fresh` bypasses the cache (the "Re-check" button). Never throws. */
export function runDoctor(opts: { fresh?: boolean } = {}): Promise<DoctorReport> {
  if (!opts.fresh && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.report;
  const report = buildReport(defaultEnv());
  cache = { at: Date.now(), report };
  return report;
}
