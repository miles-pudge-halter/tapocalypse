import { afterEach, describe, expect, test } from "bun:test";
import { api } from "../web/lib/api";
import { formatClock, leaseFraction, leaseLeft } from "../web/lib/format";
import {
  anyDeviceHint,
  createLeaseCache,
  deviceCounts,
  deviceState,
  expiredNote,
  heldRowCopy,
  heldSummary,
  lentOutLabel,
  leaseTimes,
  leaseToast,
  parseWatched,
  poolWaitingLine,
  queueHoldCopy,
  releaseCopy,
  releaseOutcome,
  sortRank,
} from "../web/lib/leases";
import type { Device, DeviceWaiter, LeaseEvent, LeaseView } from "../web/lib/api";

const T0 = Date.parse("2026-05-01T12:00:00Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();

describe("leaseLeft", () => {
  test("formats the time left by magnitude: hours, minutes (rounded up), then m:ss in the last two minutes", () => {
    expect(leaseLeft(at(65 * 60_000), T0)).toBe("1h 05m");
    expect(leaseLeft(at(12 * 60_000 - 1_000), T0)).toBe("12m");
    expect(leaseLeft(at(2 * 60_000), T0)).toBe("2m");
    expect(leaseLeft(at(102_000), T0)).toBe("1:42");
    expect(leaseLeft(at(-5_000), T0)).toBe("0:00");
  });
});

describe("leaseFraction", () => {
  const lease = { renewedAt: at(0), expiresAt: at(30 * 60_000) };

  test("drains linearly from the last renewal to expiry and stays within 0..1", () => {
    expect(leaseFraction(lease, T0)).toBe(1);
    expect(leaseFraction(lease, T0 + 15 * 60_000)).toBeCloseTo(0.5, 5);
    expect(leaseFraction(lease, T0 + 45 * 60_000)).toBe(0);
    expect(leaseFraction(lease, T0 - 60_000)).toBe(1);
  });

  test("a zero-length lease is empty instead of NaN", () => {
    expect(leaseFraction({ renewedAt: at(0), expiresAt: at(0) }, T0)).toBe(0);
  });
});
describe("force release", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function respond(status: number, body?: unknown): { calls: { url: string; body: unknown }[] } {
    const calls: { url: string; body: unknown }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
      return new Response(body === undefined ? null : JSON.stringify(body), { status });
    }) as typeof fetch;
    return { calls };
  }

  async function outcomeOf(status: number, body?: unknown) {
    respond(status, body);
    try {
      await api.releaseDevice("emulator-5554", "ab12cd34");
      return releaseOutcome(null);
    } catch (e) {
      return releaseOutcome(e);
    }
  }

  test("sends the lease ref (never a secret) for the serial and treats 204 as released", async () => {
    const { calls } = respond(204);
    await api.releaseDevice("emulator-5554", "ab12cd34");
    expect(calls).toEqual([{ url: "/api/devices/emulator-5554/release", body: { ref: "ab12cd34" } }]);
    expect(releaseOutcome(null)).toEqual({ kind: "released" });
  });

  test("404 means the device was already free", async () => {
    expect(await outcomeOf(404, { error: "no lease" })).toEqual({ kind: "already_free" });
  });

  test("409 held_by_run is told apart from a lease that changed hands", async () => {
    expect(await outcomeOf(409, { error: "run holds it", code: "held_by_run" })).toEqual({ kind: "held_by_run" });
    expect(await outcomeOf(409, { error: "ref mismatch", lease: { holder: "claude · api-auth", ref: "ffffffff" } })).toEqual({
      kind: "changed_hands",
      holder: "claude · api-auth",
    });
    expect(await outcomeOf(409, { error: "ref mismatch" })).toEqual({ kind: "changed_hands", holder: null });
  });

  test("any other failure keeps its message", async () => {
    expect(await outcomeOf(500, { error: "boom" })).toEqual({ kind: "failed", message: "boom" });
  });
});

function lease(partial: Partial<LeaseView> = {}): LeaseView {
  return {
    ref: "ab12cd34",
    serial: "emulator-5554",
    platform: "android",
    avdName: "Pixel_8",
    holder: "omp · checkout",
    reason: null,
    source: "agent",
    ttlMinutes: 30,
    acquiredAt: at(0),
    renewedAt: at(0),
    expiresAt: at(30 * 60_000),
    gated: false,
    claimPending: false,
    ...partial,
  };
}

function device(partial: Partial<Device> & Pick<Device, "serial">): Device {
  return { platform: "android", kind: "emulator", state: "ready", name: partial.serial, ...partial } as Device;
}

describe("device state precedence", () => {
  test("a running QA run outranks a lease; a claim window outranks a plain lease", () => {
    expect(deviceState(device({ serial: "a", busyRunId: "r1", lease: lease() }), false)).toBe("running");
    expect(deviceState(device({ serial: "a", lease: lease({ claimPending: true }) }), false)).toBe("reserved");
    expect(deviceState(device({ serial: "a", lease: lease() }), false)).toBe("held");
  });

  test("excluded, the expiry flash and idle shutdown come after leases, and plain devices are free", () => {
    expect(deviceState(device({ serial: "a", excluded: true }), true)).toBe("excluded");
    expect(deviceState(device({ serial: "a" }), true)).toBe("expired");
    expect(deviceState(device({ serial: "a", idleShutdownAt: at(60_000) }), false)).toBe("idle");
    expect(deviceState(device({ serial: "a" }), false)).toBe("free");
  });

  test("watches and TVs are never QA devices, and booting beats everything else", () => {
    expect(deviceState(device({ serial: "a", deviceType: "watch", lease: lease() }), false)).toBe("not_qa");
    expect(deviceState(device({ serial: "a", state: "booting", lease: lease() }), false)).toBe("booting");
  });

  test("cards sort running, held, free, booting, excluded, not QA", () => {
    const ordered = [
      device({ serial: "a-run", busyRunId: "r" }),
      device({ serial: "b-held", lease: lease() }),
      device({ serial: "c-free" }),
      device({ serial: "d-boot", state: "booting" }),
      device({ serial: "e-excluded", excluded: true }),
      device({ serial: "f-tv", deviceType: "tv" }),
    ];
    const ranks = ordered.map((d) => sortRank(d, false));
    expect(ranks).toEqual([...ranks].sort((x, y) => x - y));
    expect(new Set(ranks).size).toBe(ordered.length);
  });
});

describe("deviceCounts", () => {
  test("agent leases count as busy; watches and booting devices are not usable", () => {
    const counts = deviceCounts([
      device({ serial: "run", busyRunId: "r" }),
      device({ serial: "held", lease: lease() }),
      device({ serial: "free" }),
      device({ serial: "boot", state: "booting" }),
      device({ serial: "watch", deviceType: "watch", lease: lease() }),
    ]);
    expect(counts).toEqual({ usable: 3, running: 1, held: 1, busy: 2, free: 1 });
  });
});

describe("leaseTimes", () => {
  const since = formatClock(at(0));
  const until = formatClock(at(30 * 60_000));

  test("a running lease reads since/until, adding 'renewed' only after a renew on a non-gated lease", () => {
    expect(leaseTimes(lease(), T0 + 60_000)).toBe(`since ${since} · until ${until}`);
    expect(leaseTimes(lease({ renewedAt: at(5 * 60_000) }), T0 + 6 * 60_000)).toBe(`since ${since} · until ${until} · renewed`);
    expect(leaseTimes(lease({ renewedAt: at(5 * 60_000), gated: true }), T0 + 6 * 60_000)).toBe(`since ${since} · until ${until}`);
  });

  test("a lease past expiry that the sweep has not ended yet says it is ending", () => {
    expect(leaseTimes(lease(), T0 + 31 * 60_000)).toBe(`since ${since} · ending…`);
  });

  test("a claim window counts down the pick-up deadline instead", () => {
    const claim = lease({ claimPending: true, expiresAt: at(60_000) });
    expect(leaseTimes(claim, T0 + 18_000)).toBe(`granted ${since} · picks it up within 0:42`);
  });
});

describe("releaseCopy", () => {
  const waiters: DeviceWaiter[] = [
    { kind: "agent", holder: "claude · api-auth", since: at(0) },
    { kind: "run", runId: "r1", title: "Login smoke" },
  ];

  test("names the holder, its reason and who gets the device next, and says the agent is not stopped", () => {
    const { body } = releaseCopy(lease({ reason: "cart flow" }), waiters, T0);
    expect(body).toBe(
      "omp · checkout is holding it for “cart flow”. Releasing ends the lease now and hands the device to claude · api-auth. The agent is not stopped: it learns about it on its next lease call and may still touch the device until then.",
    );
  });

  test("a queued run or an empty line changes the hand-over text; no reason drops the 'for'", () => {
    expect(releaseCopy(lease(), [waiters[1]!], T0).body).toContain("hands the device to the queued run “Login smoke”.");
    expect(releaseCopy(lease(), [], T0).body).toStartWith("omp · checkout is holding it. Releasing ends the lease now and hands the device to nobody (it becomes free).");
  });

  test("a claim window only says it was not picked up yet", () => {
    expect(releaseCopy(lease({ claimPending: true, expiresAt: at(30_000) }), waiters, T0)).toEqual({
      body: "omp · checkout has not picked it up yet. Releasing hands the device to claude · api-auth.",
      wouldEnd: null,
    });
  });

  test("mentions when the lease would end on its own only while more than two minutes are left", () => {
    expect(releaseCopy(lease(), [], T0).wouldEnd).toBe(`It would end on its own at ${formatClock(at(30 * 60_000))}.`);
    expect(releaseCopy(lease(), [], T0 + 29 * 60_000).wouldEnd).toBeNull();
  });
});

/** What the server really emits: `lease` is set for acquired/renewed and null for every ending event. */
const ended = (change: LeaseEvent["change"], extra: Partial<LeaseEvent> = {}): LeaseEvent => ({
  serial: "emulator-5554",
  deviceName: "Pixel 8",
  change,
  lease: null,
  next: null,
  ...extra,
});

describe("leaseCache", () => {
  test("an ending event resolves to the last known lease of its device, once", () => {
    const cache = createLeaseCache();
    cache.seed([lease({ holder: "omp · checkout" })]);
    expect(cache.resolve(ended("released"))?.holder).toBe("omp · checkout");
    expect(cache.resolve(ended("released"))).toBeNull();
  });

  test("acquired and renewed events keep the cache current", () => {
    const cache = createLeaseCache();
    cache.resolve(ended("acquired", { lease: lease({ holder: "claude · api", expiresAt: at(10 * 60_000) }) }));
    cache.resolve(ended("renewed", { lease: lease({ holder: "claude · api", expiresAt: at(40 * 60_000) }) }));
    expect(cache.resolve(ended("expired"))?.expiresAt).toBe(at(40 * 60_000));
  });

  test("a device list seeds agent leases only, and a newer lease replaces the older one", () => {
    const cache = createLeaseCache();
    cache.seed([lease({ source: "run", runId: "r1", holder: "run" }), lease({ serial: "emulator-5556", holder: "a" })]);
    expect(cache.resolve(ended("gone"))).toBeNull();
    cache.seed([lease({ serial: "emulator-5556", holder: "b", ref: "zz" })]);
    expect(cache.resolve(ended("released", { serial: "emulator-5556" }))).toMatchObject({ holder: "b", ref: "zz" });
  });

  test("devices without a known lease resolve to null", () => {
    expect(createLeaseCache().resolve(ended("expired"))).toBeNull();
  });
});

describe("leaseToast", () => {
  const known = lease();
  const watching = { watching: true, ownRelease: null, lease: known } as const;

  test("only watched devices notify, and acquire/renew never do", () => {
    expect(leaseToast(ended("released"), { ...watching, watching: false })).toBeNull();
    expect(leaseToast(ended("acquired", { lease: known }), watching)).toBeNull();
    expect(leaseToast(ended("renewed", { lease: known }), watching)).toBeNull();
  });

  test("a device that became free names the holder from the cached lease and offers a run there; the watch ends", () => {
    expect(leaseToast(ended("released"), watching)).toEqual({
      kind: "success",
      title: "Pixel 8 is free",
      description: "omp · checkout released it.",
      action: { label: "New run here", to: { type: "new-run", platform: "android", serial: "emulator-5554" } },
      unwatch: true,
    });
    expect(leaseToast(ended("expired"), watching)).toMatchObject({
      kind: "warning",
      title: "Pixel 8 is free: the lease expired",
      description: "omp · checkout did not release or renew it in time. It may have stopped.",
      action: { label: "New run here" },
      unwatch: true,
    });
    expect(leaseToast(ended("revoked"), watching)).toMatchObject({ kind: "info", title: "Pixel 8 is free", description: "Released from Tapocalypse." });
  });

  test("a hand-over keeps watching and says who has it now", () => {
    const agent = leaseToast(ended("released", { next: { kind: "agent", holder: "claude · api-auth" } }), watching);
    expect(agent).toEqual({ kind: "info", title: "Pixel 8 went to the next agent", description: "claude · api-auth has it now. Still watching.", unwatch: false });
    const run = leaseToast(ended("expired", { next: { kind: "run", runId: "r1", title: "Login smoke" } }), watching);
    expect(run).toEqual({
      kind: "info",
      title: "Pixel 8 went to a queued run",
      description: "“Login smoke” is starting on it. Still watching.",
      action: { label: "View run", to: { type: "run", runId: "r1" } },
      unwatch: false,
    });
  });

  test("a lost device ends the watch with the holder's name", () => {
    expect(leaseToast(ended("gone"), watching)).toEqual({
      kind: "info",
      title: "Pixel 8 disconnected",
      description: "The lease of omp · checkout ended with it.",
      unwatch: true,
    });
  });

  test("without a cached lease or device name the toast falls back to plain words and offers no run", () => {
    const unknown = { watching: true, ownRelease: null, lease: null } as const;
    expect(leaseToast(ended("released", { deviceName: "" }), unknown)).toMatchObject({ title: "emulator-5554 is free", description: "an agent released it." });
    expect(leaseToast(ended("released"), unknown)?.action).toBeUndefined();
  });

  test("the tab that released the lease itself skips the revoked event for that device and lease", () => {
    const own = { serial: "emulator-5554", ref: "ab12cd34" };
    expect(leaseToast(ended("revoked"), { ...watching, ownRelease: own })).toBeNull();
    expect(leaseToast(ended("revoked"), { ...watching, lease: null, ownRelease: own })).toBeNull();
    expect(leaseToast(ended("revoked"), { ...watching, ownRelease: { ...own, ref: "other" } })).not.toBeNull();
    expect(leaseToast(ended("revoked"), { ...watching, ownRelease: { ...own, serial: "emulator-5556" } })).not.toBeNull();
    expect(leaseToast(ended("expired"), { ...watching, ownRelease: own })).not.toBeNull();
  });
});

describe("expiredNote", () => {
  test("names the holder and the real expiry from the cached lease", () => {
    const note = expiredNote(ended("expired"), lease({ holder: "omp · checkout", expiresAt: at(30 * 60_000) }), T0 + 31 * 60_000);
    expect(note).toEqual({ holder: "omp · checkout", at: at(30 * 60_000), chip: true });
  });

  test("falls back to an agent and the time of the event when the lease was never seen; a hand-over has no chip", () => {
    expect(expiredNote(ended("expired", { next: { kind: "agent", holder: "x" } }), null, T0)).toEqual({ holder: "an agent", at: at(0), chip: false });
  });
});

describe("heldRowCopy", () => {
  test("a held row shows the time left, the holder with the latest free time and a hover title with the reason", () => {
    const free = formatClock(at(30 * 60_000));
    expect(heldRowCopy(lease({ reason: "cart flow" }), T0 + 60_000)).toEqual({
      status: "Held · 29m",
      line: `omp · checkout · free by ${free}`,
      title: `Held by omp · checkout: cart flow. Free by ${free} at the latest.`,
    });
    expect(heldRowCopy(lease(), T0).title).toBe(`Held by omp · checkout. Free by ${free} at the latest.`);
  });

  test("a claim window is called Reserved", () => {
    expect(heldRowCopy(lease({ claimPending: true, expiresAt: at(30_000) }), T0).status).toBe("Reserved");
  });
});

describe("anyDeviceHint", () => {
  const pool = (over: Partial<{ bootable: boolean; bootedCount: number; maxBooted: number }> = {}) => ({
    bootable: over.bootable ? [{ platform: "android" as const, target: "Pixel_8", name: "Pixel 8" }] : [],
    bootedCount: over.bootedCount ?? 0,
    maxBooted: over.maxBooted ?? 2,
  });
  const early = lease({ expiresAt: at(10 * 60_000) });
  const late = lease({ ref: "ffffffff", expiresAt: at(50 * 60_000) });

  test("when every candidate is held by agents it says the run waits, and by when at the latest", () => {
    const devices = [device({ serial: "a", lease: late }), device({ serial: "b", lease: early })];
    expect(anyDeviceHint("android", devices, pool())).toBe(
      `All Android devices are held by agents. The run waits for the first one to free up, by ${formatClock(at(10 * 60_000))} at the latest.`,
    );
  });

  test("mixed agents and runs report both counts", () => {
    const devices = [device({ serial: "a", lease: early }), device({ serial: "b", busyRunId: "r" })];
    expect(anyDeviceHint("android", devices, pool())).toBe(
      "All Android devices are in use (1 held by agents, 1 running QA). The run waits for the first one to free up.",
    );
  });

  test("stays quiet when a device is free, one can be booted, only runs are busy, or the pool is still loading", () => {
    expect(anyDeviceHint("android", [device({ serial: "a", lease: early }), device({ serial: "b" })], pool())).toBeNull();
    expect(anyDeviceHint("android", [device({ serial: "a", lease: early })], pool({ bootable: true }))).toBeNull();
    expect(anyDeviceHint("android", [device({ serial: "a", busyRunId: "r" })], pool())).toBeNull();
    expect(anyDeviceHint("android", [device({ serial: "a", lease: early })], null)).toBeNull();
  });

  test("a bootable target does not help once the emulator limit is reached, and iOS has no limit", () => {
    const held = [device({ serial: "a", lease: early })];
    expect(anyDeviceHint("android", held, pool({ bootable: true, bootedCount: 2, maxBooted: 2 }))).not.toBeNull();
    const sim = [device({ serial: "s", platform: "ios", kind: "simulator", lease: early })];
    const iosPool = { bootable: [{ platform: "ios" as const, target: "u", name: "iPhone" }], bootedCount: 9, maxBooted: 1 };
    expect(anyDeviceHint("ios", sim, iosPool)).toBeNull();
  });

  test("physical, excluded, booting and non-QA devices are not candidates", () => {
    const devices = [
      device({ serial: "p", kind: "physical", lease: early }),
      device({ serial: "e", excluded: true }),
      device({ serial: "b", state: "booting" }),
      device({ serial: "w", deviceType: "watch" }),
      device({ serial: "h", lease: early }),
    ];
    expect(anyDeviceHint("android", devices, pool())).toContain("All Android devices are held by agents");
  });
});

describe("queueHoldCopy", () => {
  const clock = formatClock(at(30 * 60_000));
  const hold = { serial: "emulator-5554", deviceName: "Pixel 8", holder: "omp · checkout", reason: "cart flow", expiresAt: at(30 * 60_000) };

  test("a run pinned to a serial names that device, the holder, the reason and the latest free time", () => {
    expect(queueHoldCopy(hold, { platform: "android", serial: "emulator-5554" })).toEqual({
      note: `Waiting for Pixel 8: held by omp · checkout for “cart flow”. Free by ${clock} at the latest.`,
      paneTitle: "Waiting for Pixel 8",
      paneDescription: `Held by omp · checkout until ${clock}. The live screen appears once the device is free.`,
    });
    expect(queueHoldCopy({ ...hold, reason: null }, { platform: "android", serial: "emulator-5554" }).note).toBe(
      `Waiting for Pixel 8: held by omp · checkout. Free by ${clock} at the latest.`,
    );
  });

  test("an 'any' run points at the lease that ends first", () => {
    expect(queueHoldCopy(hold, { platform: "ios" }).note).toBe(
      `Waiting for any iOS device: the next agent lease (omp · checkout on Pixel 8) ends by ${clock} at the latest.`,
    );
  });
});

describe("poolWaitingLine", () => {
  test("lists waiting agents and a run count per platform", () => {
    expect(poolWaitingLine({ platform: "android", holders: ["omp · checkout"], runIds: ["a", "b"] })).toBe(
      "Waiting for any Android: omp · checkout, 2 runs",
    );
    expect(poolWaitingLine({ platform: "ios", holders: [], runIds: ["a"] })).toBe("Waiting for any iOS: 1 run");
    expect(poolWaitingLine({ platform: "ios", holders: ["x", "y"], runIds: [] })).toBe("Waiting for any iOS: x, y");
    expect(poolWaitingLine({ platform: "ios", holders: [], runIds: [] })).toBeNull();
  });
});

describe("heldSummary", () => {
  const held = (serial: string, minutes: number, holder: string) =>
    device({ serial, name: `Dev ${serial}`, lease: lease({ holder, expiresAt: at(minutes * 60_000) }) });

  test("is null with no agent leases", () => {
    expect(heldSummary([device({ serial: "a" })])).toBeNull();
  });

  test("counts, singular/plural, and the hover title lists up to three then '+n more'; earliest-ending lease drives the ring", () => {
    const one = heldSummary([held("a", 20, "omp · checkout")]);
    expect(one?.label).toBe("1 held by an agent");
    expect(one?.title).toBe(`omp · checkout on Dev a until ${formatClock(at(20 * 60_000))}`);

    const five = heldSummary([held("a", 50, "h1"), held("b", 10, "h2"), held("c", 30, "h3"), held("d", 40, "h4"), held("e", 20, "h5")]);
    expect(five?.label).toBe("5 held by agents");
    expect(five?.earliest.holder).toBe("h2");
    expect(five?.title.split("\n")).toHaveLength(4);
    expect(five?.title.split("\n")[3]).toBe("+2 more");
  });
});

describe("parseWatched", () => {
  test("reads a JSON string array, dropping duplicates and non-strings", () => {
    expect(parseWatched('["emulator-5554","emulator-5554",7,"B0F0"]')).toEqual(["emulator-5554", "B0F0"]);
  });

  test("anything unreadable is an empty watch list", () => {
    expect(parseWatched(null)).toEqual([]);
    expect(parseWatched("not json")).toEqual([]);
    expect(parseWatched('{"a":1}')).toEqual([]);
  });
});

describe("lentOutLabel", () => {
  test("counts agent leases only and names the one acquired last", () => {
    const leases = [
      lease({ ref: "00000001", holder: "omp · a", acquiredAt: at(1_000) }),
      lease({ ref: "00000002", holder: "claude · b", acquiredAt: at(9_000) }),
      lease({ ref: "00000003", source: "run", holder: "run", acquiredAt: at(99_000) }),
    ];
    expect(lentOutLabel(leases)).toBe(`2 devices lent out · claude · b since ${formatClock(at(9_000))}`);
    expect(lentOutLabel([leases[0]!])).toBe(`1 device lent out · omp · a since ${formatClock(at(1_000))}`);
  });

  test("nothing lent out", () => {
    expect(lentOutLabel([])).toBeNull();
    expect(lentOutLabel([lease({ source: "run" })])).toBeNull();
  });
});
