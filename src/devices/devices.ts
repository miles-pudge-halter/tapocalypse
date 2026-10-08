import { existsSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ADB_BIN, ARTEMIS_LOCK_DIR, config } from "../config";
import type { Platform } from "../runs/types";

export interface ArtemisOwner {
  pid: number;
  sessionId?: string;
  description?: string;
}

export interface Device {
  serial: string;
  platform: Platform;
  kind: "emulator" | "simulator" | "physical";
  model: string;
  state: "ready" | "booting";
  avdName?: string;
  screen?: string;
  artemisHelper?: boolean;
  artemisOwner?: ArtemisOwner | null;
  busyRunId?: string;
  bootedByTapocalypse?: boolean;
}

export interface ExecResult {
  code: number;
  stdout: Uint8Array;
  text: string;
  stderr: string;
}

/** Runs a command to completion; never throws on non-zero exit (spawn failures become code 127). */
export async function exec(
  cmd: string[],
  opts: { cwd?: string; timeoutMs?: number; stdin?: string; env?: Record<string, string> } = {},
): Promise<ExecResult> {
  let proc;
  try {
    proc = Bun.spawn(cmd, {
      cwd: opts.cwd,
      stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: opts.timeoutMs ?? 30_000,
      env: opts.env ? { ...process.env, ...opts.env } : undefined,
    });
  } catch (e) {
    return { code: 127, stdout: new Uint8Array(), text: "", stderr: (e as Error).message };
  }
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).bytes(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, text: new TextDecoder().decode(stdout), stderr };
}

export const adb = (serial: string, args: string[], timeoutMs?: number) =>
  exec([ADB_BIN, "-s", serial, ...args], { timeoutMs });

/** Parses `adb devices -l`; only rows in state `device` are usable. */
export function parseAdbDevices(out: string): { serial: string; model: string; kind: "emulator" | "physical" }[] {
  return out
    .split("\n")
    .slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter((cols) => cols.length >= 2 && cols[1] === "device")
    .map((cols) => ({
      serial: cols[0],
      model: cols.find((c) => c.startsWith("model:"))?.slice("model:".length) ?? "unknown",
      kind: cols[0].startsWith("emulator-") ? ("emulator" as const) : ("physical" as const),
    }));
}

export async function connectedAndroidSerials(): Promise<string[]> {
  const r = await exec([ADB_BIN, "devices", "-l"]);
  return parseAdbDevices(r.text).map((d) => d.serial);
}

export function artemisLockOwner(serial: string): ArtemisOwner | null {
  const file = path.join(ARTEMIS_LOCK_DIR, `artemis-device-${serial.replace(/[^A-Za-z0-9_-]/g, "_")}.lock`);
  if (!existsSync(file)) return null;
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown; session_id?: unknown; description?: unknown };
    const pid = Number(data.pid);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    process.kill(pid, 0);
    return {
      pid,
      sessionId: typeof data.session_id === "string" ? data.session_id : undefined,
      description: typeof data.description === "string" ? data.description : undefined,
    };
  } catch {
    return null;
  }
}

async function probeAndroid(d: { serial: string; model: string; kind: "emulator" | "physical" }): Promise<Device> {
  const [avd, size, a11y] = await Promise.all([
    d.kind === "emulator" ? adb(d.serial, ["emu", "avd", "name"], 5_000) : null,
    adb(d.serial, ["shell", "wm", "size"], 5_000),
    // Only the optional Artemis backend cares whether its helper is installed.
    config.artemisPath ? adb(d.serial, ["shell", "settings", "get", "secure", "enabled_accessibility_services"], 5_000) : null,
  ]);
  const avdName = avd?.code === 0 ? avd.text.split(/\r?\n/)[0].trim() || undefined : undefined;
  return {
    ...d,
    platform: "android",
    state: "ready",
    avdName,
    screen: size.code === 0 ? size.text.trim().replace(/\s*\n\s*/g, "; ") : undefined,
    artemisHelper: a11y ? a11y.text.includes("com.artemis.helper") : undefined,
    artemisOwner: artemisLockOwner(d.serial),
  };
}

async function listIos(): Promise<Device[]> {
  try {
    const r = await exec(["xcrun", "simctl", "list", "devices", "booted", "-j"], { timeoutMs: 10_000 });
    if (r.code !== 0) return [];
    const data = JSON.parse(r.text) as { devices: Record<string, { udid: string; name: string; state: string }[]> };
    return Object.values(data.devices)
      .flat()
      .filter((s) => s.state === "Booted")
      .map((s) => ({ serial: s.udid, platform: "ios", kind: "simulator", model: s.name, state: "ready" }));
  } catch {
    return [];
  }
}

/** Connected, ready devices on both platforms. */
export async function listDevices(): Promise<Device[]> {
  const [adbOut, ios] = await Promise.all([exec([ADB_BIN, "devices", "-l"]), listIos()]);
  const android = await Promise.all(parseAdbDevices(adbOut.text).map(probeAndroid));
  return [...android, ...ios];
}

export async function screencap(device: Pick<Device, "serial" | "platform">): Promise<Uint8Array> {
  if (device.platform === "android") {
    const r = await adb(device.serial, ["exec-out", "screencap", "-p"], 15_000);
    if (r.code !== 0) throw new Error(`screencap failed: ${r.stderr.trim()}`);
    return r.stdout;
  }
  const tmp = path.join(os.tmpdir(), `tapocalypse-${device.serial}-${Date.now()}.png`);
  try {
    const r = await exec(["xcrun", "simctl", "io", device.serial, "screenshot", "--type=png", tmp], { timeoutMs: 15_000 });
    if (r.code !== 0) throw new Error(`screenshot failed: ${r.stderr.trim()}`);
    return new Uint8Array(await Bun.file(tmp).arrayBuffer());
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Installed app version: Android via `dumpsys package`, iOS via `simctl appinfo`. Null when not installed or unreadable. */
export async function appVersion(
  device: Pick<Device, "serial" | "platform">,
  packageId: string,
): Promise<{ versionName: string | null; versionCode: string | null } | null> {
  if (device.platform === "android") {
    const r = await adb(device.serial, ["shell", "dumpsys", "package", packageId], 15_000);
    if (r.code !== 0) return null;
    const versionName = /^\s*versionName=(\S+)/m.exec(r.text)?.[1] ?? null;
    const versionCode = /^\s*versionCode=(\d+)/m.exec(r.text)?.[1] ?? null;
    return versionName === null && versionCode === null ? null : { versionName, versionCode };
  }
  const r = await exec(["xcrun", "simctl", "appinfo", device.serial, packageId], { timeoutMs: 15_000 });
  if (r.code !== 0) return null;
  const field = (key: string) => new RegExp(`${key}"?\\s*=\\s*"?([^";\\n]+)`).exec(r.text)?.[1].trim() ?? null;
  const versionName = field("CFBundleShortVersionString");
  const versionCode = field("CFBundleVersion");
  return versionName === null && versionCode === null ? null : { versionName, versionCode };
}

/**
 * The id mobile-mcp addresses a device by: emulators by AVD name (its device list shows them under that id, not the adb serial), iOS simulators by UDID,
 * physical Android devices by serial. Falls back to the serial when the AVD name cannot be read.
 */
export async function mobileMcpDeviceId(device: Pick<Device, "serial" | "platform">): Promise<string> {
  if (device.platform !== "android" || !device.serial.startsWith("emulator-")) return device.serial;
  const r = await adb(device.serial, ["emu", "avd", "name"], 5_000);
  const avd = r.code === 0 ? r.text.split(/\r?\n/)[0]!.trim() : "";
  return avd || device.serial;
}

/** Kills mobile-mcp's on-device DeviceServer so Artemis can take the UiAutomation connection. */
export async function stopMobileMcpDeviceServer(serial: string): Promise<number[]> {
  const ps = await adb(serial, ["shell", "ps", "-A", "-o", "PID,ARGS"], 10_000);
  const pids = ps.text
    .split("\n")
    .filter((l) => l.includes("com.mobilenext.mobilecli.DeviceServer"))
    .map((l) => Number(l.trim().split(/\s+/)[0]))
    .filter((n) => Number.isInteger(n) && n > 0);
  for (const pid of pids) await adb(serial, ["shell", "kill", String(pid)], 5_000);
  return pids;
}

/** Installs/upgrades the Artemis helper from the local clone so it matches the checked-out fixes. */
export async function ensureArtemisHelper(serial: string): Promise<void> {
  const r = await exec(["uv", "run", "artemis", "helper", "install", "--serial", serial], {
    cwd: config.artemisPath,
    stdin: "y\n",
    timeoutMs: 120_000,
  });
  if (r.code !== 0) {
    const tail = (r.stderr.trim() || r.text.trim()).split("\n").slice(-5).join("\n");
    throw new Error(`artemis helper install failed: ${tail}`);
  }
}
