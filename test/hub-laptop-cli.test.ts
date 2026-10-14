import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { readHubConfig, resolveHubCredentials, setHubPaths } from "../src/hub/credentials";
import { type HubCliApi, type HubCliDeps, runHubLaptopCommand } from "../src/hub/laptop-cli";
import type { Project } from "../src/projects/registry";
import { cleanupRuns, makeRun, uniqueTest } from "./support/regression";

const TOKEN = "tpu_clitoken00000000000000000000000000000000";
const dirs: string[] = [];
let dir: string;
let restorePaths: () => void;
let out: string[];
let err: string[];
let calls: { method: string; path: string; body: unknown }[];
let apiReplies: Record<string, unknown>;

const project = (id: string): Project => ({ id, name: "Acme Shop", repoPath: dir, personaFile: null, defaultPackage: "com.example.app", defaultPlatform: "android", defaultBranch: "main", hubKey: "github.com/acme/shop", share: true });

function deps(over: Partial<HubCliDeps> = {}): HubCliDeps {
  const api: HubCliApi = {
    async request<T>(method: "GET" | "POST" | "PUT", pathname: string, body?: unknown): Promise<T> {
      calls.push({ method, path: pathname, body });
      const reply = apiReplies[`${method} ${pathname.split("?")[0]}`];
      if (reply instanceof Error) throw reply;
      return reply as T;
    },
  };
  return { io: { out: (t) => out.push(t), err: (t) => err.push(t) }, env: {}, api: () => api, sleep: async () => {}, ...over };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tpc-hubcli-"));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ port: 1, projects: [] }));
  restorePaths = setHubPaths({ configFile: path.join(dir, "config.json"), configDir: dir });
  out = [];
  err = [];
  calls = [];
  apiReplies = {};
});
afterEach(() => {
  restorePaths();
  cleanupRuns();
});
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

describe("hub login", () => {
  /** What the server answers after it saved and tested a connection (`PUT /api/hub/connection` returns the hub status). */
  const connected = (state: string, detail: string | null = null) => ({
    configured: true,
    url: "https://hub.example.com",
    screenshots: "webp",
    credentials: { file: "/srv/tpc/hub-credentials.json", token: "file", tokenHint: "0000", problem: null, headers: { source: null, names: [] } },
    connection: { state, machine: state === "ok" ? "ann-mbp" : null, hubVersion: state === "ok" ? "9.9.9" : null, minProtocol: 1, checkedAt: "2026-04-01T09:00:00.000Z", detail },
    queue: { waiting: 0, uploading: null, failed: 0, parked: 0, uploaded: 0, backfill: null },
    paused: null,
    lastUploadAt: null,
    sharedProjects: [],
  });

  test("hands the connection to the running server, which stores it where it reads its own config; the CLI writes no files", async () => {
    // The CLI and the server can resolve different config files (another TAPOCALYPSE_CONFIG, a service): only the server's counts.
    apiReplies["PUT /api/hub/connection"] = connected("ok");
    const code = await runHubLaptopCommand("login", ["https://hub.example.com/", "--token", TOKEN], deps());

    expect(code).toBe(0);
    expect(calls).toEqual([{ method: "PUT", path: "/api/hub/connection", body: { url: "https://hub.example.com", token: TOKEN } }]);
    expect(out.join("\n")).toContain("ann-mbp");
    expect(out.join("\n")).toContain("/srv/tpc/hub-credentials.json");
    expect([...out, ...err].join("\n")).not.toContain(TOKEN);
    expect(readHubConfig(path.join(dir, "config.json"))).toBeNull();
    expect(fs.existsSync(path.join(dir, "hub-credentials.json"))).toBe(false);
  });

  test("a connection the server could not complete exits 2 with its reason", async () => {
    apiReplies["PUT /api/hub/connection"] = connected("unauthorized", "the hub rejected the upload token");
    expect(await runHubLaptopCommand("login", ["https://hub.example.com", "--token", "tpu_wrong"], deps())).toBe(2);
    expect(err.join("\n")).toContain("the hub rejected the upload token");
  });

  test("a server that is not running is a clear error, not a silent local save", async () => {
    apiReplies["PUT /api/hub/connection"] = new Error("Tapocalypse is not running at http://127.0.0.1:4310");
    expect(await runHubLaptopCommand("login", ["https://hub.example.com", "--token", TOKEN], deps())).toBe(2);
    expect(err.join("\n")).toContain("not running");
    expect(fs.existsSync(path.join(dir, "hub-credentials.json"))).toBe(false);
  });

  test("proxy headers and the screenshot choice travel to the server", async () => {
    apiReplies["PUT /api/hub/connection"] = connected("ok");
    expect(await runHubLaptopCommand("login", ["https://hub.example.com", "--token", TOKEN, "--header", "X-Proxy-Id: abc", "--header", "X-Proxy-Secret: s3cr3t", "--screenshots", "original"], deps())).toBe(0);
    expect(calls[0]?.body).toEqual({ url: "https://hub.example.com", token: TOKEN, headers: { "X-Proxy-Id": "abc", "X-Proxy-Secret": "s3cr3t" }, screenshots: "original" });
  });

  test("the token can come from the environment or a prompt, and without any it is a usage error", async () => {
    apiReplies["PUT /api/hub/connection"] = connected("ok");
    expect(await runHubLaptopCommand("login", ["https://hub.example.com"], deps({ env: { TAPOCALYPSE_HUB_TOKEN: TOKEN } }))).toBe(0);
    expect(await runHubLaptopCommand("login", ["https://hub.example.com"], deps({ readToken: async () => TOKEN }))).toBe(0);
    expect(await runHubLaptopCommand("login", ["https://hub.example.com"], deps())).toBe(3);
  });

  test("plain http is only accepted for the local machine", async () => {
    apiReplies["PUT /api/hub/connection"] = connected("ok");
    expect(await runHubLaptopCommand("login", ["http://hub.example.com", "--token", TOKEN], deps())).toBe(3);
    expect(await runHubLaptopCommand("login", ["http://127.0.0.1:4500", "--token", TOKEN], deps())).toBe(0);
  });
});

describe("hub status", () => {
  const status = {
    configured: true,
    url: "https://hub.example.com",
    screenshots: "webp",
    credentials: { file: "/x/hub-credentials.json", token: "file", tokenHint: "0000", problem: null, headers: { source: null, names: [] } },
    connection: { state: "ok", machine: "ann-mbp", hubVersion: "9.9.9", minProtocol: 1, checkedAt: "2026-04-01T09:00:00.000Z", detail: null },
    queue: { waiting: 2, uploading: null, failed: 1, parked: 0, uploaded: 5, backfill: null },
    paused: null,
    lastUploadAt: "2026-04-01T08:00:00.000Z",
    sharedProjects: [{ id: "shop", name: "Acme Shop", hubKey: "github.com/acme/shop" }],
  };

  test("prints the connection, the queue and the shared projects", async () => {
    apiReplies["GET /api/hub/status"] = status;
    expect(await runHubLaptopCommand("status", [], deps())).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("https://hub.example.com");
    expect(text).toContain("ann-mbp");
    expect(text).toContain("5 uploaded");
    expect(text).toContain("2 waiting");
    expect(text).toContain("1 failed");
    expect(text).toContain("github.com/acme/shop");
  });

  test("a connection that was never checked is checked now", async () => {
    apiReplies["GET /api/hub/status"] = { ...status, connection: { ...status.connection, state: "unknown", machine: null, checkedAt: null } };
    apiReplies["POST /api/hub/test"] = status;
    expect(await runHubLaptopCommand("status", [], deps())).toBe(0);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /api/hub/status", "POST /api/hub/test"]);
    expect(out.join("\n")).toContain("Connection: ok as ann-mbp");
  });

  test("a paused queue says why and what to do", async () => {
    apiReplies["GET /api/hub/status"] = { ...status, paused: { reason: "unauthorized", detail: "hub.example.com rejected the upload token", at: "2026-04-01T09:00:00.000Z" } };
    expect(await runHubLaptopCommand("status", [], deps())).toBe(0);
    expect(out.join("\n")).toMatch(/Paused.*rejected the upload token/s);
    expect(out.join("\n")).toContain("hub login");
  });

  test("an unconfigured machine is told how to connect, and --json prints the raw status", async () => {
    apiReplies["GET /api/hub/status"] = { ...status, configured: false, url: null };
    expect(await runHubLaptopCommand("status", [], deps())).toBe(0);
    expect(out.join("\n")).toContain("hub login");
    out.length = 0;
    expect(await runHubLaptopCommand("status", ["--json"], deps())).toBe(0);
    expect(z.object({ configured: z.boolean() }).parse(JSON.parse(out.join("\n"))).configured).toBe(false);
  });
});

describe("hub push", () => {
  test("sends the selection to the server and says the upload runs in the background", async () => {
    apiReplies["POST /api/hub/push"] = { queued: 7 };
    expect(await runHubLaptopCommand("push", ["--project", "shop", "--since", "2026-03-01"], deps())).toBe(0);
    expect(calls).toEqual([{ method: "POST", path: "/api/hub/push", body: { projectId: "shop", since: "2026-03-01T00:00:00.000Z" } }]);
    expect(out.join("\n")).toContain("7");
  });

  test("a run id, --all, --verify and --failed map to the request", async () => {
    apiReplies["POST /api/hub/push"] = { queued: 1 };
    await runHubLaptopCommand("push", ["20260301-abcd-demo"], deps());
    await runHubLaptopCommand("push", ["--all", "--verify"], deps());
    await runHubLaptopCommand("push", ["--failed"], deps());
    expect(calls.map((c) => c.body)).toEqual([{ runIds: ["20260301-abcd-demo"] }, { all: true, verify: true }, { failed: true }]);
  });

  test("with nothing to select it is a usage error", async () => {
    expect(await runHubLaptopCommand("push", [], deps())).toBe(3);
    expect(calls).toEqual([]);
  });

  test("--wait follows the queue until it is empty and exits 1 when something failed", async () => {
    apiReplies["POST /api/hub/push"] = { queued: 2 };
    const busy = { queue: { waiting: 1, uploading: "x", failed: 0, parked: 0, uploaded: 1, backfill: null }, paused: null };
    const done = { queue: { waiting: 0, uploading: null, failed: 1, parked: 0, uploaded: 2, backfill: null }, paused: null };
    const replies = [busy, done];
    const d = deps();
    const api = d.api("x");
    d.api = () => ({
      request: async <T,>(method: "GET" | "POST", pathname: string, body?: unknown): Promise<T> => (pathname === "/api/hub/status" ? (replies.shift() as T) : api.request<T>(method, pathname, body)),
    });
    expect(await runHubLaptopCommand("push", ["--all", "--wait"], d)).toBe(1);
    expect(replies).toEqual([]);
  });

  test("--dry-run packages locally and reports counts, bytes and redactions without calling the server", async () => {
    const projectId = `cli-${Date.now().toString(36)}`;
    const run = makeRun({ testKey: uniqueTest(), at: 5, projectId, status: "done", checks: [["c1", "pass"]] });
    const code = await runHubLaptopCommand("push", ["--project", projectId, "--dry-run"], deps({ local: { getProject: (id) => (id === projectId ? project(projectId) : undefined) } }));

    expect(code).toBe(0);
    expect(calls).toEqual([]);
    const text = out.join("\n");
    expect(text).toContain("1 run");
    expect(text).toContain(run.id);
    expect(text).toMatch(/redact/i);
  });
});

describe("hub unpublish", () => {
  test("removes one run from the hub through the server", async () => {
    apiReplies["POST /api/runs/20260301-abcd-demo/unpublish"] = null;
    expect(await runHubLaptopCommand("unpublish", ["20260301-abcd-demo"], deps())).toBe(0);
    expect(calls).toEqual([{ method: "POST", path: "/api/runs/20260301-abcd-demo/unpublish", body: {} }]);
  });

  test("--project removes every run of the project this machine uploaded, as the server lists them (also when sharing is off)", async () => {
    apiReplies["GET /api/hub/uploaded"] = { runIds: ["r3", "r1"] };
    apiReplies["POST /api/runs/r3/unpublish"] = null;
    apiReplies["POST /api/runs/r1/unpublish"] = null;
    expect(await runHubLaptopCommand("unpublish", ["--project", "shop"], deps())).toBe(0);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /api/hub/uploaded?project=shop", "POST /api/runs/r3/unpublish", "POST /api/runs/r1/unpublish"]);
    expect(out.join("\n")).toContain("2");
  });

  test("it needs a run id or --project", async () => {
    expect(await runHubLaptopCommand("unpublish", [], deps())).toBe(3);
  });
});

describe("hub pack", () => {
  test("writes exactly what would be sent and prints sizes and redaction counts", async () => {
    const projectId = `cli-${Date.now().toString(36)}`;
    const run = makeRun({ testKey: uniqueTest(), at: 5, projectId, status: "done", checks: [["c1", "pass"]], title: "Checkout total updates" });
    const target = path.join(dir, "pack");
    const code = await runHubLaptopCommand("pack", [run.id, "--out", target], deps({ local: { getProject: (id) => (id === projectId ? project(projectId) : undefined) } }));

    expect(code).toBe(0);
    const doc = z.object({ run: z.object({ id: z.string(), title: z.string() }), project: z.object({ hubKey: z.string() }), redaction: z.object({ replaced: z.record(z.string(), z.number()) }) }).parse(JSON.parse(fs.readFileSync(path.join(target, "upload.json"), "utf8")));
    expect(doc.run).toEqual({ id: run.id, title: "Checkout total updates" });
    expect(doc.project.hubKey).toBe("github.com/acme/shop");
    const text = out.join("\n");
    expect(text).toContain(target);
    expect(text).toMatch(/redact/i);
    expect(calls).toEqual([]);
  });

  test("an unknown run exits 3 and writes nothing", async () => {
    const target = path.join(dir, "nothing");
    expect(await runHubLaptopCommand("pack", ["no-such-run", "--out", target], deps())).toBe(3);
    expect(fs.existsSync(target)).toBe(false);
  });

  test("a project that is not shared can still be packed (to see what sharing would send)", async () => {
    const projectId = `cli-${Date.now().toString(36)}`;
    const run = makeRun({ testKey: uniqueTest(), at: 5, projectId, status: "done" });
    const target = path.join(dir, "pack2");
    const code = await runHubLaptopCommand("pack", [run.id, "--out", target], deps({ local: { getProject: (id) => (id === projectId ? { ...project(projectId), share: false } : undefined) } }));
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(target, "upload.json"))).toBe(true);
  });
});

