import { config, EMULATOR_BIN, HttpError, XCRUN_BIN } from "../config";
import type { Platform } from "../runs/types";
import { deviceOwner } from "./leases";
import {
  adb,
  androidDeviceType,
  connectedAndroidSerials,
  exec,
  invalidateDeviceProbes,
  lastDeviceSnapshot,
  listDevices,
  setIdleShutdownLookup,
} from "./devices";

interface BootedEntry {
  platform: Platform;
  /** AVD name (android) or UDID (ios). */
  target: string;
  lastReleasedAt: number | null;
}

/** Devices this process booted; only these are ever shut down. Not persisted. */
const booted = new Map<string, BootedEntry>();
/** Serials whose emulator is starting but not yet boot-complete (must not be scheduled or reuse their port). */
const bootingSerials = new Set<string>();
/**
 * Every boot in flight, by AVD name / UDID. Reserved synchronously (before any await) so the same target is never booted
 * twice and the maxBooted accounting sees a boot the instant it is requested. `manual` = started from the Devices page / API.
 */
const inFlight = new Map<string, { platform: Platform; manual: boolean }>();

export const isBootedByTapocalypse = (serial: string) => booted.has(serial);
export const isBootingSerial = (serial: string) => bootingSerials.has(serial);
export const isBootingTarget = (target: string) => inFlight.has(target);

/** Boots started through `bootTarget` that have not finished. The scheduler counts these against maxBooted next to its own boots. */
export function manualBootCount(platform: Platform): number {
  return [...inFlight.values()].filter((b) => b.manual && b.platform === platform).length;
}

function inFlightCount(platform: Platform): number {
  return [...inFlight.values()].filter((b) => b.platform === platform).length;
}

/** Synchronous: claims `target` or throws 409. Returns the release function. */
function reserveBoot(platform: Platform, target: string, manual: boolean): () => void {
  if (inFlight.has(target)) throw new HttpError(409, `${target} is already booting`);
  inFlight.set(target, { platform, manual });
  return () => void inFlight.delete(target);
}

export interface BootOptions {
  /** Boot watch/TV images too. Scheduler boots leave this off: only phones and tablets can run QA. */
  allowNonQaDevice?: boolean;
}

const QA_INCAPABLE = ["watch", "tv"];

export function bootedCount(platform: Platform): number {
  return [...booted.values()].filter((b) => b.platform === platform).length;
}

export function markAssigned(serial: string): void {
  const b = booted.get(serial);
  if (b) b.lastReleasedAt = null;
}

export function markReleased(serial: string): void {
  const b = booted.get(serial);
  if (b) b.lastReleasedAt = Date.now();
}

export async function bootAndroid(avd: string, log: (m: string) => void = () => {}, opts: BootOptions = {}): Promise<string> {
  const release = reserveBoot("android", avd, false);
  try {
    return await launchAndroid(avd, log, opts);
  } finally {
    release();
  }
}

async function launchAndroid(avd: string, log: (m: string) => void, opts: BootOptions): Promise<string> {
  if (!EMULATOR_BIN) throw new Error("emulator binary not found");
  const pool = config.devicePool.android;
  const taken = new Set([...(await connectedAndroidSerials()), ...bootingSerials]);
  let port = pool.basePort + (pool.basePort % 2);
  while (taken.has(`emulator-${port}`)) port += 2;
  const serial = `emulator-${port}`;
  bootingSerials.add(serial);
  try {
    Bun.spawn([EMULATOR_BIN, "-avd", avd, "-port", String(port), "-no-snapshot-save", "-no-boot-anim", "-no-audio"], {
      stdio: ["ignore", "ignore", "ignore"],
      // Own process group: Ctrl-C on the server must not take the emulator down with it.
      detached: true,
    }).unref();
    log(`emulator ${avd} starting on ${serial}`);
    const deadline = Date.now() + 180_000;
    for (;;) {
      await Bun.sleep(2_000);
      const r = await adb(serial, ["shell", "getprop", "sys.boot_completed"], 5_000);
      if (r.code === 0 && r.text.trim() === "1") break;
      if (Date.now() > deadline) {
        await adb(serial, ["emu", "kill"], 10_000);
        throw new Error(`emulator ${avd} did not boot in 180s`);
      }
    }
    if (!opts.allowNonQaDevice) {
      const characteristics = await adb(serial, ["shell", "getprop", "ro.build.characteristics"], 5_000);
      const type = androidDeviceType(characteristics.text.trim());
      if (QA_INCAPABLE.includes(type)) {
        await adb(serial, ["emu", "kill"], 10_000);
        throw new Error(`${avd} is a ${type} image; only phones and tablets can run QA`);
      }
    }
    await ensureMinScreen(serial, log);
    booted.set(serial, { platform: "android", target: avd, lastReleasedAt: null });
    return serial;
  } finally {
    bootingSerials.delete(serial);
  }
}

async function ensureMinScreen(serial: string, log: (m: string) => void): Promise<void> {
  const { minSize, minDensity } = config.devicePool.android;
  const r = await adb(serial, ["shell", "wm", "size"], 5_000);
  const m = /Physical size:\s*(\d+)x(\d+)/.exec(r.text);
  if (!m) return;
  const [w, h] = [Number(m[1]), Number(m[2])].sort((a, b) => a - b);
  const [minW, minH] = minSize.split("x").map(Number).sort((a, b) => a - b);
  if (w >= minW && h >= minH) return;
  await adb(serial, ["shell", "wm", "size", minSize], 5_000);
  await adb(serial, ["shell", "wm", "density", String(minDensity)], 5_000);
  invalidateDeviceProbes(serial);
}

export async function bootIos(udid: string, opts: BootOptions = {}): Promise<string> {
  const release = reserveBoot("ios", udid, false);
  try {
    return await launchIos(udid, opts);
  } finally {
    release();
  }
}

async function launchIos(udid: string, opts: BootOptions): Promise<string> {
  const type = lastDeviceSnapshot().simulators.find((s) => s.udid === udid)?.deviceType;
  if (!opts.allowNonQaDevice && type && QA_INCAPABLE.includes(type)) {
    throw new Error(`simulator ${udid} is a ${type}; only phones and tablets can run QA`);
  }
  const r = await exec([XCRUN_BIN, "simctl", "boot", udid], { timeoutMs: 60_000 });
  const alreadyBooted = r.code !== 0 && /current state: Booted|already booted/i.test(r.stderr);
  if (r.code !== 0 && !alreadyBooted) throw new Error(`simctl boot ${udid} failed: ${r.stderr.trim()}`);
  const s = await exec([XCRUN_BIN, "simctl", "bootstatus", udid], { timeoutMs: 180_000 });
  if (s.code !== 0) throw new Error(`simulator ${udid} did not boot in 180s`);
  // A simulator that was already running is the user's: never claim it, or the idle reaper would shut it down.
  if (!alreadyBooted) booted.set(udid, { platform: "ios", target: udid, lastReleasedAt: null });
  return udid;
}

const idleMinutes = (platform: Platform) =>
  platform === "android" ? config.devicePool.android.idleShutdownMinutes : config.devicePool.ios.idleShutdownMinutes;

/** When an idle Tapocalypse-booted device will be shut down; null for assigned or foreign devices. */
export function idleShutdownAt(serial: string): string | null {
  const b = booted.get(serial);
  if (!b || b.lastReleasedAt === null) return null;
  return new Date(b.lastReleasedAt + idleMinutes(b.platform) * 60_000).toISOString();
}
setIdleShutdownLookup(idleShutdownAt);

async function shutdownEntry(serial: string, b: BootedEntry): Promise<void> {
  booted.delete(serial);
  if (b.platform === "android") await adb(serial, ["emu", "kill"], 10_000);
  else await exec([XCRUN_BIN, "simctl", "shutdown", serial], { timeoutMs: 60_000 });
  invalidateDeviceProbes(serial);
}

export interface PoolView {
  maxConcurrentRuns: number;
  activeRuns: number;
  maxBooted: number;
  bootedCount: number;
  /** Configured AVDs / simulators that are not running. */
  bootable: { platform: Platform; target: string; name: string }[];
  idle: { serial: string; shutdownAt: string }[];
  /** Agents and queued runs that wait for *any* device of a platform (waiters for one serial are on that device). */
  waiting: { platform: Platform; holders: string[]; runIds: string[] }[];
}

/**
 * Pool state for the Devices page. Reads what the latest `listDevices()` saw, so call that first for a fresh view.
 * `activeRuns` is the scheduler's count of assigned + booting runs; `waiting` is its per-platform wait list.
 */
export function poolView(activeRuns = 0, waiting: PoolView["waiting"] = []): PoolView {
  const { devices, simulators } = lastDeviceSnapshot();
  const runningAvds = new Set(devices.flatMap((d) => (d.avdName ? [d.avdName] : [])));
  const bootedUdids = new Set(devices.filter((d) => d.platform === "ios").map((d) => d.serial));
  const bootable: PoolView["bootable"] = [
    ...config.devicePool.android.avds
      .filter((avd) => !runningAvds.has(avd) && !inFlight.has(avd))
      .map((avd) => ({ platform: "android" as const, target: avd, name: avd.replace(/_/g, " ") })),
    ...config.devicePool.ios.simulators
      .filter((udid) => !bootedUdids.has(udid) && !inFlight.has(udid))
      .map((udid) => ({ platform: "ios" as const, target: udid, name: simulators.find((s) => s.udid === udid)?.name ?? udid })),
  ];
  const idle = [...booted.keys()].flatMap((serial) => {
    const shutdownAt = idleShutdownAt(serial);
    return shutdownAt ? [{ serial, shutdownAt }] : [];
  });
  return {
    maxConcurrentRuns: config.maxConcurrentRuns,
    activeRuns,
    maxBooted: config.devicePool.android.maxBooted,
    bootedCount: bootedCount("android") + inFlightCount("android"),
    bootable,
    idle,
    waiting,
  };
}

/**
 * Boots a configured AVD (android) or simulator UDID (ios) on request. The device is marked idle immediately,
 * so it is reaped after the idle window unless a run claims it first.
 */
export async function bootTarget(platform: Platform, target: string): Promise<string> {
  const configured = platform === "android" ? config.devicePool.android.avds : config.devicePool.ios.simulators;
  if (!configured.includes(target)) throw new HttpError(400, `${target} is not listed in devicePool.${platform}`);
  // Everything up to the reservation is synchronous: two requests in the same tick cannot both pass the checks.
  if (inFlight.has(target)) throw new HttpError(409, `${target} is already booting`);
  if (platform === "android" && bootedCount("android") + inFlightCount("android") >= config.devicePool.android.maxBooted) {
    throw new HttpError(409, `emulator limit reached (maxBooted ${config.devicePool.android.maxBooted})`);
  }
  const release = reserveBoot(platform, target, true);
  try {
    const running = (await listDevices()).some((d) => (platform === "android" ? d.avdName === target : d.serial === target));
    if (running) throw new HttpError(409, `${target} is already running`);
    const opts = { allowNonQaDevice: true };
    const serial = platform === "android" ? await launchAndroid(target, () => {}, opts) : await launchIos(target, opts);
    markReleased(serial);
    return serial;
  } finally {
    release();
  }
}

/** Shuts down a device this process booted that no run or agent lease is using. */
export async function shutdownDevice(serial: string): Promise<void> {
  const owner = deviceOwner(serial);
  if (owner?.kind === "agent") throw new HttpError(409, `${serial} is held by ${owner.lease.holder}`);
  if (owner?.kind === "run") throw new HttpError(409, `${serial} is in use by a run`);
  const b = booted.get(serial);
  if (!b) throw new HttpError(409, `${serial} was not booted by Tapocalypse`);
  if (b.lastReleasedAt === null) throw new HttpError(409, `${serial} is in use`);
  await shutdownEntry(serial, b);
}

/** Shuts down tapocalypse-booted devices idle longer than the configured limit. */
export async function reapIdle(now = Date.now()): Promise<void> {
  for (const [serial, b] of booted) {
    if (b.lastReleasedAt === null || now - b.lastReleasedAt < idleMinutes(b.platform) * 60_000) continue;
    console.log(`idle shutdown: ${serial} (${b.target})`);
    await shutdownEntry(serial, b);
  }
}

export function startIdleReaper(): void {
  setInterval(() => void reapIdle(), 60_000);
}
