// The laptop sync worker against a real hub: `src/server.ts` in hub mode in a child process with its own temp data dir
// (the hub stores runs under the same layout as a laptop, so a hub in this process would collide with the fixture runs).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { REPO_ROOT } from "../src/config";
import { HubSyncWorker } from "../src/hub/sync";
import type { Project } from "../src/projects/registry";
import { runDir, saveRun } from "../src/runs/store";
import type { Run } from "../src/runs/types";
import { cleanupRuns, makeRun, uniqueTest } from "./support/regression";

const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

let root: string;
let hub: Bun.Subprocess<"ignore", "pipe", "pipe">;
let base: string;
let token: string;
const projectId = `e2e-${Date.now().toString(36)}`;
const tag = Math.random().toString(36).slice(2, 8);

function project(): Project {
  return { id: projectId, name: "Acme Shop", repoPath: path.join(root, "repo"), personaFile: null, defaultPackage: "com.example.app", defaultPlatform: "android", defaultBranch: "main", hubKey: `github.com/acme/e2e-${tag}`, share: true };
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tpc-hub-e2e-"));
  const port = 44000 + Math.floor(Math.random() * 900);
  base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, TAPOCALYPSE_MODE: "hub", TAPOCALYPSE_HOST: "127.0.0.1", TAPOCALYPSE_PORT: String(port), TAPOCALYPSE_DATA_DIR: path.join(root, "hub-data"), TAPOCALYPSE_CONFIG: path.join(root, "none.json"), NODE_ENV: "production" };
  const minted = Bun.spawnSync(["bun", "-e", 'import { createToken } from "./src/hub/tokens"; console.log(createToken("e2e-laptop").token)'], { cwd: REPO_ROOT, env });
  token = minted.stdout.toString().trim();
  hub = Bun.spawn(["bun", "src/server.ts"], { cwd: REPO_ROOT, env, stdout: "pipe", stderr: "pipe" });
  const reader = hub.stdout.getReader();
  const deadline = Date.now() + 30_000;
  let seen = "";
  while (!seen.includes("listening")) {
    if (Date.now() > deadline) throw new Error(`hub did not start: ${seen}`);
    const { value, done } = await reader.read();
    if (done) throw new Error(`hub exited early: ${seen}`);
    seen += new TextDecoder().decode(value);
  }
  reader.releaseLock();
}, 40_000);

afterAll(() => {
  hub.kill();
  fs.rmSync(root, { recursive: true, force: true });
  cleanupRuns();
});

/** A finished run with a report that mentions this machine's repo path, and one screenshot. */
function fixtureRun(): Run {
  const run = makeRun({ testKey: uniqueTest(), at: 3, projectId, status: "done", title: "Checkout total updates", checks: [{ id: "c1", status: "pass", screenshot: "screenshots/step-1.png" }] });
  const dir = runDir(run.id);
  fs.mkdirSync(path.join(dir, "screenshots"), { recursive: true });
  fs.writeFileSync(path.join(dir, "screenshots", "step-1.png"), PNG_1X1);
  fs.writeFileSync(path.join(dir, "report.md"), `# Checkout\n\nBuilt from ${path.join(root, "repo")}/app\n\n![step](screenshots/step-1.png)\n`);
  run.reportPath = "report.md";
  run.summary = "Checkout works.";
  saveRun(run);
  return run;
}

function worker(over: { token?: string; requests?: string[] } = {}): HubSyncWorker {
  return new HubSyncWorker({
    stateFile: path.join(root, `outbox-${Math.random().toString(36).slice(2)}.json`),
    settings: () => ({ url: base, screenshots: "webp", headers: {} }),
    credentials: () => ({ ok: true, token: over.token ?? token, tokenSource: "file", tokenHint: "test", headers: {}, headersSource: null }),
    fetch: (req) => {
      over.requests?.push(`${req.method} ${new URL(req.url).pathname.replace(/[0-9a-f]{64}/, ":sha")}`);
      return fetch(req);
    },
    getProject: (id) => (id === projectId ? project() : undefined),
  });
}

const RunBody = z.object({ title: z.string(), hub: z.object({ machine: z.string() }).nullable() });

describe("against a real hub", () => {
  test("uploads a finished run: the hub shows it, redacted, with its report and a WebP screenshot", async () => {
    const run = fixtureRun();
    const w = worker();
    w.enqueue(run.id);
    await w.drain();

    expect(w.syncState(run.id, run)).toMatchObject({ state: "uploaded", url: expect.stringContaining(run.id) });
    const res = await fetch(`${base}/api/runs/${run.id}`);
    expect(res.status).toBe(200);
    expect(RunBody.parse(await res.json())).toEqual({ title: "Checkout total updates", hub: expect.objectContaining({ machine: "e2e-laptop" }) });
    const report = await (await fetch(`${base}/api/runs/${run.id}/report`)).text();
    expect(report).toContain("<repo>/app");
    expect(report).not.toContain(path.join(root, "repo"));
    const shot = await fetch(`${base}/api/runs/${run.id}/files/screenshots/step-1.webp`);
    expect(shot.status).toBe(200);
    expect(shot.headers.get("content-type")).toBe("image/webp");
  }, 30_000);

  test("an unchanged run is not sent again; an edit re-sends the document alone", async () => {
    const run = fixtureRun();
    const requests: string[] = [];
    const w = worker({ requests });
    w.enqueue(run.id);
    await w.drain();
    requests.length = 0;

    w.enqueue(run.id);
    await w.drain();
    expect(requests).toEqual([]);

    saveRun({ ...run, title: "Checkout total updates (renamed)" });
    w.enqueue(run.id);
    await w.drain();
    expect(requests).toEqual(["POST /api/hub/v1/blobs/check", `PUT /api/hub/v1/runs/${run.id}`]);
    expect(RunBody.parse(await (await fetch(`${base}/api/runs/${run.id}`)).json()).title).toBe("Checkout total updates (renamed)");
  }, 30_000);

  test("a token the hub does not know pauses the queue with the reason", async () => {
    const run = fixtureRun();
    const w = worker({ token: "tpu_not-a-real-token" });
    w.enqueue(run.id);
    await w.drain();
    expect(w.status().paused).toMatchObject({ reason: "unauthorized" });
    expect(w.syncState(run.id, run)?.state).toBe("paused");
  }, 30_000);

  test("unpublish removes the hub copy", async () => {
    const run = fixtureRun();
    const w = worker();
    w.enqueue(run.id);
    await w.drain();
    await w.unpublish(run.id);
    expect((await fetch(`${base}/api/runs/${run.id}`)).status).toBe(404);
    expect(w.syncState(run.id, run)?.state).toBe("local");
  }, 30_000);

  test("the connection test reports the machine the token belongs to", async () => {
    expect(await worker().testConnection()).toMatchObject({ state: "ok", machine: "e2e-laptop" });
    expect(await worker({ token: "tpu_not-a-real-token" }).testConnection()).toMatchObject({ state: "unauthorized" });
  }, 30_000);
});
