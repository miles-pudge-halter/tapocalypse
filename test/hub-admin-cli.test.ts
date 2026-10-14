import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fetchHandler } from "../src/api";
import { config } from "../src/config";
import { hubAdminCommand } from "../src/hub/admin-cli";
import { ingestRun, type Uploader } from "../src/hub/ingest";
import { hubDir, setHubMode } from "../src/hub/mode";
import { hubProjectByKey, installHubProjects } from "../src/hub/projects";
import { HUB_PROTOCOL, type RunUploadBodyT } from "../src/hub/protocol";
import { listTokens, revokeToken, verifyToken } from "../src/hub/tokens";
import { setProjectSource } from "../src/projects/registry";
import { deleteRun, getRun } from "../src/runs/store";

const tag = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const created: string[] = [];
let n = 0;
const uploader: Uploader = { machine: `${tag}-laptop`, admin: false, identity: null };

beforeAll(() => {
  setHubMode(true);
  installHubProjects();
});

afterAll(() => {
  setHubMode(null);
  setProjectSource(null);
  for (const id of created) deleteRun(id);
  for (const t of listTokens()) if (t.name.startsWith(tag)) revokeToken(t.name);
  const registry = path.join(hubDir(), "projects.json");
  if (fs.existsSync(registry)) {
    const entries = JSON.parse(fs.readFileSync(registry, "utf8")) as { hubKey: string }[];
    fs.writeFileSync(registry, JSON.stringify(entries.filter((e) => !e.hubKey.includes(tag))));
  }
});

async function run(...args: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await hubAdminCommand(args, { out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out, err };
}

function upload(hubKey: string, at = "2026-04-01T00:00:00.000Z"): string {
  const id = `20260401-0000${String(++n).padStart(2, "0")}-${tag}-c${n}`;
  created.push(id);
  const body = {
    protocol: HUB_PROTOCOL,
    clientVersion: "0.1.0",
    sentAt: new Date().toISOString(),
    project: { hubKey, name: "Acme Shop", remoteUrl: null, subpath: null, defaultBranch: null, defaultPlatform: "android", localId: "shop" },
    run: { id, projectId: "shop", title: "Checkout flow", status: "done", createdAt: at, checks: [], testKey: null, brief: "b", deviceRequest: { platform: "android" } },
    batch: null,
    report: null,
    activity: null,
    screenshots: [],
    transcript: null,
    redaction: { replaced: {} },
  } as unknown as RunUploadBodyT;
  ingestRun(id, body, uploader);
  return id;
}

describe("hub token", () => {
  test("create prints the token once on stdout; list never shows it; revoke ends it", async () => {
    const created = await run("token", "create", `${tag}-alice`);
    expect(created.code).toBe(0);
    const token = created.out.find((l) => l.startsWith("tpu_"));
    expect(token).toBeDefined();
    expect(verifyToken(token!)).toMatchObject({ name: `${tag}-alice`, admin: false });

    const listed = await run("token", "list");
    expect(listed.out.join("\n")).toContain(`${tag}-alice`);
    expect(listed.out.join("\n")).not.toContain(token!);

    expect((await run("token", "revoke", `${tag}-alice`)).code).toBe(0);
    expect(verifyToken(token!)).toBeNull();
    expect((await run("token", "revoke", `${tag}-alice`)).code).toBe(2);
  });

  test("--admin makes an admin token; a taken name and a missing name are errors", async () => {
    const admin = await run("token", "create", `${tag}-boss`, "--admin");
    expect(verifyToken(admin.out.find((l) => l.startsWith("tpu_"))!)?.admin).toBe(true);
    const again = await run("token", "create", `${tag}-boss`);
    expect(again.code).toBe(2);
    expect(again.err.join(" ")).toMatch(/already exists/);
    expect((await run("token", "create")).code).toBe(3);
    expect((await run("token", "frobnicate")).code).toBe(3);
  });
});

describe("hub project rename", () => {
  test("pins a display name that later uploads leave alone", async () => {
    const hubKey = `github.com/acme/cli-${tag}`;
    upload(hubKey);
    expect((await run("project", "rename", hubKey, "Acme", "Storefront")).code).toBe(0);
    expect(hubProjectByKey(hubKey)?.name).toBe("Acme Storefront");
    expect((await run("project", "rename", "github.com/acme/unknown", "x")).code).toBe(2);
    expect((await run("project", "rename", hubKey)).code).toBe(3);
  });
});

describe("hub unpublish", () => {
  test("removes a run by id, or every run of a machine in a project, and refuses an empty selection", async () => {
    const hubKey = `github.com/acme/unpub-${tag}`;
    const a = upload(hubKey);
    const b = upload(hubKey);
    expect((await run("unpublish", a)).code).toBe(0);
    expect(getRun(a)).toBeNull();
    expect(getRun(b)).not.toBeNull();
    expect((await run("unpublish", a)).code).toBe(2);
    expect((await run("unpublish")).code).toBe(3);

    const c = upload(hubKey);
    const out = await run("unpublish", "--machine", uploader.machine, "--project", hubProjectByKey(hubKey)!.id);
    expect(out.code).toBe(0);
    expect(getRun(b)).toBeNull();
    expect(getRun(c)).toBeNull();
  });

  test("`runs rm` is the same operation", async () => {
    const id = upload(`github.com/acme/rm-${tag}`);
    expect((await run("runs", "rm", id)).code).toBe(0);
    expect(getRun(id)).toBeNull();
  });

  test("with the hub running, the change goes through its API (its in-memory store would otherwise go stale) and no helper token is left", async () => {
    const hits: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: config.port,
      fetch: (req) => {
        hits.push(`${req.method} ${new URL(req.url).pathname} ${req.headers.get("authorization") ? "auth" : "anon"}`);
        return fetchHandler(req);
      },
    });
    try {
      const id = upload(`github.com/acme/live-${tag}`);
      const before = listTokens().length;
      const result = await run("unpublish", id);
      expect(result.code).toBe(0);
      expect(hits).toEqual(["POST /api/hub/v1/admin/unpublish auth"]);
      expect(getRun(id)).toBeNull();
      expect(listTokens().length).toBe(before);
    } finally {
      await server.stop(true);
    }
  });
});

describe("hub rekey", () => {
  test("re-keys one project or all of them and reports how many runs changed", async () => {
    const hubKey = `github.com/acme/rekey-${tag}`;
    upload(hubKey);
    const one = await run("rekey", "--project", hubProjectByKey(hubKey)!.id);
    expect(one.code).toBe(0);
    expect(one.out.join(" ")).toMatch(/re-keyed|unchanged/i);
    expect((await run("rekey")).code).toBe(0);
    expect((await run("rekey", "--project", "no-such-project")).code).toBe(2);
  });
});
