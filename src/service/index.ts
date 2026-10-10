import { closeSync, mkdirSync, openSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { config, DATA_DIR } from "../config";
import { type ExecResult, exec } from "../devices/devices";

export type ServiceAction = "install" | "uninstall" | "start" | "stop" | "restart" | "status" | "logs";

export interface ServiceDeps {
  platform: NodeJS.Platform;
  home: string;
  uid: number;
  execPath: string;
  repoRoot: string;
  dataDir: string;
  env: Record<string, string | undefined>;
  run: (cmd: string[]) => Promise<ExecResult>;
  /** GET /api/mcp/status answered ok. */
  probe: () => Promise<boolean>;
  write: (file: string, text: string) => void;
  remove: (file: string) => void;
  /** Creates `dir` and missing parents; throws when it cannot. */
  mkdir: (dir: string) => void;
  readLog: (file: string, lines: number) => string;
}

const LABEL = "dev.tapocalypse.server";
const UNIT = "tapocalypse";
const PASSTHROUGH = /^(TAPOCALYPSE_.+|ANDROID_HOME|ANDROID_SDK_ROOT|OMP_BIN|CLAUDE_BIN|CODEX_BIN|ADB_BIN|XCRUN_BIN|EMULATOR_BIN)$/;

/** Environment baked into the unit: a service manager starts with an empty one. */
function serviceEnv(deps: ServiceDeps): [string, string][] {
  const out: [string, string][] = [["NODE_ENV", "production"]];
  if (deps.env.PATH) out.push(["PATH", deps.env.PATH]);
  out.push(["HOME", deps.home]);
  for (const key of Object.keys(deps.env).sort()) {
    const value = deps.env[key];
    if (value !== undefined && PASSTHROUGH.test(key)) out.push([key, value]);
  }
  return out;
}

function logFile(deps: ServiceDeps): string {
  return path.join(deps.dataDir, "logs", "service.log");
}

function xml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function plist(deps: ServiceDeps): string {
  const args = [deps.execPath, path.join(deps.repoRoot, "src", "cli.ts"), "serve"];
  const log = xml(logFile(deps));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(deps.repoRoot)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${serviceEnv(deps)
  .map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`)
  .join("\n")}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${log}</string>
  <key>StandardErrorPath</key>
  <string>${log}</string>
</dict>
</plist>
`;
}

/** `%` starts a systemd specifier; `$` starts a variable in ExecStart. Doubling keeps both literal. */
function sdQuote(s: string, doubleDollar: boolean): string {
  const literal = s.replace(doubleDollar ? /[%$]/g : /%/g, (c) => c + c);
  return `"${literal.replace(/[\\"]/g, "\\$&")}"`;
}

function systemdUnit(deps: ServiceDeps): string {
  const exec = [deps.execPath, path.join(deps.repoRoot, "src", "cli.ts"), "serve"]
    .map((a) => (/[\s"'\\$%]/.test(a) ? sdQuote(a, true) : a))
    .join(" ");
  const env = serviceEnv(deps).map(([k, v]) => `Environment=${sdQuote(`${k}=${v}`, false)}`);
  return `[Unit]
Description=Tapocalypse mobile QA server
After=network.target

[Service]
ExecStart=${exec}
WorkingDirectory=${deps.repoRoot.replace(/%/g, "%%")}
${env.join("\n")}
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`;
}

/** The service definition for this platform: a launchd agent (macOS) or a systemd user unit (Linux). */
export function unitFile(deps: ServiceDeps): { path: string; content: string } {
  if (deps.platform === "darwin") {
    return { path: path.join(deps.home, "Library", "LaunchAgents", `${LABEL}.plist`), content: plist(deps) };
  }
  if (deps.platform === "linux") {
    return { path: path.join(deps.home, ".config", "systemd", "user", `${UNIT}.service`), content: systemdUnit(deps) };
  }
  throw new Error(`service management is not supported on ${deps.platform}`);
}

type Result = { ok: boolean; lines: string[] };

const detail = (r: ExecResult): string => (r.stderr.trim() || r.text.trim() || `exit ${r.code}`).replace(/\n+/g, " ");

const RESTART_WARNING = "this restarts the server: active runs end as interrupted";

async function launchctlLoaded(deps: ServiceDeps, target: string): Promise<boolean> {
  return (await deps.run(["launchctl", "print", target])).code === 0;
}

/** Loads the plist into the user's launchd domain; an already loaded job is replaced so a rewritten plist takes effect. */
async function bootstrap(deps: ServiceDeps, domain: string, target: string, plistPath: string): Promise<ExecResult> {
  const first = await deps.run(["launchctl", "bootstrap", domain, plistPath]);
  if (first.code === 0) return first;
  if (!/already/i.test(first.stderr) && !(await launchctlLoaded(deps, target))) return first;
  await deps.run(["launchctl", "bootout", target]);
  return deps.run(["launchctl", "bootstrap", domain, plistPath]);
}

async function installDarwin(deps: ServiceDeps): Promise<Result> {
  const unit = unitFile(deps);
  try {
    deps.mkdir(path.dirname(logFile(deps)));
  } catch (err) {
    return { ok: false, lines: [`could not create the log directory ${path.dirname(logFile(deps))}: ${err instanceof Error ? err.message : String(err)}`] };
  }
  deps.write(unit.path, unit.content);
  const domain = `gui/${deps.uid}`;
  const r = await bootstrap(deps, domain, `${domain}/${LABEL}`, unit.path);
  if (r.code !== 0) return { ok: false, lines: [`could not load ${unit.path}: ${detail(r)}`] };
  return { ok: true, lines: [`installed ${unit.path}`, "Tapocalypse starts at login and restarts if it crashes", RESTART_WARNING] };
}

/** (Re)starts the job, loading the plist first when launchd does not know it yet. */
async function startDarwin(deps: ServiceDeps, force: boolean): Promise<Result> {
  const domain = `gui/${deps.uid}`;
  const target = `${domain}/${LABEL}`;
  if (!(await launchctlLoaded(deps, target))) {
    const plistPath = unitFile(deps).path;
    const loaded = await deps.run(["launchctl", "bootstrap", domain, plistPath]);
    if (loaded.code !== 0) {
      return { ok: false, lines: [`the service is not installed (${detail(loaded)}); run \`tapocalypse service install\``] };
    }
  }
  const r = await deps.run(["launchctl", "kickstart", ...(force ? ["-k"] : []), target]);
  if (r.code !== 0) return { ok: false, lines: [`could not ${force ? "restart" : "start"} the service: ${detail(r)}`] };
  return { ok: true, lines: [force ? "restarted Tapocalypse" : "started Tapocalypse", ...(force ? [RESTART_WARNING] : [])] };
}

const NOT_LOADED = /no such process|could not find|not found|not loaded/i;

async function stopDarwin(deps: ServiceDeps): Promise<Result> {
  const r = await deps.run(["launchctl", "bootout", `gui/${deps.uid}/${LABEL}`]);
  if (r.code !== 0 && !NOT_LOADED.test(r.stderr + r.text)) return { ok: false, lines: [`could not stop the service: ${detail(r)}`] };
  return { ok: true, lines: [r.code === 0 ? "stopped Tapocalypse (it starts again at next login or with `tapocalypse service start`)" : "Tapocalypse was not running"] };
}

async function uninstallDarwin(deps: ServiceDeps): Promise<Result> {
  const stopped = await stopDarwin(deps);
  if (!stopped.ok) return stopped;
  deps.remove(unitFile(deps).path);
  return { ok: true, lines: ["uninstalled the Tapocalypse service"] };
}

const LOG_LINES = 100;
const INSTALL_HINT = "run `tapocalypse service install`";

interface UnitState {
  installed: boolean;
  running: boolean;
  /** Manager-specific detail, e.g. `pid 42` or `state = waiting`. */
  note: string;
}

async function statusResult(deps: ServiceDeps, unit: UnitState): Promise<Result> {
  const reachable = await deps.probe();
  const service = !unit.installed
    ? `service: not installed (${INSTALL_HINT})`
    : unit.running
      ? `service: running${unit.note ? ` (${unit.note})` : ""}`
      : `service: installed, not running${unit.note ? ` (${unit.note})` : ""}`;
  return { ok: unit.running && reachable, lines: [service, `server: ${reachable ? "reachable" : "not reachable"}`] };
}

async function statusDarwin(deps: ServiceDeps): Promise<Result> {
  const r = await deps.run(["launchctl", "print", `gui/${deps.uid}/${LABEL}`]);
  if (r.code !== 0) return statusResult(deps, { installed: false, running: false, note: "" });
  const pid = /^\s*pid = (\d+)/m.exec(r.text)?.[1];
  const state = /^\s*state = (\S+)/m.exec(r.text)?.[1];
  return statusResult(deps, pid ? { installed: true, running: true, note: `pid ${pid}` } : { installed: true, running: false, note: state ? `state = ${state}` : "" });
}

function logsResult(text: string): Result {
  const lines = text.split("\n");
  while (lines.at(-1) === "") lines.pop();
  return { ok: true, lines: lines.length > 0 ? lines : ["(no log output yet)"] };
}

const systemctl = (deps: ServiceDeps, ...args: string[]): Promise<ExecResult> => deps.run(["systemctl", "--user", ...args]);

async function installLinux(deps: ServiceDeps): Promise<Result> {
  const unit = unitFile(deps);
  deps.write(unit.path, unit.content);
  const reload = await systemctl(deps, "daemon-reload");
  if (reload.code !== 0) return { ok: false, lines: [`systemctl daemon-reload failed: ${detail(reload)}`] };
  const enabled = await systemctl(deps, "enable", "--now", UNIT);
  if (enabled.code !== 0) return { ok: false, lines: [`could not enable ${UNIT}.service: ${detail(enabled)}`] };
  return {
    ok: true,
    lines: [`installed ${unit.path}`, "Tapocalypse starts at login; to keep it running after you log out, run `loginctl enable-linger`", RESTART_WARNING],
  };
}

async function uninstallLinux(deps: ServiceDeps): Promise<Result> {
  await systemctl(deps, "disable", "--now", UNIT);
  deps.remove(unitFile(deps).path);
  await systemctl(deps, "daemon-reload");
  return { ok: true, lines: ["uninstalled the Tapocalypse service"] };
}

const PAST: Record<"start" | "stop" | "restart", string> = { start: "started", stop: "stopped", restart: "restarted" };

async function controlLinux(deps: ServiceDeps, action: "start" | "stop" | "restart"): Promise<Result> {
  const r = await systemctl(deps, action, UNIT);
  if (r.code !== 0) return { ok: false, lines: [`could not ${action} the service: ${detail(r)}`] };
  return { ok: true, lines: [`${PAST[action]} Tapocalypse`, ...(action === "restart" ? [RESTART_WARNING] : [])] };
}

async function statusLinux(deps: ServiceDeps): Promise<Result> {
  const active = await systemctl(deps, "is-active", UNIT);
  const state = active.text.trim() || "inactive";
  if (active.code === 0) return statusResult(deps, { installed: true, running: true, note: "" });
  const installed = (await systemctl(deps, "cat", UNIT)).code === 0;
  return statusResult(deps, { installed, running: false, note: state });
}

async function logsLinux(deps: ServiceDeps): Promise<Result> {
  const r = await deps.run(["journalctl", "--user", "-u", UNIT, "-n", String(LOG_LINES), "--no-pager"]);
  if (r.code !== 0) return { ok: false, lines: [`could not read the journal: ${detail(r)}`] };
  return logsResult(r.text);
}

/** Manage the always-on Tapocalypse server (launchd on macOS, systemd user unit on Linux). */
export async function serviceCommand(action: ServiceAction, deps: ServiceDeps): Promise<Result> {
  if (deps.platform === "darwin") {
    switch (action) {
      case "install":
        return installDarwin(deps);
      case "uninstall":
        return uninstallDarwin(deps);
      case "start":
        return startDarwin(deps, false);
      case "restart":
        return startDarwin(deps, true);
      case "stop":
        return stopDarwin(deps);
      case "status":
        return statusDarwin(deps);
      case "logs":
        return logsResult(deps.readLog(logFile(deps), LOG_LINES));
    }
  }
  if (deps.platform === "linux") {
    switch (action) {
      case "install":
        return installLinux(deps);
      case "uninstall":
        return uninstallLinux(deps);
      case "start":
      case "stop":
      case "restart":
        return controlLinux(deps, action);
      case "status":
        return statusLinux(deps);
      case "logs":
        return logsLinux(deps);
    }
  }
  return {
    ok: false,
    lines: [`service ${action} is not supported on ${deps.platform}; run \`tapocalypse serve\` in a terminal instead`],
  };
}

const LOG_TAIL_BYTES = 1024 * 1024;

/** Last `lines` lines of a text file, reading at most the final megabyte; "" when the file does not exist. */
function tailFile(file: string, lines: number): string {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return "";
  }
  try {
    const size = statSync(file).size;
    const length = Math.min(size, LOG_TAIL_BYTES);
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, size - length);
    const all = buf.toString("utf8").split("\n");
    if (all.at(-1) === "") all.pop();
    return `${all.slice(-lines).join("\n")}\n`;
  } finally {
    closeSync(fd);
  }
}

export function defaultServiceDeps(): ServiceDeps {
  const url = `http://127.0.0.1:${config.port}/api/mcp/status`;
  return {
    platform: process.platform,
    home: os.homedir(),
    uid: process.getuid?.() ?? -1,
    execPath: process.execPath,
    repoRoot: path.resolve(import.meta.dir, "..", ".."),
    dataDir: DATA_DIR,
    env: process.env,
    run: (cmd) => exec(cmd),
    probe: async () => {
      try {
        return (await fetch(url, { signal: AbortSignal.timeout(2000) })).ok;
      } catch {
        return false;
      }
    },
    write: (file, text) => {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, text);
    },
    remove: (file) => rmSync(file, { force: true }),
    mkdir: (dir) => void mkdirSync(dir, { recursive: true }),
    readLog: tailFile,
  };
}
