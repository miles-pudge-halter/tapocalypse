import { config, EMULATOR_BIN } from "../config";
import type { Platform } from "../runs/types";
import { adb, connectedAndroidSerials, exec } from "./devices";

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

export const isBootedByTapocalypse = (serial: string) => booted.has(serial);
export const isBootingSerial = (serial: string) => bootingSerials.has(serial);

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

export async function bootAndroid(avd: string, log: (m: string) => void = () => {}): Promise<string> {
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
  log(`${serial}: screen ${m[1]}x${m[2]} below ${minSize}; overridden to ${minSize} @${minDensity}dpi`);
}

export async function bootIos(udid: string): Promise<string> {
  const r = await exec(["xcrun", "simctl", "boot", udid], { timeoutMs: 60_000 });
  if (r.code !== 0 && !/current state: Booted|already booted/i.test(r.stderr)) {
    throw new Error(`simctl boot ${udid} failed: ${r.stderr.trim()}`);
  }
  const s = await exec(["xcrun", "simctl", "bootstatus", udid], { timeoutMs: 180_000 });
  if (s.code !== 0) throw new Error(`simulator ${udid} did not boot in 180s`);
  booted.set(udid, { platform: "ios", target: udid, lastReleasedAt: null });
  return udid;
}

/** Shuts down tapocalypse-booted devices idle longer than the configured limit. */
export async function reapIdle(now = Date.now()): Promise<void> {
  for (const [serial, b] of booted) {
    const minutes =
      b.platform === "android" ? config.devicePool.android.idleShutdownMinutes : config.devicePool.ios.idleShutdownMinutes;
    if (b.lastReleasedAt === null || now - b.lastReleasedAt < minutes * 60_000) continue;
    booted.delete(serial);
    console.log(`idle shutdown: ${serial} (${b.target})`);
    if (b.platform === "android") await adb(serial, ["emu", "kill"], 10_000);
    else await exec(["xcrun", "simctl", "shutdown", serial], { timeoutMs: 60_000 });
  }
}

export function startIdleReaper(): void {
  setInterval(() => void reapIdle(), 60_000);
}
