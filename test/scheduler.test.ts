import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HttpError } from "../src/config";
import { CLAIM_WINDOW_MS } from "../src/devices/leases";
import type { Scheduler } from "../src/runs/scheduler";
import { briefFingerprint } from "../src/regression/keys";
import { getRun } from "../src/runs/store";
import type { Platform, Run } from "../src/runs/types";
import { type Env, emulator, setup, settle } from "./support/scheduler-env";

/** The server's local HH:MM clock, as the queue reasons print it. */
const clock = (iso: string | null) => new Date(iso ?? 0).toTimeString().slice(0, 5);

const agentLease = (env: Env, serial: string, extra: Partial<Parameters<Env["leases"]["grantAgent"]>[0]> = {}) =>
  env.leases.grantAgent({ serial, platform: "android", avdName: null, holder: "claude · api", reason: "login flow", ttlMinutes: 30, ...extra });

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
    expect(env.leases.deviceOwner("R5CT123ABCD")).toBeNull();
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

  test("a device leased to an agent is skipped by platform-only runs", async () => {
    const env = setup({ devices: [emulator("emulator-5556"), emulator("emulator-5558")] });
    agentLease(env, "emulator-5556");
    const r1 = await enqueue(env.scheduler);
    await settle(env.scheduler);
    expect(env.started).toEqual([[r1.id, { serial: "emulator-5558" }]]);
  });

  test("an explicit serial leased to an agent stays queued, names the holder, and starts once the lease ends", async () => {
    const env = setup({ devices: [emulator("emulator-5556", { name: "Pixel 8" })] });
    const lease = agentLease(env, "emulator-5556");
    const r1 = await enqueue(env.scheduler, { serial: "emulator-5556", platform: "android" });
    await settle(env.scheduler);
    expect(env.started).toEqual([]);
    expect(env.scheduler.queuePosition(r1.id)).toBe(1);
    expect(env.scheduler.queueReason(r1.id)).toBe(`emulator-5556 is held by claude · api until ${clock(lease.expiresAt)}`);
    expect(env.scheduler.queueHold(r1.id)).toEqual({
      serial: "emulator-5556",
      deviceName: "Pixel 8",
      holder: "claude · api",
      reason: "login flow",
      expiresAt: lease.expiresAt!,
    });

    env.leases.release(lease.leaseId);
    await settle(env.scheduler);
    expect(env.started).toEqual([[r1.id, { serial: "emulator-5556" }]]);
    expect(env.scheduler.queueHold(r1.id)).toBeNull();
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

  test("explicit serial that is not connected", async () => {
    const env = setup({ devices: [emulator("emulator-5556")] });
    const err = await env.scheduler
      .enqueueRun({ projectId: "test-proj", title: "t", brief: "b", device: { serial: "emulator-9999", platform: "android" } })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 400, message: "device emulator-9999 not connected" });
  });

  test("a serial that belongs to a device of another platform names both platforms and the field to set", async () => {
    const env = setup({ devices: [emulator("emulator-5556")] });
    const err = await env.scheduler
      .enqueueRun({ projectId: "test-proj", title: "t", brief: "b", device: { serial: "emulator-5556", platform: "ios" } })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ status: 400, message: "device emulator-5556 is an android device; this run targets ios (set device.platform)" });
    expect(env.scheduler.queue).toEqual([]);
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
    expect(env.scheduler.queueReason(r3.id)).toBe("all android devices busy (2 running QA)");
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

  test("new, re-run and retried runs store their artefacts in the data dir, even when the source run is a legacy repo run", async () => {
    const env = setup();
    const first = await env.scheduler.enqueueRun({ projectId: "test-proj", title: "storage", brief: "b", device: { platform: "android" } });
    expect(first.storage).toBe("data");
    first.storage = "repo";
    first.status = "error";
    first.errorKind = "infra";
    expect((await env.scheduler.rerun(first.id, { only: "all" })).storage).toBe("data");
    expect(env.scheduler.retry(first).storage).toBe("data");
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

describe("harness selection", () => {
  const base = { projectId: "test-proj", title: "t", brief: "b" };
  const finish = (env: ReturnType<typeof setup>, run: { id: string; status: string }) => {
    run.status = "error";
    env.scheduler.release(run.id);
  };

  test("runs default to omp when nothing names a harness; a request wins and is stored", async () => {
    const env = setup();
    expect((await env.scheduler.enqueueRun(base)).harness).toBe("omp");
    expect((await env.scheduler.enqueueRun({ ...base, harness: "claude" })).harness).toBe("claude");
    const err = await env.scheduler.enqueueRun({ ...base, harness: "gemini" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(400);
    expect((err as HttpError).message).toStartWith("harness: ");
  });

  test("effort is stored harness-neutrally; thinking stays populated only for omp", async () => {
    const env = setup();
    expect(await env.scheduler.enqueueRun({ ...base, thinking: "high" })).toMatchObject({ thinking: "high", effort: "high" });
    expect(await env.scheduler.enqueueRun({ ...base, harness: "omp", effort: "low" })).toMatchObject({ thinking: "low", effort: "low" });
    expect(await env.scheduler.enqueueRun({ ...base, harness: "claude", effort: "xhigh" })).toMatchObject({ thinking: null, effort: "xhigh" });
  });

  test("batch runs carry the requested harness", async () => {
    const env = setup();
    const { runs } = await env.scheduler.enqueueBatch({ ...base, harness: "claude", devices: [{ platform: "android" }, { platform: "android" }] });
    expect(runs.map((r) => r.harness)).toEqual(["claude", "claude"]);
  });

  test("rerun and retry keep the harness; a rerun on another harness starts from its own model and effort", async () => {
    const env = setup();
    const first = await env.scheduler.enqueueRun({ ...base, harness: "claude", model: "sonnet", effort: "high" });
    finish(env, first);

    const same = await env.scheduler.rerun(first.id, { only: "all" });
    expect(same).toMatchObject({ harness: "claude", model: "sonnet", effort: "high" });

    const other = await env.scheduler.rerun(first.id, { only: "all", harness: "omp" });
    expect(other).toMatchObject({ harness: "omp", model: null, effort: null, thinking: null });

    const retried = env.scheduler.retry(first);
    expect(retried).toMatchObject({ harness: "claude", model: "sonnet", effort: "high", retryOf: first.id });
  });
});

describe("queue reasons with leases", () => {
  test("a platform-only run says how many devices agents and runs hold", async () => {
    const env = setup({
      devices: [emulator("emulator-5556", { avdName: "AVD_A", name: "Pixel A" }), emulator("emulator-5558", { avdName: "AVD_B" })],
    });
    const lease = agentLease(env, "emulator-5556");
    const r1 = await enqueue(env.scheduler);
    const r2 = await enqueue(env.scheduler);
    await settle(env.scheduler);
    expect(env.started).toEqual([[r1.id, { serial: "emulator-5558" }]]);
    expect(env.scheduler.queueReason(r2.id)).toBe("all android devices busy (1 held by agents, 1 running QA)");
    expect(env.scheduler.queueHold(r2.id)).toMatchObject({ serial: "emulator-5556", deviceName: "Pixel A", holder: "claude · api", expiresAt: lease.expiresAt });
  });

  test("with several leases the hold is the one that ends first", async () => {
    const env = setup({ devices: [emulator("emulator-5556", { avdName: "AVD_A" }), emulator("emulator-5558", { avdName: "AVD_B" })] });
    agentLease(env, "emulator-5556", { holder: "late", ttlMinutes: 90 });
    agentLease(env, "emulator-5558", { holder: "early", ttlMinutes: 10 });
    const r1 = await enqueue(env.scheduler);
    await settle(env.scheduler);
    expect(env.scheduler.queueReason(r1.id)).toBe("all android devices busy (2 held by agents)");
    expect(env.scheduler.queueHold(r1.id)).toMatchObject({ serial: "emulator-5558", holder: "early" });
  });

  test("a run waiting only for other runs has no hold", async () => {
    const env = setup({ devices: [emulator("emulator-5556", { avdName: "AVD_A" }), emulator("emulator-5558", { avdName: "AVD_B" })] });
    await enqueue(env.scheduler);
    await enqueue(env.scheduler);
    const r3 = await enqueue(env.scheduler);
    await settle(env.scheduler);
    expect(env.scheduler.queueHold(r3.id)).toBeNull();
  });
});

describe("one queue for runs and agents", () => {
  const request = { platform: "android", holder: "omp · checkout" } as const;
  /** One device that nothing else can be booted next to. */
  const oneDevice = () => setup({ devices: [emulator("emulator-5556", { avdName: "AVD_A" })], avds: ["AVD_A"] });

  test("the earliest entry wins every freed device, whatever its kind", async () => {
    const env = oneDevice();
    const lease = agentLease(env, "emulator-5556");
    const r1 = await enqueue(env.scheduler);
    const waiting = await env.scheduler.acquire(request, 0);
    const r2 = await enqueue(env.scheduler);
    await settle(env.scheduler);
    expect(env.started).toEqual([]);
    expect(waiting).toMatchObject({ timedOut: true, position: 2, state: "waiting" });
    expect(env.scheduler.queuePosition(r1.id)).toBe(1);
    expect(env.scheduler.queuePosition(r2.id)).toBe(3);

    env.leases.release(lease.leaseId);
    await settle(env.scheduler);
    expect(env.started).toEqual([[r1.id, { serial: "emulator-5556" }]]);

    env.scheduler.release(r1.id);
    await settle(env.scheduler);
    expect(env.started).toHaveLength(1);
    expect(env.leases.listLeases()[0]).toMatchObject({ holder: "omp · checkout", claimPending: true });

    const ticket = (waiting as { ticket: string }).ticket;
    const resumed = await env.scheduler.acquire({ ...request, ticket }, 0);
    expect(resumed).toMatchObject({ lease: { serial: "emulator-5556", ttlMinutes: 30 } });
    expect(env.leases.deviceOwner("emulator-5556")).toMatchObject({ kind: "agent" });

    env.leases.release((resumed as { lease: { leaseId: string } }).lease.leaseId);
    await settle(env.scheduler);
    expect(env.started.at(-1)).toEqual([r2.id, { serial: "emulator-5556" }]);
  });

  test("a run held back by maxConcurrentRuns does not block an agent behind it", async () => {
    const env = setup({
      devices: [emulator("emulator-5556", { avdName: "AVD_A" }), emulator("emulator-5558", { avdName: "AVD_B" })],
      avds: [],
      maxConcurrentRuns: 1,
    });
    const r1 = await enqueue(env.scheduler);
    const r2 = await enqueue(env.scheduler);
    await settle(env.scheduler);
    expect(env.scheduler.queueReason(r2.id)).toBe("maxConcurrentRuns (1) reached");

    const got = await env.scheduler.acquire(request, 0);
    expect(got).toMatchObject({ lease: { serial: "emulator-5558" } });
    expect(env.started).toEqual([[r1.id, { serial: "emulator-5556" }]]);
    expect(env.scheduler.queuePosition(r2.id)).toBe(1);
  });

  test("a ticket keeps its place across calls and a repeat call does not queue twice", async () => {
    const env = oneDevice();
    agentLease(env, "emulator-5556");
    const first = (await env.scheduler.acquire(request, 0)) as { ticket: string; position: number };
    const second = (await env.scheduler.acquire({ ...request, holder: "claude · api" }, 0)) as { ticket: string; position: number };
    expect([first.position, second.position]).toEqual([1, 2]);
    const again = (await env.scheduler.acquire({ ...request, ticket: first.ticket }, 0)) as { ticket: string; position: number };
    expect(again).toMatchObject({ ticket: first.ticket, position: 1 });
    expect(env.scheduler.ticketsView()).toHaveLength(2);
  });

  test("a ticket nobody resumes within the claim window is dropped", async () => {
    const env = oneDevice();
    agentLease(env, "emulator-5556");
    await env.scheduler.acquire(request, 0);
    env.clock.t += 61_000;
    await settle(env.scheduler);
    expect(env.scheduler.ticketsView()).toEqual([]);
    expect(env.scheduler.queue).toEqual([]);
  });

  test("a grant nobody picks up within the window passes the device to the next entry", async () => {
    const env = oneDevice();
    const lease = agentLease(env, "emulator-5556");
    await env.scheduler.acquire(request, 0);
    const r1 = await enqueue(env.scheduler);
    env.leases.release(lease.leaseId);
    await settle(env.scheduler);
    expect(env.leases.listLeases()[0]).toMatchObject({ holder: "omp · checkout", claimPending: true });
    expect(env.started).toEqual([]);

    env.clock.t += 61_000;
    env.leases.sweep(env.devices, env.clock.t);
    await settle(env.scheduler);
    expect(env.started).toEqual([[r1.id, { serial: "emulator-5556" }]]);
  });

  test("a waiting call returns the lease the moment the device frees, without a claim window", async () => {
    const env = oneDevice();
    const lease = agentLease(env, "emulator-5556");
    const waiting = env.scheduler.acquire(request, 5_000);
    await settle(env.scheduler);
    env.leases.release(lease.leaseId);
    const result = await waiting;
    expect(result).toMatchObject({ lease: { serial: "emulator-5556", name: "sdk", mobileDeviceId: "AVD_A" } });
    expect(env.leases.listLeases()[0]).toMatchObject({ claimPending: false });
  });

  test("a call whose client gave up (abort) detaches: a later grant waits in the claim window instead of being lost", async () => {
    const env = oneDevice();
    const lease = agentLease(env, "emulator-5556");
    const gaveUp = new AbortController();
    const waiting = env.scheduler.acquire(request, 60_000, gaveUp.signal);
    await settle(env.scheduler);
    gaveUp.abort();
    const result = await waiting;
    expect(result).toMatchObject({ timedOut: true, position: 1 });

    env.leases.release(lease.leaseId);
    await settle(env.scheduler);
    expect(env.leases.listLeases()[0]).toMatchObject({ claimPending: true });
    const resumed = await env.scheduler.acquire({ ...request, ticket: (result as { ticket: string }).ticket }, 0);
    expect(resumed).toMatchObject({ lease: { serial: "emulator-5556" } });
  });

  test("a waiting call that runs out of time still hands back its ticket", async () => {
    const env = oneDevice();
    agentLease(env, "emulator-5556");
    const result = await env.scheduler.acquire(request, 30);
    expect(result).toMatchObject({
      timedOut: true,
      position: 1,
      state: "waiting",
      heldBy: { kind: "agent", holder: "claude · api", reason: "login flow" },
      reason: "all android devices busy (1 held by agents)",
    });
  });

  test("a call whose ticket is queued while a pass is mid-flight still gets a full lease, not a claim window", async () => {
    const env = setup({ devices: [emulator("emulator-5556", { avdName: "AVD_A" }), emulator("emulator-5558", { avdName: "AVD_B" })], avds: [] });
    agentLease(env, "emulator-5558");
    await enqueue(env.scheduler, { serial: "emulator-5558", platform: "android" });
    await settle(env.scheduler);
    // A pass is already waiting for its device list when the acquire call asks for its own.
    env.holdLists = true;
    void env.scheduler.schedule();
    const call = env.scheduler.acquire(request, 0);
    expect(env.pendingLists).toHaveLength(2);
    // The call's list returns first (queues its ticket), then the pass's, before the call goes on.
    env.pendingLists[1]!();
    env.pendingLists[0]!();
    env.holdLists = false;

    expect(await call).toMatchObject({ lease: { serial: "emulator-5556", ttlMinutes: 30, expiresAt: new Date(env.clock.t + 30 * 60_000).toISOString() } });
    expect(env.leases.listLeases().find((l) => l.serial === "emulator-5556")).toMatchObject({ claimPending: false });
  });

  test("a client that leaves in the instant its device is granted does not strand a full lease: the grant waits in the claim window", async () => {
    const env = oneDevice();
    const lease = agentLease(env, "emulator-5556");
    const gaveUp = new AbortController();
    const waiting = env.scheduler.acquire(request, 60_000, gaveUp.signal);
    await settle(env.scheduler);
    env.leases.bus.on("lease", (e) => {
      if (e.change === "acquired") gaveUp.abort();
    });
    env.leases.release(lease.leaseId);

    const result = await waiting;
    expect(result).toMatchObject({ timedOut: true });
    expect(env.leases.listLeases()[0]).toMatchObject({ claimPending: true, expiresAt: new Date(env.clock.t + CLAIM_WINDOW_MS).toISOString() });
    if (!("ticket" in result)) throw new Error("expected a ticket to resume with");
    expect(await env.scheduler.acquire({ ...request, ticket: result.ticket }, 0)).toMatchObject({ lease: { serial: "emulator-5556", ttlMinutes: 30 } });
  });

  test("the grant reply needs no further device listing, so a stalled adb cannot leave the lease held by nobody", async () => {
    const env = oneDevice();
    const lease = agentLease(env, "emulator-5556");
    const waiting = env.scheduler.acquire(request, 60_000);
    await settle(env.scheduler);
    env.holdLists = true;
    env.leases.release(lease.leaseId);
    expect(env.pendingLists).toHaveLength(1);
    let result: Awaited<typeof waiting> | undefined;
    void waiting.then((r) => (result = r));
    env.pendingLists[0]!();
    const turn = Promise.withResolvers<void>();
    setImmediate(turn.resolve);
    await turn.promise;
    expect(result).toMatchObject({ lease: { serial: "emulator-5556", name: "sdk", mobileDeviceId: "AVD_A" } });
  });
});

describe("acquire", () => {
  const holder = "omp · checkout";

  test("an explicit serial held by a QA run reports the run and takes the device after it", async () => {
    const env = setup({ devices: [emulator("emulator-5556")] });
    const r1 = await enqueue(env.scheduler, { serial: "emulator-5556", platform: "android" });
    await settle(env.scheduler);
    const waiting = await env.scheduler.acquire({ serial: "emulator-5556", holder }, 0);
    expect(waiting).toMatchObject({ timedOut: true, position: 1, heldBy: { kind: "run", runId: r1.id, title: r1.title }, reason: "emulator-5556 is busy" });

    env.scheduler.release(r1.id);
    await settle(env.scheduler);
    const resumed = await env.scheduler.acquire({ serial: "emulator-5556", holder, ticket: (waiting as { ticket: string }).ticket }, 0);
    expect(resumed).toMatchObject({ lease: { serial: "emulator-5556" } });
  });

  test("an explicit serial held by an agent says who and until when", async () => {
    const env = setup({ devices: [emulator("emulator-5556")] });
    const lease = agentLease(env, "emulator-5556");
    const waiting = await env.scheduler.acquire({ serial: "emulator-5556", holder }, 0);
    expect(waiting).toMatchObject({
      reason: `emulator-5556 is held by claude · api until ${clock(lease.expiresAt)}`,
      heldBy: { kind: "agent", holder: "claude · api", expiresAt: lease.expiresAt },
    });
  });

  test("a free device is granted at once with the id mobile tools need", async () => {
    const env = setup({ devices: [emulator("emulator-5556", { name: "Pixel 8" })] });
    const got = await env.scheduler.acquire({ platform: "android", holder, ttlMinutes: 45, reason: "smoke", cwd: "/work/app" }, 0);
    expect(got).toEqual({
      lease: {
        serial: "emulator-5556",
        platform: "android",
        name: "Pixel 8",
        mobileDeviceId: "emulator-5556",
        leaseId: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
        expiresAt: new Date(env.clock.t + 45 * 60_000).toISOString(),
        ttlMinutes: 45,
      },
    });
    expect(env.leases.deviceOwner("emulator-5556")).toMatchObject({ kind: "agent", lease: { cwd: "/work/app", reason: "smoke" } });
  });

  test("nothing free and nothing bootable is an immediate no_device", async () => {
    const env = setup({ devices: [], avds: [] });
    await expect(env.scheduler.acquire({ platform: "android", holder }, 5_000)).rejects.toMatchObject({ status: 409, code: "no_device" });
    await expect(env.scheduler.acquire({ platform: "ios", holder }, 5_000)).rejects.toMatchObject({ status: 409, code: "no_device" });
    expect(env.scheduler.ticketsView()).toEqual([]);
  });

  test("a physical device is leased only by its serial", async () => {
    const env = setup({ devices: [emulator("R5CT123ABCD", { kind: "physical" })], avds: [] });
    await expect(env.scheduler.acquire({ platform: "android", holder }, 0)).rejects.toMatchObject({ code: "no_device" });
    expect(await env.scheduler.acquire({ serial: "R5CT123ABCD", holder }, 0)).toMatchObject({ lease: { serial: "R5CT123ABCD" } });
  });

  test("watch and TV devices, excluded serials and unknown serials are refused", async () => {
    const env = setup({ devices: [emulator("emulator-5556", { deviceType: "watch" }), emulator("emulator-5999")] });
    await expect(env.scheduler.acquire({ serial: "emulator-5556", holder }, 0)).rejects.toMatchObject({ status: 400, code: "device_unsupported" });
    await expect(env.scheduler.acquire({ serial: "emulator-5999", holder }, 0)).rejects.toMatchObject({ status: 400, code: "device_excluded" });
    await expect(env.scheduler.acquire({ serial: "emulator-1234", holder }, 0)).rejects.toMatchObject({ status: 404, code: "device_not_found" });
  });

  test("bad input is an invalid_argument", async () => {
    const env = setup({ devices: [emulator("emulator-5556")] });
    for (const bad of [{ holder }, { platform: "android", serial: "emulator-5556", holder }, { platform: "android", holder: " " }, { platform: "android", holder, ttlMinutes: 1 }]) {
      await expect(env.scheduler.acquire(bad, 0)).rejects.toMatchObject({ status: 400, code: "invalid_argument" });
    }
  });

  test("at most 32 agents can wait", async () => {
    const env = setup({ devices: [emulator("emulator-5556")] });
    agentLease(env, "emulator-5556");
    for (let i = 0; i < 32; i++) await env.scheduler.acquire({ serial: "emulator-5556", holder: `agent ${i}` }, 0);
    await expect(env.scheduler.acquire({ serial: "emulator-5556", holder: "one too many" }, 0)).rejects.toMatchObject({ status: 409, code: "queue_full" });
  });

  test("with nothing free a ticket boots an AVD under the same maxBooted limit as runs", async () => {
    const env = setup({ devices: [], maxBooted: 1 });
    const waiting = await env.scheduler.acquire({ platform: "android", holder }, 0);
    expect(waiting).toMatchObject({ timedOut: true, state: "booting", heldBy: { kind: "booting" } });
    expect(env.boots.map((b) => [b.platform, b.target])).toEqual([["android", "AVD_A"]]);

    const run = await enqueue(env.scheduler);
    await settle(env.scheduler);
    expect(env.started).toEqual([]);
    expect(env.scheduler.queueReason(run.id)).toBe("maxBooted (1) reached");
    expect(env.scheduler.overlay([], () => false).find((d) => d.serial === "booting:AVD_A")).toMatchObject({ state: "booting" });

    env.devices.push(emulator("emulator-5560", { avdName: "AVD_A" }));
    env.boots[0]!.finish("emulator-5560");
    await settle(env.scheduler);
    const resumed = await env.scheduler.acquire({ platform: "android", holder, ticket: (waiting as { ticket: string }).ticket }, 0);
    expect(resumed).toMatchObject({ lease: { serial: "emulator-5560" } });
    expect(env.leases.deviceOwner("emulator-5560")).toMatchObject({ kind: "agent", lease: { avdName: "AVD_A" } });
  });

  test("a waiting call gets the booted device directly; a failed boot is reported to the caller", async () => {
    const env = setup({ devices: [] });
    const first = env.scheduler.acquire({ platform: "android", holder }, 5_000);
    await settle(env.scheduler);
    env.devices.push(emulator("emulator-5560", { avdName: "AVD_A" }));
    env.boots[0]!.finish("emulator-5560");
    expect(await first).toMatchObject({ lease: { serial: "emulator-5560" } });
    expect(env.leases.listLeases()[0]).toMatchObject({ claimPending: false });

    const second = env.scheduler.acquire({ platform: "android", holder: "other" }, 5_000);
    const failed = second.catch((e: unknown) => e);
    await settle(env.scheduler);
    env.boots[1]!.fail("emulator did not boot");
    expect(await failed).toMatchObject({ status: 502, code: "boot_failed", message: expect.stringContaining("emulator did not boot") });
    expect(env.scheduler.ticketsView()).toEqual([]);
  });

  test("a boot that lands on a serial an agent still holds (its emulator was closed and reopened) takes the device and ends the old lease", async () => {
    const env = setup({ devices: [] });
    const stale = agentLease(env, "emulator-5560", { avdName: "AVD_A" });
    const waiting = env.scheduler.acquire({ platform: "android", holder }, 5_000);
    await settle(env.scheduler);
    env.devices.push(emulator("emulator-5560", { avdName: "AVD_A" }));
    env.boots[0]!.finish("emulator-5560");
    expect(await waiting).toMatchObject({ lease: { serial: "emulator-5560" } });
    expect(env.leases.deviceOwner("emulator-5560")).toMatchObject({ kind: "agent", lease: { holder } });
    expect(() => env.leases.renew(stale.leaseId)).toThrow(/disconnected/);
  });

  test("a run's boot that lands on a serial an agent still holds takes it and ends the old lease", async () => {
    const env = setup({ devices: [], avds: ["AVD_A"] });
    const stale = agentLease(env, "emulator-5560", { avdName: "AVD_A" });
    const run = await enqueue(env.scheduler);
    await settle(env.scheduler);
    expect(env.started).toEqual([[run.id, { bootTarget: { platform: "android", target: "AVD_A" } }]]);
    env.scheduler.bootComplete(run.id, "emulator-5560");
    expect(env.leases.deviceOwner("emulator-5560")).toMatchObject({ kind: "run", lease: { runId: run.id } });
    expect(() => env.leases.renew(stale.leaseId)).toThrow(/disconnected/);
  });
});

describe("views for devices, pool and the live wait list", () => {
  test("overlay carries the agent lease and who waits for each serial, FIFO", async () => {
    const env = setup({ devices: [emulator("emulator-5556")] });
    const lease = agentLease(env, "emulator-5556");
    await env.scheduler.acquire({ serial: "emulator-5556", holder: "omp · checkout" }, 0);
    const run = await enqueue(env.scheduler, { serial: "emulator-5556", platform: "android" });
    await settle(env.scheduler);

    const [device] = env.scheduler.overlay(env.devices, () => false);
    expect(device!.lease).toMatchObject({ ref: lease.ref, holder: "claude · api", gated: false });
    expect(JSON.stringify(device)).not.toContain(lease.leaseId);
    expect(device!.waiters).toEqual([
      { kind: "agent", holder: "omp · checkout", since: new Date(env.clock.t).toISOString() },
      { kind: "run", runId: run.id, title: run.title },
    ]);
    expect(device!.busyRunId).toBeUndefined();
  });

  test("a device with no lease and no waiters has none", () => {
    const env = setup({ devices: [emulator("emulator-5556")] });
    expect(env.scheduler.overlay(env.devices, () => false)[0]).toMatchObject({ lease: null, waiters: [] });
  });

  test("waitingView groups platform-wide waiters, not serial-specific ones", async () => {
    const env = setup({ devices: [emulator("emulator-5556", { avdName: "AVD_A" })], avds: ["AVD_A"] });
    agentLease(env, "emulator-5556");
    await env.scheduler.acquire({ platform: "android", holder: "omp · a" }, 0);
    await env.scheduler.acquire({ platform: "android", holder: "omp · a" }, 0);
    await env.scheduler.acquire({ serial: "emulator-5556", holder: "serial waiter" }, 0);
    const run = await enqueue(env.scheduler);
    await settle(env.scheduler);
    expect(env.scheduler.waitingView()).toEqual([{ platform: "android", holders: ["omp · a"], runIds: [run.id] }]);
  });

  test("nextFor names the first queued entry that would take a serial", async () => {
    const env = setup({ devices: [emulator("emulator-5556", { avdName: "AVD_A" })], avds: ["AVD_A"] });
    agentLease(env, "emulator-5556");
    await env.scheduler.acquire({ platform: "android", holder: "omp · a" }, 0);
    const run = await enqueue(env.scheduler);
    await settle(env.scheduler);
    expect(env.scheduler.nextFor("emulator-5556")).toEqual({ kind: "agent", holder: "omp · a" });
    expect(env.scheduler.nextFor("emulator-1111")).toBeNull();
    void run;
  });
});

describe("regression identity", () => {
  const unique = (label: string) => `${label} ${Date.now().toString(36)}-${++counter}`;
  const plan = (id: string, title: string, status: "pass" | "fail" = "pass") => ({ id, title, status, updatedAt: "2026-01-01T00:00:00.000Z" });
  /** Ends a run the way the runner does: terminal status, checks as reported, one update. */
  const finishWith = (env: Env, run: Run, checks: Run["checks"], status: Run["status"] = "done") => {
    run.checks = checks;
    run.status = status;
    env.scheduler.update(run);
    env.scheduler.release(run.id);
  };

  test("a new run joins the test of the earliest run with the same brief, or of the same run title, else starts its own", async () => {
    const env = setup();
    const brief = unique("walk the cart");
    const first = await env.scheduler.enqueueRun({ projectId: "test-proj", title: `${unique("cart lane")} v1.0`, brief });
    expect(first.testKey).toBe(`brief:${briefFingerprint(brief)}`);

    const sameBrief = await env.scheduler.enqueueRun({ projectId: "test-proj", title: unique("another title"), brief });
    expect(sameBrief.testKey).toBe(first.testKey!);

    const sameTitle = await env.scheduler.enqueueRun({ projectId: "test-proj", title: first.title.replace("v1.0", "v1.1"), brief: unique("rewritten") });
    expect(sameTitle.testKey).toBe(first.testKey!);

    const fresh = await env.scheduler.enqueueRun({ projectId: "test-proj", title: unique("unrelated"), brief: unique("unrelated brief") });
    expect(fresh.testKey).not.toBe(first.testKey!);
    expect(getRun(fresh.id)!.testKey).toBe(fresh.testKey!);
  });

  test("a re-run and a retry stay in their parent's test", async () => {
    const env = setup();
    const first = await env.scheduler.enqueueRun({ projectId: "test-proj", title: unique("lane"), brief: unique("brief") });
    expect(first.testKey).not.toBeNull();
    finishWith(env, first, [plan("C1", "Login", "fail")]);
    const failedOnly = await env.scheduler.rerun(first.id, { only: "failed" });
    expect(failedOnly.brief).not.toBe(first.brief);
    expect(failedOnly.testKey).toBe(first.testKey!);
    expect(env.scheduler.retry(failedOnly).testKey).toBe(first.testKey!);
  });

  test("the terminal update keys every check once and persists it; updates while the run is active do not", async () => {
    const env = setup();
    const run = await env.scheduler.enqueueRun({ projectId: "test-proj", title: unique("lane"), brief: unique("brief") });
    run.status = "running";
    run.checks = [plan("C1", "Cart total updates")];
    env.scheduler.update(run);
    expect(getRun(run.id)!.checks[0]!.checkKey).toBeUndefined();

    finishWith(env, run, run.checks);
    const stored = getRun(run.id)!.checks[0]!;
    expect(stored).toMatchObject({ keyKind: "title" });
    expect(stored.checkKey).toMatch(/^t:/);

    run.checks[0]!.title = "Renamed afterwards";
    env.scheduler.update(run);
    expect(getRun(run.id)!.checks[0]!.checkKey).toBe(stored.checkKey!);
  });

  test("a run whose plan was never keyed at creation (testKey null) is keyed when it ends", async () => {
    const env = setup();
    const run = await env.scheduler.enqueueRun({ projectId: "test-proj", title: unique("lane"), brief: unique("brief") });
    run.testKey = null;
    finishWith(env, run, [plan("C1", "Login")], "error");
    expect(getRun(run.id)!.testKey).toBe(`brief:${briefFingerprint(run.brief)}`);
  });

  test("restore keys the checks of a run it has to interrupt", async () => {
    const env = setup();
    const run = await env.scheduler.enqueueRun({ projectId: "test-proj", title: unique("lane"), brief: unique("brief") });
    run.status = "running";
    run.checks = [plan("C1", "Login works")];
    env.scheduler.update(run);
    const crashed = setup();
    crashed.scheduler.restore();
    const stored = getRun(run.id)!;
    expect(stored.status).toBe("interrupted");
    expect(stored.checks[0]!.checkKey).toMatch(/^t:/);
  });

  test("a run that cannot be keyed (no brief) is still saved by update and interrupted by restore", async () => {
    const env = setup();
    const run = await env.scheduler.enqueueRun({ projectId: "test-proj", title: unique("lane"), brief: unique("brief") });
    run.status = "running";
    run.brief = undefined as unknown as string;
    run.testKey = null;
    env.scheduler.update(run);
    expect(getRun(run.id)!.status).toBe("running");
    const crashed = setup();
    crashed.scheduler.restore();
    expect(getRun(run.id)!.status).toBe("interrupted");
    run.status = "done";
    env.scheduler.update(run);
    expect(getRun(run.id)!.status).toBe("done");
  });

  describe("hints", () => {
    const earlierRun = async (env: Env, brief: string, checks: Run["checks"]) => {
      const run = await env.scheduler.enqueueRun({ projectId: "test-proj", title: unique("lane"), brief });
      finishWith(env, run, checks);
      return run;
    };

    test("a run of a test seen before is handed the previous checks and persists them; reuseChecks: false opts out", async () => {
      const env = setup();
      const brief = unique("brief");
      const earlier = await earlierRun(env, brief, [plan("C1", "Login works"), plan("C2", "Cart total updates", "fail")]);
      const next = await env.scheduler.enqueueRun({ projectId: "test-proj", title: unique("lane"), brief });
      expect(next.checkHints).toEqual({
        fromRunIds: [earlier.id],
        checks: [
          { id: "C1", title: "Login works", checkKey: getRun(earlier.id)!.checks[0]!.checkKey! },
          { id: "C2", title: "Cart total updates", checkKey: getRun(earlier.id)!.checks[1]!.checkKey! },
        ],
      });
      expect(getRun(next.id)!.checkHints).toEqual(next.checkHints);

      const optedOut = await env.scheduler.enqueueRun({ projectId: "test-proj", title: unique("lane"), brief, reuseChecks: false });
      expect(optedOut.checkHints).toBeNull();
    });

    test("a first run of a test gets none; batch lanes of a known test each get the previous checks", async () => {
      const env = setup();
      const brief = unique("brief");
      expect((await env.scheduler.enqueueRun({ projectId: "test-proj", title: unique("lane"), brief })).checkHints).toBeNull();
      await earlierRun(env, brief, [plan("C1", "Login works")]);
      const { runs } = await env.scheduler.enqueueBatch({ projectId: "test-proj", title: unique("lane"), brief, devices: [{ platform: "android" }, { platform: "android" }] });
      expect(runs.map((r) => r.checkHints?.checks.length)).toEqual([1, 1]);
    });

    test("re-running everything or retrying shows the parent's checks; re-running only the failed ones shows none", async () => {
      const env = setup();
      const parent = await earlierRun(env, unique("brief"), [plan("C1", "Login works"), plan("C2", "Cart total updates", "fail")]);
      const all = await env.scheduler.rerun(parent.id, { only: "all" });
      expect(all.checkHints?.fromRunIds).toEqual([parent.id]);
      expect(all.checkHints?.checks.map((c) => c.id)).toEqual(["C1", "C2"]);
      expect((await env.scheduler.rerun(parent.id, { only: "failed" })).checkHints).toBeNull();

      const retried = env.scheduler.retry(parent);
      expect(retried.checkHints?.checks.map((c) => c.id)).toEqual(["C1", "C2"]);
    });

    test("a run that opted out of hints keeps the opt-out through a re-run of everything and an infra retry", async () => {
      const env = setup();
      const parent = await env.scheduler.enqueueRun({ projectId: "test-proj", title: unique("lane"), brief: unique("brief"), reuseChecks: false });
      finishWith(env, parent, [plan("C1", "Login works"), plan("C2", "Cart total updates", "fail")]);
      expect(getRun(parent.id)!.reuseChecks).toBe(false);
      expect((await env.scheduler.rerun(parent.id, { only: "all" })).checkHints).toBeNull();
      expect(env.scheduler.retry(parent).checkHints).toBeNull();
    });

    test("only the hints the prompt shows are persisted, so `was` can name nothing the agent never saw", async () => {
      const env = setup();
      const brief = unique("brief");
      await earlierRun(env, brief, Array.from({ length: 55 }, (_, i) => plan(`C${i + 1}`, `Check number ${i + 1} of the walk`)));
      const next = await env.scheduler.enqueueRun({ projectId: "test-proj", title: unique("lane"), brief });
      expect(next.checkHints?.checks).toHaveLength(40);
      expect(next.checkHints?.more).toBe(15);
      expect(getRun(next.id)!.checkHints?.more).toBe(15);
      // C50 was never shown: naming it does not carry its key.
      finishWith(env, next, [{ ...plan("N1", "Something else entirely"), was: "C50" }]);
      expect(getRun(next.id)!.checks[0]!.keyKind).not.toBe("carried");
    });
  });

  describe("source", () => {
    test("a re-run reads the source again from the project, keeping tickets and labels; a retry keeps the original source", async () => {
      const env = setup();
      const first = await env.scheduler.enqueueRun({
        projectId: "test-proj",
        title: unique("lane"),
        brief: unique("brief"),
        source: { commit: "a".repeat(40), branch: "feature/old", tickets: ["ACME-12"], labels: { flavor: "dev" } },
      });
      finishWith(env, first, [plan("C1", "Login works")]);
      expect(first.source).toMatchObject({ commit: "a".repeat(40), branch: "feature/old" });

      const rerun = await env.scheduler.rerun(first.id, { only: "all" });
      // The test project is not a git repo: what the project says now is "no commit, no branch".
      expect(rerun.source).toMatchObject({ commit: null, branch: null, tickets: ["ACME-12"], labels: { flavor: "dev" } });

      const retry = env.scheduler.retry(first);
      expect(retry.source).toMatchObject({ commit: "a".repeat(40), branch: "feature/old" });
    });
  });
});
