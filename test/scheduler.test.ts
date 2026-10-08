import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HttpError } from "../src/config";
import type { Scheduler } from "../src/runs/scheduler";
import type { Platform } from "../src/runs/types";
import { emulator, setup, settle } from "./support/scheduler-env";

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

describe("device types", () => {
  test("watches and TVs are never auto-assigned", async () => {
    const env = setup({
      devices: [emulator("emulator-5556", { deviceType: "watch" }), emulator("emulator-5558", { deviceType: "tv" })],
      maxBooted: 0,
    });
    const r1 = await enqueue(env.scheduler);
    await settle(env.scheduler);
    expect(env.started).toEqual([]);
    expect(env.scheduler.queuePosition(r1.id)).toBe(1);
  });

  test("tablets and unknown device types are still used", async () => {
    const env = setup({ devices: [emulator("emulator-5556", { deviceType: "tablet" })] });
    const r1 = await enqueue(env.scheduler);
    await settle(env.scheduler);
    expect(env.started).toEqual([[r1.id, { serial: "emulator-5556" }]]);
  });

  test("an explicit watch serial is rejected", async () => {
    const env = setup({ devices: [emulator("emulator-5556", { deviceType: "watch" })] });
    const err = await enqueue(env.scheduler, { serial: "emulator-5556", platform: "android" }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 400, message: "device emulator-5556 is a watch; only phones and tablets can run QA" });
    expect(env.scheduler.queue).toEqual([]);
  });
});

describe("queue reasons", () => {
  test("explain why each queued run waits and clear once it starts", async () => {
    const env = setup({ devices: [emulator("emulator-5556")], maxBooted: 1, booted: 1 });
    const r1 = await enqueue(env.scheduler, { serial: "emulator-5556", platform: "android" });
    const r2 = await enqueue(env.scheduler, { serial: "emulator-5556", platform: "android" });
    const r3 = await enqueue(env.scheduler);
    const r4 = await enqueue(env.scheduler, { serial: "emulator-5560", platform: "android" }).catch(() => null);
    await settle(env.scheduler);

    expect(env.scheduler.queueReason(r1.id)).toBeNull();
    expect(env.scheduler.queueReason(r2.id)).toBe("emulator-5556 is busy");
    expect(env.scheduler.queueReason(r3.id)).toBe("maxBooted (1) reached");
    expect(r4).toBeNull();

    env.scheduler.release(r1.id);
    await settle(env.scheduler);
    expect(env.scheduler.queueReason(r2.id)).toBeNull();
    expect(env.scheduler.queueReason(r3.id)).toBe("maxBooted (1) reached");
  });

  test("with every AVD already running and busy the reason is that all devices are busy", async () => {
    const env = setup({
      devices: [emulator("emulator-5556", { avdName: "AVD_A" }), emulator("emulator-5558", { avdName: "AVD_B" })],
      maxBooted: 3,
    });
    await enqueue(env.scheduler);
    await enqueue(env.scheduler);
    const r3 = await enqueue(env.scheduler);
    await settle(env.scheduler);
    expect(env.scheduler.queueReason(r3.id)).toBe("all android devices busy");
  });

  test("a full run slot count is reported for every queued run", async () => {
    const env = setup({ devices: [emulator("emulator-5556"), emulator("emulator-5558")], maxConcurrentRuns: 1 });
    await enqueue(env.scheduler);
    const r2 = await enqueue(env.scheduler);
    await settle(env.scheduler);
    expect(env.scheduler.queueReason(r2.id)).toBe("maxConcurrentRuns (1) reached");
  });

  test("a queued run announces its reason change on the bus", async () => {
    const env = setup({ devices: [emulator("emulator-5556")], maxBooted: 0 });
    const seen: (string | null)[] = [];
    env.scheduler.bus.on("run", (r: { id: string }) => seen.push(env.scheduler.queueReason(r.id)));
    await enqueue(env.scheduler);
    await enqueue(env.scheduler);
    await settle(env.scheduler);
    expect(seen).toContain("maxBooted (0) reached");
  });
});

describe("enqueue limits and options", () => {
  test("title over 200 characters and brief over 20000 characters are rejected", async () => {
    const env = setup();
    const longTitle = await env.scheduler
      .enqueueRun({ projectId: "test-proj", title: "x".repeat(201), brief: "b" })
      .catch((e: unknown) => e);
    expect(longTitle).toMatchObject({ status: 400, message: "title must be at most 200 characters" });
    const longBrief = await env.scheduler
      .enqueueRun({ projectId: "test-proj", title: "t", brief: "x".repeat(20_001) })
      .catch((e: unknown) => e);
    expect(longBrief).toMatchObject({ status: 400, message: "brief must be at most 20000 characters" });
    expect(env.scheduler.queue).toEqual([]);
  });

  test("model and thinking are stored; an invalid thinking level is rejected", async () => {
    const env = setup();
    const run = await env.scheduler.enqueueRun({ projectId: "test-proj", title: "t", brief: "b", model: "anthropic/x", thinking: "high" });
    expect(run).toMatchObject({ model: "anthropic/x", thinking: "high" });
    const err = await env.scheduler
      .enqueueRun({ projectId: "test-proj", title: "t", brief: "b", thinking: "ludicrous" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).message).toStartWith("thinking: ");
  });

  test("install must be an existing absolute file with the platform's extension", async () => {
    const env = setup();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tapocalypse-install-"));
    try {
      const apk = path.join(dir, "app.apk");
      fs.writeFileSync(apk, "x");
      const base = { projectId: "test-proj", title: "t", brief: "b" };
      const ok = await env.scheduler.enqueueRun({ ...base, install: { path: apk } });
      expect(ok.install).toEqual({ path: apk });
      const relative = await env.scheduler.enqueueRun({ ...base, install: { path: "app.apk" } }).catch((e: unknown) => e);
      expect(relative).toMatchObject({ status: 400, message: "install.path must be an absolute path" });
      const missing = await env.scheduler.enqueueRun({ ...base, install: { path: path.join(dir, "no.apk") } }).catch((e: unknown) => e);
      expect(missing).toMatchObject({ status: 400 });
      const wrongExt = await env.scheduler.enqueueRun({ ...base, install: { path: path.join(dir, "app.ipa") } }).catch((e: unknown) => e);
      expect(wrongExt).toMatchObject({ status: 400, message: "install.path must be a .apk for android" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("retry", () => {
  test("queues the next attempt with the same parameters and links both runs", async () => {
    const env = setup({ devices: [emulator("emulator-5556")] });
    const first = await env.scheduler.enqueueRun({
      projectId: "test-proj",
      title: "flaky boot",
      brief: "b",
      model: "anthropic/x",
      device: { platform: "android" },
    });
    await settle(env.scheduler);
    first.status = "error";
    first.errorKind = "infra";
    env.scheduler.release(first.id);

    const next = env.scheduler.retry(first);
    expect(next).toMatchObject({
      status: "queued",
      attempt: 2,
      retryOf: first.id,
      retriedBy: null,
      title: "flaky boot",
      brief: "b",
      model: "anthropic/x",
      checks: [],
      deviceSerial: null,
    });
    expect(first.retriedBy).toBe(next.id);
    await settle(env.scheduler);
    expect(env.started.at(-1)).toEqual([next.id, { serial: "emulator-5556" }]);
  });
});

describe("run deletion", () => {
  test("a run cancelled mid-preflight cannot be deleted until its runner released the device", async () => {
    const env = setup({ devices: [emulator("emulator-5556")] });
    const run = await enqueue(env.scheduler);
    await settle(env.scheduler);
    expect(env.started).toHaveLength(1);
    // What the runner's cancel does while preflight is still working: terminal status, slot still held.
    run.status = "cancelled";
    env.scheduler.update(run);
    expect(() => env.scheduler.removeRun(run.id)).toThrow(HttpError);
    expect(() => env.scheduler.removeRun(run.id)).toThrow(/still shutting down/);
    env.scheduler.release(run.id);
    env.scheduler.removeRun(run.id);
    expect(env.scheduler.getLive(run.id)).toBeUndefined();
  });

  test("a run that is still booting its device cannot be deleted either", async () => {
    const env = setup();
    const run = await enqueue(env.scheduler);
    await settle(env.scheduler);
    expect(env.started[0]![1]).toEqual({ bootTarget: { platform: "android", target: "AVD_A" } });
    run.status = "cancelled";
    env.scheduler.update(run);
    expect(() => env.scheduler.removeRun(run.id)).toThrow(/still shutting down/);
  });

  test("cancelling a queued run records errorKind cancelled", async () => {
    const env = setup({ maxConcurrentRuns: 0 });
    const run = await enqueue(env.scheduler);
    const cancelled = await env.scheduler.cancelRun(run.id);
    expect(cancelled).toMatchObject({ status: "cancelled", errorKind: "cancelled" });
  });
});

describe("input limits", () => {
  const base = { projectId: "test-proj", title: "t", brief: "b" };

  test("packageId must look like an application id (no shell metacharacters)", async () => {
    const env = setup();
    for (const bad of ["com.x; pm clear com.android.chrome", "com.x com.y", "$(id)", "nodots"]) {
      const err = await env.scheduler.enqueueRun({ ...base, packageId: bad }).catch((e: unknown) => e);
      expect(err).toMatchObject({ status: 400, message: "packageId: must look like com.example.app" });
    }
    expect((await env.scheduler.enqueueRun({ ...base, packageId: "com.example.app" })).packageId).toBe("com.example.app");
    const blank = await env.scheduler.enqueueRun({ ...base, packageId: "" });
    expect(blank.packageId).not.toBe("");
  });

  test("requester and model are length-capped", async () => {
    const env = setup();
    expect(await env.scheduler.enqueueRun({ ...base, requestedBy: "r".repeat(201) }).catch((e: unknown) => e)).toMatchObject({
      status: 400,
    });
    expect(await env.scheduler.enqueueRun({ ...base, model: "m".repeat(201) }).catch((e: unknown) => e)).toMatchObject({ status: 400 });
    expect((await env.scheduler.enqueueRun({ ...base, requestedBy: "r".repeat(200) })).requestedBy).toHaveLength(200);
  });
});

describe("auto-boot targets", () => {
  test("a wearable / TV AVD is never auto-booted for a platform-only run", async () => {
    const env = setup({ avds: ["Wear_OS_Large_Round_API_34", "Android_TV_1080p", "Pixel_7"] });
    await enqueue(env.scheduler);
    await settle(env.scheduler);
    expect(env.started[0]![1]).toEqual({ bootTarget: { platform: "android", target: "Pixel_7" } });
  });

  test("an AVD with a boot already in flight (manual boot) is not booted a second time", async () => {
    const env = setup({ bootingTargets: ["AVD_A"] });
    await enqueue(env.scheduler);
    await settle(env.scheduler);
    expect(env.started[0]![1]).toEqual({ bootTarget: { platform: "android", target: "AVD_B" } });
  });

  test("manual boots in flight count against maxBooted", async () => {
    const env = setup({ maxBooted: 1, manualBoots: 1 });
    const run = await enqueue(env.scheduler);
    await settle(env.scheduler);
    expect(env.started).toEqual([]);
    expect(env.scheduler.queuePosition(run.id)).toBe(1);
    expect(env.scheduler.queueReason(run.id)).toBe("maxBooted (1) reached");
  });
});
