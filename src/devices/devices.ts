import { existsSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ADB_BIN, ARTEMIS_LOCK_DIR, config, XCRUN_BIN } from "../config";
import type { Platform } from "../runs/types";

export interface ArtemisOwner {
  pid: number;
  sessionId?: string;
  description?: string;
}

export type DeviceType = "phone" | "tablet" | "watch" | "tv" | "unknown";

export interface Device {
  serial: string;
  platform: Platform;
  kind: "emulator" | "simulator" | "physical";
  model: string;
  /** Friendly label: AVD name with spaces / simulator name / market name or model. */
  name: string;
  /** "Android 14" / "iOS 26.1"; null when unreadable. */
  osVersion: string | null;
  /** Effective resolution as "1440×3120"; null when unknown (always null for iOS simulators). */
  screen: string | null;
  deviceType: DeviceType;
  state: "ready" | "booting";
  avdName?: string;
  artemisHelper?: boolean;
  artemisOwner?: ArtemisOwner | null;
  busyRunId?: string;
  bootedByTapocalypse?: boolean;
  /** True when the serial is in devicePool.android.excludeSerials: never auto-assigned. */
  excluded?: boolean;
  /** ISO time at which an idle Tapocalypse-booted device is shut down; null when not scheduled. */
  idleShutdownAt: string | null;
}

/** A simulator known to simctl, booted or not. */
export interface SimulatorInfo {
  udid: string;
  name: string;
  booted: boolean;
  osVersion: string | null;
  deviceType: DeviceType;
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

/** "Physical size: 1440x3120" (+ optional "Override size: …") → "1440×3120"; the override is what apps actually see. */
export function normalizeScreen(wmSize: string): string | null {
  const m = /Override size:\s*(\d+)x(\d+)/.exec(wmSize) ?? /Physical size:\s*(\d+)x(\d+)/.exec(wmSize);
  return m ? `${m[1]}×${m[2]}` : null;
}

/** `ro.build.characteristics` (comma list: "tablet,nosdcard", "watch", "tv", "emulator"). Empty = could not be read. */
export function androidDeviceType(characteristics: string): DeviceType {
  const tokens = characteristics.toLowerCase().split(",").map((t) => t.trim()).filter(Boolean);
  if (tokens.length === 0) return "unknown";
  if (tokens.includes("watch")) return "watch";
  if (tokens.some((t) => t === "tv" || t === "television")) return "tv";
  if (tokens.includes("tablet")) return "tablet";
  if (tokens.includes("automotive")) return "unknown";
  return "phone";
}

export function androidName(opts: { avdName?: string; marketName?: string; model: string; serial: string }): string {
  const clean = (s: string) => s.replace(/_/g, " ").replace(/\s+/g, " ").trim();
  if (opts.avdName) return clean(opts.avdName);
  if (opts.marketName) return clean(opts.marketName);
  return opts.model && opts.model !== "unknown" ? clean(opts.model) : opts.serial;
}

/** `com.apple.CoreSimulator.SimRuntime.iOS-26-1` → "iOS 26.1". */
export function iosRuntimeVersion(runtimeKey: string): string | null {
  const m = /SimRuntime\.([A-Za-z]+)-(\d+(?:-\d+)*)$/.exec(runtimeKey);
  return m ? `${m[1]} ${m[2]!.replace(/-/g, ".")}` : null;
}

/** From `com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro`; the simulator name is the fallback. */
export function iosDeviceType(identifier: string | undefined, name = ""): DeviceType {
  const id = (identifier ?? "").split(".").pop() || name;
  if (/iPhone|iPod/i.test(id)) return "phone";
  if (/iPad/i.test(id)) return "tablet";
  if (/Apple-?Watch/i.test(id)) return "watch";
  if (/Apple-?TV/i.test(id)) return "tv";
  return "unknown";
}

/** Parses `simctl list devices -j` (all simulators, any state); unavailable ones are dropped. */
export function parseSimctlDevices(json: string): SimulatorInfo[] {
  type Raw = { udid: string; name: string; state: string; isAvailable?: boolean; deviceTypeIdentifier?: string };
  let data: { devices?: Record<string, Raw[]> };
  try {
    data = JSON.parse(json) as typeof data;
  } catch {
    return [];
  }
  const out: SimulatorInfo[] = [];
  for (const [runtime, sims] of Object.entries(data.devices ?? {})) {
    for (const s of sims) {
      if (s.isAvailable === false) continue;
      out.push({
        udid: s.udid,
        name: s.name,
        booted: s.state === "Booted",
        osVersion: iosRuntimeVersion(runtime),
        deviceType: iosDeviceType(s.deviceTypeIdentifier, s.name),
      });
    }
  }
  return out;
}

interface Memo<T> {
  at: number;
  value: Promise<T>;
}

/** Per-key result cache that also shares one in-flight load between concurrent callers. */
function memo<T>(cache: Map<string, Memo<T>>, key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = load();
  cache.set(key, { at: Date.now(), value });
  value.catch(() => cache.delete(key));
  return value;
}

interface AndroidStatic {
  avdName?: string;
  marketName?: string;
  osVersion: string | null;
  screen: string | null;
  deviceType: DeviceType;
}

// Identity/hardware facts barely change; the Artemis helper flag changes after an install, so it expires sooner.
const STATIC_TTL_MS = 30_000;
const HELPER_TTL_MS = 5_000;
const staticProbes = new Map<string, Memo<AndroidStatic>>();
const helperProbes = new Map<string, Memo<boolean>>();

/** Forget cached probes of a device (its screen override or helper state just changed). */
export function invalidateDeviceProbes(serial: string): void {
  staticProbes.delete(serial);
  helperProbes.delete(serial);
}

async function loadAndroidStatic(d: { serial: string; kind: "emulator" | "physical" }): Promise<AndroidStatic> {
  const [avd, size, props] = await Promise.all([
    d.kind === "emulator" ? adb(d.serial, ["emu", "avd", "name"], 5_000) : null,
    adb(d.serial, ["shell", "wm", "size"], 5_000),
    adb(
      d.serial,
      ["shell", "getprop ro.build.version.release; getprop ro.build.characteristics; getprop ro.product.marketname"],
      5_000,
    ),
  ]);
  const [release = "", characteristics = "", marketName = ""] = props.code === 0 ? props.text.split(/\r?\n/).map((l) => l.trim()) : [];
  return {
    avdName: avd?.code === 0 ? avd.text.split(/\r?\n/)[0]!.trim() || undefined : undefined,
    marketName: marketName || undefined,
    osVersion: release ? `Android ${release}` : null,
    screen: size.code === 0 ? normalizeScreen(size.text) : null,
    deviceType: androidDeviceType(characteristics),
  };
}

async function probeAndroid(d: { serial: string; model: string; kind: "emulator" | "physical" }): Promise<Device> {
  const [info, helper] = await Promise.all([
    memo(staticProbes, d.serial, STATIC_TTL_MS, () => loadAndroidStatic(d)),
    // Only the optional Artemis backend cares whether its helper is installed.
    config.artemisPath
      ? memo(helperProbes, d.serial, HELPER_TTL_MS, async () =>
          (await adb(d.serial, ["shell", "settings", "get", "secure", "enabled_accessibility_services"], 5_000)).text.includes("com.artemis.helper"),
        )
      : undefined,
  ]);
  return {
    ...d,
    platform: "android",
    name: androidName({ avdName: info.avdName, marketName: info.marketName, model: d.model, serial: d.serial }),
    osVersion: info.osVersion,
    screen: info.screen,
    deviceType: info.deviceType,
    state: "ready",
    avdName: info.avdName,
    artemisHelper: helper,
    artemisOwner: artemisLockOwner(d.serial),
    idleShutdownAt: null,
  };
}

let simulators: SimulatorInfo[] = [];
let lastDevices: Device[] = [];
let idleShutdownLookup: (serial: string) => string | null = () => null;

/** The pool registers how to ask "when will this idle device be shut down" (devices.ts cannot import the pool). */
export function setIdleShutdownLookup(fn: (serial: string) => string | null): void {
  idleShutdownLookup = fn;
}

/** What the most recent `listDevices()` saw, including simulators that are not booted; empty before the first call. */
export function lastDeviceSnapshot(): { devices: readonly Device[]; simulators: readonly SimulatorInfo[] } {
  return { devices: lastDevices, simulators };
}

async function listIos(): Promise<Device[]> {
  const r = await exec([XCRUN_BIN, "simctl", "list", "devices", "-j"], { timeoutMs: 10_000 });
  simulators = r.code === 0 ? parseSimctlDevices(r.text) : [];
  return simulators
    .filter((s) => s.booted)
    .map((s) => ({
      serial: s.udid,
      platform: "ios",
      kind: "simulator",
      model: s.name,
      name: s.name,
      osVersion: s.osVersion,
      screen: null,
      deviceType: s.deviceType,
      state: "ready",
      idleShutdownAt: null,
    }));
}

/** Connected, ready devices on both platforms. Slow probes run in parallel and are cached briefly. */
export async function listDevices(): Promise<Device[]> {
  const [adbOut, ios] = await Promise.all([exec([ADB_BIN, "devices", "-l"]), listIos()]);
  const connected = parseAdbDevices(adbOut.text);
  const serials = new Set(connected.map((d) => d.serial));
  for (const cache of [staticProbes, helperProbes]) {
    for (const key of cache.keys()) if (!serials.has(key)) cache.delete(key);
  }
  const android = await Promise.all(connected.map(probeAndroid));
  const excluded = new Set(config.devicePool.android.excludeSerials);
  lastDevices = [...android, ...ios].map((d) => ({ ...d, idleShutdownAt: idleShutdownLookup(d.serial), excluded: excluded.has(d.serial) }));
  return lastDevices;
}

export async function screencap(device: Pick<Device, "serial" | "platform">): Promise<Uint8Array> {
  if (device.platform === "android") {
    const r = await adb(device.serial, ["exec-out", "screencap", "-p"], 15_000);
    if (r.code !== 0) throw new Error(`screencap failed: ${r.stderr.trim()}`);
    return r.stdout;
  }
  const tmp = path.join(os.tmpdir(), `tapocalypse-${device.serial}-${Date.now()}.png`);
  try {
    const r = await exec([XCRUN_BIN, "simctl", "io", device.serial, "screenshot", "--type=png", tmp], { timeoutMs: 15_000 });
    if (r.code !== 0) throw new Error(`screenshot failed: ${r.stderr.trim()}`);
    return new Uint8Array(await Bun.file(tmp).arrayBuffer());
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Package/bundle ids only; anything else must never reach `adb shell`, which re-parses its arguments with the device's sh. */
const SAFE_APP_ID = /^[A-Za-z0-9._-]+$/;

/** Installed app version: Android via `dumpsys package`, iOS via `simctl appinfo`. Null when not installed or unreadable. */
export async function appVersion(
  device: Pick<Device, "serial" | "platform">,
  packageId: string,
): Promise<{ versionName: string | null; versionCode: string | null } | null> {
  if (!SAFE_APP_ID.test(packageId)) return null;
  if (device.platform === "android") {
    const r = await adb(device.serial, ["shell", "dumpsys", "package", packageId], 15_000);
    if (r.code !== 0) return null;
    const versionName = /^\s*versionName=(\S+)/m.exec(r.text)?.[1] ?? null;
    const versionCode = /^\s*versionCode=(\d+)/m.exec(r.text)?.[1] ?? null;
    return versionName === null && versionCode === null ? null : { versionName, versionCode };
  }
  const r = await exec([XCRUN_BIN, "simctl", "appinfo", device.serial, packageId], { timeoutMs: 15_000 });
  if (r.code !== 0) return null;
  const field = (key: string) => new RegExp(`${key}"?\\s*=\\s*"?([^";\\n]+)`).exec(r.text)?.[1].trim() ?? null;
  let versionName = field("CFBundleShortVersionString");
  const versionCode = field("CFBundleVersion");
  // `simctl appinfo` omits CFBundleShortVersionString for many apps (observed with Flutter builds); read it from the bundle's Info.plist.
  const bundlePath = /^\s*Path\s*=\s*"([^"]+)"/m.exec(r.text)?.[1];
  if (versionName === null && bundlePath) {
    const plist = await exec(["plutil", "-extract", "CFBundleShortVersionString", "raw", "-o", "-", `${bundlePath}/Info.plist`], { timeoutMs: 5_000 });
    if (plist.code === 0 && plist.text.trim()) versionName = plist.text.trim();
  }
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
