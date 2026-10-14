// Live progress from the laptop (contract 13): active runs of shared projects are sent to the hub's `PUT …/runs/:id/live`,
// throttled, best effort, never through the outbox. The worker's live timers are replaced by a scheduler the test advances.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { HubConfigSchema } from "../src/config";
import { packageLive, type PackagedRun } from "../src/hub/package";
import { LIVE_MAX_BYTES, LiveRunBody } from "../src/hub/protocol";
import { HubSyncWorker, type HubSyncOptions } from "../src/hub/sync";
import type { Project } from "../src/projects/registry";
import type { GitRunner } from "../src/regression/baseline";
import { saveRun } from "../src/runs/store";
import type { Run } from "../src/runs/types";
import { createFakeHub, type FakeHub, type LiveAnswer } from "./support/fake-hub";
import { cleanupRuns, makeRun, uniqueTest } from "./support/regression";

const TOKEN = "tpu_testtoken0000000000000000000000000000000";
const THROTTLE = 40;
const HEARTBEAT = 60_000;
const dirs: string[] = [];
const sha = (s: string | Uint8Array): string => createHash("sha256").update(s).digest("hex");

afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
afterEach(cleanupRuns);

interface Scheduler {
  start(fn: () => void, ms: number): () => void;
  /** Moves the clock; timers fire, in order, as it passes their time. */
  advance(ms: number): void;
  armed(): number;
}

function scheduler(): Scheduler {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    start(fn: () => void, ms: number): () => void {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn });
      return () => void timers.delete(id);
    },
    advance(ms: number): void {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = target;
    },
    armed: () => timers.size,
  };
}

/** `remote get-url` / `rev-parse` / `worktree list` answers for a repo at `repo`; every call is counted. */
function fakeGit(repo: string): { git: GitRunner; calls: () => number } {
  let calls = 0;
  const git: GitRunner = async (_cwd, args) => {
    calls++;
    if (args[0] === "remote") return "git@github.com:acme/shop.git";
    if (args.includes("--show-prefix")) return "";
    if (args.includes("--show-toplevel")) return repo;
    if (args[0] === "worktree") return `worktree ${repo}\nHEAD abc\n`;
    return null;
  };
  return { git, calls: () => calls };
}

/** The upload side of a finished run, deterministic (the real packaging is covered by hub-package.test.ts). */
async function fakePackage(run: Run, project: Project): Promise<PackagedRun> {
  const doc = {
    protocol: 1,
    clientVersion: "0.0.0-test",
    sentAt: new Date().toISOString(),
    project: { hubKey: "github.com/acme/shop", name: project.name, remoteUrl: null, subpath: null, defaultBranch: null, defaultPlatform: "android" as const, localId: project.id },
    run: { id: run.id, projectId: project.id, title: run.title, status: run.status as "done", createdAt: run.createdAt, checks: run.checks.map((c) => ({ id: c.id, title: c.title, status: c.status })), testKey: run.testKey ?? null },
    batch: null,
    report: null,
    activity: null,
    screenshots: [],
    transcript: null,
    redaction: { replaced: {} },
  };
  return { doc, blobs: new Map(), contentHash: sha(JSON.stringify(doc.run)) };
}

interface Rig {
  hub: FakeHub;
  worker: HubSyncWorker;
  sched: Scheduler;
  projectId: string;
  creds: { token: string };
  share: { on: boolean };
  settings: { live: boolean | undefined };
  /** A stored run in progress with one passed check. Created before the worker starts, so its saves are the test's own. */
  make(over?: { note?: string; screenshot?: string }): Run;
  /** A stored finished run. */
  finished(): Run;
  /** The live requests the hub got for a run. */
  sent(runId: string): number;
  /** Lets in-flight work finish. */
  settle(): Promise<void>;
}

function rig(over: Partial<HubSyncOptions> = {}): Rig {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tpc-hublive-"));
  dirs.push(repo);
  const hub = createFakeHub(TOKEN);
  const sched = scheduler();
  const projectId = `live-${randomBytes(4).toString("hex")}`;
  const share = { on: true };
  const creds = { token: TOKEN };
  const settings: Rig["settings"] = { live: undefined };
  const { git } = fakeGit(repo);
  const worker = new HubSyncWorker({
    stateFile: path.join(repo, "hub-outbox.json"),
    settings: () => ({ url: "https://hub.example.com", screenshots: "webp", headers: {}, live: settings.live }),
    credentials: () => ({ ok: true, token: creds.token, tokenSource: "file", tokenHint: creds.token.slice(-4), headers: {}, headersSource: null }),
    fetch: (req) => hub.fetch(req),
    getProject: (id) =>
      id === projectId
        ? ({ id, name: "Acme Shop", repoPath: repo, personaFile: null, defaultPackage: "com.example.app", defaultPlatform: "android", defaultBranch: "main", share: share.on } satisfies Project)
        : undefined,
    packageRun: fakePackage,
    packageLive: (run, project) => packageLive(run, project, { git }),
    debounceMs: 0,
    liveThrottleMs: THROTTLE,
    liveHeartbeatMs: HEARTBEAT,
    liveTimers: sched.start,
    ...over,
  });
  return {
    hub,
    worker,
    sched,
    projectId,
    creds,
    share,
    settings,
    make: ({ note, screenshot } = {}) =>
      makeRun({ testKey: uniqueTest(), at: 1, projectId, status: "running", verdict: null, checks: [{ id: "c1", status: "pass", ...(note ? { note } : {}), ...(screenshot ? { screenshot } : {}) }] }),
    finished: () => makeRun({ testKey: uniqueTest(), at: 1, projectId, status: "done", checks: [["c1", "pass"]] }),
    sent: (runId) => hub.liveRequests.filter((l) => l.runId === runId).length,
    settle: () => worker.idle(),
  };
}

/** Saves the run with `n` checks, as the agent does while it works. */
function tick(run: Run, n: number): Run {
  const next: Run = { ...run, checks: Array.from({ length: n }, (_, i) => ({ ...run.checks[0]!, id: `c${i + 1}`, title: `Check c${i + 1}` })) };
  saveRun(next);
  return next;
}

describe("packageLive", () => {
  const project = (repo: string): Project => ({ id: "acme-app", name: "Acme Shop", repoPath: repo, personaFile: null, defaultPackage: "com.acme.shop", defaultPlatform: "android" });
  const activeRun = (over: Partial<Parameters<typeof makeRun>[0]> = {}): Run =>
    makeRun({
      testKey: uniqueTest(),
      at: 1,
      projectId: "acme-app",
      status: "running",
      verdict: null,
      checks: [
        { id: "c1", status: "pass", note: `Saw the cart (log at ${os.homedir()}/Library/acme.log, password: hunter2hunter2)`, screenshot: "screenshots/01.png" },
        { id: "c2", status: "running" as never },
      ],
      ...over,
    });
  const tmpRepo = (): string => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tpc-livepkg-"));
    dirs.push(repo);
    return repo;
  };

  test("is the upload document without blobs: redacted notes, no screenshots, no report, same run fields", async () => {
    const repo = tmpRepo();
    const run = activeRun();
    const body = await packageLive(run, project(repo), { git: fakeGit(repo).git, now: () => Date.parse("2026-02-03T04:05:06.000Z"), clientVersion: "9.9.9" });

    expect(LiveRunBody.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({ protocol: 1, clientVersion: "9.9.9", sentAt: "2026-02-03T04:05:06.000Z" });
    expect(body.project).toMatchObject({ hubKey: "github.com/acme/shop", name: "Acme Shop", localId: "acme-app" });
    expect(body.run).toMatchObject({ id: run.id, status: "running", reportPath: null, transcriptHtml: false, deviceSerial: null, storage: "data", testKey: run.testKey });
    expect(body.run.checks.map((c) => c.id)).toEqual(["c1", "c2"]);
    const note = body.run.checks[0]!.note!;
    expect(note).toContain("~/Library/acme.log");
    expect(note).not.toContain(os.homedir());
    expect(note).not.toContain("hunter2hunter2");
    expect(body.redaction.replaced).not.toEqual({});
    expect(JSON.stringify(body)).not.toContain("screenshots/01.png");
    expect(body.run.checks.every((c) => !("screenshot" in c))).toBe(true);
    expect(Object.keys(body).sort()).toEqual(["clientVersion", "project", "protocol", "redaction", "run", "sentAt"]);
  });

  test("git is asked once per run, however often the run is sent", async () => {
    const repo = tmpRepo();
    const { git, calls } = fakeGit(repo);
    const run = activeRun();
    await packageLive(run, project(repo), { git });
    const afterFirst = calls();
    expect(afterFirst).toBeGreaterThan(0);
    await packageLive({ ...run, checks: run.checks.slice(0, 1) }, project(repo), { git });
    await packageLive(run, project(repo), { git });
    expect(calls()).toBe(afterFirst);
  });

  test("the brief and the notes are clamped so a document stays far below the hub's size limit", async () => {
    const repo = tmpRepo();
    const run = activeRun({ brief: "b".repeat(50_000), checks: [{ id: "c1", status: "pass", note: "n".repeat(30_000) }] });
    const body = await packageLive(run, project(repo), { git: fakeGit(repo).git });
    const brief = z.string().parse(body.run.brief);
    expect(brief.length).toBeLessThanOrEqual(4000);
    expect(brief.startsWith("bbb")).toBe(true);
    expect(z.string().parse(body.run.checks[0]?.note).length).toBeLessThanOrEqual(2000);
    expect(JSON.stringify(body).length).toBeLessThan(LIVE_MAX_BYTES);
  });

  test("a finished run is not live progress", async () => {
    const repo = tmpRepo();
    await expect(packageLive(activeRun({ status: "done" }), project(repo), { git: fakeGit(repo).git })).rejects.toThrow(/not in progress/);
  });

  test("a project that cannot be named on the hub fails with the same advice as an upload", async () => {
    const repo = tmpRepo();
    await expect(packageLive(activeRun(), project(repo), { git: async () => null })).rejects.toThrow(/set a hubKey/);
  });
});

describe("live sending", () => {
  test("a running shared run is sent as JSON the hub accepts, redacted and without screenshot paths", async () => {
    const r = rig();
    const run = r.make({ note: `Opened ${os.homedir()}/Library/acme.log with API_TOKEN=abcdef123456`, screenshot: "screenshots/01.png" });
    r.worker.start();
    try {
      saveRun(run);
      await r.settle();
      expect(r.hub.liveRequests).toHaveLength(1);
      const sent = r.hub.liveRequests[0]!;
      expect(sent.runId).toBe(run.id);
      expect(sent.contentType).toStartWith("application/json");
      expect(sent.body.run).toMatchObject({ id: run.id, status: "running", projectId: r.projectId });
      expect(sent.body.run.checks[0]!.note).toContain("~/Library/acme.log");
      expect(sent.raw).not.toContain(os.homedir());
      expect(sent.raw).not.toContain("abcdef123456");
      expect(sent.raw).not.toContain("screenshots/01.png");
      expect(r.hub.livePuts()[0]).toMatchObject({ method: "PUT", path: `/api/hub/v1/runs/${run.id}/live` });
      // Best effort: the outbox never hears of it.
      expect(r.worker.status().queue).toMatchObject({ waiting: 0, failed: 0, uploading: null });
      expect(r.hub.puts()).toEqual([]);
    } finally {
      await r.worker.stop();
    }
  });

  test("rapid saves are throttled to one request per interval, and the last state always arrives", async () => {
    const r = rig();
    const run = r.make();
    r.worker.start();
    try {
      saveRun(run);
      await r.settle();
      expect(r.sent(run.id)).toBe(1);

      let latest = run;
      for (const n of [2, 3, 4, 5]) latest = tick(latest, n);
      r.sched.advance(THROTTLE - 1);
      await r.settle();
      expect(r.sent(run.id)).toBe(1);
      expect(r.hub.liveRequests[0]!.body.run.checks).toHaveLength(1);

      r.sched.advance(1);
      await r.settle();
      expect(r.sent(run.id)).toBe(2);
      expect(r.hub.liveRequests[1]!.body.run.checks).toHaveLength(5);

      // Nothing changed since: the interval ending sends nothing more.
      r.sched.advance(HEARTBEAT - 2 * THROTTLE);
      await r.settle();
      expect(r.sent(run.id)).toBe(2);
    } finally {
      await r.worker.stop();
    }
  });

  test("a save after a quiet interval goes out at once", async () => {
    const r = rig();
    const run = r.make();
    r.worker.start();
    try {
      saveRun(run);
      await r.settle();
      r.sched.advance(THROTTLE);
      tick(run, 2);
      await r.settle();
      expect(r.hub.liveRequests.map((l) => l.body.run.checks.length)).toEqual([1, 2]);
    } finally {
      await r.worker.stop();
    }
  });

  test("an active run is resent every heartbeat while nothing changes", async () => {
    const r = rig({ liveThrottleMs: 10, liveHeartbeatMs: 40 });
    const run = r.make();
    r.worker.start();
    try {
      saveRun(run);
      await r.settle();
      expect(r.sent(run.id)).toBe(1);
      for (const expected of [2, 3, 4]) {
        r.sched.advance(40);
        await r.settle();
        expect(r.sent(run.id)).toBe(expected);
      }
      expect(r.hub.liveRequests.every((l) => l.body.run.checks.length === 1 && l.body.run.status === "running")).toBe(true);
    } finally {
      await r.worker.stop();
    }
  });

  test("a terminal run stops the live updates and its normal upload still happens", async () => {
    const r = rig({ liveThrottleMs: 10, liveHeartbeatMs: 30 });
    const run = r.make();
    r.worker.start();
    try {
      saveRun(run);
      r.sched.advance(30);
      await r.settle();
      expect(r.sent(run.id)).toBe(2);

      saveRun({ ...run, status: "done", verdict: "PASS" });
      await r.settle();
      expect(r.hub.runs.get(run.id)?.doc.run.status).toBe("done");
      expect(r.sched.armed()).toBe(0);
      r.sched.advance(10 * HEARTBEAT);
      await r.settle();
      expect(r.sent(run.id)).toBe(2);
      expect(r.hub.liveRequests.every((l) => l.body.run.status === "running")).toBe(true);
    } finally {
      await r.worker.stop();
    }
  });

  test("a live request that never answers does not delay a finished run's upload", async () => {
    const r = rig({ fetch: (req) => (req.url.endsWith("/live") ? new Promise<Response>(() => {}) : r.hub.fetch(req)) });
    const run = r.make();
    const done = r.finished();
    r.worker.start();
    try {
      saveRun(run);
      r.worker.enqueue(done.id);
      await r.worker.drain();
      expect(r.hub.runs.has(done.id)).toBe(true);
      expect(r.hub.livePuts()).toHaveLength(0);
    } finally {
      await r.worker.stop();
    }
  });

  test("stop() cancels the timers: nothing goes out afterwards", async () => {
    const r = rig({ liveThrottleMs: 10, liveHeartbeatMs: 20 });
    const run = r.make();
    r.worker.start();
    saveRun(run);
    await r.settle();
    expect(r.sched.armed()).toBeGreaterThan(0);
    await r.worker.stop();
    expect(r.sched.armed()).toBe(0);
    r.sched.advance(10 * HEARTBEAT);
    await r.settle();
    expect(r.sent(run.id)).toBe(1);
  });
});

describe("when nothing is sent", () => {
  test("a project that is not shared sends nothing", async () => {
    const r = rig();
    const run = r.make();
    r.share.on = false;
    r.worker.start();
    try {
      saveRun(run);
      r.sched.advance(10 * HEARTBEAT);
      await r.settle();
      expect(r.hub.log).toEqual([]);
      expect(r.sched.armed()).toBe(0);
    } finally {
      await r.worker.stop();
    }
  });

  test("share.hub.live: false sends nothing; an unset flag, or true, sends", async () => {
    const r = rig();
    const run = r.make();
    r.settings.live = false;
    r.worker.start();
    try {
      saveRun(run);
      r.sched.advance(10 * HEARTBEAT);
      await r.settle();
      expect(r.hub.log).toEqual([]);

      r.settings.live = true;
      tick(run, 2);
      await r.settle();
      expect(r.sent(run.id)).toBe(1);

      r.settings.live = undefined;
      r.sched.advance(THROTTLE);
      tick(run, 3);
      await r.settle();
      expect(r.sent(run.id)).toBe(2);
    } finally {
      await r.worker.stop();
    }
  });

  test("turning live off while a run is in progress stops its heartbeat", async () => {
    const r = rig();
    const run = r.make();
    r.worker.start();
    try {
      saveRun(run);
      await r.settle();
      r.settings.live = false;
      r.sched.advance(10 * HEARTBEAT);
      await r.settle();
      expect(r.sent(run.id)).toBe(1);
    } finally {
      await r.worker.stop();
    }
  });

  test("with no hub configured nothing is sent", async () => {
    const r = rig({ settings: () => null });
    const run = r.make();
    r.worker.start();
    try {
      saveRun(run);
      r.sched.advance(10 * HEARTBEAT);
      await r.settle();
      expect(r.hub.log).toEqual([]);
    } finally {
      await r.worker.stop();
    }
  });

  test("while uploads are paused nothing is sent", async () => {
    const r = rig();
    const run = r.make();
    const done = r.finished();
    r.creds.token = "tpu_revoked";
    r.worker.start();
    try {
      saveRun(done);
      await r.settle();
      expect(r.worker.status().paused?.reason).toBe("unauthorized");
      const before = r.hub.log.length;

      saveRun(run);
      tick(run, 2);
      r.sched.advance(10 * HEARTBEAT);
      await r.settle();
      expect(r.hub.log).toHaveLength(before);
      expect(r.hub.livePuts()).toHaveLength(0);
    } finally {
      await r.worker.stop();
    }
  });
});

describe("hub answers", () => {
  test("404 (a hub without the route) turns live off for this connection and leaves uploads alone", async () => {
    const r = rig();
    r.hub.liveAnswer = "not_found";
    const run = r.make();
    const done = r.finished();
    r.worker.start();
    try {
      saveRun(run);
      await r.settle();
      expect(r.hub.livePuts()).toHaveLength(1);

      tick(run, 2);
      r.sched.advance(10 * HEARTBEAT);
      await r.settle();
      expect(r.hub.livePuts()).toHaveLength(1);
      expect(r.worker.status().paused).toBeNull();

      saveRun(done);
      await r.settle();
      expect(r.hub.runs.has(done.id)).toBe(true);
      expect(r.worker.status().paused).toBeNull();
    } finally {
      await r.worker.stop();
    }
  });

  test("a changed token makes the hub worth asking again after a 404", async () => {
    const r = rig();
    r.hub.liveAnswer = "not_found";
    const run = r.make();
    r.worker.start();
    try {
      saveRun(run);
      await r.settle();
      expect(r.hub.livePuts()).toHaveLength(1);

      r.hub.liveAnswer = "live";
      r.hub.token = "tpu_rotated";
      r.creds.token = "tpu_rotated";
      r.sched.advance(THROTTLE);
      tick(run, 2);
      await r.settle();
      expect(r.hub.liveRequests).toHaveLength(1);
    } finally {
      await r.worker.stop();
    }
  });

  test.each<[LiveAnswer, string]>([
    ["unauthorized", "401"],
    ["proxy_login", "a proxy login page"],
    ["protocol_unsupported", "426"],
    ["not_found", "404"],
  ])("%s on the live route only turns live off: uploads are not paused and the outbox is untouched", async (answer) => {
    const r = rig();
    r.hub.liveAnswer = answer;
    const run = r.make();
    const done = r.finished();
    r.worker.start();
    try {
      saveRun(run);
      await r.settle();
      expect(r.hub.livePuts()).toHaveLength(1);
      expect(r.worker.status().paused).toBeNull();
      expect(r.worker.status().queue).toMatchObject({ waiting: 0, failed: 0 });

      tick(run, 2);
      r.sched.advance(10 * HEARTBEAT);
      await r.settle();
      expect(r.hub.livePuts()).toHaveLength(1);

      // A finished upload goes through as if nothing had happened…
      saveRun(done);
      await r.settle();
      expect(r.hub.runs.has(done.id)).toBe(true);
      expect(r.worker.status().paused).toBeNull();

      // …and live asks again once the credentials change.
      r.hub.liveAnswer = "live";
      r.hub.token = "tpu_rotated";
      r.creds.token = "tpu_rotated";
      r.sched.advance(THROTTLE);
      tick(run, 3);
      await r.settle();
      expect(r.hub.liveRequests.at(-1)!.body.run.checks).toHaveLength(3);
    } finally {
      await r.worker.stop();
    }
  });

  test("an access proxy that lets uploads through but sends /live to a login page: uploads keep working", async () => {
    const r = rig();
    r.hub.liveAnswer = "proxy_login";
    const run = r.make();
    const first = r.finished();
    const second = r.finished();
    r.worker.start();
    try {
      saveRun(run);
      await r.settle();
      saveRun(first);
      await r.settle();
      tick(run, 2);
      r.sched.advance(10 * HEARTBEAT);
      saveRun(second);
      await r.settle();
      expect([r.hub.runs.has(first.id), r.hub.runs.has(second.id)]).toEqual([true, true]);
      expect(r.worker.status().paused).toBeNull();
      expect(r.hub.livePuts()).toHaveLength(1);
    } finally {
      await r.worker.stop();
    }
  });

  test("a hub that is wholly behind a login: live stops quietly and the finished upload finds the real problem itself", async () => {
    const r = rig();
    r.hub.proxyLogin = true;
    const run = r.make();
    const done = r.finished();
    r.worker.start();
    try {
      saveRun(run);
      await r.settle();
      expect(r.worker.status().paused).toBeNull();
      saveRun(done);
      await r.settle();
      expect(r.worker.status().paused).toMatchObject({ reason: "unauthorized", detail: expect.stringContaining("login page") });
    } finally {
      await r.worker.stop();
    }
  });

  test.each<[LiveAnswer]>([["final"], ["conflict"], ["too_large"]])("%s stops that run only", async (answer) => {
    const r = rig();
    const stopped = r.make();
    const other = r.make();
    r.hub.liveAnswers.set(stopped.id, answer);
    r.worker.start();
    try {
      saveRun(stopped);
      saveRun(other);
      await r.settle();
      expect([r.sent(stopped.id), r.sent(other.id)]).toEqual([1, 1]);

      r.sched.advance(THROTTLE);
      tick(stopped, 2);
      tick(other, 2);
      r.sched.advance(10 * HEARTBEAT);
      await r.settle();
      expect(r.sent(stopped.id)).toBe(1);
      expect(r.sent(other.id)).toBeGreaterThanOrEqual(2);
      expect(r.worker.status().paused).toBeNull();
    } finally {
      await r.worker.stop();
    }
  });

  test("a network error is ignored: no pause, no outbox entry, and the next change sends again", async () => {
    const r = rig();
    const run = r.make();
    r.hub.down = true;
    r.worker.start();
    try {
      saveRun(run);
      await r.settle();
      expect(r.worker.status()).toMatchObject({ paused: null, queue: { waiting: 0, failed: 0 } });

      r.hub.down = false;
      r.sched.advance(THROTTLE);
      tick(run, 2);
      await r.settle();
      expect(r.hub.liveRequests).toHaveLength(1);
      expect(r.hub.liveRequests[0]!.body.run.checks).toHaveLength(2);
    } finally {
      await r.worker.stop();
    }
  });
});

describe("share.hub.live", () => {
  test("is an optional boolean: unset stays unset (live is on), anything else is refused", () => {
    expect(HubConfigSchema.parse({ url: "https://hub.example.com" }).live).toBeUndefined();
    expect(HubConfigSchema.parse({ url: "https://hub.example.com", live: false }).live).toBe(false);
    expect(HubConfigSchema.safeParse({ url: "https://hub.example.com", live: "no" }).success).toBe(false);
  });
});
