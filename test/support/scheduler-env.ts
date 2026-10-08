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

export interface Env {
  scheduler: Scheduler;
  devices: Device[];
  started: [string, StartTarget][];
  markedAssigned: string[];
  markedReleased: string[];
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
}

export function setup(opts: SetupOptions = {}): Env {
  const env: Env = {
    scheduler: undefined as unknown as Scheduler,
    devices: opts.devices ?? [],
    started: [],
    markedAssigned: [],
    markedReleased: [],
  };
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
        ios: { simulators: [], idleShutdownMinutes: 20 },
      },
    },
    listDevices: async () => env.devices,
    bootedCount: (_platform: Platform) => opts.booted ?? 0,
    manualBootCount: (_platform: Platform) => opts.manualBoots ?? 0,
    isBootingSerial: () => false,
    isBootingTarget: (t) => opts.bootingTargets?.includes(t) ?? false,
    markAssigned: (s) => env.markedAssigned.push(s),
    markReleased: (s) => env.markedReleased.push(s),
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

