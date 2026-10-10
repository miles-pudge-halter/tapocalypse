import { LeaseStore } from "../../src/devices/leases";
import { Scheduler, type SchedulerDeps, type StartTarget } from "../../src/runs/scheduler";
import type { Device } from "../../src/devices/devices";
import type { Platform, Run } from "../../src/runs/types";

export const emulator = (serial: string, extra: Partial<Device> = {}): Device => ({
  serial,
  platform: "android",
  kind: "emulator",
  model: "sdk",
  name: "sdk",
  osVersion: "Android 14",
  screen: "1080×2400",
  deviceType: "phone",
  state: "ready",
  idleShutdownAt: null,
  ...extra,
});

/** A boot the scheduler asked for; the test decides when (and whether) it finishes. */
export interface PendingBoot {
  platform: Platform;
  target: string;
  finish(serial: string): void;
  fail(message: string): void;
}

export interface Env {
  scheduler: Scheduler;
  leases: LeaseStore;
  devices: Device[];
  started: [string, StartTarget][];
  markedAssigned: string[];
  markedReleased: string[];
  /** Boots started on behalf of agent tickets. */
  boots: PendingBoot[];
  /** Shared by the scheduler and the lease store; move it to age tickets and leases. */
  clock: { t: number };
  /** While true, every `listDevices()` call parks until released through `pendingLists` (oldest first). */
  holdLists: boolean;
  pendingLists: (() => void)[];
}

export interface SetupOptions {
  devices?: Device[];
  maxConcurrentRuns?: number;
  maxBooted?: number;
  booted?: number;
  /** Manual boots in flight (pool `manualBootCount`). */
  manualBoots?: number;
  /** AVD names / UDIDs with a boot in flight in the pool. */
  bootingTargets?: string[];
  avds?: string[];
  simulators?: string[];
}

export function setup(opts: SetupOptions = {}): Env {
  const clock = { t: Date.parse("2026-03-02T09:00:00.000Z") };
  const env: Env = {
    scheduler: undefined as unknown as Scheduler,
    leases: undefined as unknown as LeaseStore,
    devices: opts.devices ?? [],
    started: [],
    markedAssigned: [],
    markedReleased: [],
    boots: [],
    clock,
    holdLists: false,
    pendingLists: [],
  };
  const isBootingSerial = () => false;
  env.leases = new LeaseStore({
    now: () => clock.t,
    markAssigned: (s) => env.markedAssigned.push(s),
    markReleased: (s) => env.markedReleased.push(s),
    isBootingSerial,
    deviceName: (s) => env.devices.find((d) => d.serial === s)?.name ?? s,
  });
  const deps: SchedulerDeps = {
    config: {
      maxConcurrentRuns: opts.maxConcurrentRuns ?? 4,
      devicePool: {
        android: {
          avds: opts.avds ?? ["AVD_A", "AVD_B"],
          basePort: 5560,
          maxBooted: opts.maxBooted ?? 3,
          minSize: "720x1280",
          minDensity: 320,
          idleShutdownMinutes: 20,
          excludeSerials: ["emulator-5999"],
        },
        ios: { simulators: opts.simulators ?? [], idleShutdownMinutes: 20 },
      },
    },
    now: () => clock.t,
    listDevices: async () => {
      if (env.holdLists) {
        const gate = Promise.withResolvers<void>();
        env.pendingLists.push(gate.resolve);
        await gate.promise;
      }
      return env.devices;
    },
    bootedCount: (_platform: Platform) => opts.booted ?? 0,
    manualBootCount: (_platform: Platform) => opts.manualBoots ?? 0,
    isBootingTarget: (t) => opts.bootingTargets?.includes(t) ?? false,
    leases: env.leases,
    boot: (platform, target) => {
      const done = Promise.withResolvers<string>();
      env.boots.push({
        platform,
        target,
        finish: (serial) => done.resolve(serial),
        fail: (message) => done.reject(new Error(message)),
      });
      return done.promise;
    },
    startRun: (run: Run, target: StartTarget) => {
      env.started.push([run.id, target]);
    },
    cancelActive: async () => {},
  };
  env.scheduler = new Scheduler(deps);
  return env;
}

/** Lets every pending scheduling pass (including coalesced reruns) finish; passes only await microtasks. */
export async function settle(s: Scheduler): Promise<void> {
  await s.schedule();
  const turn = Promise.withResolvers<void>();
  setImmediate(turn.resolve);
  await turn.promise;
}
