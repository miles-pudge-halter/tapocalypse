import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { fetchHandler } from "../src/api";
import { scheduler } from "../src/app";
import { config } from "../src/config";
import { expireLive, hubEvents, ingestLiveRun } from "../src/hub/ingest";
import { deleteLiveRun, getLiveRun, LIVE_MAX_PER_MACHINE, listLiveRuns, liveRoomFor, putLiveRun, sweepLiveRuns } from "../src/hub/live";
import { hubDir, setHubMode } from "../src/hub/mode";
import { hubProjectByKey, installHubProjects } from "../src/hub/projects";
import { HUB_PROTOCOL, LIVE_EXPIRE_MS, LIVE_MAX_BYTES, type LiveRunBodyT, type RunUploadBodyT } from "../src/hub/protocol";
import { createToken, revokeToken } from "../src/hub/tokens";
import { projectEvents, setProjectSource } from "../src/projects/registry";
import { deleteRun, getRun } from "../src/runs/store";
import type { Run } from "../src/runs/types";

const tag = `l${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const HOST = `127.0.0.1:${config.port}`;
const base = `http://${HOST}`;
const created: string[] = [];
const tokens: string[] = [];
const hubKey = `github.com/acme/live-${tag}`;

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

function machine(name: string): { name: string; auth: Record<string, string> } {
  const full = `${tag}-${name}`;
  const { token } = createToken(full, { admin: false });
  tokens.push(full);
  return { name: full, auth: { authorization: `Bearer ${token}` } };
}

const get = (p: string): Promise<Response> => fetchHandler(new Request(`${base}${p}`, { headers: { host: HOST } }));
const call = (method: string, p: string, init: { headers?: Record<string, string>; body?: BodyInit } = {}): Promise<Response> =>
  fetchHandler(new Request(`${base}${p}`, { method, headers: { host: HOST, ...init.headers }, body: init.body }));

const runId = (n: number): string => `20260301-0000${String(n).padStart(2, "0")}-${tag}-l${n}`;

const project = (over: Record<string, unknown> = {}) => ({
  hubKey,
  name: "Acme Shop",
  remoteUrl: null,
  subpath: null,
  defaultBranch: "main",
  defaultPlatform: "android" as const,
  localId: "shop",
  ...over,
});

function liveDoc(id: string, run: Record<string, unknown> = {}, over: Record<string, unknown> = {}): LiveRunBodyT {
  created.push(id);
  return {
    protocol: HUB_PROTOCOL,
    clientVersion: "0.1.0",
    sentAt: new Date().toISOString(),
    project: project(),
    run: {
      id,
      projectId: "shop",
      title: "Checkout flow",
      status: "running",
      createdAt: "2026-03-01T00:00:00.000Z",
      checks: [
        { id: "C1", title: "Checkout total updates", status: "pass", note: "total = 42", updatedAt: "2026-03-01T00:01:00.000Z", screenshot: "screenshots/c1.webp" },
        { id: "C2", title: "Coupon applies", status: "running", updatedAt: "2026-03-01T00:02:00.000Z" },
      ],
      testKey: null,
      brief: "Walk through checkout",
      deviceRequest: { platform: "android" },
      ...run,
    },
    redaction: { replaced: {} },
    ...over,
  } as unknown as LiveRunBodyT;
}

function finalDoc(id: string, run: Record<string, unknown> = {}): RunUploadBodyT {
  created.push(id);
  return {
    protocol: HUB_PROTOCOL,
    clientVersion: "0.1.0",
    sentAt: new Date().toISOString(),
    project: project(),
    run: {
      id,
      projectId: "shop",
      title: "Checkout flow",
      status: "done",
      createdAt: "2026-03-01T00:00:00.000Z",
      checks: [{ id: "C1", title: "Checkout total updates", status: "pass", updatedAt: "2026-03-01T00:01:00.000Z" }],
      testKey: null,
      brief: "Walk through checkout",
      verdict: "PASS",
      deviceRequest: { platform: "android" },
      ...run,
    },
    batch: null,
    report: null,
    activity: null,
    screenshots: [],
    transcript: null,
    redaction: { replaced: {} },
  } as unknown as RunUploadBodyT;
}

const putLive = (id: string, body: unknown, headers: Record<string, string>, gz = false): Promise<Response> =>
  call("PUT", `/api/hub/v1/runs/${id}/live`, {
    headers: { "content-type": "application/json", ...(gz ? { "content-encoding": "gzip" } : {}), ...headers },
    body: gz ? gzipSync(JSON.stringify(body)) : JSON.stringify(body),
  });

const putFinal = (id: string, body: unknown, headers: Record<string, string>): Promise<Response> =>
  call("PUT", `/api/hub/v1/runs/${id}`, { headers: { "content-type": "application/json", "content-encoding": "gzip", ...headers }, body: gzipSync(JSON.stringify(body)) });

interface ListedRun {
  id: string;
  status: string;
  projectId: string;
  hub: { machine: string; live?: { lastSeenAt: string } } | null;
}
/** `GET /api/runs`, narrowed to this file's hub project once it exists: other files' runs share the data dir and would page ours out. */
const listed = async (query = ""): Promise<ListedRun[]> => {
  const own = hubProjectByKey(hubKey);
  const scoped = own && !query.includes("project=") ? `project=${own.id}${query ? `&${query}` : ""}` : query;
  // The hub's own list route answers this shape; the assertions check the fields they use.
  const page = (await (await get(`/api/runs?${scoped}`)).json()) as { runs: ListedRun[] };
  return page.runs;
};

describe("live run map", () => {
  const sample = (id: string, lastSeenAt: string): Run => ({ id, hub: { machine: "ann-mbp", live: { lastSeenAt } } }) as unknown as Run;

  test("stores, replaces, lists and deletes entries", () => {
    const a = runId(90);
    expect(getLiveRun(a)).toBeUndefined();
    putLiveRun(sample(a, "2026-03-01T00:00:00.000Z"));
    putLiveRun(sample(a, "2026-03-01T00:01:00.000Z"));
    expect(getLiveRun(a)?.hub?.live?.lastSeenAt).toBe("2026-03-01T00:01:00.000Z");
    expect(listLiveRuns().filter((r) => r.id === a)).toHaveLength(1);
    expect(deleteLiveRun(a)).toBe(true);
    expect(deleteLiveRun(a)).toBe(false);
    expect(getLiveRun(a)).toBeUndefined();
  });

  test("the sweep drops entries not seen for LIVE_EXPIRE_MS and keeps the rest", () => {
    const seen = Date.parse("2026-03-01T00:00:00.000Z");
    const old = runId(91);
    const fresh = runId(92);
    putLiveRun(sample(old, new Date(seen).toISOString()));
    putLiveRun(sample(fresh, new Date(seen + 10 * 60_000).toISOString()));
    expect(sweepLiveRuns(seen + LIVE_EXPIRE_MS).map((r) => r.id)).not.toContain(old);
    expect(getLiveRun(old)).toBeDefined();
    expect(sweepLiveRuns(seen + LIVE_EXPIRE_MS + 1).map((r) => r.id)).toContain(old);
    expect(getLiveRun(old)).toBeUndefined();
    expect(getLiveRun(fresh)).toBeDefined();
    deleteLiveRun(fresh);
  });

  test("a new id is refused once its machine holds the maximum; known ids still refresh and other machines are unaffected", () => {
    const of = (machineName: string, id: string): Run => ({ id, hub: { machine: machineName, live: { lastSeenAt: "2026-03-01T00:00:00.000Z" } } }) as unknown as Run;
    const busy = `cap-${tag}`;
    const ids = Array.from({ length: LIVE_MAX_PER_MACHINE }, (_, i) => `${runId(200 + i)}-cap`);
    try {
      for (const id of ids) {
        expect(liveRoomFor(busy, id)).toBe(true);
        putLiveRun(of(busy, id));
      }
      expect(liveRoomFor(busy, `${runId(299)}-cap`)).toBe(false);
      expect(liveRoomFor(busy, ids[0]!)).toBe(true);
      expect(liveRoomFor(`other-${tag}`, `${runId(298)}-cap`)).toBe(true);
    } finally {
      for (const id of ids) deleteLiveRun(id);
    }
  });
});

describe("live run limits on the route", () => {
  test("a machine past its maximum of live runs gets 429 for a new id, while its existing live runs keep updating", async () => {
    const m = machine("cap");
    const ids = Array.from({ length: LIVE_MAX_PER_MACHINE }, (_, i) => `${runId(400 + i)}-lim`);
    try {
      for (const id of ids) expect((await putLive(id, liveDoc(id), m.auth, true)).status).toBe(200);
      const over = `${runId(499)}-lim`;
      const refused = await putLive(over, liveDoc(over), m.auth, true);
      expect(refused.status).toBe(429);
      expect(await refused.json()).toMatchObject({ code: "too_many_live_runs" });
      expect(getLiveRun(over)).toBeUndefined();
      expect((await putLive(ids[0]!, liveDoc(ids[0]!), m.auth, true)).status).toBe(200);
    } finally {
      for (const id of ids) deleteLiveRun(id);
    }
  });
});

describe("PUT /api/hub/v1/runs/:id/live", () => {
  test("a live update shows the run in the list, its status filter and its page, with hub.live, and never in the store", async () => {
    const m = machine("a");
    const id = runId(1);
    const res = await putLive(id, liveDoc(id), m.auth, true);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ runId: id, status: "live", url: `/#/runs/${id}` });
    expect(getRun(id)).toBeNull();

    const hubProject = hubProjectByKey(hubKey)!;
    const ids = (runs: ListedRun[]) => runs.map((r) => r.id);
    expect(ids(await listed(`project=${hubProject.id}`))).toContain(id);
    expect(ids(await listed("status=running"))).toContain(id);
    expect(ids(await listed("status=done"))).not.toContain(id);
    expect(ids(await listed(`machine=${m.name}`))).toContain(id);

    const view = (await (await get(`/api/runs/${id}`)).json()) as { status: string; projectId: string; checks: { id: string; screenshot?: string }[]; hub: { machine: string; live: { lastSeenAt: string } } };
    expect(view).toMatchObject({ status: "running", projectId: hubProject.id, hub: { machine: m.name } });
    expect(Date.now() - Date.parse(view.hub.live.lastSeenAt)).toBeLessThan(10_000);
    // the document ships no blobs, so a check's screenshot reference would dangle
    expect(view.checks.map((c) => c.screenshot)).toEqual([undefined, undefined]);
  });

  test("a refresh replaces the entry, announces the run and keeps one row", async () => {
    const m = machine("refresh");
    const id = runId(2);
    expect((await putLive(id, liveDoc(id), m.auth)).status).toBe(200);
    const seen: Run[] = [];
    const onRun = (r: Run) => void (r.id === id && seen.push(r));
    hubEvents.on("run", onRun);
    try {
      const next = liveDoc(id, { checks: [{ id: "C1", title: "Checkout total updates", status: "fail", note: "total = 0", updatedAt: "2026-03-01T00:05:00.000Z" }] });
      expect((await putLive(id, next, m.auth)).status).toBe(200);
    } finally {
      hubEvents.off("run", onRun);
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]?.hub?.live?.lastSeenAt).toBeDefined();
    expect((await listed()).filter((r) => r.id === id)).toHaveLength(1);
    expect(((await (await get(`/api/runs/${id}`)).json()) as { checks: { status: string }[] }).checks.map((c) => c.status)).toEqual(["fail"]);
  });

  test("it changes neither stats, nor project counts, machines, overview or releases", async () => {
    const m = machine("quiet");
    const done = runId(3);
    expect((await putFinal(done, finalDoc(done), m.auth)).status).toBe(201);
    const hubProject = hubProjectByKey(hubKey)!;
    const paths = ["/api/stats", `/api/stats?project=${hubProject.id}`, "/api/hub/v1/machines", "/api/hub/v1/info", `/api/projects/${hubProject.id}/overview`, `/api/projects/${hubProject.id}/releases`, "/api/projects"];
    const snapshot = async () => Promise.all(paths.map(async (p) => (await (await get(p)).text()).replace(/"serverTime":"[^"]*"/, "")));
    const before = await snapshot();

    const id = runId(4);
    expect((await putLive(id, liveDoc(id, { createdAt: "2026-03-02T00:00:00.000Z" }, { project: project({ defaultBranch: "develop" }) }), m.auth)).status).toBe(200);
    expect(await snapshot()).toEqual(before);
    expect(hubProjectByKey(hubKey)?.defaultBranch).toBe("main");
  });

  test("a live update does not bump the project's last upload, a finished one does", async () => {
    const m = machine("bump");
    const first = runId(5);
    expect((await putFinal(first, finalDoc(first), m.auth)).status).toBe(201);
    const stamp = hubProjectByKey(hubKey)!.lastUploadAt;
    const id = runId(6);
    const { result } = ingestLiveRun(id, liveDoc(id), { machine: m.name, admin: false, identity: null }, new Date("2030-01-01T00:00:00.000Z"));
    expect(result.status).toBe("live");
    expect(getLiveRun(id)?.hub?.live?.lastSeenAt).toBe("2030-01-01T00:00:00.000Z");
    expect(hubProjectByKey(hubKey)!.lastUploadAt).toBe(stamp);
  });

  test("another machine's finished upload cannot take over an id that is being sent live; the owner's own finished upload then lands", async () => {
    const a = machine("fa");
    const b = machine("fb");
    const id = runId(26);
    expect((await putLive(id, liveDoc(id), a.auth)).status).toBe(200);
    const clash = await putFinal(id, finalDoc(id), b.auth);
    expect(clash.status).toBe(409);
    expect(await clash.json()).toMatchObject({ code: "id_conflict" });
    expect(getRun(id)).toBeNull();
    expect(getLiveRun(id)?.hub?.machine).toBe(a.name);
    expect((await putFinal(id, finalDoc(id), a.auth)).status).toBe(201);
    expect(getLiveRun(id)).toBeUndefined();
    expect(getRun(id)?.hub?.machine).toBe(a.name);
  });

  test("the finished upload replaces the live entry, which then is gone", async () => {
    const m = machine("final");
    const id = runId(7);
    expect((await putLive(id, liveDoc(id), m.auth)).status).toBe(200);
    expect(getLiveRun(id)).toBeDefined();
    expect((await putFinal(id, finalDoc(id), m.auth)).status).toBe(201);
    expect(getLiveRun(id)).toBeUndefined();
    const view = (await (await get(`/api/runs/${id}`)).json()) as { status: string; hub: { live?: unknown } };
    expect(view.status).toBe("done");
    expect(view.hub.live).toBeUndefined();
    expect((await listed()).filter((r) => r.id === id)).toHaveLength(1);
    expect((await listed("status=running")).map((r) => r.id)).not.toContain(id);
  });

  test("a repeated finished upload (unchanged) also clears a live entry that slipped in", async () => {
    const m = machine("unchanged");
    const id = runId(8);
    expect((await putFinal(id, finalDoc(id), m.auth)).status).toBe(201);
    const stored = getRun(id)!;
    putLiveRun({ ...structuredClone(stored), status: "running", hub: { ...stored.hub!, live: { lastSeenAt: new Date().toISOString() } } });
    expect(((await (await get(`/api/runs/${id}`)).json()) as { status: string }).status).toBe("done");
    expect((await listed()).filter((r) => r.id === id)).toHaveLength(1);
    expect((await putFinal(id, finalDoc(id), m.auth)).status).toBe(200);
    expect(getLiveRun(id)).toBeUndefined();
  });

  test("after the finished run, the same machine's late live update answers final and changes nothing; another machine gets 409", async () => {
    const owner = machine("owner");
    const other = machine("intruder");
    const id = runId(9);
    expect((await putFinal(id, finalDoc(id), owner.auth)).status).toBe(201);
    const hash = getRun(id)!.hub!.contentHash;

    const late = await putLive(id, liveDoc(id), owner.auth);
    expect(late.status).toBe(200);
    expect(await late.json()).toEqual({ runId: id, status: "final", url: `/#/runs/${id}` });
    expect(getLiveRun(id)).toBeUndefined();
    expect(getRun(id)?.hub?.contentHash).toBe(hash);
    expect(getRun(id)?.status).toBe("done");

    const clash = await putLive(id, liveDoc(id), other.auth);
    expect(clash.status).toBe(409);
    expect(await clash.json()).toMatchObject({ code: "id_conflict" });
  });

  test("a live entry of another machine is not taken over", async () => {
    const owner = machine("liveowner");
    const other = machine("liveother");
    const id = runId(10);
    expect((await putLive(id, liveDoc(id), owner.auth)).status).toBe(200);
    const clash = await putLive(id, liveDoc(id, { title: "Hijacked" }), other.auth);
    expect(clash.status).toBe(409);
    expect(await clash.json()).toMatchObject({ code: "id_conflict" });
    expect(getLiveRun(id)?.title).toBe("Checkout flow");
    expect(getLiveRun(id)?.hub?.machine).toBe(owner.name);
  });

  test("a finished status, a wrong id and a malformed document are 422 invalid_run; protocol, content type, size and token are checked first", async () => {
    const m = machine("bad");
    const id = runId(11);
    for (const status of ["done", "error", "cancelled", "interrupted", "bogus"]) {
      const res = await putLive(id, liveDoc(id, { status }), m.auth);
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({ code: "invalid_run" });
    }
    const mismatch = await putLive(id, liveDoc(runId(12)), m.auth);
    expect(mismatch.status).toBe(422);
    expect(await mismatch.json()).toMatchObject({ code: "invalid_run" });
    expect((await putLive(id, liveDoc(id, { checks: [{ id: "C1", title: 7, status: "pass" }] }), m.auth)).status).toBe(422);
    expect((await putLive(id, { ...liveDoc(id), run: "nope" }, m.auth)).status).toBe(422);
    expect(getLiveRun(id)).toBeUndefined();

    const old = await putLive(id, liveDoc(id, {}, { protocol: HUB_PROTOCOL + 1 }), m.auth);
    expect(old.status).toBe(426);
    expect(await old.json()).toMatchObject({ code: "protocol_unsupported" });
    expect((await putLive(id, liveDoc(id), { ...m.auth, "content-type": "text/plain" })).status).toBe(415);
    expect((await putLive(id, liveDoc(id), {})).status).toBe(401);
    expect((await call("PUT", `/api/hub/v1/runs/${id}/live`, { headers: { "content-type": "application/json", ...m.auth }, body: "{nope" })).status).toBe(400);
    const huge = liveDoc(id, { brief: "x".repeat(LIVE_MAX_BYTES + 1) });
    expect((await putLive(id, huge, m.auth)).status).toBe(413);
    const bomb = await call("PUT", `/api/hub/v1/runs/${id}/live`, { headers: { "content-type": "application/json", "content-encoding": "gzip", ...m.auth }, body: gzipSync(Buffer.alloc(LIVE_MAX_BYTES * 2, "a")) });
    expect(bomb.status).toBe(413);
    expect((await call("GET", `/api/hub/v1/runs/${id}/live`, { headers: m.auth })).status).toBe(405);
  });

  test("an expired entry is dropped, announced like a removal, and the run is gone from the list", async () => {
    const m = machine("expire");
    const id = runId(13);
    expect((await putLive(id, liveDoc(id), m.auth)).status).toBe(200);
    let changes = 0;
    const onChange = () => void changes++;
    projectEvents.on("change", onChange);
    try {
      expect(expireLive(Date.now() + LIVE_EXPIRE_MS - 5_000)).toEqual([]);
      expect(await listed("status=running").then((r) => r.map((x) => x.id))).toContain(id);
      expect(expireLive(Date.now() + LIVE_EXPIRE_MS + 5_000)).toContain(id);
    } finally {
      projectEvents.off("change", onChange);
    }
    expect(changes).toBeGreaterThan(0);
    expect((await listed()).map((r) => r.id)).not.toContain(id);
    expect((await get(`/api/runs/${id}`)).status).toBe(404);
  });

  test("the owner (and nobody else) can delete a live run", async () => {
    const owner = machine("delown");
    const other = machine("delother");
    const id = runId(14);
    expect((await putLive(id, liveDoc(id), owner.auth)).status).toBe(200);
    expect((await call("DELETE", `/api/hub/v1/runs/${id}`, { headers: other.auth })).status).toBe(403);
    expect(getLiveRun(id)).toBeDefined();
    expect((await call("DELETE", `/api/hub/v1/runs/${id}`, { headers: owner.auth })).status).toBe(204);
    expect(getLiveRun(id)).toBeUndefined();
    expect((await get(`/api/runs/${id}`)).status).toBe(404);
  });

  test("live updates have their own rate limit: it neither eats the run-upload budget nor is eaten by it", async () => {
    const busy = machine("ratelive");
    const id = runId(15);
    const put = (kind: "live" | "run") =>
      call("PUT", `/api/hub/v1/runs/${id}${kind === "live" ? "/live" : ""}`, { headers: { "content-type": "application/json", ...busy.auth }, body: "{}" });
    const statuses: number[] = [];
    for (let i = 0; i < 245; i++) statuses.push((await put("live")).status);
    expect(statuses.slice(0, 240).every((s) => s === 426)).toBe(true);
    expect(statuses.slice(240)).toEqual([429, 429, 429, 429, 429]);
    expect(Number((await put("live")).headers.get("retry-after"))).toBeGreaterThan(0);
    // run uploads of the same token are untouched
    expect((await put("run")).status).toBe(426);

    const other = machine("raterun");
    for (let i = 0; i < 121; i++) await call("PUT", `/api/hub/v1/runs/${id}`, { headers: { "content-type": "application/json", ...other.auth }, body: "{}" });
    expect((await call("PUT", `/api/hub/v1/runs/${id}/live`, { headers: { "content-type": "application/json", ...other.auth }, body: "{}" })).status).toBe(426);
  });
});

describe("what viewers read of a live run", () => {
  test("sub-routes that read files answer empty or 404, never 500", async () => {
    const m = machine("subs");
    const id = runId(20);
    expect((await putLive(id, liveDoc(id), m.auth)).status).toBe(200);

    const shots = await get(`/api/runs/${id}/screenshots`);
    expect(shots.status).toBe(200);
    expect(await shots.json()).toEqual([]);
    const report = await get(`/api/runs/${id}/report`);
    expect(report.status).toBe(404);
    const activity = await get(`/api/runs/${id}/activity`);
    expect(activity.status).toBe(200);
    expect(await activity.json()).toEqual({ items: [], hasMore: false });
    expect((await get(`/api/runs/${id}/transcript`)).status).toBe(404);
    expect((await get(`/api/runs/${id}/files/screenshots/c1.webp`)).status).toBe(404);
    expect((await get(`/api/runs/${id}/report.html`)).status).toBe(200);
    for (const p of ["compare", "baseline-candidates", "checks/C1/history"]) {
      const res = await get(`/api/runs/${id}/${p}`);
      expect(res.status, p).toBeLessThan(500);
    }
    const compare = await get(`/api/runs/${id}/compare`);
    expect(compare.status).toBe(200);
    expect(await compare.json()).toMatchObject({ comparison: null });
  });

  test("the page stream opens with a snapshot that has no activity, and a later live update arrives as a run frame", async () => {
    const m = machine("sse");
    const id = runId(21);
    expect((await putLive(id, liveDoc(id), m.auth)).status).toBe(200);
    const res = await get(`/api/runs/${id}/events`);
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = decoder.decode((await reader.read()).value);
    expect(text).toContain("event: snapshot");
    const snapshot = JSON.parse(/event: snapshot\ndata: (.*)\n/.exec(text)![1]!) as { run: { status: string; hub: { live: unknown } }; activity: unknown[]; hasMoreActivity: boolean };
    expect(snapshot).toMatchObject({ run: { status: "running" }, activity: [], hasMoreActivity: false });
    expect(snapshot.run.hub.live).toBeDefined();

    // `initHub` forwards hub events to the bus the streams listen on; this test does not boot the hub.
    const forward = (run: Run) => scheduler.bus.emit("run", run);
    hubEvents.on("run", forward);
    try {
      expect((await putLive(id, liveDoc(id, { status: "finishing" }), m.auth)).status).toBe(200);
      text = decoder.decode((await reader.read()).value);
    } finally {
      hubEvents.off("run", forward);
      await reader.cancel();
    }
    expect(text).toContain("event: run");
    expect(text).toContain('"finishing"');
    expect(text).toContain('"live"');
  });

  test("a stored run wins over a live entry with the same id, in the list and on its page", async () => {
    const m = machine("wins");
    const id = runId(22);
    expect((await putFinal(id, finalDoc(id), m.auth)).status).toBe(201);
    const stored = getRun(id)!;
    putLiveRun({ ...structuredClone(stored), status: "running", hub: { ...stored.hub!, live: { lastSeenAt: new Date().toISOString() } } });
    const rows = (await listed()).filter((r) => r.id === id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("done");
    expect(((await (await get(`/api/runs/${id}`)).json()) as { status: string }).status).toBe("done");
    deleteLiveRun(id);
  });

  test("live and stored runs merge newest first across pages", async () => {
    const m = machine("page");
    const older = runId(23);
    const newer = runId(24);
    const newest = runId(25);
    expect((await putFinal(older, finalDoc(older, { createdAt: "2026-03-03T00:00:00.000Z" }), m.auth)).status).toBe(201);
    expect((await putFinal(newest, finalDoc(newest, { createdAt: "2026-03-05T00:00:00.000Z" }), m.auth)).status).toBe(201);
    expect((await putLive(newer, liveDoc(newer, { createdAt: "2026-03-04T00:00:00.000Z" }), m.auth)).status).toBe(200);
    const hubProject = hubProjectByKey(hubKey)!;
    const page = (await (await get(`/api/runs?project=${hubProject.id}&limit=2`)).json()) as { runs: ListedRun[]; hasMore: boolean };
    expect(page.runs.map((r) => r.id)).toEqual([newest, newer]);
    expect(page.hasMore).toBe(true);
    const rest = (await (await get(`/api/runs?project=${hubProject.id}&limit=2&before=${encodeURIComponent("2026-03-04T00:00:00.000Z")}`)).json()) as { runs: ListedRun[] };
    expect(rest.runs[0]?.id).toBe(older);
  });
});
