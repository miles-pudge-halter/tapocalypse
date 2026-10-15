import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveHubCredentials } from "../src/hub/credentials";
import type { PackagedRun } from "../src/hub/package";
import { HubSyncWorker, type HubSyncOptions } from "../src/hub/sync";
import type { Project } from "../src/projects/registry";
import type { Run } from "../src/runs/types";
import { deleteRun, getRun, saveRun } from "../src/runs/store";
import { cleanupRuns, makeRun, uniqueTest } from "./support/regression";
import { createFakeHub, type FakeHub } from "./support/fake-hub";

const TOKEN = "tpu_testtoken0000000000000000000000000000000";
const dirs: string[] = [];
const sha = (s: string | Uint8Array): string => createHash("sha256").update(s).digest("hex");

afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
afterEach(cleanupRuns);

/** A deterministic stand-in for HubCore's packaging: the document depends on the run's content, the blobs only on its id. */
async function fakePackage(run: Run, project: Project): Promise<PackagedRun> {
  const report = new TextEncoder().encode(`# Report ${run.id}\n`);
  const shot = new TextEncoder().encode(`RIFFwebp ${run.id}`);
  const blobs = new Map([
    [sha(report), { type: "text/markdown" as const, bytes: report }],
    [sha(shot), { type: "image/webp" as const, bytes: shot }],
  ]);
  const doc = {
    protocol: 1,
    clientVersion: "0.0.0-test",
    sentAt: new Date().toISOString(),
    project: { hubKey: "github.com/acme/shop", name: project.name, remoteUrl: null, subpath: null, defaultBranch: null, defaultPlatform: "android" as const, localId: project.id },
    run: { id: run.id, projectId: project.id, title: run.title, status: run.status as "done", createdAt: run.createdAt, checks: run.checks.map((c) => ({ id: c.id, title: c.title, status: c.status })), testKey: run.testKey ?? null },
    batch: null,
    report: { sha256: sha(report), bytes: report.length, type: "text/markdown" as const },
    activity: null,
    screenshots: [{ sha256: sha(shot), bytes: shot.length, type: "image/webp" as const, path: "screenshots/step-1.webp" }],
    transcript: null,
    redaction: { replaced: {} },
  };
  return { doc, blobs, contentHash: sha(JSON.stringify(doc.run)) };
}

interface Rig {
  hub: FakeHub;
  worker: HubSyncWorker;
  /** A second worker over the same outbox, hub and clock: what a server restart gives. */
  restart(): HubSyncWorker;
  projectId: string;
  stateFile: string;
  clock: { now: number };
  creds: { token: string };
  share: { on: boolean };
  make(over?: { at?: number; status?: Run["status"] }): Run;
}

function rig(over: Partial<HubSyncOptions> = {}): Rig {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tpc-hubsync-"));
  dirs.push(dir);
  const hub = createFakeHub(TOKEN);
  const projectId = `sync-${randomBytes(4).toString("hex")}`;
  const share = { on: true };
  const creds = { token: TOKEN };
  const clock = { now: Date.parse("2026-04-01T09:00:00.000Z") };
  const stateFile = path.join(dir, "hub-outbox.json");
  const options: Partial<HubSyncOptions> = {
    stateFile,
    settings: () => ({ url: "https://hub.example.com", screenshots: "webp", headers: {}, live: false }),
    credentials: () => ({ ok: true, token: creds.token, tokenSource: "file", tokenHint: creds.token.slice(-4), headers: {}, headersSource: null }),
    fetch: (req) => hub.fetch(req),
    getProject: (id) => (id === projectId ? ({ id, name: "Acme Shop", repoPath: dir, personaFile: null, defaultPackage: "com.example.app", defaultPlatform: "android", share: share.on } satisfies Project) : undefined),
    packageRun: fakePackage,
    now: () => clock.now,
    debounceMs: 0,
    ...over,
  };
  return {
    hub,
    worker: new HubSyncWorker(options),
    restart: () => new HubSyncWorker(options),
    projectId,
    stateFile,
    clock,
    creds,
    share,
    make: ({ at = 1, status = "done" } = {}) => makeRun({ testKey: uniqueTest(), at, projectId, status, checks: [["c1", "pass"]] }),
  };
}

describe("first upload", () => {
  test("uploads the missing blobs, then the run document, and records it as uploaded", async () => {
    const r = rig();
    const run = r.make();
    expect(r.worker.enqueue(run.id)).toBe(true);
    await r.worker.drain();

    const stored = r.hub.runs.get(run.id);
    expect(stored?.doc.run.title).toBe(run.title);
    expect(r.hub.blobs.size).toBe(2);
    // blobs go before the document
    const order = r.hub.log.map((l) => `${l.method} ${l.path.replace(/[0-9a-f]{64}/, ":sha").replace(run.id, ":id")}`);
    expect(order).toEqual(["POST /api/hub/v1/blobs/check", "PUT /api/hub/v1/blobs/:sha", "PUT /api/hub/v1/blobs/:sha", "PUT /api/hub/v1/runs/:id"]);
    const sync = r.worker.syncState(run.id, run);
    expect(sync).toMatchObject({ state: "uploaded", error: null, attempts: 0 });
    expect(sync?.url).toBe(`https://hub.example.com/#/runs/${run.id}`);
  });
});

describe("content-hash dedupe", () => {
  test("an unchanged run is not sent again", async () => {
    const r = rig();
    const run = r.make();
    r.worker.enqueue(run.id);
    await r.worker.drain();
    r.hub.log.length = 0;

    r.worker.enqueue(run.id);
    await r.worker.drain();
    expect(r.hub.log).toEqual([]);
  });

  test("an edited run re-sends only the document; the hub already has its blobs", async () => {
    const r = rig();
    const run = r.make();
    r.worker.enqueue(run.id);
    await r.worker.drain();
    r.hub.log.length = 0;

    saveRun({ ...run, title: "Checkout total updates (renamed)" });
    expect(r.worker.syncState(run.id, run)?.state).toBe("uploaded");
    r.worker.enqueue(run.id);
    expect(r.worker.syncState(run.id, run)?.state).toBe("outdated");
    await r.worker.drain();

    expect(r.hub.log.map((l) => l.method)).toEqual(["POST", "PUT"]);
    expect(r.hub.runs.get(run.id)?.doc.run.title).toBe("Checkout total updates (renamed)");
    expect(r.worker.syncState(run.id, run)?.state).toBe("uploaded");
  });
});

describe("offline", () => {
  test("a down hub keeps the run queued with exponential backoff, and the queue drains when it is back", async () => {
    const r = rig();
    const run = r.make();
    r.hub.down = true;
    r.worker.enqueue(run.id);
    await r.worker.drain();

    expect(r.worker.syncState(run.id, run)).toMatchObject({ state: "failed", attempts: 1, error: { code: "unreachable" }, nextAttemptAt: "2026-04-01T09:00:30.000Z" });

    // not due yet: nothing is attempted (hub.log is empty because a down hub logs nothing, so watch the state instead)
    await r.worker.drain();
    expect(r.worker.syncState(run.id, run)?.attempts).toBe(1);

    r.clock.now += 30_000;
    await r.worker.drain();
    expect(r.worker.syncState(run.id, run)).toMatchObject({ attempts: 2, nextAttemptAt: "2026-04-01T09:01:30.000Z" });

    r.hub.down = false;
    r.clock.now += 60_000;
    await r.worker.drain();
    expect(r.hub.runs.has(run.id)).toBe(true);
    expect(r.worker.syncState(run.id, run)?.state).toBe("uploaded");
  });

  test("backoff is capped at one hour", async () => {
    const r = rig();
    const run = r.make();
    r.hub.down = true;
    r.worker.enqueue(run.id);
    for (let i = 0; i < 12; i++) {
      await r.worker.drain();
      r.clock.now += 3_600_000;
    }
    const sync = r.worker.syncState(run.id, run);
    expect(sync?.attempts).toBe(12);
    expect(Date.parse(sync?.nextAttemptAt ?? "") - (r.clock.now - 3_600_000)).toBe(3_600_000);
  });

  test("one failed request delays the whole queue instead of trying every run", async () => {
    const r = rig();
    const runs = [r.make({ at: 1 }), r.make({ at: 2 }), r.make({ at: 3 })];
    r.hub.down = true;
    let requests = 0;
    const hubFetch = r.hub.fetch;
    r.hub.fetch = (req) => {
      requests++;
      return hubFetch(req);
    };
    for (const run of runs) r.worker.enqueue(run.id);
    await r.worker.drain();
    expect(requests).toBe(1);
    expect(runs.map((x) => r.worker.syncState(x.id, x)?.nextAttemptAt)).toEqual(Array(3).fill("2026-04-01T09:00:30.000Z"));
  });

  test("the outbox survives a restart", async () => {
    const r = rig();
    const run = r.make();
    r.hub.down = true;
    r.worker.enqueue(run.id);
    await r.worker.drain();
    expect(fs.statSync(r.stateFile).mode & 0o777).toBe(0o600);

    r.hub.down = false;
    r.clock.now += 30_000;
    const restarted = r.restart();
    expect(restarted.syncState(run.id, run)).toMatchObject({ state: "failed", attempts: 1 });
    await restarted.drain();
    expect(r.hub.runs.has(run.id)).toBe(true);
  });
});

describe("triggers", () => {
  test("a run that reaches a terminal state uploads on its own; a live run waits", async () => {
    const r = rig();
    r.worker.start();
    try {
      const run = r.make({ status: "running" });
      expect(r.worker.syncState(run.id, run)?.state).toBe("waiting");
      await r.worker.idle();
      expect(r.hub.log).toEqual([]);

      saveRun({ ...run, status: "done" });
      await r.worker.idle();
      expect(r.hub.runs.has(run.id)).toBe(true);
    } finally {
      await r.worker.stop();
    }
  });

  test("a later edit of an uploaded run (a relink, a PR lookup) re-uploads it", async () => {
    const r = rig();
    r.worker.start();
    try {
      const run = r.make();
      await r.worker.idle();
      expect(r.hub.runs.get(run.id)?.doc.run.title).toBe(run.title);
      saveRun({ ...run, title: "Renamed after a relink" });
      await r.worker.idle();
      expect(r.hub.runs.get(run.id)?.doc.run.title).toBe("Renamed after a relink");
    } finally {
      await r.worker.stop();
    }
  });

  test("a project that is not shared never uploads, however the run is queued", async () => {
    const r = rig();
    r.share.on = false;
    r.worker.start();
    try {
      const run = r.make();
      r.worker.enqueue(run.id);
      await r.worker.idle();
      expect(r.hub.log).toEqual([]);
      expect(r.worker.syncState(run.id, run)).toBeNull();
      expect(r.worker.status().queue.waiting).toBe(0);
    } finally {
      await r.worker.stop();
    }
  });

  test("with no hub configured nothing is uploaded and the run has no sync state", async () => {
    const r = rig({ settings: () => null });
    r.worker.start();
    try {
      const run = r.make();
      await r.worker.idle();
      expect(r.hub.log).toEqual([]);
      expect(r.worker.syncState(run.id, run)).toBeNull();
    } finally {
      await r.worker.stop();
    }
  });

  test("deleting a run locally drops it from the outbox and leaves the hub copy alone", async () => {
    const r = rig();
    const run = r.make();
    r.worker.enqueue(run.id);
    await r.worker.drain();
    r.worker.enqueue(run.id);
    deleteRun(run.id);
    r.worker.forget(run.id);
    await r.worker.drain();
    expect(r.hub.runs.has(run.id)).toBe(true);
    expect(r.hub.log.some((l) => l.method === "DELETE")).toBe(false);
    expect(r.worker.status().queue.waiting).toBe(0);
  });
});

describe("pause states", () => {
  test("401 pauses the whole queue without burning attempts, and fixing the token resumes it", async () => {
    const r = rig();
    const runs = [r.make({ at: 1 }), r.make({ at: 2 })];
    r.creds.token = "tpu_revoked";
    for (const run of runs) r.worker.enqueue(run.id);
    await r.worker.drain();

    expect(r.hub.log).toHaveLength(1);
    expect(r.worker.status().paused).toMatchObject({ reason: "unauthorized" });
    expect(r.worker.syncState(runs[1].id, runs[1])).toMatchObject({ state: "paused", error: { code: "unauthorized" }, attempts: 0 });

    r.clock.now += 3 * 3_600_000;
    await r.worker.drain();
    expect(r.hub.log).toHaveLength(1);

    r.creds.token = TOKEN;
    await r.worker.drain();
    expect(r.worker.status().paused).toBeNull();
    expect(runs.every((run) => r.hub.runs.has(run.id))).toBe(true);
  });

  test("426 pauses with the hub's required protocol and survives a restart", async () => {
    const r = rig();
    const run = r.make();
    r.hub.minProtocol = 2;
    r.worker.enqueue(run.id);
    await r.worker.drain();

    const paused = r.worker.status().paused;
    expect(paused?.reason).toBe("protocol_unsupported");
    expect(paused?.detail).toContain("protocol 2");
    expect(r.worker.syncState(run.id, run)).toMatchObject({ state: "paused", error: { code: "protocol_unsupported" } });

    const restarted = r.restart();
    expect(restarted.status().paused?.reason).toBe("protocol_unsupported");
    r.hub.log.length = 0;
    await restarted.drain();
    expect(r.hub.log).toEqual([]);
  });

  test("an access proxy that redirects to a login pauses with its own error code", async () => {
    const r = rig();
    const run = r.make();
    r.hub.proxyLogin = true;
    r.worker.enqueue(run.id);
    await r.worker.drain();
    expect(r.worker.status().paused?.reason).toBe("unauthorized");
    expect(r.worker.syncState(run.id, run)).toMatchObject({ state: "paused", error: { code: "proxy_login" } });
  });

  test("no usable credentials pause with the reason and send nothing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tpc-hubsync-creds-"));
    dirs.push(dir);
    const file = path.join(dir, "hub-credentials.json");
    fs.writeFileSync(file, JSON.stringify({ token: TOKEN }));
    fs.chmodSync(file, 0o644);
    const r = rig({ credentials: () => resolveHubCredentials({ env: {}, configDir: dir }) });
    const run = r.make();
    r.worker.enqueue(run.id);
    await r.worker.drain();

    expect(r.hub.log).toEqual([]);
    expect(r.worker.status().paused?.detail).toContain("chmod 600");
    expect(r.worker.syncState(run.id, run)).toMatchObject({ state: "paused" });

    fs.chmodSync(file, 0o600);
    await r.worker.drain();
    expect(r.hub.runs.has(run.id)).toBe(true);
    expect(r.worker.status().paused).toBeNull();
  });
});

describe("per-run failures", () => {
  test("409 id_conflict parks only that run: it is never retried, the others still upload", async () => {
    const r = rig();
    const [clash, fine] = [r.make({ at: 1 }), r.make({ at: 2 })];
    r.hub.conflicts.add(clash.id);
    r.worker.enqueue(clash.id);
    r.worker.enqueue(fine.id);
    await r.worker.drain();

    expect(r.hub.runs.has(fine.id)).toBe(true);
    expect(r.hub.runs.has(clash.id)).toBe(false);
    expect(r.worker.syncState(clash.id, clash)).toMatchObject({ state: "parked", error: { code: "id_conflict" } });
    expect(r.worker.status().queue).toMatchObject({ parked: 1, waiting: 0, failed: 0 });
    expect(r.worker.status().paused).toBeNull();

    // later saves of the parked run do not queue it again, and it stays parked after a restart
    r.hub.log.length = 0;
    expect(r.worker.enqueue(clash.id)).toBe(false);
    const restarted = r.restart();
    r.clock.now += 10 * 3_600_000;
    await restarted.drain();
    expect(r.hub.log).toEqual([]);
    expect(restarted.syncState(clash.id, clash)?.state).toBe("parked");
  });

  test("422 missing_blobs: the worker uploads the blobs the hub names and sends the document again", async () => {
    const r = rig();
    const run = r.make();
    r.hub.forgetBlobsOnce = true;
    r.worker.enqueue(run.id);
    await r.worker.drain();

    expect(r.hub.runs.has(run.id)).toBe(true);
    expect(r.worker.syncState(run.id, run)?.state).toBe("uploaded");
    expect(r.hub.puts()).toHaveLength(2);
  });

  test("an unexpected hub error fails that run with the hub's message and retries with backoff", async () => {
    const r = rig();
    const bad = r.make({ at: 1 });
    const good = r.make({ at: 2 });
    const hubFetch = r.hub.fetch;
    r.hub.fetch = async (req) => (req.method === "PUT" && req.url.includes(`/runs/${bad.id}`) ? Response.json({ error: "title too long" }, { status: 400 }) : hubFetch(req));
    r.worker.enqueue(bad.id);
    r.worker.enqueue(good.id);
    await r.worker.drain();

    expect(r.worker.syncState(bad.id, bad)).toMatchObject({ state: "failed", attempts: 1, error: { code: "other", detail: expect.stringContaining("title too long") } });
    expect(r.hub.runs.has(good.id)).toBe(true);
  });
});

describe("background worker", () => {
  // These two tests exercise the worker's real timers (the pause poll); fake timers cannot drive Bun.setTimeout inside the
  // worker, so they use a 10 ms poll and wait on observable state.
  test("a paused queue notices a fixed token on its own (a `hub login` from the CLI) and drains", async () => {
    const r = rig({ pausePollMs: 10 });
    r.creds.token = "tpu_stale";
    r.worker.start();
    try {
      const run = r.make();
      await r.worker.idle();
      expect(r.worker.status().paused?.reason).toBe("unauthorized");

      r.creds.token = TOKEN;
      for (let i = 0; i < 100 && !r.hub.runs.has(run.id); i++) await Bun.sleep(10);
      expect(r.hub.runs.has(run.id)).toBe(true);
      expect(r.worker.status().paused).toBeNull();
    } finally {
      await r.worker.stop();
    }
  });

  test("a paused queue waits for its poll interval instead of spinning", async () => {
    let looks = 0;
    const r = rig({
      pausePollMs: 60_000,
      credentials: () => {
        looks++;
        return { ok: false, code: "missing", problem: "no token" };
      },
    });
    r.worker.start();
    try {
      const run = r.make();
      r.worker.enqueue(run.id);
      await r.worker.idle();
      const before = looks;
      await Bun.sleep(100);
      expect(looks - before).toBeLessThan(5);
    } finally {
      await r.worker.stop();
    }
  });
});

describe("push (backfill, retry, verify, unpublish)", () => {
  test("a project backfill queues its finished, not-yet-uploaded runs oldest first and reports progress", async () => {
    const r = rig();
    const newest = r.make({ at: 30 });
    const oldest = r.make({ at: 10 });
    const middle = r.make({ at: 20 });
    r.make({ at: 40, status: "running" });
    const queued = r.worker.push({ projectId: r.projectId });
    expect(queued).toBe(3);
    expect(r.worker.status().queue.backfill).toEqual({ total: 3, done: 0 });
    await r.worker.drain();

    expect(r.hub.puts().map((l) => l.detail)).toEqual([oldest.id, middle.id, newest.id]);
    expect(r.worker.status().queue.backfill).toBeNull();
    expect(r.worker.push({ projectId: r.projectId })).toBe(0);
  });

  test("--since only takes runs created on or after the date", async () => {
    const r = rig();
    r.make({ at: 1 });
    const recent = r.make({ at: 60 * 24 * 3 });
    expect(r.worker.push({ projectId: r.projectId, since: "2026-03-03T00:00:00.000Z" })).toBe(1);
    await r.worker.drain();
    expect(r.hub.runs.has(recent.id)).toBe(true);
  });

  test("a failed upload can be retried now, and a parked run only by naming it", async () => {
    const r = rig();
    const flaky = r.make({ at: 1 });
    const clash = r.make({ at: 2 });
    r.hub.down = true;
    r.worker.enqueue(flaky.id);
    await r.worker.drain();
    r.hub.down = false;
    expect(r.worker.syncState(flaky.id, flaky)?.state).toBe("failed");

    expect(r.worker.push({ failed: true })).toBe(1);
    await r.worker.drain();
    expect(r.hub.runs.has(flaky.id)).toBe(true);

    r.hub.conflicts.add(clash.id);
    r.worker.enqueue(clash.id);
    await r.worker.drain();
    expect(r.worker.syncState(clash.id, clash)?.state).toBe("parked");
    r.hub.conflicts.clear();
    expect(r.worker.push({ failed: true })).toBe(0);
    expect(r.worker.push({ runIds: [clash.id] })).toBe(1);
    await r.worker.drain();
    expect(r.hub.runs.has(clash.id)).toBe(true);
  });

  test("runs of a private project cannot be pushed", () => {
    const r = rig();
    const run = r.make();
    r.share.on = false;
    expect(r.worker.push({ runIds: [run.id] })).toBe(0);
    expect(r.worker.push({ projectId: r.projectId })).toBe(0);
  });

  test("verify re-queues runs the hub no longer has or holds in another version", async () => {
    const r = rig();
    const [lost, stale, fine] = [r.make({ at: 1 }), r.make({ at: 2 }), r.make({ at: 3 })];
    for (const run of [lost, stale, fine]) r.worker.enqueue(run.id);
    await r.worker.drain();
    r.hub.runs.delete(lost.id);
    const staleCopy = r.hub.runs.get(stale.id);
    if (staleCopy) staleCopy.hash = "0".repeat(64);

    expect(await r.worker.verify({ projectId: r.projectId })).toEqual({ checked: 3, requeued: 2 });
    r.hub.log.length = 0;
    await r.worker.drain();
    expect(r.hub.puts().map((l) => l.detail).sort()).toEqual([lost.id, stale.id].sort());
  });

  test("a 429 from the hub's token limit is waited out (Retry-After, then the same run again): verify and unpublish complete", async () => {
    const waits: number[] = [];
    const r = rig({ sleep: async (ms) => void waits.push(ms) });
    const runs = [r.make({ at: 1 }), r.make({ at: 2 }), r.make({ at: 3 })];
    for (const run of runs) r.worker.enqueue(run.id);
    await r.worker.drain();
    r.hub.runs.delete(runs[2]!.id);

    r.hub.throttle = { times: 3, retryAfter: "7" };
    expect(await r.worker.verify({ projectId: r.projectId })).toEqual({ checked: 3, requeued: 1 });
    expect(waits).toEqual([7000, 7000, 7000]);
    // every run was asked exactly once successfully: 3 throttled + 3 answered
    expect(r.hub.log.filter((l) => l.method === "GET" && l.path.endsWith("/state")).length).toBe(6);

    waits.length = 0;
    r.hub.throttle = { times: 2, retryAfter: null };
    await r.worker.unpublish(runs[0]!.id);
    expect(r.hub.runs.has(runs[0]!.id)).toBe(false);
    expect(r.worker.syncState(runs[0]!.id, runs[0]!)?.state).toBe("local");
    expect(waits.length).toBe(2);
    expect(waits.every((ms) => ms >= 1000 && ms <= 60_000)).toBe(true);
  });

  test("a hub that keeps answering 429 is given up on after a few waits, as an error", async () => {
    const waits: number[] = [];
    const r = rig({ sleep: async (ms) => void waits.push(ms) });
    const run = r.make();
    r.worker.enqueue(run.id);
    await r.worker.drain();
    r.hub.throttle = { times: 1000, retryAfter: "1" };
    await expect(r.worker.verify()).rejects.toMatchObject({ message: expect.stringContaining("429") });
    expect(waits.length).toBeGreaterThan(0);
    expect(waits.length).toBeLessThan(20);
  });

  test("unpublish deletes the hub copy and forgets the upload; an unknown copy is fine", async () => {
    const r = rig();
    const run = r.make();
    r.worker.enqueue(run.id);
    await r.worker.drain();
    await r.worker.unpublish(run.id);
    expect(r.hub.runs.has(run.id)).toBe(false);
    expect(r.worker.syncState(run.id, run)?.state).toBe("local");
    await r.worker.unpublish(run.id);
  });
});

describe("connection test", () => {
  const settings = { url: "https://hub.example.com", screenshots: "webp" as const, headers: {} };

  test("a working hub reports its machine name and version", async () => {
    const r = rig();
    expect(await r.worker.testConnection()).toMatchObject({ state: "ok", machine: "ann-mbp", hubVersion: "9.9.9", minProtocol: 1 });
    expect(r.worker.status().connection.state).toBe("ok");
  });

  test("a wrong token, a login-wanting proxy, an old client, a dead host and a non-hub are told apart", async () => {
    const r = rig();
    r.creds.token = "tpu_wrong";
    expect((await r.worker.testConnection()).state).toBe("unauthorized");
    r.creds.token = TOKEN;
    r.hub.proxyLogin = true;
    expect((await r.worker.testConnection()).state).toBe("proxy_login");
    r.hub.proxyLogin = false;
    r.hub.minProtocol = 5;
    expect((await r.worker.testConnection()).state).toBe("protocol_unsupported");
    r.hub.minProtocol = 1;
    r.hub.down = true;
    expect((await r.worker.testConnection()).state).toBe("unreachable");
    r.hub.down = false;
    const stranger = rig({ settings: () => settings, fetch: async () => new Response("<h1>Welcome to nginx</h1>", { headers: { "content-type": "text/html" } }) });
    expect((await stranger.worker.testConnection()).state).toBe("not_a_hub");
    const gate = rig({ settings: () => settings, fetch: async () => new Response("<h1>Sign in</h1>", { status: 403, headers: { "content-type": "text/html" } }) });
    expect((await gate.worker.testConnection()).state).toBe("proxy_login");
    const api = rig({ settings: () => settings, fetch: async () => Response.json({ hello: "world" }) });
    expect((await api.worker.testConnection()).state).toBe("not_a_hub");
  });

  test("a good test resumes a paused queue", async () => {
    const r = rig();
    const run = r.make();
    r.hub.token = "tpu_rotated";
    r.worker.enqueue(run.id);
    await r.worker.drain();
    expect(r.worker.status().paused).not.toBeNull();
    r.hub.token = TOKEN;
    expect((await r.worker.testConnection()).state).toBe("ok");
    expect(r.worker.status().paused).toBeNull();
  });
});

describe("changing hubs", () => {
  test("after the address changes, runs uploaded to the old hub count as not uploaded and go to the new one", async () => {
    const target = { url: "https://hub.example.com" };
    const r = rig({ settings: () => ({ url: target.url, screenshots: "webp", headers: {} }) });
    const run = r.make();
    r.worker.enqueue(run.id);
    await r.worker.drain();
    expect(r.worker.syncState(run.id, run)?.state).toBe("uploaded");

    target.url = "https://other.example.com";
    expect(r.worker.syncState(run.id, run)?.state).toBe("local");
    r.hub.log.length = 0;
    r.worker.enqueue(run.id);
    await r.worker.drain();
    expect(r.hub.puts()).toHaveLength(1);
    expect(r.worker.syncState(run.id, run)).toMatchObject({ state: "uploaded", url: `https://other.example.com/#/runs/${run.id}` });
  });
});

describe("background worker: robustness", () => {
  test("a due run with no hub configured does not make the worker spin: it looks again at the pause poll", async () => {
    let reads = 0;
    const r = rig({ settings: () => null, getRun: (id) => (reads++, getRun(id)) });
    const run = r.make();
    r.worker.enqueue(run.id);
    r.worker.start();
    try {
      await r.worker.idle();
      const before = reads;
      await Bun.sleep(200);
      expect(reads - before).toBeLessThan(3);
      expect(r.worker.status().queue.waiting).toBe(1);
    } finally {
      await r.worker.stop();
    }
  });

  test("a save that arrives while the run is uploading is sent right after, not dropped", async () => {
    const r = rig();
    const run = r.make();
    const hubFetch = r.hub.fetch;
    let edited = false;
    r.hub.fetch = async (req) => {
      if (!edited && req.method === "PUT" && req.url.includes(`/runs/${run.id}`)) {
        edited = true;
        saveRun({ ...run, title: "Relinked while uploading" });
        r.worker.enqueue(run.id); // what the debounce does for that save
      }
      return hubFetch(req);
    };
    r.worker.enqueue(run.id);
    await r.worker.drain();

    expect(r.hub.runs.get(run.id)?.doc.run.title).toBe("Relinked while uploading");
    expect(r.worker.syncState(run.id, getRun(run.id)!)?.state).toBe("uploaded");
    expect(r.worker.status().queue.waiting).toBe(0);
  });

  test("a save still waiting out its debounce when the server stops is queued, and uploads after the restart", async () => {
    const r = rig({ debounceMs: 60_000 });
    r.worker.start();
    const run = r.make();
    await r.worker.stop();

    const restarted = r.restart();
    expect(restarted.status().queue.waiting).toBe(1);
    await restarted.drain();
    expect(r.hub.runs.has(run.id)).toBe(true);
  });

  test("a run that finished while the server was down uploads at the next start; older runs the user chose not to backfill do not", async () => {
    const r = rig();
    const old = r.make({ at: 1 });
    r.worker.start();
    await r.worker.stop();
    r.clock.now += 3_600_000;

    const interrupted = r.make({ at: 2, status: "interrupted" });
    saveRun({ ...interrupted, endedAt: new Date(r.clock.now - 60_000).toISOString() });
    const restarted = r.restart();
    restarted.start();
    try {
      await restarted.idle();
      expect(r.hub.runs.has(interrupted.id)).toBe(true);
      expect(r.hub.runs.has(old.id)).toBe(false);
    } finally {
      await restarted.stop();
    }
  });

  test("an error inside a background pass or the debounce timer is logged, not thrown into the process", async () => {
    const seen: unknown[] = [];
    const onRejection = (e: unknown) => seen.push(e);
    process.on("unhandledRejection", onRejection);
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void errors.push(args.join(" "));
    let broken = true;
    const r = rig({
      getRun: (id) => {
        if (broken) throw new Error("disk went away");
        return getRun(id);
      },
    });
    const run = r.make();
    r.worker.enqueue(run.id);
    try {
      r.worker.start();
      await Bun.sleep(30);
      expect(seen).toEqual([]);
      expect(errors.join("\n")).toContain("disk went away");
      broken = false;
      await r.worker.drain();
      expect(r.hub.runs.has(run.id)).toBe(true);
    } finally {
      console.error = original;
      process.off("unhandledRejection", onRejection);
      await r.worker.stop();
    }
  });

  test("an unreadable outbox is set aside as .corrupt instead of being silently overwritten", () => {
    const r = rig();
    fs.writeFileSync(r.stateFile, "{ not json");
    const warn = console.warn;
    console.warn = () => {};
    try {
      const worker = r.restart();
      expect(worker.status().queue).toMatchObject({ waiting: 0, uploaded: 0 });
    } finally {
      console.warn = warn;
    }
    expect(fs.readFileSync(`${r.stateFile}.corrupt`, "utf8")).toBe("{ not json");
  });
});

describe("hub retention", () => {
  test("a run older than the hub's retention is not uploaded (it would be deleted again within hours)", async () => {
    const r = rig();
    r.hub.retentionDays = 30;
    const stale = r.make({ at: 1 }); // 1 minute after 2026-03-01 against a clock at 2026-04-01 and 30 days
    const fresh = r.make({ at: 60 * 24 * 25 }); // 2026-03-26
    expect(r.worker.push({ projectId: r.projectId })).toBe(2);
    await r.worker.drain();

    expect(r.hub.runs.has(fresh.id)).toBe(true);
    expect(r.hub.runs.has(stale.id)).toBe(false);
    expect(r.worker.status().queue).toMatchObject({ waiting: 0, backfill: null });
    // the retention is known now: the next backfill does not offer the stale run again
    expect(r.worker.push({ projectId: r.projectId })).toBe(0);
  });

  test("verify does not send again a run the hub deleted because of its retention", async () => {
    const r = rig();
    const old = r.make({ at: 1 });
    const recent = r.make({ at: 60 * 24 * 25 });
    r.worker.enqueue(old.id);
    r.worker.enqueue(recent.id);
    await r.worker.drain();
    r.hub.retentionDays = 30;
    r.hub.runs.delete(old.id);
    r.hub.runs.delete(recent.id);

    expect(await r.worker.verify()).toEqual({ checked: 2, requeued: 1 });
    await r.worker.drain();
    expect(r.hub.runs.has(recent.id)).toBe(true);
    expect(r.hub.runs.has(old.id)).toBe(false);
  });

  test("a hub that keeps everything gets every run", async () => {
    const r = rig();
    const old = r.make({ at: 1 });
    expect(r.worker.push({ projectId: r.projectId })).toBe(1);
    await r.worker.drain();
    expect(r.hub.runs.has(old.id)).toBe(true);
  });
});
