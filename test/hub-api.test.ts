import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { fetchHandler } from "../src/api";
import { config } from "../src/config";
import { hubDir, setHubMode } from "../src/hub/mode";
import { installHubProjects, hubProjectByKey } from "../src/hub/projects";
import { contentHashOf, HUB_PROTOCOL, type RunUploadBodyT } from "../src/hub/protocol";
import { createToken, revokeToken } from "../src/hub/tokens";
import { setProjectSource } from "../src/projects/registry";
import { deleteRun, getRun } from "../src/runs/store";

const tag = `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const HOST = `127.0.0.1:${config.port}`;
const base = `http://${HOST}`;
const created: string[] = [];
const tokens: string[] = [];
const hubKey = `github.com/acme/api-${tag}`;

const envKeys = ["TAPOCALYPSE_HUB_HOSTS", "TAPOCALYPSE_HUB_IDENTITY_HEADER", "TAPOCALYPSE_HUB_MAX_BLOB_MB"] as const;
const savedEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));

beforeAll(() => {
  setHubMode(true);
  installHubProjects();
});

afterEach(() => {
  for (const k of envKeys) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  setHubMode(true);
});

afterAll(() => {
  setHubMode(null);
  setProjectSource(null);
  for (const id of created) deleteRun(id);
  for (const name of tokens) revokeToken(name);
  const registry = path.join(hubDir(), "projects.json");
  if (fs.existsSync(registry)) {
    const entries = JSON.parse(fs.readFileSync(registry, "utf8")) as { hubKey: string }[];
    fs.writeFileSync(registry, JSON.stringify(entries.filter((e) => !e.hubKey.includes(tag))));
  }
});

function machine(name: string, admin = false): { name: string; auth: Record<string, string> } {
  const full = `${tag}-${name}`;
  const { token } = createToken(full, { admin });
  tokens.push(full);
  return { name: full, auth: { authorization: `Bearer ${token}` } };
}

const get = (p: string, headers: Record<string, string> = {}): Promise<Response> => fetchHandler(new Request(`${base}${p}`, { headers: { host: HOST, ...headers } }));
const call = (method: string, p: string, init: { headers?: Record<string, string>; body?: BodyInit } = {}): Promise<Response> =>
  fetchHandler(new Request(`${base}${p}`, { method, headers: { host: HOST, ...init.headers }, body: init.body }));

const sha = (bytes: Uint8Array): string => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

function docFor(id: string, over: Record<string, unknown> = {}, extra: Partial<RunUploadBodyT> = {}): RunUploadBodyT {
  created.push(id);
  return {
    protocol: HUB_PROTOCOL,
    clientVersion: "0.1.0",
    sentAt: new Date().toISOString(),
    project: { hubKey, name: "Acme Shop", remoteUrl: null, subpath: null, defaultBranch: "main", defaultPlatform: "android", localId: "shop" },
    run: {
      id,
      projectId: "shop",
      title: "Checkout flow",
      status: "done",
      createdAt: "2026-02-01T00:00:00.000Z",
      checks: [{ id: "C1", title: "Checkout total updates", status: "pass", updatedAt: "2026-02-01T00:00:00.000Z" }],
      testKey: null,
      brief: "Walk through checkout",
      verdict: "PASS",
      deviceRequest: { platform: "android" },
      build: { packageId: "com.acme.shop", versionName: `9.${tag.length}.0`, versionCode: "1", capturedAt: "2026-02-01T00:00:00.000Z" },
      ...over,
    },
    batch: null,
    report: null,
    activity: null,
    screenshots: [],
    transcript: null,
    redaction: { replaced: {} },
    ...extra,
  } as unknown as RunUploadBodyT;
}

const putRun = (id: string, body: unknown, headers: Record<string, string>, gz = true): Promise<Response> =>
  call("PUT", `/api/hub/v1/runs/${id}`, {
    headers: { "content-type": "application/json", ...(gz ? { "content-encoding": "gzip" } : {}), ...headers },
    body: gz ? gzipSync(JSON.stringify(body)) : JSON.stringify(body),
  });

const putBlob = (bytes: Uint8Array, type: string, headers: Record<string, string>): Promise<Response> =>
  call("PUT", `/api/hub/v1/blobs/${sha(bytes)}`, { headers: { "content-type": type, ...headers }, body: Buffer.from(bytes) });

const runId = (n: number): string => `20260201-0000${String(n).padStart(2, "0")}-${tag}-r${n}`;

describe("route allowlist on the hub", () => {
  const blocked: [string, string][] = [
    ["POST", "/api/runs"],
    ["POST", "/api/batches"],
    ["DELETE", "/api/runs/x"],
    ["POST", "/api/runs/x/cancel"],
    ["POST", "/api/runs/x/steer"],
    ["POST", "/api/runs/x/rerun"],
    ["POST", "/api/runs/x/export"],
    ["POST", "/api/runs/x/share"],
    ["GET", "/api/runs/x/stderr"],
    ["GET", "/api/devices"],
    ["GET", "/api/devices/pool"],
    ["POST", "/api/devices/boot"],
    ["GET", "/api/devices/emulator-5554/screen.png"],
    ["GET", "/api/leases"],
    ["POST", "/api/leases"],
    ["POST", "/api/projects"],
    ["PUT", "/api/projects/x"],
    ["DELETE", "/api/projects/x"],
    ["POST", "/api/projects/validate"],
    ["POST", "/api/projects/detect"],
    ["GET", "/api/projects/suggestions"],
    ["GET", "/api/projects/x/suites"],
    ["POST", "/api/projects/x/suites"],
    ["GET", "/files/x/y.png"],
    ["GET", "/api/doctor"],
    ["GET", "/api/harnesses"],
    ["GET", "/api/models"],
    ["GET", "/api/templates"],
    ["GET", "/api/mcp/status"],
    ["GET", "/api/share/status"],
    ["POST", "/api/check-links"],
    ["DELETE", "/api/check-links"],
    ["POST", "/mcp"],
    ["POST", "/mcp/runs/x"],
    ["GET", "/api/hub/status"],
    ["PUT", "/api/hub/connection"],
    ["POST", "/api/hub/push"],
    ["POST", "/api/runs/x/unpublish"],
  ];

  test.each(blocked)("%s %s is not available", async (method, p) => {
    const res = await call(method, p, { headers: method === "GET" ? {} : { "content-type": "application/json" }, body: method === "GET" ? undefined : "{}" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not available on the team hub" });
  });

  const allowed = [
    "/api/runs",
    "/api/runs/x",
    "/api/runs/x/activity",
    "/api/runs/x/screenshots",
    "/api/runs/x/files/screenshots/a.webp",
    "/api/runs/x/report",
    "/api/runs/x/report.html",
    "/api/runs/x/transcript",
    "/api/runs/x/compare",
    "/api/runs/x/baseline-candidates",
    "/api/runs/x/checks/C1/history",
    "/api/batches/b-20260101-000000-abcd",
    "/api/projects",
    "/api/projects/x/flaky",
    "/api/projects/x/reports",
    "/api/projects/x/reports/some-run",
    "/api/projects/x/refs",
    "/api/projects/x/overview",
    "/api/projects/x/releases/version/1.0.0",
    "/api/projects/x/releases/branch/release/2.4",
    "/api/projects/x/checks/t:abc/history",
    "/api/stats",
    "/api/health",
    "/api/hub/v1/info",
    "/api/hub/v1/machines",
  ];

  test.each(allowed)("GET %s is served", async (p) => {
    const res = await get(p);
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    expect(body?.error).not.toBe("not available on the team hub");
  });

  test("the live event stream is served", async () => {
    const res = await get("/api/events");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    await res.body?.cancel();
  });

  test("outside the hub the same ingest routes do not exist, and laptops keep their routes", async () => {
    setHubMode(false);
    expect((await get("/api/hub/v1/info")).status).toBe(404);
    expect((await get("/api/devices")).status).toBe(200);
  });
});

describe("health", () => {
  test("reports the mode", async () => {
    expect(await (await get("/api/health")).json()).toMatchObject({ ok: true, mode: "hub", runs: expect.any(Number), version: expect.any(String) });
    setHubMode(false);
    expect(await (await get("/api/health")).json()).toMatchObject({ ok: true, mode: "local" });
  });
});

describe("host guard", () => {
  test("a configured public host is accepted, anything else is not, loopback stays for the healthcheck", async () => {
    process.env.TAPOCALYPSE_HUB_HOSTS = "qa.example.com, Qa2.Example.com";
    expect((await get("/api/health", { host: "qa.example.com" })).status).toBe(200);
    expect((await get("/api/health", { host: "QA2.example.com" })).status).toBe(200);
    expect((await get("/api/health", { host: "evil.example.net" })).status).toBe(403);
    expect((await get("/api/health", { host: `localhost:${config.port}` })).status).toBe(200);
    expect((await get("/api/health", { host: HOST })).status).toBe(200);
  });

  test("with no hosts configured only loopback is accepted", async () => {
    delete process.env.TAPOCALYPSE_HUB_HOSTS;
    expect((await get("/api/health", { host: "qa.example.com" })).status).toBe(403);
  });

  test("a write from a page on another origin is refused; one from a configured host is not", async () => {
    process.env.TAPOCALYPSE_HUB_HOSTS = "qa.example.com";
    const m = machine("origin");
    const refused = await call("DELETE", `/api/hub/v1/runs/${runId(90)}`, { headers: { host: "qa.example.com", origin: "https://evil.example.net", ...m.auth } });
    expect(refused.status).toBe(403);
    const ok = await call("DELETE", `/api/hub/v1/runs/${runId(90)}`, { headers: { host: "qa.example.com", origin: "https://qa.example.com", ...m.auth } });
    expect(ok.status).toBe(404);
  });
});

describe("upload API", () => {
  test("every write needs an active token; info and machines are readable by viewers", async () => {
    const m = machine("auth");
    expect((await putRun(runId(1), docFor(runId(1)), {})).status).toBe(401);
    expect((await call("POST", "/api/hub/v1/blobs/check", { headers: { "content-type": "application/json" }, body: JSON.stringify({ sha256: [] }) })).status).toBe(401);
    expect((await putRun(runId(1), docFor(runId(1)), { authorization: "Bearer tpu_nope" })).status).toBe(401);
    expect((await get("/api/hub/v1/info")).status).toBe(200);
    expect(await (await get("/api/hub/v1/info")).json()).toMatchObject({ machine: null, protocol: HUB_PROTOCOL, minProtocol: 1, runs: expect.any(Number), storeWarning: false });
    expect(await (await get("/api/hub/v1/info", m.auth)).json()).toMatchObject({ machine: m.name });
    revokeToken(m.name);
    expect(await (await get("/api/hub/v1/info", m.auth)).json()).toMatchObject({ machine: null });
  });

  test("blobs are checked, uploaded (text gzipped) and a run referencing them is stored once", async () => {
    const m = machine("flow");
    const report = new TextEncoder().encode(`# Checkout report ${tag}`);
    const shot = Buffer.concat([Buffer.from("RIFF"), Buffer.from([1, 0, 0, 0]), Buffer.from("WEBP"), Buffer.from(`shot ${tag}`)]);
    const check = await call("POST", "/api/hub/v1/blobs/check", { headers: { "content-type": "application/json", ...m.auth }, body: JSON.stringify({ sha256: [sha(report), sha(shot)] }) });
    expect(await check.json()).toEqual({ missing: [sha(report), sha(shot)] });

    const gzReport = await call("PUT", `/api/hub/v1/blobs/${sha(report)}`, { headers: { "content-type": "text/markdown", "content-encoding": "gzip", ...m.auth }, body: gzipSync(report) });
    expect(gzReport.status).toBe(201);
    expect((await putBlob(shot, "image/webp", m.auth)).status).toBe(201);
    expect((await putBlob(shot, "image/webp", m.auth)).status).toBe(200);

    const id = runId(2);
    const body = docFor(id, { checks: [{ id: "C1", title: "Checkout total updates", status: "pass", updatedAt: "x", screenshot: "screenshots/s.webp" }] }, {
      report: { sha256: sha(report), bytes: report.byteLength, type: "text/markdown" },
      screenshots: [{ sha256: sha(shot), bytes: shot.byteLength, type: "image/webp", path: "screenshots/s.webp" }],
    });
    const first = await putRun(id, body, m.auth);
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ runId: id, status: "created", contentHash: contentHashOf(body) });
    const again = await putRun(id, { ...body, sentAt: new Date(Date.now() + 5000).toISOString() }, m.auth);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ status: "unchanged" });

    expect(await (await get(`/api/hub/v1/runs/${id}/state`, m.auth)).json()).toEqual({ contentHash: contentHashOf(body), machine: m.name });
    expect((await get(`/api/hub/v1/runs/${id}/state`)).status).toBe(401);

    const view = (await (await get(`/api/runs/${id}`)).json()) as Record<string, unknown>;
    expect(view).toMatchObject({ id, hub: { machine: m.name, localProjectId: "shop" }, storage: "data", reportPath: "report.md" });
    expect(JSON.stringify(view.hub)).not.toContain("keys");
    expect(await (await get(`/api/runs/${id}/report`)).json()).toEqual({ markdown: `# Checkout report ${tag}` });
    const image = await get(`/api/runs/${id}/files/screenshots/s.webp`);
    expect(image.status).toBe(200);
    expect(Buffer.from(await image.arrayBuffer()).equals(shot)).toBe(true);
  });

  test("run documents go through the same errors the protocol names", async () => {
    const a = machine("errs-a");
    const b = machine("errs-b");
    const id = runId(3);
    expect((await putRun(id, docFor(id), a.auth)).status).toBe(201);
    const conflict = await putRun(id, docFor(id, { title: "Other" }), b.auth);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "id_conflict" });

    const old = docFor(runId(4));
    const stale = await putRun(runId(4), { ...old, protocol: HUB_PROTOCOL + 1 }, a.auth);
    expect(stale.status).toBe(426);
    expect(await stale.json()).toMatchObject({ code: "protocol_unsupported", minProtocol: 1, protocol: HUB_PROTOCOL });

    const running = await putRun(runId(5), docFor(runId(5), { status: "running" }), a.auth);
    expect(running.status).toBe(422);
    expect(await running.json()).toMatchObject({ code: "not_terminal" });

    const ghost = { sha256: "c".repeat(64), bytes: 5, type: "text/markdown" };
    const missing = await putRun(runId(6), docFor(runId(6), {}, { report: ghost } as Partial<RunUploadBodyT>), a.auth);
    expect(missing.status).toBe(422);
    expect(await missing.json()).toMatchObject({ code: "missing_blobs", missing: [ghost.sha256] });

    expect((await putRun(runId(7), docFor(runId(7)), { ...a.auth, "content-type": "text/plain" })).status).toBe(415);
    expect((await call("PUT", `/api/hub/v1/runs/${runId(7)}`, { headers: { "content-type": "application/json", ...a.auth }, body: "{nope" })).status).toBe(400);
    expect((await call("PUT", `/api/hub/v1/runs/${runId(7)}`, { headers: { "content-type": "application/json", "content-encoding": "gzip", ...a.auth }, body: "not gzip" })).status).toBe(400);
  });

  test("oversized bodies are cut off, including a small gzip that inflates past the cap", async () => {
    const m = machine("caps");
    const bomb = gzipSync(Buffer.alloc(3 * 1024 * 1024, "a"));
    expect(bomb.byteLength).toBeLessThan(100 * 1024);
    const doc = await call("PUT", `/api/hub/v1/runs/${runId(8)}`, { headers: { "content-type": "application/json", "content-encoding": "gzip", ...m.auth }, body: bomb });
    expect(doc.status).toBe(413);
    process.env.TAPOCALYPSE_HUB_MAX_BLOB_MB = "1";
    const big = Buffer.concat([Buffer.from("RIFF"), Buffer.from([1, 0, 0, 0]), Buffer.from("WEBP"), Buffer.alloc(1024 * 1024 + 1, 1)]);
    expect((await putBlob(big, "image/webp", m.auth)).status).toBe(413);
  });

  test("only the owner or an admin deletes a run", async () => {
    const owner = machine("own");
    const other = machine("other");
    const admin = machine("admin", true);
    const a = runId(10);
    const b = runId(11);
    await putRun(a, docFor(a), owner.auth);
    await putRun(b, docFor(b), owner.auth);
    expect((await call("DELETE", `/api/hub/v1/runs/${a}`, { headers: other.auth })).status).toBe(403);
    expect((await call("DELETE", `/api/hub/v1/runs/${a}`, { headers: owner.auth })).status).toBe(204);
    expect(getRun(a)).toBeNull();
    expect((await call("DELETE", `/api/hub/v1/runs/${b}`, { headers: admin.auth })).status).toBe(204);
    expect((await call("DELETE", `/api/hub/v1/runs/${b}`, { headers: owner.auth })).status).toBe(404);
  });

  test("the proxy's identity header is read for 'uploaded by' only when configured", async () => {
    const m = machine("ident");
    const headers = { "x-forwarded-email": "dana@example.com", ...m.auth };
    const without = runId(12);
    await putRun(without, docFor(without), headers);
    expect(getRun(without)?.hub?.uploader).toBeNull();
    process.env.TAPOCALYPSE_HUB_IDENTITY_HEADER = "X-Forwarded-Email";
    const withHeader = runId(13);
    await putRun(withHeader, docFor(withHeader), headers);
    expect(getRun(withHeader)?.hub?.uploader).toBe("dana@example.com");
    expect(await (await get("/api/hub/v1/info")).json()).toMatchObject({ identityHeader: true });
  });
});

describe("what viewers read", () => {
  test("machines list the uploader and last upload and never a digest; the run list filters by machine and version", async () => {
    const m = machine("view");
    const id = runId(20);
    await putRun(id, docFor(id, { build: { packageId: "com.acme.shop", versionName: `7.${tag.length}.1`, versionCode: "1", capturedAt: "x" } }), m.auth);
    const machines = (await (await get("/api/hub/v1/machines")).json()) as { machines: { name: string; runs30d: number; lastUploadAt: string | null; revoked: boolean }[] };
    const mine = machines.machines.find((x) => x.name === m.name);
    expect(mine).toMatchObject({ runs30d: 1, revoked: false });
    expect(mine?.lastUploadAt).not.toBeNull();
    expect(JSON.stringify(machines)).not.toContain("digest");

    revokeToken(m.name);
    const after = (await (await get("/api/hub/v1/machines")).json()) as { machines: { name: string; revoked: boolean; runs30d: number }[] };
    expect(after.machines.find((x) => x.name === m.name)).toMatchObject({ revoked: true, runs30d: 1 });

    const byMachine = (await (await get(`/api/runs?machine=${encodeURIComponent(m.name)}`)).json()) as { runs: { id: string }[] };
    expect(byMachine.runs.map((r) => r.id)).toEqual([id]);
    const byVersion = (await (await get(`/api/runs?version=7.${tag.length}.1&machine=${encodeURIComponent(m.name)}`)).json()) as { runs: { id: string }[] };
    expect(byVersion.runs.map((r) => r.id)).toEqual([id]);
    expect(((await (await get(`/api/runs?machine=${encodeURIComponent(`${m.name}-x`)}`)).json()) as { runs: unknown[] }).runs).toEqual([]);
  });

  test("the project list carries what the hub knows about each project", async () => {
    const m = machine("proj");
    const id = runId(21);
    await putRun(id, docFor(id), m.auth);
    const entry = hubProjectByKey(hubKey)!;
    const list = (await (await get("/api/projects")).json()) as { id: string; status: string; hub?: { hubKey: string; runs: number; machines: { name: string }[]; lastUploadBy: { machine: string } | null } }[];
    const mine = list.find((p) => p.id === entry.id);
    expect(mine).toMatchObject({ status: "ok", hub: { hubKey, lastUploadBy: { machine: m.name } } });
    expect(mine?.hub?.runs).toBeGreaterThanOrEqual(1);
  });

  test("a hub run's activity pages from the uploaded feed", async () => {
    const m = machine("act");
    const id = runId(22);
    const feed = new TextEncoder().encode([{ ts: "2026-02-01T00:00:00.000Z", seq: 4, kind: "say", text: "hello" }].map((l) => JSON.stringify(l)).join("\n") + "\n");
    await putBlob(feed, "application/x-ndjson", m.auth);
    await putRun(id, docFor(id, {}, { activity: { sha256: sha(feed), bytes: feed.byteLength, type: "application/x-ndjson" } } as Partial<RunUploadBodyT>), m.auth);
    expect(await (await get(`/api/runs/${id}/activity`)).json()).toMatchObject({ items: [{ seq: 4, text: "hello" }], hasMore: false });
  });

  test("a hub run's page stream opens with its snapshot and asks reverse proxies not to buffer it", async () => {
    // nginx buffers proxied responses unless told otherwise; a buffered stream never delivers the snapshot and the run page hangs.
    const m = machine("sse");
    const id = runId(24);
    await putRun(id, docFor(id), m.auth);
    for (const p of [`/api/runs/${id}/events`, "/api/events"]) {
      const res = await get(p);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-accel-buffering")).toBe("no");
      const reader = res.body?.getReader();
      if (p.includes(id)) expect(new TextDecoder().decode((await reader?.read())?.value)).toContain("event: snapshot");
      await reader?.cancel();
    }
  });

  test("the reports list shows data-dir reports and never reads a folder of the server's working directory", async () => {
    const m = machine("rep");
    const id = runId(23);
    const report = new TextEncoder().encode(`# Wishlist report ${tag}`);
    await putBlob(report, "text/markdown", m.auth);
    await putRun(id, docFor(id, { title: "Wishlist lane" }, { report: { sha256: sha(report), bytes: report.byteLength, type: "text/markdown" } } as Partial<RunUploadBodyT>), m.auth);
    const projectId = hubProjectByKey(hubKey)!.id;
    const cwd = process.cwd();
    const trap = fs.mkdtempSync(path.join(os.tmpdir(), "hub-cwd-"));
    fs.mkdirSync(path.join(trap, "qa"));
    fs.writeFileSync(path.join(trap, "qa", "leak.md"), "# leaked\n");
    try {
      process.chdir(trap);
      const entries = (await (await get(`/api/projects/${projectId}/reports`)).json()) as { name: string }[];
      expect(entries.map((e) => e.name)).toContain(id);
      expect(entries.map((e) => e.name)).not.toContain("leak.md");
      expect((await get(`/api/projects/${projectId}/reports/leak.md`)).status).toBe(404);
    } finally {
      process.chdir(cwd);
      fs.rmSync(trap, { recursive: true, force: true });
    }
  });
});

describe("hub hardening", () => {
  test("a token may upload only so many run documents a minute, another token is unaffected, and the limit is answered before the body is read", async () => {
    const busy = machine("busy");
    const calm = machine("calm");
    const statuses: number[] = [];
    for (let i = 0; i < 125; i++) statuses.push((await call("PUT", `/api/hub/v1/runs/${runId(100)}`, { headers: { "content-type": "application/json", ...busy.auth }, body: "{}" })).status);
    expect(statuses.slice(0, 120).every((s) => s === 426)).toBe(true);
    expect(statuses.slice(120)).toEqual([429, 429, 429, 429, 429]);
    const limited = await call("PUT", `/api/hub/v1/runs/${runId(100)}`, { headers: { "content-type": "application/json", ...busy.auth }, body: "{}" });
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await call("PUT", `/api/hub/v1/runs/${runId(100)}`, { headers: { "content-type": "application/json", ...calm.auth }, body: "{}" })).status).toBe(426);
  });

  test("viewers are not shown the hub's filesystem layout", async () => {
    const m = machine("paths");
    const report = new TextEncoder().encode(`# Paths report ${tag}`);
    expect((await call("PUT", `/api/hub/v1/blobs/${sha(report)}`, { headers: { "content-type": "text/markdown", ...m.auth }, body: Buffer.from(report) })).status).toBe(201);
    const id = runId(101);
    const body = docFor(id, {}, { report: { sha256: sha(report), bytes: report.byteLength, type: "text/markdown" } });
    expect((await putRun(id, body, m.auth)).status).toBe(201);
    const view = (await (await get(`/api/runs/${id}`)).json()) as { runDir: string; reportFile: string | null; projectId: string };
    expect(view.runDir).toBe("");
    expect(view.reportFile).toBeNull();
    const reports = (await (await get(`/api/projects/${view.projectId}/reports`)).json()) as { runId: string | null; path: string }[];
    expect(reports.find((r) => r.runId === id)).toBeDefined();
    expect(reports.every((r) => r.path === "")).toBe(true);
    const rendered = (await (await get(`/api/projects/${view.projectId}/reports/${id}`)).json()) as { path: string };
    expect(rendered.path).toBe("");
  });
});

describe("idle connections", () => {
  test("only the event streams are exempt from the server's idle timeout", async () => {
    const exempted: string[] = [];
    const server = { timeout: (req: Request, seconds: number) => void (seconds === 0 && exempted.push(new URL(req.url).pathname)) };
    const stream = await fetchHandler(new Request(`${base}/api/events`, { headers: { host: HOST } }), server);
    await stream.body?.cancel();
    await fetchHandler(new Request(`${base}/api/health`, { headers: { host: HOST } }), server);
    await fetchHandler(new Request(`${base}/api/runs`, { headers: { host: HOST } }), server);
    expect(exempted).toEqual(["/api/events"]);
  });
});
