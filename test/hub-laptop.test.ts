import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { HttpError } from "../src/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readHubConfig, setHubPaths, writeHubConfig, writeHubCredentials } from "../src/hub/credentials";
import type { DoctorCheck } from "../src/doctor";
import { hubChecks } from "../src/hub/laptop-doctor";
import { laptopHubRoute } from "../src/hub/laptop-routes";
import { projectHubInfo, queueBackfill } from "../src/hub/project-hub";
import type { PackagedRun } from "../src/hub/package";
import { type HubSyncWorker, refreshHubConfig, startHubSync, stopHubSync } from "../src/hub/sync";
import type { Project } from "../src/projects/registry";
import type { GitRunner } from "../src/regression/baseline";
import type { Run } from "../src/runs/types";
import { cleanupRuns, makeRun, uniqueTest } from "./support/regression";
import { createFakeHub, type FakeHub } from "./support/fake-hub";

const TOKEN = "tpu_routetoken00000000000000000000000000000";
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const dirs: string[] = [];

async function fakePackage(run: Run, project: Project): Promise<PackagedRun> {
  const report = new TextEncoder().encode(`# ${run.id}`);
  const doc = {
    protocol: 1,
    clientVersion: "0.0.0-test",
    sentAt: new Date().toISOString(),
    project: { hubKey: "github.com/acme/shop", name: project.name, remoteUrl: null, subpath: null, defaultBranch: null, defaultPlatform: "android" as const, localId: project.id },
    run: { id: run.id, projectId: project.id, title: run.title, status: run.status as "done", createdAt: run.createdAt, checks: [], testKey: null },
    batch: null,
    report: { sha256: sha(`# ${run.id}`), bytes: report.length, type: "text/markdown" as const },
    activity: null,
    screenshots: [],
    transcript: null,
    redaction: { replaced: {} },
  };
  return { doc, blobs: new Map([[sha(`# ${run.id}`), { type: "text/markdown" as const, bytes: report }]]), contentHash: sha(JSON.stringify(doc.run)) };
}

const Json = z.record(z.string(), z.unknown());
let hub: FakeHub;
let worker: HubSyncWorker;
let dir: string;
let restorePaths: () => void;
let projectId: string;
let shared = true;
/** Every request the sync worker sent, whatever hub it was addressed to. */
let sent: Request[] = [];

beforeEach(async () => {
  // Another test file may have created the process-wide worker (a run view asks for its sync state): start from a clean one.
  await stopHubSync();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tpc-hublaptop-"));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ port: 1, projects: [] }));
  restorePaths = setHubPaths({ configFile: path.join(dir, "config.json"), configDir: dir });
  refreshHubConfig();
  hub = createFakeHub(TOKEN);
  sent = [];
  shared = true;
  projectId = `route-${randomBytes(4).toString("hex")}`;
  worker = startHubSync({
    stateFile: path.join(dir, "hub-outbox.json"),
    fetch: (req) => {
      sent.push(req.clone());
      return hub.fetch(req);
    },
    getProject: (id) => (id === projectId ? ({ id, name: "Acme Shop", repoPath: dir, personaFile: null, defaultPackage: "com.example.app", defaultPlatform: "android", share: shared } satisfies Project) : undefined),
    packageRun: fakePackage,
    debounceMs: 0,
  });
});
afterEach(async () => {
  await stopHubSync();
  restorePaths();
  refreshHubConfig();
  delete process.env.TAPOCALYPSE_HUB_TOKEN;
  delete process.env.TAPOCALYPSE_HUB_HEADERS;
  cleanupRuns();
});
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

async function call(method: string, pathname: string, body?: unknown): Promise<Response | null> {
  const url = new URL(`http://127.0.0.1:4399${pathname}`);
  try {
    return await laptopHubRoute(new Request(url, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), url);
  } catch (e) {
    // api.ts turns a thrown HttpError into this response.
    if (e instanceof HttpError) return Response.json({ error: e.message, code: e.code }, { status: e.status });
    throw e;
  }
}
async function ok(method: string, pathname: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await call(method, pathname, body);
  if (!res) throw new Error(`${method} ${pathname} not handled`);
  expect(res.status).toBe(200);
  return Json.parse(await res.json());
}

describe("GET /api/hub/status", () => {
  test("an unconfigured machine reports nothing set and no credentials", async () => {
    const status = await ok("GET", "/api/hub/status");
    expect(status).toMatchObject({ configured: false, url: null, credentials: { file: path.join(dir, "hub-credentials.json"), token: null, tokenHint: null }, queue: { waiting: 0, uploaded: 0 }, paused: null });
  });

  test("a connection saved by `hub login` in another process is used without a restart", async () => {
    writeHubConfig(path.join(dir, "config.json"), { url: "https://hub.example.com" });
    writeHubCredentials({ token: TOKEN });
    expect(await ok("GET", "/api/hub/status")).toMatchObject({ configured: true, url: "https://hub.example.com", credentials: { token: "file" } });
    expect(await ok("POST", "/api/hub/test")).toMatchObject({ connection: { state: "ok" } });
    writeHubConfig(path.join(dir, "config.json"), null);
    expect(await ok("GET", "/api/hub/status")).toMatchObject({ configured: false });
  });

  test("routes it does not own are left alone", async () => {
    expect(await call("GET", "/api/runs")).toBeNull();
    expect(await call("POST", "/api/hub/status")).toBeNull();
  });
});

describe("PUT /api/hub/connection", () => {
  test("saves the url to the config and the token to a mode-600 file, then tests the connection; the token is never echoed", async () => {
    const res = await ok("PUT", "/api/hub/connection", { url: "https://hub.example.com/", token: TOKEN });

    expect(res).toMatchObject({ configured: true, url: "https://hub.example.com", credentials: { token: "file", tokenHint: TOKEN.slice(-4) }, connection: { state: "ok", machine: "ann-mbp" } });
    expect(JSON.stringify(res)).not.toContain(TOKEN);
    expect(readHubConfig(path.join(dir, "config.json"))).toEqual({ url: "https://hub.example.com" });
    expect(fs.readFileSync(path.join(dir, "config.json"), "utf8")).not.toContain(TOKEN);
    const credFile = path.join(dir, "hub-credentials.json");
    expect(fs.statSync(credFile).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(credFile, "utf8")).token).toBe(TOKEN);
  });

  test("a wrong token is saved but reported as unauthorized", async () => {
    const res = await ok("PUT", "/api/hub/connection", { url: "https://hub.example.com", token: "tpu_wrong" });
    expect(res).toMatchObject({ connection: { state: "unauthorized" } });
  });

  test("an invalid url is refused and nothing is written", async () => {
    const res = await call("PUT", "/api/hub/connection", { url: "not a url", token: TOKEN });
    expect(res?.status).toBe(400);
    expect(fs.existsSync(path.join(dir, "hub-credentials.json"))).toBe(false);
  });

  test("a plain-http address for another machine is refused and nothing is written", async () => {
    for (const url of ["http://hub.example.com", "http://hub.example.com:80/qa", "ftp://hub.example.com"]) {
      const res = await call("PUT", "/api/hub/connection", { url, token: TOKEN });
      expect(res?.status).toBe(400);
    }
    expect(fs.existsSync(path.join(dir, "hub-credentials.json"))).toBe(false);
    expect(readHubConfig(path.join(dir, "config.json"))).toBeNull();
    expect((await call("PUT", "/api/hub/connection", { url: "http://127.0.0.1:4311", token: TOKEN }))?.status).toBe(200);
  });

  test("proxy headers: omitted keeps the saved set, present replaces it, null keeps that header's saved value; values never leave the server", async () => {
    await ok("PUT", "/api/hub/connection", { url: "https://hub.example.com", token: TOKEN, headers: { "X-Proxy-Id": "id-1", "X-Proxy-Secret": "s3cr3t" } });
    const credFile = path.join(dir, "hub-credentials.json");
    expect(JSON.parse(fs.readFileSync(credFile, "utf8")).headers).toEqual({ "X-Proxy-Id": "id-1", "X-Proxy-Secret": "s3cr3t" });

    await ok("PUT", "/api/hub/connection", { url: "https://hub.example.com" });
    expect(JSON.parse(fs.readFileSync(credFile, "utf8")).headers).toEqual({ "X-Proxy-Id": "id-1", "X-Proxy-Secret": "s3cr3t" });

    const res = await ok("PUT", "/api/hub/connection", { url: "https://hub.example.com", headers: { "X-Proxy-Id": "id-2", "X-Proxy-Secret": null } });
    expect(JSON.parse(fs.readFileSync(credFile, "utf8")).headers).toEqual({ "X-Proxy-Id": "id-2", "X-Proxy-Secret": "s3cr3t" });
    expect(res).toMatchObject({ credentials: { headers: { source: "file", names: ["X-Proxy-Id", "X-Proxy-Secret"] } } });
    expect(JSON.stringify(res)).not.toContain("s3cr3t");

    await ok("PUT", "/api/hub/connection", { url: "https://hub.example.com", headers: {} });
    expect(JSON.parse(fs.readFileSync(credFile, "utf8")).headers).toBeUndefined();
  });

  test("reconnecting keeps the live-progress choice made in the config", async () => {
    await ok("PUT", "/api/hub/connection", { url: "https://hub.example.com", token: TOKEN });
    const configFile = path.join(dir, "config.json");
    const config = z.object({ share: z.object({ hub: z.record(z.string(), z.unknown()) }) }).passthrough().parse(JSON.parse(fs.readFileSync(configFile, "utf8")));
    fs.writeFileSync(configFile, JSON.stringify({ ...config, share: { ...config.share, hub: { ...config.share.hub, live: false } } }));
    refreshHubConfig();

    await ok("PUT", "/api/hub/connection", { url: "https://hub.example.com" });
    expect(readHubConfig(configFile)).toMatchObject({ url: "https://hub.example.com", live: false });
  });

  describe("a different hub address", () => {
    const credFile = (): string => path.join(dir, "hub-credentials.json");
    const savedCredentials = (): { token: string; headers?: Record<string, string> } => JSON.parse(fs.readFileSync(credFile(), "utf8"));

    test("without a token it is refused: nothing is written and the saved token and headers are not sent to the new host", async () => {
      await ok("PUT", "/api/hub/connection", { url: "https://hub.example.com", token: TOKEN, headers: { "X-Proxy-Secret": "s3cr3t" } });
      const before = fs.readFileSync(credFile(), "utf8");
      const requests = sent.length;

      for (const url of ["https://hub.attacker.example", "https://hub.example.com:8443", "http://127.0.0.1:4311"]) {
        const res = await call("PUT", "/api/hub/connection", { url });
        expect(res?.status).toBe(400);
        expect(await res?.json()).toMatchObject({ code: "token_required_for_new_hub" });
      }
      expect(readHubConfig(path.join(dir, "config.json"))?.url).toBe("https://hub.example.com");
      expect(fs.readFileSync(credFile(), "utf8")).toBe(before);
      expect(sent.length).toBe(requests);
    });

    test("with a token the saved proxy headers (credentials file and config) are dropped, and only the new values reach the new host", async () => {
      await ok("PUT", "/api/hub/connection", { url: "https://hub.example.com", token: TOKEN, headers: { "X-Proxy-Secret": "s3cr3t" } });
      writeHubConfig(path.join(dir, "config.json"), { url: "https://hub.example.com", headers: { "X-Static": "static-value" } });
      refreshHubConfig();
      sent = [];

      await ok("PUT", "/api/hub/connection", { url: "https://hub.other.example", token: TOKEN });
      expect(savedCredentials()).toEqual({ token: TOKEN });
      expect(readHubConfig(path.join(dir, "config.json"))).toEqual({ url: "https://hub.other.example" });
      expect(sent.length).toBeGreaterThan(0);
      for (const req of sent) {
        expect(new URL(req.url).host).toBe("hub.other.example");
        expect(req.headers.get("x-proxy-secret")).toBeNull();
        expect(req.headers.get("x-static")).toBeNull();
        expect(req.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
      }

      await ok("PUT", "/api/hub/connection", { url: "https://hub.third.example", token: TOKEN, headers: { "X-Proxy-Id": "fresh" } });
      expect(savedCredentials().headers).toEqual({ "X-Proxy-Id": "fresh" });
    });

    test("keeping a saved header value with null is refused across origins and works within one", async () => {
      await ok("PUT", "/api/hub/connection", { url: "https://hub.example.com", token: TOKEN, headers: { "X-Proxy-Secret": "s3cr3t" } });
      const res = await call("PUT", "/api/hub/connection", { url: "https://hub.other.example", token: TOKEN, headers: { "X-Proxy-Secret": null } });
      expect(res?.status).toBe(400);
      expect(readHubConfig(path.join(dir, "config.json"))?.url).toBe("https://hub.example.com");
      expect(savedCredentials().headers).toEqual({ "X-Proxy-Secret": "s3cr3t" });

      await ok("PUT", "/api/hub/connection", { url: "https://hub.example.com/qa/", headers: { "X-Proxy-Secret": null } });
      expect(savedCredentials().headers).toEqual({ "X-Proxy-Secret": "s3cr3t" });
    });

    test("another path on the same origin keeps the saved token and headers", async () => {
      await ok("PUT", "/api/hub/connection", { url: "https://hub.example.com", token: TOKEN, headers: { "X-Proxy-Secret": "s3cr3t" } });
      await ok("PUT", "/api/hub/connection", { url: "https://hub.example.com/team-qa" });
      expect(savedCredentials()).toEqual({ token: TOKEN, headers: { "X-Proxy-Secret": "s3cr3t" } });
      expect(readHubConfig(path.join(dir, "config.json"))?.url).toBe("https://hub.example.com/team-qa");
    });
  });

  test("a token set by the environment locks the field", async () => {
    process.env.TAPOCALYPSE_HUB_TOKEN = TOKEN;
    const res = await call("PUT", "/api/hub/connection", { url: "https://hub.example.com", token: "tpu_other" });
    expect(res?.status).toBe(400);
    const ok2 = await ok("PUT", "/api/hub/connection", { url: "https://hub.example.com" });
    expect(ok2).toMatchObject({ credentials: { token: "env" }, connection: { state: "ok" } });
  });
});

describe("DELETE /api/hub/connection and POST /api/hub/test", () => {
  test("disconnecting removes the url and the credentials but keeps the queue", async () => {
    await ok("PUT", "/api/hub/connection", { url: "https://hub.example.com", token: TOKEN });
    hub.down = true;
    const run = makeRun({ testKey: uniqueTest(), at: 1, projectId, status: "done" });
    await ok("POST", "/api/hub/push", { runIds: [run.id] });
    const gone = await ok("DELETE", "/api/hub/connection");

    expect(gone).toMatchObject({ configured: false, url: null, credentials: { token: null } });
    expect(readHubConfig(path.join(dir, "config.json"))).toBeNull();
    expect(fs.existsSync(path.join(dir, "hub-credentials.json"))).toBe(false);
    expect(gone).toMatchObject({ queue: { failed: 1 } });
  });

  test("test re-checks the connection", async () => {
    await ok("PUT", "/api/hub/connection", { url: "https://hub.example.com", token: TOKEN });
    hub.down = true;
    expect(await ok("POST", "/api/hub/test")).toMatchObject({ connection: { state: "unreachable" } });
    hub.down = false;
    expect(await ok("POST", "/api/hub/test")).toMatchObject({ connection: { state: "ok" } });
  });
});

describe("POST /api/hub/push and POST /api/runs/:id/unpublish", () => {
  test("push queues the project's finished runs and they upload", async () => {
    await ok("PUT", "/api/hub/connection", { url: "https://hub.example.com", token: TOKEN });
    const runs = [makeRun({ testKey: uniqueTest(), at: 1, projectId, status: "done" }), makeRun({ testKey: uniqueTest(), at: 2, projectId, status: "done" })];
    expect(await ok("POST", "/api/hub/push", { projectId })).toEqual({ queued: 2 });
    await worker.idle();
    expect(runs.every((r) => hub.runs.has(r.id))).toBe(true);
  });

  test("push --verify asks the hub what it still has and queues what it lost", async () => {
    await ok("PUT", "/api/hub/connection", { url: "https://hub.example.com", token: TOKEN });
    const run = makeRun({ testKey: uniqueTest(), at: 1, projectId, status: "done" });
    await ok("POST", "/api/hub/push", { runIds: [run.id] });
    await worker.idle();
    hub.runs.delete(run.id);

    expect(await ok("POST", "/api/hub/push", { projectId, verify: true })).toEqual({ queued: 1, verified: { checked: 1, requeued: 1 } });
    await worker.idle();
    expect(hub.runs.has(run.id)).toBe(true);
  });

  test("push with no hub configured is a conflict, with a message", async () => {
    const res = await call("POST", "/api/hub/push", { projectId });
    expect(res?.status).toBe(409);
  });

  test("unpublish removes the hub copy; an unknown run is a 404", async () => {
    await ok("PUT", "/api/hub/connection", { url: "https://hub.example.com", token: TOKEN });
    const run = makeRun({ testKey: uniqueTest(), at: 1, projectId, status: "done" });
    await ok("POST", "/api/hub/push", { runIds: [run.id] });
    await worker.idle();
    const res = await call("POST", `/api/runs/${run.id}/unpublish`);
    expect(res?.status).toBe(204);
    expect(hub.runs.has(run.id)).toBe(false);
    expect((await call("POST", "/api/runs/no-such-run/unpublish"))?.status).toBe(404);
  });

  test("GET /api/hub/uploaded names this machine's uploaded runs of a project, also after sharing was turned off", async () => {
    await ok("PUT", "/api/hub/connection", { url: "https://hub.example.com", token: TOKEN });
    const mine = [makeRun({ testKey: uniqueTest(), at: 1, projectId, status: "done" }), makeRun({ testKey: uniqueTest(), at: 2, projectId, status: "done" })];
    const other = makeRun({ testKey: uniqueTest(), at: 3, projectId: `${projectId}-other`, status: "done" });
    await ok("POST", "/api/hub/push", { runIds: mine.map((r) => r.id) });
    await worker.idle();
    shared = false;
    const notUploaded = makeRun({ testKey: uniqueTest(), at: 4, projectId, status: "done" });
    await worker.idle();

    const body = await ok("GET", `/api/hub/uploaded?project=${encodeURIComponent(projectId)}`);
    expect([...(body.runIds as string[])].sort()).toEqual(mine.map((r) => r.id).sort());
    expect(body.runIds).not.toContain(other.id);
    expect(body.runIds).not.toContain(notUploaded.id);
  });

  test("a hub that refuses the delete is reported as a bad gateway", async () => {
    await ok("PUT", "/api/hub/connection", { url: "https://hub.example.com", token: TOKEN });
    const run = makeRun({ testKey: uniqueTest(), at: 1, projectId, status: "done" });
    hub.token = "tpu_rotated";
    const res = await call("POST", `/api/runs/${run.id}/unpublish`);
    expect(res?.status).toBe(502);
  });
});

describe("doctor checks", () => {
  const byId = (checks: DoctorCheck[], id: string): DoctorCheck | undefined => checks.find((c) => c.id === id);

  test("no hub configured is a skipped, optional check", async () => {
    const checks = await hubChecks();
    expect(checks).toEqual([expect.objectContaining({ id: "hub", status: "skip", required: false })]);
  });

  test("a working hub is ok and names the machine", async () => {
    writeHubConfig(path.join(dir, "config.json"), { url: "https://hub.example.com" });
    writeHubCredentials({ token: TOKEN });
    const checks = await hubChecks();
    expect(byId(checks, "hub")).toMatchObject({ status: "ok", required: false });
    expect(byId(checks, "hub")?.detail).toContain("ann-mbp");
    expect(byId(checks, "hub-queue")).toMatchObject({ status: "ok" });
  });

  test("a credentials file others can read is an error with the fix", async () => {
    writeHubConfig(path.join(dir, "config.json"), { url: "https://hub.example.com" });
    const file = writeHubCredentials({ token: TOKEN });
    fs.chmodSync(file, 0o644);
    const check = byId(await hubChecks(), "hub");
    expect(check).toMatchObject({ status: "error" });
    expect(check?.fix).toContain("chmod 600");
    expect(hub.log).toEqual([]);
  });

  test("a rejected token and a paused queue are warnings that say what to do", async () => {
    writeHubConfig(path.join(dir, "config.json"), { url: "https://hub.example.com" });
    writeHubCredentials({ token: TOKEN });
    const run = makeRun({ testKey: uniqueTest(), at: 1, projectId, status: "done" });
    hub.token = "tpu_rotated";
    worker.enqueue(run.id);
    await worker.idle();
    const checks = await hubChecks();
    expect(byId(checks, "hub")).toMatchObject({ status: "error" });
    expect(byId(checks, "hub")?.fix).toContain("hub login");
    expect(byId(checks, "hub-queue")).toMatchObject({ status: "warn" });
    expect(byId(checks, "hub-queue")?.detail).toMatch(/paused/i);
  });

  test("a shared project with no hub key to upload under is a warning", async () => {
    writeHubConfig(path.join(dir, "config.json"), { url: "https://hub.example.com" });
    writeHubCredentials({ token: TOKEN });
    const shared = { id: "orphan", name: "Orphan App", repoPath: dir, personaFile: null, defaultPackage: "com.example.app", defaultPlatform: "android", share: true } satisfies Project;
    const check = byId(await hubChecks({ projects: () => [shared], hubKey: async () => null }), "hub-projects");
    expect(check).toMatchObject({ status: "warn" });
    expect(check?.detail).toContain("Orphan App");
  });
});

describe("project form helpers", () => {
  const gitFor = (remote: string | null, prefix = ""): GitRunner => async (_cwd, args) => (args[0] === "remote" ? remote : args[0] === "rev-parse" ? prefix : null);
  const sharedProject = (id: string, hubKey?: string): Project => ({ id, name: `App ${id}`, repoPath: `/work/${id}`, personaFile: null, defaultPackage: "com.example.app", defaultPlatform: "android", share: true, ...(hubKey ? { hubKey } : {}) });

  test("projectHubInfo reports the derived key, the run counts and no conflict for a fresh project", async () => {
    makeRun({ testKey: uniqueTest(), at: 1, projectId, status: "done" });
    makeRun({ testKey: uniqueTest(), at: 2, projectId, status: "error" });
    makeRun({ testKey: uniqueTest(), at: 3, projectId, status: "running" });
    const info = await projectHubInfo({ repoPath: "/work/shop", id: projectId, share: true }, { git: gitFor("git@github.com:Acme/Shop.git", "apps/mobile/"), projects: () => [] });
    expect(info).toEqual({ derivedKey: "github.com/acme/shop#apps/mobile", remoteUrl: "https://github.com/Acme/Shop", subpath: "apps/mobile", existingRuns: 2, uploadedRuns: 0, conflictWith: null });
  });

  test("uploadedRuns counts what the outbox has uploaded for the project", async () => {
    // finished before any hub was connected: nothing uploads on its own
    const run = makeRun({ testKey: uniqueTest(), at: 1, projectId, status: "done" });
    makeRun({ testKey: uniqueTest(), at: 2, projectId, status: "done" });
    await ok("PUT", "/api/hub/connection", { url: "https://hub.example.com", token: TOKEN });
    await ok("POST", "/api/hub/push", { runIds: [run.id] });
    await worker.idle();
    const info = await projectHubInfo({ repoPath: "/work/shop", id: projectId }, { git: gitFor("https://github.com/acme/shop"), projects: () => [] });
    expect(info).toMatchObject({ existingRuns: 2, uploadedRuns: 1 });
  });

  test("a repository without a usable remote has no derived key", async () => {
    const info = await projectHubInfo({ repoPath: "/work/solo" }, { git: gitFor(null), projects: () => [] });
    expect(info).toMatchObject({ derivedKey: null, remoteUrl: null, subpath: null, existingRuns: 0, uploadedRuns: 0, conflictWith: null });
  });

  test("another shared project with the same effective key is a conflict; itself and different keys are not", async () => {
    const git = gitFor("https://github.com/acme/shop");
    const other = sharedProject("other");
    expect(await projectHubInfo({ repoPath: "/work/new", id: "new" }, { git, projects: () => [other] })).toMatchObject({ conflictWith: { id: "other", name: "App other" } });
    expect(await projectHubInfo({ repoPath: "/work/other", id: "other" }, { git, projects: () => [other] })).toMatchObject({ conflictWith: null });
    expect(await projectHubInfo({ repoPath: "/work/new", id: "new", hubKey: "github.com/acme/shop#com.acme.kiosk" }, { git, projects: () => [other] })).toMatchObject({ conflictWith: null });
    expect(await projectHubInfo({ repoPath: "/work/new", id: "new" }, { git, projects: () => [sharedProject("other", "github.com/acme/other")] })).toMatchObject({ conflictWith: null });
    expect(await projectHubInfo({ repoPath: "/work/new", id: "new" }, { git, projects: () => [{ ...other, share: false }] })).toMatchObject({ conflictWith: null });
  });

  test("queueBackfill queues the project's finished runs that are not on the hub yet, and uploads them", async () => {
    await ok("PUT", "/api/hub/connection", { url: "https://hub.example.com", token: TOKEN });
    const runs = [makeRun({ testKey: uniqueTest(), at: 2, projectId, status: "done" }), makeRun({ testKey: uniqueTest(), at: 1, projectId, status: "error" })];
    makeRun({ testKey: uniqueTest(), at: 3, projectId, status: "running" });
    expect(queueBackfill(projectId)).toEqual({ queued: 2 });
    await worker.idle();
    expect(hub.puts().map((l) => l.detail)).toEqual([runs[1].id, runs[0].id]);
    expect(queueBackfill(projectId)).toEqual({ queued: 0 });
  });

  test("queueBackfill queues nothing while no hub is configured", () => {
    makeRun({ testKey: uniqueTest(), at: 1, projectId, status: "done" });
    expect(queueBackfill(projectId)).toEqual({ queued: 0 });
  });
});
