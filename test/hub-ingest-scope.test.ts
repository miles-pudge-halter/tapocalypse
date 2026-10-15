// Contract 14 D: what one upload token can do to a hub's shared state (retention, default branch, registry, rekey, rates).
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fetchHandler } from "../src/api";
import { config } from "../src/config";
import { ingestLiveRun, ingestRun, type RekeyTimers, rekeyPassCount, rekeyProject, setRekeyTimers, type Uploader } from "../src/hub/ingest";
import { deleteLiveRun, getLiveRun } from "../src/hub/live";
import { hubDir, setHubMode } from "../src/hub/mode";
import { hubProjectByKey, installHubProjects, removeHubProject, setHubDefaultBranch } from "../src/hub/projects";
import { HUB_PROTOCOL, type LiveRunBodyT, type RunUploadBodyT } from "../src/hub/protocol";
import { createToken, revokeToken } from "../src/hub/tokens";
import { selectExpiredRuns } from "../src/retention";
import { projectEvents, setProjectSource } from "../src/projects/registry";
import { deleteRun, getRun, listRuns } from "../src/runs/store";

const tag = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const HOST = `127.0.0.1:${config.port}`;
const base = `http://${HOST}`;
const created: string[] = [];
const tokens: string[] = [];
let counter = 0;

const uploaderOf = (name: string): Uploader => ({ machine: `${tag}-${name}`, admin: false, identity: null });
const alice = uploaderOf("alice");
const mallory = uploaderOf("mallory");
const bob = uploaderOf("bob");

beforeAll(() => {
  setHubMode(true);
  installHubProjects();
});

afterEach(() => {
  setHubMode(true);
});

afterAll(() => {
  setHubMode(null);
  setProjectSource(null);
  for (const id of created) {
    deleteLiveRun(id);
    deleteRun(id);
  }
  for (const name of tokens) revokeToken(name);
  const registry = path.join(hubDir(), "projects.json");
  if (fs.existsSync(registry)) {
    const entries = JSON.parse(fs.readFileSync(registry, "utf8")) as { hubKey: string }[];
    fs.writeFileSync(registry, JSON.stringify(entries.filter((e) => !e.hubKey.includes(tag))));
  }
});

interface DocOptions {
  hubKey: string;
  createdAt?: string;
  defaultBranch?: string | null;
  explicit?: boolean;
  remoteUrl?: string | null;
  subpath?: string | null;
  testKey?: string;
  run?: Record<string, unknown>;
}

function doc(o: DocOptions): { id: string; body: RunUploadBodyT } {
  const id = `20260101-0000${String(++counter).padStart(2, "0")}-${tag}-sc${counter}`;
  created.push(id);
  return {
    id,
    body: {
      protocol: HUB_PROTOCOL,
      clientVersion: "0.1.0",
      sentAt: new Date().toISOString(),
      project: {
        hubKey: o.hubKey,
        name: "Acme Shop",
        remoteUrl: o.remoteUrl === undefined ? "https://github.com/acme/shop" : o.remoteUrl,
        subpath: o.subpath === undefined ? null : o.subpath,
        defaultBranch: o.defaultBranch === undefined ? "main" : o.defaultBranch,
        ...(o.explicit ? { defaultBranchSource: "explicit" } : {}),
        defaultPlatform: "android",
        localId: "shop",
      },
      run: {
        id,
        projectId: "shop",
        title: "Checkout flow",
        status: "done",
        createdAt: o.createdAt ?? "2026-01-01T00:00:00.000Z",
        checks: [{ id: "C1", title: "Checkout total updates", status: "pass", updatedAt: "2026-01-01T00:00:00.000Z" }],
        testKey: o.testKey ?? "brief:machine-local",
        brief: "Walk through checkout",
        verdict: "PASS",
        deviceRequest: { platform: "android" },
        ...o.run,
      },
      batch: null,
      report: null,
      activity: null,
      screenshots: [],
      transcript: null,
      redaction: { replaced: {} },
    } as unknown as RunUploadBodyT,
  };
}

function liveDoc(o: DocOptions): { id: string; body: LiveRunBodyT } {
  const { id, body } = doc({ ...o, run: { status: "running", ...o.run } });
  return { id, body: { protocol: body.protocol, clientVersion: body.clientVersion, sentAt: body.sentAt, project: body.project, run: body.run, redaction: body.redaction } as unknown as LiveRunBodyT };
}

const expectHttp = (fn: () => unknown, status: number, code?: string): void => {
  try {
    fn();
  } catch (e) {
    expect((e as { status?: number }).status).toBe(status);
    if (code) expect((e as { code?: string }).code).toBe(code);
    return;
  }
  throw new Error(`expected an HTTP ${status} error`);
};

const T1 = new Date("2026-05-01T10:00:00.000Z");
const T2 = new Date("2026-05-02T10:00:00.000Z");
const T3 = new Date("2026-05-03T10:00:00.000Z");

describe("uploader times", () => {
  test("a creation time in the far future is clamped to when the hub received the run; a close one is kept", () => {
    const hubKey = `github.com/acme/clamp-${tag}`;
    const far = doc({ hubKey, createdAt: "2099-01-01T00:00:00.000Z" });
    ingestRun(far.id, far.body, alice, T1);
    expect(getRun(far.id)?.createdAt).toBe(T1.toISOString());
    expect(getRun(far.id)?.hub?.receivedAt).toBe(T1.toISOString());

    const close = doc({ hubKey, createdAt: "2026-05-01T10:04:00.000Z" });
    ingestRun(close.id, close.body, alice, T1);
    expect(getRun(close.id)?.createdAt).toBe("2026-05-01T10:04:00.000Z");

    const justOver = doc({ hubKey, createdAt: "2026-05-01T10:05:01.000Z" });
    ingestRun(justOver.id, justOver.body, alice, T1);
    expect(getRun(justOver.id)?.createdAt).toBe(T1.toISOString());
  });

  test("start and end times in the future are clamped; real past times are kept", () => {
    const hubKey = `github.com/acme/ends-${tag}`;
    const d = doc({ hubKey, run: { startedAt: "2026-05-01T09:00:00.000Z", endedAt: "2999-12-31T23:59:59.000Z" } });
    ingestRun(d.id, d.body, alice, T1);
    expect(getRun(d.id)?.startedAt).toBe("2026-05-01T09:00:00.000Z");
    expect(getRun(d.id)?.endedAt).toBe(T1.toISOString());

    const live = liveDoc({ hubKey, run: { startedAt: "3000-01-01T00:00:00.000Z", endedAt: null } });
    ingestLiveRun(live.id, live.body, alice, T1);
    expect(getLiveRun(live.id)?.startedAt).toBe(T1.toISOString());
    expect(getLiveRun(live.id)?.createdAt).toBe("2026-01-01T00:00:00.000Z");
  });

  test("a start or end time that is not an ISO datetime is refused with 422 invalid_run, and nothing is stored", () => {
    const hubKey = `github.com/acme/garbage-${tag}`;
    for (const run of [{ endedAt: "never" }, { startedAt: "yesterday" }, { endedAt: 12345 }, { endedAt: "2026-13-45T00:00:00Z" }]) {
      const d = doc({ hubKey, run });
      expectHttp(() => ingestRun(d.id, d.body, alice, T1), 422, "invalid_run");
      expect(getRun(d.id)).toBeNull();
      const live = liveDoc({ hubKey, run });
      expectHttp(() => ingestLiveRun(live.id, live.body, alice, T1), 422, "invalid_run");
      expect(getLiveRun(live.id)).toBeUndefined();
    }
    expect(hubProjectByKey(hubKey)).toBeUndefined();
    const nulls = doc({ hubKey, run: { startedAt: null, endedAt: null } });
    ingestRun(nulls.id, nulls.body, alice, T1);
    expect(getRun(nulls.id)?.endedAt).toBeNull();
  });

  test("a far-future run cannot outrank real runs in retention", () => {
    const hubKey = `github.com/acme/retain-${tag}`;
    const evil = doc({ hubKey, createdAt: "2099-01-01T00:00:00.000Z", run: { endedAt: "2099-01-01T00:00:00.000Z" } });
    ingestRun(evil.id, evil.body, mallory, T1);
    const real = doc({ hubKey, createdAt: "2026-05-02T09:00:00.000Z", run: { endedAt: "2026-05-02T09:30:00.000Z" } });
    ingestRun(real.id, real.body, alice, T2);

    const runs = listRuns({ projectId: hubProjectByKey(hubKey)!.id });
    expect(runs[0]?.id).toBe(real.id);
    expect(selectExpiredRuns(runs, { maxRuns: 1 }, T3.getTime())).toEqual([evil.id]);
    // by age: the clamped end time makes the run exactly as old as it is, not immortal
    expect(selectExpiredRuns(runs, { days: 1 }, Date.parse("2026-06-30T00:00:00Z")).sort()).toEqual([evil.id, real.id].sort());
  });

  test("a far-future createdAt cannot pin the default branch: a later real run still changes it", () => {
    const hubKey = `github.com/acme/pin-${tag}`;
    const first = doc({ hubKey, createdAt: "2026-05-01T09:00:00.000Z", defaultBranch: "main", explicit: true });
    ingestRun(first.id, first.body, alice, T1);
    const evil = doc({ hubKey, createdAt: "2099-01-01T00:00:00.000Z", defaultBranch: "evil", explicit: true });
    ingestRun(evil.id, evil.body, mallory, T1);
    expect(hubProjectByKey(hubKey)?.defaultBranch).toBe("evil");
    expect(hubProjectByKey(hubKey)?.defaultBranchRunAt).toBe(T1.toISOString());

    const real = doc({ hubKey, createdAt: "2026-05-02T09:00:00.000Z", defaultBranch: "main", explicit: true });
    ingestRun(real.id, real.body, alice, T2);
    expect(hubProjectByKey(hubKey)?.defaultBranch).toBe("main");
  });
});

describe("project registry", () => {
  test("remoteUrl and subpath keep the first value; a later upload only fills an empty one", () => {
    const hubKey = `github.com/acme/first-${tag}`;
    const a = doc({ hubKey, remoteUrl: "https://github.com/acme/first", subpath: "app" });
    ingestRun(a.id, a.body, alice, T1);
    const b = doc({ hubKey, remoteUrl: "https://evil.example/phish", subpath: "elsewhere" });
    ingestRun(b.id, b.body, mallory, T2);
    expect(hubProjectByKey(hubKey)).toMatchObject({ remoteUrl: "https://github.com/acme/first", subpath: "app" });

    const emptyKey = `github.com/acme/empty-${tag}`;
    const c = doc({ hubKey: emptyKey, remoteUrl: null, subpath: null });
    ingestRun(c.id, c.body, alice, T1);
    const d = doc({ hubKey: emptyKey, remoteUrl: "https://github.com/acme/empty", subpath: "mobile" });
    ingestRun(d.id, d.body, bob, T2);
    const e = doc({ hubKey: emptyKey, remoteUrl: "https://evil.example/phish", subpath: "elsewhere" });
    ingestRun(e.id, e.body, mallory, T3);
    expect(hubProjectByKey(emptyKey)).toMatchObject({ remoteUrl: "https://github.com/acme/empty", subpath: "mobile" });
  });

  test("an admin-set default branch is locked: uploads, even newer explicit ones, no longer change it; --clear opens it again", () => {
    const hubKey = `github.com/acme/lock-${tag}`;
    const a = doc({ hubKey, createdAt: "2026-05-01T09:00:00.000Z", defaultBranch: "evil", explicit: true });
    ingestRun(a.id, a.body, mallory, T1);
    expect(hubProjectByKey(hubKey)?.defaultBranch).toBe("evil");

    expect(setHubDefaultBranch(hubKey, "main")).toMatchObject({ defaultBranch: "main", defaultBranchSource: "explicit", defaultBranchLocked: true });
    const b = doc({ hubKey, createdAt: "2026-05-02T09:00:00.000Z", defaultBranch: "evil", explicit: true });
    ingestRun(b.id, b.body, mallory, T2);
    expect(hubProjectByKey(hubKey)?.defaultBranch).toBe("main");
    const live = liveDoc({ hubKey, createdAt: "2026-05-02T09:30:00.000Z", defaultBranch: "evil", explicit: true });
    ingestLiveRun(live.id, live.body, mallory, T2);
    expect(hubProjectByKey(hubKey)?.defaultBranch).toBe("main");

    expect(setHubDefaultBranch(hubKey, null)).toMatchObject({ defaultBranch: null, defaultBranchSource: null, defaultBranchLocked: false });
    const c = doc({ hubKey, createdAt: "2026-05-03T09:00:00.000Z", defaultBranch: "trunk" });
    ingestRun(c.id, c.body, alice, T3);
    expect(hubProjectByKey(hubKey)?.defaultBranch).toBe("trunk");

    expectHttp(() => setHubDefaultBranch(`github.com/acme/unknown-${tag}`, "main"), 404);
    expectHttp(() => setHubDefaultBranch(hubKey, "  "), 400);
  });

  test("a project is removed only while it has no stored or live runs", () => {
    const hubKey = `github.com/acme/remove-${tag}`;
    const stored = doc({ hubKey });
    ingestRun(stored.id, stored.body, alice, T1);
    expectHttp(() => removeHubProject(hubKey), 409, "project_not_empty");
    deleteRun(stored.id);
    removeHubProject(hubKey);
    expect(hubProjectByKey(hubKey)).toBeUndefined();
    expectHttp(() => removeHubProject(hubKey), 404);

    const liveKey = `github.com/acme/remove-live-${tag}`;
    const live = liveDoc({ hubKey: liveKey });
    ingestLiveRun(live.id, live.body, alice, T1);
    expectHttp(() => removeHubProject(liveKey), 409, "project_not_empty");
    deleteLiveRun(live.id);
    removeHubProject(liveKey);
    expect(hubProjectByKey(liveKey)).toBeUndefined();
  });

  test("removing a project tells open pages", () => {
    const hubKey = `github.com/acme/remove-event-${tag}`;
    const d = doc({ hubKey });
    ingestRun(d.id, d.body, alice, T1);
    deleteRun(d.id);
    let heard = 0;
    const onChange = (): void => void heard++;
    projectEvents.on("change", onChange);
    try {
      removeHubProject(hubKey);
    } finally {
      projectEvents.off("change", onChange);
    }
    expect(heard).toBeGreaterThan(0);
  });
});

describe("new hub keys per token", () => {
  test("a token may create 20 new hub keys in 24 hours (uploads and live together); the 21st is 429 too_many_projects", () => {
    const busy = uploaderOf("busy");
    for (let i = 0; i < 20; i++) {
      const hubKey = `github.com/acme/many-${tag}-${i}`;
      if (i % 2 === 0) {
        const d = doc({ hubKey });
        ingestRun(d.id, d.body, busy, T1);
      } else {
        const d = liveDoc({ hubKey });
        ingestLiveRun(d.id, d.body, busy, T1);
      }
    }
    const hubKey = `github.com/acme/many-${tag}-20`;
    const upload = doc({ hubKey });
    expectHttp(() => ingestRun(upload.id, upload.body, busy, T1), 429, "too_many_projects");
    const live = liveDoc({ hubKey });
    expectHttp(() => ingestLiveRun(live.id, live.body, busy, T1), 429, "too_many_projects");
    expect(hubProjectByKey(hubKey)).toBeUndefined();
    expect(getRun(upload.id)).toBeNull();
    expect(getLiveRun(live.id)).toBeUndefined();

    // a key the hub already knows is no new key, even for the token at its limit
    const known = doc({ hubKey: `github.com/acme/many-${tag}-3` });
    ingestRun(known.id, known.body, busy, T1);
    // another token is unaffected
    const other = doc({ hubKey });
    ingestRun(other.id, other.body, uploaderOf("calm"), T1);
    expect(hubProjectByKey(hubKey)).toBeDefined();

    // 24 hours later the first keys no longer count
    const later = doc({ hubKey: `github.com/acme/many-${tag}-21` });
    ingestRun(later.id, later.body, busy, new Date(T1.getTime() + 24 * 3600_000 + 1000));
    expect(hubProjectByKey(`github.com/acme/many-${tag}-21`)).toBeDefined();
  });
});

describe("re-key bound", () => {
  test("repeated keys-moved uploads cause one re-key pass per 5 minutes, then one trailing pass", async () => {
    // A fake clock and timer queue: the pass is "due" when the test fires the timer, not after real waiting.
    let clock = 0;
    const timers: { fn: () => void; ms: number; cancelled: boolean; fired: boolean }[] = [];
    const seam: RekeyTimers = {
      now: () => clock,
      start: (fn, ms) => {
        const timer = { fn, ms, cancelled: false, fired: false };
        timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
    };
    const fire = (): { ms: number } => {
      const live = timers.filter((t) => !t.cancelled && !t.fired);
      expect(live).toHaveLength(1);
      const timer = live[0]!;
      clock += timer.ms;
      timer.fired = true;
      timer.fn();
      return timer;
    };
    setRekeyTimers(seam);
    try {
      const hubKey = `github.com/acme/rekey-${tag}`;
      const first = doc({ hubKey, testKey: "k:0" });
      ingestRun(first.id, first.body, alice, T1);
      const projectId = hubProjectByKey(hubKey)!.id;
      const resend = (n: number): void => {
        const moved = { ...first.body, run: { ...first.body.run, testKey: `k:${n}` } } as RunUploadBodyT;
        expect(ingestRun(first.id, moved, alice, T1).result.status).toBe("updated");
      };
      const start = rekeyPassCount(projectId);

      resend(1);
      expect(fire().ms).toBeLessThan(5 * 60_000);
      expect(rekeyPassCount(projectId)).toBe(start + 1);

      // five more moves within the window: no pass until 5 minutes after the last one started
      const lastPassAt = clock;
      for (let n = 2; n <= 6; n++) {
        clock += 1000;
        resend(n);
        expect(rekeyPassCount(projectId)).toBe(start + 1);
      }
      const trailing = fire();
      expect(clock).toBeGreaterThanOrEqual(lastPassAt + 5 * 60_000);
      expect(trailing.ms).toBeGreaterThan(0);
      expect(rekeyPassCount(projectId)).toBe(start + 2);

      // nothing else is pending
      expect(timers.filter((t) => !t.cancelled && !t.fired)).toHaveLength(0);
      await rekeyProject(projectId);
    } finally {
      setRekeyTimers(null);
    }
  });
});

describe("admin routes of a running hub", () => {
  test("project-remove and project-default-branch need an admin token and act on the registry", async () => {
    const adminName = `${tag}-root`;
    const userName = `${tag}-plain`;
    const { token: adminToken } = createToken(adminName, { admin: true });
    const { token: userToken } = createToken(userName, { admin: false });
    tokens.push(adminName, userName);
    const post = (action: string, token: string, body: unknown): Promise<Response> =>
      fetchHandler(new Request(`${base}/api/hub/v1/admin/${action}`, { method: "POST", headers: { host: HOST, "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) }));

    const hubKey = `github.com/acme/admin-route-${tag}`;
    const d = doc({ hubKey });
    ingestRun(d.id, d.body, alice, T1);

    expect((await post("project-default-branch", userToken, { hubKey, branch: "x" })).status).toBe(403);
    expect((await post("project-default-branch", adminToken, { hubKey, branch: "release" })).status).toBe(200);
    expect(hubProjectByKey(hubKey)).toMatchObject({ defaultBranch: "release", defaultBranchLocked: true });
    expect((await post("project-default-branch", adminToken, { hubKey })).status).toBe(400);

    expect((await post("project-remove", userToken, { hubKey })).status).toBe(403);
    const refused = await post("project-remove", adminToken, { hubKey });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "project_not_empty" });
    deleteRun(d.id);
    expect((await post("project-remove", adminToken, { hubKey })).status).toBe(200);
    expect(hubProjectByKey(hubKey)).toBeUndefined();
  });
});

describe("rate limits on the token's read-ish routes", () => {
  const call = (method: string, p: string, headers: Record<string, string>, body?: string): Promise<Response> =>
    fetchHandler(new Request(`${base}${p}`, { method, headers: { host: HOST, ...headers }, body }));

  test("blobs/check, runs/:id/state and DELETE runs/:id share one 600-a-minute budget per token", async () => {
    const name = `${tag}-meta`;
    const other = `${tag}-meta2`;
    const auth = (n: string): Record<string, string> => {
      const { token } = createToken(n, { admin: false });
      tokens.push(n);
      return { authorization: `Bearer ${token}` };
    };
    const mine = auth(name);
    const calm = auth(other);
    const runPath = `/api/hub/v1/runs/20260101-000000-${tag}-none`;
    const requests: (() => Promise<Response>)[] = [
      () => call("POST", "/api/hub/v1/blobs/check", { ...mine, "content-type": "application/json" }, JSON.stringify({ sha256: [] })),
      () => call("GET", `${runPath}/state`, mine),
      () => call("DELETE", runPath, mine),
    ];
    const statuses: number[] = [];
    for (let i = 0; i < 600; i++) statuses.push((await requests[i % 3]!()).status);
    expect(statuses.filter((s) => s === 429)).toEqual([]);
    for (const request of requests) {
      const res = await request();
      expect(res.status).toBe(429);
      expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    }
    expect((await call("GET", `${runPath}/state`, calm)).status).toBe(404);
  });
});
