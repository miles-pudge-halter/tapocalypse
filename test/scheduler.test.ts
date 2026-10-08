import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HttpError } from "../src/config";
import type { Device } from "../src/devices/devices";
import { Scheduler, type SchedulerDeps, type StartTarget } from "../src/runs/scheduler";
import type { Platform, Run } from "../src/runs/types";

const emulator = (serial: string, extra: Partial<Device> = {}): Device => ({
  serial,
  platform: "android",
  kind: "emulator",
  model: "sdk",
  state: "ready",
  ...extra,
});

interface Env {
  scheduler: Scheduler;
  devices: Device[];
  started: [string, StartTarget][];
  markedAssigned: string[];
  markedReleased: string[];
}

function setup(opts: { devices?: Device[]; maxConcurrentRuns?: number; maxBooted?: number; booted?: number } = {}): Env {
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
          avds: ["AVD_A", "AVD_B"],
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
    isBootingSerial: () => false,
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
async function settle(s: Scheduler): Promise<void> {
  await s.schedule();
  const turn = Promise.withResolvers<void>();
  setImmediate(turn.resolve);
  await turn.promise;
}

let counter = 0;
const enqueue = (s: Scheduler, device: { serial?: string; platform?: Platform } = { platform: "android" }) =>
  s.enqueueRun({ projectId: "test-proj", title: `run ${++counter}`, brief: "do things", device });

describe("scheduling", () => {
  test("a platform-only run takes a free emulator; the next one boots an AVD that is not already running", async () => {
    const env = setup({ devices: [emulator("emulator-5556", { avdName: "AVD_B" })] });
    const r1 = await enqueue(env.scheduler);
    const r2 = await enqueue(env.scheduler);
    await settle(env.scheduler);

    expect(env.started).toEqual([
      [r1.id, { serial: "emulator-5556" }],
      [r2.id, { bootTarget: { platform: "android", target: "AVD_A" } }],
    ]);
    expect(env.markedAssigned).toEqual(["emulator-5556"]);
    expect(env.scheduler.queue).toEqual([]);
    expect(env.scheduler.booting.get(r2.id)).toEqual({ platform: "android", target: "AVD_A" });
  });

  test("when the boot cap is reached the run stays queued, then takes the freed device after release", async () => {
    const env = setup({ devices: [emulator("emulator-5556")], maxBooted: 1, booted: 1 });
    const r1 = await enqueue(env.scheduler);
    const r2 = await enqueue(env.scheduler);
    await settle(env.scheduler);

    expect(env.started).toEqual([[r1.id, { serial: "emulator-5556" }]]);
    expect(env.scheduler.queuePosition(r2.id)).toBe(1);
    expect(env.scheduler.queuePosition(r1.id)).toBeNull();

    env.scheduler.release(r1.id);
    await settle(env.scheduler);

    expect(env.markedReleased).toEqual(["emulator-5556"]);
    expect(env.started).toEqual([
      [r1.id, { serial: "emulator-5556" }],
      [r2.id, { serial: "emulator-5556" }],
    ]);
    expect(env.scheduler.queuePosition(r2.id)).toBeNull();
  });

  test("a busy explicit serial stays queued without blocking later platform-only runs", async () => {
    const env = setup({ devices: [emulator("emulator-5556"), emulator("emulator-5558")] });
    const r1 = await enqueue(env.scheduler, { serial: "emulator-5556", platform: "android" });
    await settle(env.scheduler);
    const r2 = await enqueue(env.scheduler, { serial: "emulator-5556", platform: "android" });
    const r3 = await enqueue(env.scheduler);
    await settle(env.scheduler);

    expect(env.started).toEqual([
      [r1.id, { serial: "emulator-5556" }],
      [r3.id, { serial: "emulator-5558" }],
    ]);
    expect(env.scheduler.queuePosition(r2.id)).toBe(1);

    env.scheduler.release(r1.id);
    await settle(env.scheduler);
    expect(env.started.at(-1)).toEqual([r2.id, { serial: "emulator-5556" }]);
  });

  test("a physical device is never chosen for a platform-only request (boots an AVD instead)", async () => {
    const env = setup({ devices: [emulator("R5CT123ABCD", { kind: "physical" })] });
    const r1 = await enqueue(env.scheduler);
    await settle(env.scheduler);

    expect(env.started).toEqual([[r1.id, { bootTarget: { platform: "android", target: "AVD_A" } }]]);
    expect(env.scheduler.assigned.has("R5CT123ABCD")).toBe(false);
  });

  test("a physical device is never chosen even when nothing can be booted", async () => {
    const env = setup({ devices: [emulator("R5CT123ABCD", { kind: "physical" })], maxBooted: 0 });
    const r1 = await enqueue(env.scheduler);
    await settle(env.scheduler);

    expect(env.started).toEqual([]);
    expect(env.scheduler.queuePosition(r1.id)).toBe(1);
  });

  test("a physical device can still be targeted by explicit serial", async () => {
    const env = setup({ devices: [emulator("R5CT123ABCD", { kind: "physical" })] });
    const r1 = await enqueue(env.scheduler, { serial: "R5CT123ABCD", platform: "android" });
    await settle(env.scheduler);

    expect(env.started).toEqual([[r1.id, { serial: "R5CT123ABCD" }]]);
  });

  test("a device held by a live Artemis task is skipped", async () => {
    const env = setup({
      devices: [emulator("emulator-5556", { artemisOwner: { pid: 1 } }), emulator("emulator-5558")],
    });
    const r1 = await enqueue(env.scheduler);
    await settle(env.scheduler);
    expect(env.started).toEqual([[r1.id, { serial: "emulator-5558" }]]);
  });

  test("an explicit serial held by Artemis stays queued", async () => {
    const env = setup({ devices: [emulator("emulator-5556", { artemisOwner: { pid: 1 } })] });
    const r1 = await enqueue(env.scheduler, { serial: "emulator-5556", platform: "android" });
    await settle(env.scheduler);
    expect(env.started).toEqual([]);
    expect(env.scheduler.queuePosition(r1.id)).toBe(1);
  });

  test("excluded serials are never auto-assigned", async () => {
    const env = setup({ devices: [emulator("emulator-5999")], maxBooted: 0 });
    const r1 = await enqueue(env.scheduler);
    await settle(env.scheduler);
    expect(env.started).toEqual([]);
    expect(env.scheduler.queuePosition(r1.id)).toBe(1);
  });

  test("maxConcurrentRuns caps simultaneous assignments", async () => {
    const env = setup({
      devices: [emulator("emulator-5556"), emulator("emulator-5558"), emulator("emulator-5560")],
      maxConcurrentRuns: 2,
    });
    const r1 = await enqueue(env.scheduler);
    const r2 = await enqueue(env.scheduler);
    const r3 = await enqueue(env.scheduler);
    await settle(env.scheduler);

    expect(env.started.map(([id]) => id)).toEqual([r1.id, r2.id]);
    expect(env.scheduler.queuePosition(r3.id)).toBe(1);

    env.scheduler.release(r1.id);
    await settle(env.scheduler);
    expect(env.started.map(([id]) => id)).toEqual([r1.id, r2.id, r3.id]);
  });

  test("overlay marks assigned devices busy and adds a placeholder for booting runs", async () => {
    const env = setup({ devices: [emulator("emulator-5556", { avdName: "AVD_B" })] });
    const r1 = await enqueue(env.scheduler);
    const r2 = await enqueue(env.scheduler);
    await settle(env.scheduler);

    const view = env.scheduler.overlay(env.devices, () => false);
    expect(view.find((d) => d.serial === "emulator-5556")?.busyRunId).toBe(r1.id);
    expect(view.find((d) => d.serial === "booting:AVD_A")).toMatchObject({ state: "booting", busyRunId: r2.id });
  });
});

describe("enqueue validation", () => {
  test("unknown project", async () => {
    const env = setup();
    const err = await env.scheduler
      .enqueueRun({ projectId: "nope", title: "t", brief: "b" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ status: 400, message: "unknown project nope" });
  });

  test("title and brief are required", async () => {
    const env = setup();
    const err = await env.scheduler
      .enqueueRun({ projectId: "test-proj", title: "  ", brief: "b" })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 400, message: "title and brief are required" });
  });

  test("artemis backend is Android-only", async () => {
    const env = setup();
    const err = await env.scheduler
      .enqueueRun({ projectId: "test-proj", title: "t", brief: "b", backend: "artemis", device: { platform: "ios" } })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 400, message: "Artemis backend is Android-only" });
  });

  test("artemis backend on an unconfigured install is rejected", async () => {
    const env = setup({ devices: [emulator("emulator-5556")] });
    const err = await env.scheduler
      .enqueueRun({ projectId: "test-proj", title: "t", brief: "b", backend: "artemis", device: { platform: "android" } })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({
      status: 400,
      message: "Artemis backend is not configured (set artemisPath in tapocalypse.config.json)",
    });
    expect(env.started).toHaveLength(0);
  });

  test("explicit serial that is not connected", async () => {
    const env = setup({ devices: [emulator("emulator-5556")] });
    const err = await env.scheduler
      .enqueueRun({ projectId: "test-proj", title: "t", brief: "b", device: { serial: "emulator-9999", platform: "android" } })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 400, message: "device emulator-9999 not connected" });
  });

  test("explicit serial excluded in config", async () => {
    const env = setup({ devices: [emulator("emulator-5999")] });
    const err = await env.scheduler
      .enqueueRun({ projectId: "test-proj", title: "t", brief: "b", device: { serial: "emulator-5999", platform: "android" } })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 400, message: "device emulator-5999 is excluded in config" });
  });

  test("source.path outside the project is rejected and nothing is queued", async () => {
    const env = setup();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "tapocalypse-outside-"));
    try {
      const err = await env.scheduler
        .enqueueRun({ projectId: "test-proj", title: "t", brief: "b", source: { path: outside } })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HttpError);
      expect(err).toMatchObject({ status: 400, message: `source.path ${outside} is not a worktree of project test-proj` });
      expect(env.scheduler.queue).toEqual([]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test("malformed source is rejected with the offending field path", async () => {
    const env = setup();
    const err = await env.scheduler
      .enqueueRun({ projectId: "test-proj", title: "t", brief: "b", source: { prNumber: -1 } })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ status: 400 });
    expect((err as HttpError).message).toStartWith("source.prNumber: ");
  });

  test("a non-git project records an empty source without a PR lookup", async () => {
    const env = setup();
    const run = await env.scheduler.enqueueRun({
      projectId: "test-proj",
      title: "t",
      brief: "b",
      source: { tickets: ["ABC-1"], labels: { flavor: "dev" } },
    });
    expect(run.build).toBeNull();
    expect(run.source).toMatchObject({ branch: null, commit: null, dirty: null, prStatus: "none", tickets: ["ABC-1"], labels: { flavor: "dev" } });
  });

  test("defaults come from the project and rejected input leaves nothing queued", async () => {
    const env = setup();
    await env.scheduler.enqueueRun({ projectId: "nope", title: "t", brief: "b" }).catch(() => {});
    expect(env.scheduler.queue).toEqual([]);

    const run = await env.scheduler.enqueueRun({ projectId: "test-proj", title: "t", brief: "b" });
    expect(run).toMatchObject({
      backend: "mobile-mcp",
      packageId: "com.example.app",
      requestedBy: "web",
      deviceRequest: { platform: "android" },
      status: "queued",
    });
  });
});
