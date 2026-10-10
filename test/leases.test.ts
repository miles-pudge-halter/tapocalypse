import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { HttpError } from "../src/config";
import { emulator } from "./support/scheduler-env";
import { CLAIM_WINDOW_MS, grantAgent, leaseKey, LeaseStore, release, TTL, type LeaseEvent, type LeaseStoreDeps } from "../src/devices/leases";
import { shutdownDevice } from "../src/devices/pool";

/** The error a callback throws (the tests assert on its status/code/message). */
function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tapocalypse-leases-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const MIN = 60_000;
const T0 = Date.parse("2026-01-01T12:00:00.000Z");

function setup(over: Partial<LeaseStoreDeps> = {}) {
  const clock = { t: T0 };
  const assigned: string[] = [];
  const released: string[] = [];
  const events: LeaseEvent[] = [];
  const file = path.join(fs.mkdtempSync(path.join(tmp, "s-")), "leases.json");
  const store = new LeaseStore({
    file,
    now: () => clock.t,
    markAssigned: (s) => assigned.push(s),
    markReleased: (s) => released.push(s),
    isBootingSerial: () => false,
    deviceName: (s) => `name of ${s}`,
    nextFor: () => null,
    ...over,
  });
  store.bus.on("lease", (e) => events.push(e));
  const grant = (serial = "emulator-5554", extra: Partial<Parameters<LeaseStore["grantAgent"]>[0]> = {}) =>
    store.grantAgent({ serial, platform: "android", avdName: "Pixel_8", holder: "omp · checkout", reason: "smoke", ttlMinutes: 30, cwd: "/work/app", ...extra });
  return { store, clock, assigned, released, events, file, grant };
}

describe("agent leases", () => {
  test("a grant owns the device until its ttl and the public view hides secrets", () => {
    const { store, grant, assigned } = setup();
    const lease = grant();
    expect(lease.leaseId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(lease.ref).toMatch(/^[0-9a-f]{8}$/);
    expect(lease.expiresAt).toBe(new Date(T0 + 30 * MIN).toISOString());
    expect(assigned).toEqual(["emulator-5554"]);

    expect(store.deviceOwner("emulator-5554")).toMatchObject({ kind: "agent", lease: { holder: "omp · checkout" } });
    expect(store.deviceOwner("emulator-5554", T0 + 30 * MIN)).toBeNull();
    expect(store.deviceOwner("emulator-5556")).toBeNull();

    const [view] = store.listLeases();
    expect(view).toMatchObject({ ref: lease.ref, serial: "emulator-5554", holder: "omp · checkout", gated: false, claimPending: false });
    expect(JSON.stringify(store.listLeases())).not.toContain(lease.leaseId);
    expect(Object.keys(view!)).not.toContain("leaseId");
    expect(Object.keys(view!)).not.toContain("cwd");
    expect(Object.keys(view!)).not.toContain("claimTicket");
  });

  test("ttl is clamped to the allowed range", () => {
    const { grant } = setup();
    expect(grant("emulator-5554", { ttlMinutes: 1 }).ttlMinutes).toBe(TTL.min);
    expect(grant("emulator-5556", { ttlMinutes: 999 }).ttlMinutes).toBe(TTL.max);
  });

  test("a second grant on a held device is a 409", () => {
    const { grant } = setup();
    grant();
    expect(() => grant()).toThrow(HttpError);
  });

  test("deviceOwner reports a booting serial as booting, and a lease wins over it", () => {
    const { store, grant } = setup({ isBootingSerial: (s) => s === "emulator-5560" || s === "emulator-5554" });
    expect(store.deviceOwner("emulator-5560")).toEqual({ kind: "booting" });
    grant("emulator-5554");
    expect(store.deviceOwner("emulator-5554")).toMatchObject({ kind: "agent" });
  });
});

describe("run leases", () => {
  test("a run lease owns the serial, is found by run id and is released by it", () => {
    const { store, assigned, released } = setup();
    store.grantRun("emulator-5554", { id: "r1", platform: "android" }, { avdName: "Pixel_8" });
    expect(assigned).toEqual(["emulator-5554"]);
    expect(store.deviceOwner("emulator-5554")).toMatchObject({ kind: "run", lease: { runId: "r1" } });
    expect(store.runLease("r1")).toMatchObject({ serial: "emulator-5554", source: "run", expiresAt: null });
    expect(store.runLeaseCount()).toBe(1);
    expect(store.listLeases()).toEqual([]);

    store.releaseRun("r1");
    expect(released).toEqual(["emulator-5554"]);
    expect(store.deviceOwner("emulator-5554")).toBeNull();
    expect(store.runLease("r1")).toBeNull();
    expect(store.runLeaseCount()).toBe(0);
  });

  test("a run that boots onto a serial left over by a different, vanished AVD replaces that stale agent lease", () => {
    const { store, grant } = setup();
    const stale = grant("emulator-5554", { avdName: "Pixel_8" });
    store.grantRun("emulator-5554", { id: "r1", platform: "android" }, { avdName: "Tablet_10" });
    expect(store.deviceOwner("emulator-5554")).toMatchObject({ kind: "run" });
    expect(() => store.renew(stale.leaseId)).toThrow(/gone|disconnected/i);
  });

  test("a run cannot take a serial an agent still holds", () => {
    const { store, grant } = setup();
    grant("emulator-5554", { avdName: "Pixel_8" });
    expect(() => store.grantRun("emulator-5554", { id: "r1", platform: "android" }, { avdName: "Pixel_8" })).toThrow(HttpError);
    expect(store.deviceOwner("emulator-5554")).toMatchObject({ kind: "agent" });
  });

  test("a run that just booted a serial replaces any agent lease on it, even one for the same AVD, and that lease reads as gone", () => {
    const { store, grant, events } = setup();
    const stale = grant("emulator-5554", { avdName: "Pixel_8" });
    store.grantRun("emulator-5554", { id: "r1", platform: "android" }, { avdName: "Pixel_8", booted: true });
    expect(store.deviceOwner("emulator-5554")).toMatchObject({ kind: "run", lease: { runId: "r1" } });
    expect(thrown(() => store.renew(stale.leaseId))).toMatchObject({ status: 404, message: expect.stringContaining("disconnected") });
    expect(events.at(-1)).toMatchObject({ change: "gone", serial: "emulator-5554" });
  });

  test("a booted serial that another run already holds is a conflict and its pool slot is handed back", () => {
    const { store, released } = setup();
    store.grantRun("emulator-5554", { id: "r1", platform: "android" }, { avdName: "Pixel_8" });
    expect(() => store.grantRun("emulator-5554", { id: "r2", platform: "android" }, { avdName: "Pixel_8", booted: true })).toThrow(HttpError);
    expect(released).toEqual(["emulator-5554"]);
    expect(store.deviceOwner("emulator-5554")).toMatchObject({ kind: "run", lease: { runId: "r1" } });
  });
});

describe("renew, release, revoke", () => {
  test("renew moves expiry to now + ttl, keeps the device held and can change the ttl", () => {
    const { store, clock, grant, events } = setup();
    const lease = grant();
    clock.t += 20 * MIN;
    const renewed = store.renew(lease.leaseId);
    expect(renewed.expiresAt).toBe(new Date(clock.t + 30 * MIN).toISOString());
    expect(renewed.renewedAt).toBe(new Date(clock.t).toISOString());
    expect(store.deviceOwner("emulator-5554", T0 + 40 * MIN)).toMatchObject({ kind: "agent" });
    expect(store.renew(lease.leaseId, 60).expiresAt).toBe(new Date(clock.t + 60 * MIN).toISOString());
    expect(events.map((e) => e.change)).toEqual(["acquired", "renewed", "renewed"]);
  });

  test("renewing a claim-pending lease makes it a full one: it no longer reads as pending or lapses with the claim window", () => {
    const { store, clock, grant } = setup();
    const lease = grant("emulator-5554", { claimTicket: "t1" });
    expect(store.listLeases()[0]).toMatchObject({ claimPending: true });
    store.renew(lease.leaseId);
    expect(store.listLeases()[0]).toMatchObject({ claimPending: false });
    expect(store.claim("t1")).toBeNull();
    clock.t += 2 * CLAIM_WINDOW_MS;
    expect(store.deviceOwner("emulator-5554")).toMatchObject({ kind: "agent" });
  });

  test("release frees the device, announces it, and the old id then names how it ended", () => {
    const { store, clock, grant, released, events } = setup({ nextFor: () => ({ kind: "agent", holder: "claude · api" }) });
    const lease = grant();
    expect(store.release(lease.leaseId).serial).toBe("emulator-5554");
    expect(store.deviceOwner("emulator-5554")).toBeNull();
    expect(released).toEqual(["emulator-5554"]);
    expect(events.at(-1)).toMatchObject({ serial: "emulator-5554", deviceName: "name of emulator-5554", change: "released", lease: null, next: { kind: "agent", holder: "claude · api" } });

    clock.t += MIN;
    expect(thrown(() => store.renew(lease.leaseId))).toMatchObject({ status: 404, code: "lease_not_found", message: expect.stringContaining("released") });
  });

  test("an id that was never issued gets the bare not-found, with no end reason", () => {
    const { store, grant } = setup();
    grant();
    expect(thrown(() => store.release("A".repeat(22)))).toMatchObject({ status: 404, code: "lease_not_found", message: "unknown or expired lease" });
  });

  test("an expired lease cannot be renewed and says it expired", () => {
    const { store, clock, grant, events } = setup();
    const lease = grant();
    clock.t += 31 * MIN;
    expect(() => store.renew(lease.leaseId)).toThrow(/expired/);
    expect(events.map((e) => e.change)).toEqual(["acquired", "expired"]);
    expect(store.deviceOwner("emulator-5554")).toBeNull();
  });

  test("a new grant replaces an expired lease nobody swept yet", () => {
    const { store, clock, grant } = setup();
    grant();
    clock.t += 31 * MIN;
    expect(grant("emulator-5554", { holder: "claude · api" }).holder).toBe("claude · api");
    expect(store.listLeases()).toHaveLength(1);
  });

  test("revoke ends any agent lease by its public ref", () => {
    const { store, grant, events, clock } = setup();
    const lease = grant();
    expect(thrown(() => store.revoke("emulator-5554", "deadbeef"))).toMatchObject({ status: 409, code: "ref_mismatch" });
    expect(store.deviceOwner("emulator-5554")).not.toBeNull();
    expect(thrown(() => store.revoke("emulator-5556", lease.ref))).toMatchObject({ status: 404, code: "lease_not_found" });

    expect(store.revoke("emulator-5554", lease.ref).ref).toBe(lease.ref);
    expect(events.at(-1)).toMatchObject({ change: "revoked", lease: null });
    clock.t += MIN;
    expect(() => store.renew(lease.leaseId)).toThrow(/revoked from the Devices page at/);
  });

  test("a run's lease cannot be revoked", () => {
    const { store } = setup();
    store.grantRun("emulator-5554", { id: "r1", platform: "android" }, { avdName: null });
    const ref = store.runLease("r1")!.ref;
    expect(thrown(() => store.revoke("emulator-5554", ref))).toMatchObject({ status: 409, code: "held_by_run" });
    expect(store.deviceOwner("emulator-5554")).toMatchObject({ kind: "run" });
  });

  test("a run lease never reaches the lease event stream", () => {
    const { store, events } = setup();
    store.grantRun("emulator-5554", { id: "r1", platform: "android" }, { avdName: null });
    store.releaseRun("r1");
    expect(events).toEqual([]);
  });

  test("only the 100 most recent ended ids stay explained", () => {
    const { store, grant } = setup();
    const first = grant("emulator-5554");
    store.release(first.leaseId);
    for (let i = 0; i < 100; i++) store.release(grant(`emulator-${6000 + i}`).leaseId);
    expect(() => store.renew(first.leaseId)).toThrow("unknown or expired lease");
  });
});

describe("sweep", () => {
  const pixel = (serial = "emulator-5554", avdName = "Pixel_8") => emulator(serial, { avdName });

  test("ends expired leases, returns what ended and keeps live ones", () => {
    const { store, clock, grant, released } = setup();
    grant("emulator-5554", { ttlMinutes: 5 });
    grant("emulator-5556", { ttlMinutes: 60 });
    clock.t += 6 * MIN;
    const events = store.sweep([pixel("emulator-5554"), pixel("emulator-5556")]);
    expect(events.map((e) => [e.serial, e.change])).toEqual([["emulator-5554", "expired"]]);
    expect(released).toEqual(["emulator-5554"]);
    expect(store.listLeases().map((l) => l.serial)).toEqual(["emulator-5556"]);
  });

  test("a lease is gone once its device has been absent for two minutes, not before", () => {
    const { store, clock, grant, events } = setup();
    grant();
    expect(store.sweep([])).toEqual([]);
    clock.t += 119_000;
    expect(store.sweep([])).toEqual([]);
    clock.t += 2_000;
    expect(store.sweep([]).map((e) => e.change)).toEqual(["gone"]);
    expect(events.at(-1)).toMatchObject({ change: "gone", lease: null });
    expect(store.deviceOwner("emulator-5554")).toBeNull();
  });

  test("a device that reappears in time restarts the absence clock", () => {
    const { store, clock, grant } = setup();
    grant();
    store.sweep([]);
    clock.t += 100_000;
    store.sweep([pixel()]);
    clock.t += 100_000;
    expect(store.sweep([])).toEqual([]);
    clock.t += 121_000;
    expect(store.sweep([]).map((e) => e.change)).toEqual(["gone"]);
  });

  test("a serial that comes back as a different AVD ends the lease at once", () => {
    const { store, grant } = setup();
    grant("emulator-5554", { avdName: "Pixel_8" });
    expect(store.sweep([pixel("emulator-5554", "Pixel_8")])).toEqual([]);
    expect(store.sweep([pixel("emulator-5554", "Tablet_10")]).map((e) => e.change)).toEqual(["gone"]);
  });

  test("a run lease is not ended for an absent device: the run owns its own lifetime", () => {
    const { store, clock } = setup();
    store.grantRun("emulator-5554", { id: "r1", platform: "android" }, { avdName: null });
    clock.t += 10 * MIN;
    expect(store.sweep([])).toEqual([]);
    expect(store.deviceOwner("emulator-5554")).toMatchObject({ kind: "run" });
  });
});

describe("claim window", () => {
  test("a grant for a detached ticket is claim-pending for 60 s and the resume call turns it into a full lease", () => {
    const { store, clock, grant, events } = setup();
    const pending = grant("emulator-5554", { claimTicket: "t-1", ttlMinutes: 30 });
    expect(pending.expiresAt).toBe(new Date(T0 + CLAIM_WINDOW_MS).toISOString());
    expect(store.listLeases()[0]).toMatchObject({ claimPending: true });
    expect(store.deviceOwner("emulator-5554")).toMatchObject({ kind: "agent" });

    clock.t += 30_000;
    const full = store.claim("t-1");
    expect(full).toMatchObject({ leaseId: pending.leaseId, expiresAt: new Date(clock.t + 30 * MIN).toISOString() });
    expect(full?.claimTicket).toBeUndefined();
    expect(store.listLeases()[0]).toMatchObject({ claimPending: false });
    expect(events.map((e) => e.change)).toEqual(["acquired", "renewed"]);
    expect(store.claim("t-1")).toBeNull();
  });

  test("an unknown ticket claims nothing", () => {
    const { store, grant } = setup();
    grant("emulator-5554", { claimTicket: "t-1" });
    expect(store.claim("t-2")).toBeNull();
  });

  test("an unclaimed grant expires at the claim deadline and the device is free again", () => {
    const { store, clock, grant } = setup();
    grant("emulator-5554", { claimTicket: "t-1" });
    clock.t += CLAIM_WINDOW_MS + 1;
    expect(store.claim("t-1")).toBeNull();
    expect(store.sweep([emulator("emulator-5554", { avdName: "Pixel_8" })]).map((e) => e.change)).toEqual(["expired"]);
    expect(store.deviceOwner("emulator-5554")).toBeNull();
  });
});

const SavedFile = z.object({ version: z.number(), leases: z.array(z.object({ serial: z.string(), leaseId: z.string() }).passthrough()) });
const saved = (file: string) => SavedFile.parse(JSON.parse(fs.readFileSync(file, "utf8")));

describe("persistence", () => {
  test("leases.json holds the agent leases only, owner-readable, and follows releases", () => {
    const { store, grant, file } = setup();
    const lease = grant("emulator-5554");
    store.grantRun("emulator-5556", { id: "r1", platform: "android" }, { avdName: null });
    expect(saved(file).version).toBe(1);
    expect(saved(file).leases.map((l) => [l.serial, l.leaseId])).toEqual([["emulator-5554", lease.leaseId]]);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);

    store.release(lease.leaseId);
    expect(saved(file).leases).toEqual([]);
  });

  test("a restart restores live leases with the same secret and expiry, and marks their devices in use", () => {
    const first = setup();
    const lease = first.grant("emulator-5554", { cwd: "/work/app" });
    const second = setup({ file: first.file });
    second.store.restore();
    expect(second.assigned).toEqual(["emulator-5554"]);
    expect(second.store.deviceOwner("emulator-5554")).toMatchObject({ kind: "agent", lease: { ref: lease.ref, expiresAt: lease.expiresAt } });
    expect(second.store.renew(lease.leaseId).serial).toBe("emulator-5554");
  });

  test("expired and claim-pending leases are dropped on restore", () => {
    const first = setup();
    first.grant("emulator-5554", { ttlMinutes: 5 });
    first.grant("emulator-5556", { ttlMinutes: 60 });
    first.grant("emulator-5558", { claimTicket: "t-1" });
    const second = setup({ file: first.file });
    second.clock.t = T0 + 10 * MIN;
    second.store.restore();
    expect(second.store.listLeases().map((l) => l.serial)).toEqual(["emulator-5556"]);
    expect(saved(first.file).leases).toHaveLength(1);
  });

  test("a missing, corrupt or partly invalid file never blocks startup", () => {
    const missing = setup();
    missing.store.restore();
    expect(missing.store.listLeases()).toEqual([]);

    const corrupt = setup();
    fs.writeFileSync(corrupt.file, "{not json");
    corrupt.store.restore();
    expect(corrupt.store.listLeases()).toEqual([]);

    const source = setup();
    const lease = source.grant("emulator-5554");
    fs.writeFileSync(source.file, JSON.stringify({ version: 1, leases: [...saved(source.file).leases, { serial: 1 }, "junk"] }));
    const partial = setup({ file: source.file });
    partial.store.restore();
    expect(partial.store.listLeases().map((l) => l.ref)).toEqual([lease.ref]);
  });
});

describe("gated calls: touch, gated flag, device id, end keys", () => {
  test("touch renews to now + ttl without changing the ttl, returns the lease with its device id, and marks it gated", () => {
    const { store, grant, clock } = setup();
    const lease = grant("emulator-5554", { ttlMinutes: 45 });
    expect(store.listLeases()[0]).toMatchObject({ gated: false });
    clock.t = T0 + 10 * MIN;
    const touched = store.touch(lease.leaseId);
    expect(touched).toMatchObject({ serial: "emulator-5554", mobileDeviceId: "Pixel_8", cwd: "/work/app", ttlMinutes: 45 });
    expect(touched.renewedAt).toBe(new Date(T0 + 10 * MIN).toISOString());
    expect(touched.expiresAt).toBe(new Date(T0 + 55 * MIN).toISOString());
    expect(store.listLeases()[0]).toMatchObject({ gated: true });
    expect(Object.keys(store.listLeases()[0]!)).not.toContain("mobileDeviceId");
  });

  test("the device id mobile tools use is the AVD name on emulators and the serial on simulators and devices", () => {
    const { grant } = setup();
    expect(grant("emulator-5554", { avdName: "Pixel_8" }).mobileDeviceId).toBe("Pixel_8");
    expect(grant("0A1B2C3D-0000-1111-2222-333344445555", { platform: "ios", avdName: null }).mobileDeviceId).toBe("0A1B2C3D-0000-1111-2222-333344445555");
    expect(grant("R5CT123ABC", { avdName: null }).mobileDeviceId).toBe("R5CT123ABC");
  });

  test("a lease that ended is rejected with its end reason, an unknown id with the plain not-found", () => {
    const { store, grant } = setup();
    const lease = grant();
    store.release(lease.leaseId);
    expect(thrown(() => store.touch(lease.leaseId))).toMatchObject({ status: 404, code: "lease_not_found", message: expect.stringContaining("released") });
    expect(thrown(() => store.touch("not-a-lease-id-at-all"))).toMatchObject({ status: 404, code: "lease_not_found" });
  });

  test("a lease whose ttl ran out is rejected even before the sweep ends it", () => {
    const { store, grant, clock } = setup();
    const lease = grant("emulator-5554", { ttlMinutes: 5 });
    clock.t = T0 + 6 * MIN;
    expect(thrown(() => store.touch(lease.leaseId))).toMatchObject({ code: "lease_not_found" });
  });

  test("touching often keeps the lease alive but announces and saves only when something visible changed", () => {
    const { store, grant, clock, events, file } = setup();
    const lease = grant();
    events.length = 0;
    store.touch(lease.leaseId);
    expect(events.map((e) => [e.change, e.lease?.gated])).toEqual([["renewed", true]]);
    clock.t += 5_000;
    store.touch(lease.leaseId);
    store.touch(lease.leaseId);
    expect(events).toHaveLength(1);
    expect(store.touch(lease.leaseId).expiresAt).toBe(new Date(clock.t + 30 * MIN).toISOString());
    clock.t += 30_000;
    store.touch(lease.leaseId);
    expect(events).toHaveLength(2);
    expect(saved(file).leases[0]!.expiresAt).toBe(new Date(clock.t + 30 * MIN).toISOString());
  });

  test("gated and the device id survive a restart", () => {
    const first = setup();
    const lease = first.grant("emulator-5554");
    first.store.touch(lease.leaseId);
    const second = setup({ file: first.file });
    second.store.restore();
    expect(second.store.listLeases()[0]).toMatchObject({ gated: true });
    expect(second.store.touch(lease.leaseId).mobileDeviceId).toBe("Pixel_8");
  });

  test("every way an agent lease ends announces its gateway key, which is the digest of the lease id and not the id", () => {
    const { store, grant } = setup();
    const keys: string[] = [];
    store.ends.on("end", (key) => keys.push(key));
    const a = grant("emulator-5554");
    const b = grant("emulator-5556");
    const c = grant("emulator-5558", { ttlMinutes: 5 });
    store.release(a.leaseId);
    store.revoke("emulator-5556", b.ref);
    store.sweep([emulator("emulator-5558", { avdName: "Pixel_8" })], T0 + 10 * MIN);
    expect(keys).toEqual([a, b, c].map((l) => leaseKey(l.leaseId)));
    expect(keys.join()).not.toContain(a.leaseId);
    expect(new Set(keys).size).toBe(3);
    expect(keys[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a run lease ending announces no gateway key", () => {
    const { store } = setup();
    const keys: string[] = [];
    store.ends.on("end", (key) => keys.push(key));
    store.grantRun("emulator-5554", { id: "r1", platform: "android" }, { avdName: "Pixel_8" });
    store.releaseRun("r1");
    expect(keys).toEqual([]);
  });
});

describe("the process-wide store", () => {
  test("a leased device cannot be shut down, and says who holds it", async () => {
    const lease = grantAgent({ serial: "emulator-9901", platform: "android", avdName: null, holder: "omp · lease-test" });
    try {
      await expect(shutdownDevice("emulator-9901")).rejects.toMatchObject({ status: 409, message: expect.stringContaining("omp · lease-test") });
    } finally {
      release(lease.leaseId);
    }
    await expect(shutdownDevice("emulator-9901")).rejects.toMatchObject({ status: 409, message: expect.stringContaining("not booted by Tapocalypse") });
  });
});
