import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { flushRekeys, gcBlobs, hubEvents, ingestRun, missingBlobs, putBlob, runState, setRekeyDelay, unpublishRun, unpublishRuns, type Uploader } from "../src/hub/ingest";
import { hubDir } from "../src/hub/mode";
import { hubProjectByKey, hubProjectsView } from "../src/hub/projects";
import { contentHashOf, HUB_PROTOCOL, type RunUploadBodyT } from "../src/hub/protocol";
import { briefFingerprint } from "../src/regression/keys";
import { deleteRun, getRun, listRuns, readActivity, runDir } from "../src/runs/store";

const tag = `i${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const created: string[] = [];
let counter = 0;

const alice: Uploader = { machine: `${tag}-alice`, admin: false, identity: "ann@example.com" };
const bob: Uploader = { machine: `${tag}-bob`, admin: false, identity: null };
const root: Uploader = { machine: `${tag}-root`, admin: true, identity: null };

const sha = (bytes: Uint8Array): string => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const PNG = (seed: string): Uint8Array => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(seed)]);
const WEBP = (seed: string): Uint8Array => Buffer.concat([Buffer.from("RIFF"), Buffer.from([1, 0, 0, 0]), Buffer.from("WEBP"), Buffer.from(seed)]);
const TEXT = (s: string): Uint8Array => Buffer.from(s);

function blob(bytes: Uint8Array, type: "image/png" | "image/webp" | "text/markdown" | "application/x-ndjson") {
  putBlob(sha(bytes), type, bytes);
  return { sha256: sha(bytes), bytes: bytes.byteLength, type };
}

interface DocOptions {
  id?: string;
  hubKey?: string;
  localId?: string;
  title?: string;
  brief?: string;
  createdAt?: string;
  status?: string;
  checks?: Record<string, unknown>[];
  screenshots?: { path: string; ref: ReturnType<typeof blob> }[];
  run?: Record<string, unknown>;
  sentAt?: string;
}

const key = `github.com/acme/shop-${tag}`;

function doc(o: DocOptions = {}): { id: string; body: RunUploadBodyT } {
  const id = o.id ?? `20260101-0000${String(++counter).padStart(2, "0")}-${tag}-run${counter}`;
  created.push(id);
  const checks = o.checks ?? [{ id: "C1", title: "Checkout total updates", status: "pass", updatedAt: "2026-01-01T00:00:00.000Z", checkKey: "t:machine-local-1", keyKind: "title" }];
  return {
    id,
    body: {
      protocol: HUB_PROTOCOL,
      clientVersion: "0.1.0",
      sentAt: o.sentAt ?? new Date().toISOString(),
      project: { hubKey: o.hubKey ?? key, name: "Acme Shop", remoteUrl: "https://github.com/acme/shop", subpath: null, defaultBranch: "main", defaultPlatform: "android", localId: o.localId ?? "shop" },
      run: {
        id,
        projectId: o.localId ?? "shop",
        title: o.title ?? "Checkout flow",
        status: o.status ?? "done",
        createdAt: o.createdAt ?? "2026-01-01T00:00:00.000Z",
        checks,
        testKey: "brief:machine-local",
        brief: o.brief ?? "Walk through checkout",
        verdict: "PASS",
        deviceRequest: { platform: "android" },
        deviceName: "Pixel 8",
        storage: "repo",
        ...o.run,
      },
      batch: null,
      report: null,
      activity: null,
      screenshots: (o.screenshots ?? []).map((s) => ({ ...s.ref, path: s.path })),
      transcript: null,
      redaction: { replaced: {} },
    } as unknown as RunUploadBodyT,
  };
}

afterAll(() => {
  for (const id of created) deleteRun(id);
  const registry = path.join(hubDir(), "projects.json");
  if (fs.existsSync(registry)) {
    const entries = JSON.parse(fs.readFileSync(registry, "utf8")) as { hubKey: string }[];
    fs.writeFileSync(registry, JSON.stringify(entries.filter((e) => !e.hubKey.includes(tag))));
  }
});

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

describe("blobs", () => {
  test("a blob is stored once; check reports only what is missing", () => {
    const bytes = TEXT(`# report ${tag}`);
    expect(missingBlobs([sha(bytes)])).toEqual([sha(bytes)]);
    expect(putBlob(sha(bytes), "text/markdown", bytes)).toBe("created");
    expect(putBlob(sha(bytes), "text/markdown", bytes)).toBe("exists");
    expect(missingBlobs([sha(bytes), "0".repeat(64)])).toEqual(["0".repeat(64)]);
  });

  test("a blob that does not hash to its name, or is not what its type says, is refused", () => {
    const bytes = TEXT(`abc ${tag}`);
    expectHttp(() => putBlob("f".repeat(64), "text/markdown", bytes), 400);
    expectHttp(() => putBlob(sha(bytes), "image/png", bytes), 415);
    expectHttp(() => putBlob(sha(bytes), "application/zip", bytes), 415);
  });

  test("an unreferenced blob older than a week is collected, a referenced one is not", () => {
    const orphan = TEXT(`orphan ${tag}`);
    putBlob(sha(orphan), "text/markdown", orphan);
    const { id, body } = doc({ run: {} });
    const report = blob(TEXT(`kept report ${tag}`), "text/markdown");
    ingestRun(id, { ...body, report }, alice);
    const future = Date.now() + 8 * 24 * 3600 * 1000;
    gcBlobs(future);
    expect(missingBlobs([sha(orphan)])).toHaveLength(1);
    expect(missingBlobs([report.sha256])).toHaveLength(0);
  });
});

describe("ingest", () => {
  test("the same document twice makes one run and writes nothing the second time", () => {
    const { id, body } = doc();
    const first = ingestRun(id, body, alice);
    expect(first.result.status).toBe("created");
    const stored = fs.readFileSync(path.join(runDir(id), "run.json"), "utf8");
    const again = ingestRun(id, { ...body, sentAt: new Date(Date.now() + 1000).toISOString() }, alice);
    expect(again.result).toMatchObject({ status: "unchanged", contentHash: first.result.contentHash });
    expect(listRuns().filter((r) => r.id === id)).toHaveLength(1);
    expect(fs.readFileSync(path.join(runDir(id), "run.json"), "utf8")).toBe(stored);
    expect(runState(id)).toEqual({ contentHash: contentHashOf(body), machine: alice.machine });
  });

  test("a changed document updates the run and drops screenshots it no longer ships", () => {
    const one = blob(PNG(`one ${tag}`), "image/png");
    const two = blob(WEBP(`two ${tag}`), "image/webp");
    const { id, body } = doc({ screenshots: [{ path: "screenshots/a.png", ref: one }, { path: "screenshots/b.webp", ref: two }] });
    ingestRun(id, body, alice);
    expect(fs.readdirSync(path.join(runDir(id), "screenshots")).sort()).toEqual(["a.png", "b.webp"]);
    const next = { ...body, screenshots: body.screenshots.slice(0, 1), run: { ...body.run, title: "Checkout flow (retitled)" } } as RunUploadBodyT;
    expect(ingestRun(id, next, alice).result.status).toBe("updated");
    expect(fs.readdirSync(path.join(runDir(id), "screenshots"))).toEqual(["a.png"]);
    expect(getRun(id)?.title).toBe("Checkout flow (retitled)");
  });

  test("artefacts become normal files in the run dir, hard-linked to the blob, and the copy is a data run", () => {
    const shot = blob(PNG(`shot ${tag}`), "image/png");
    const report = blob(TEXT(`# Report ${tag}`), "text/markdown");
    const { id, body } = doc({ screenshots: [{ path: "screenshots/s1.png", ref: shot }], run: { reportPath: "qa/old.md" } });
    ingestRun(id, { ...body, report }, alice);
    const run = getRun(id)!;
    expect(run).toMatchObject({ storage: "data", reportPath: "report.md", deviceSerial: null, stats: null });
    expect(fs.readFileSync(path.join(runDir(id), "report.md"), "utf8")).toBe(`# Report ${tag}`);
    expect(fs.statSync(path.join(runDir(id), "screenshots", "s1.png")).ino).toBe(fs.statSync(path.join(hubDir(), "blobs", shot.sha256)).ino);
  });

  test("a run with an activity blob serves it through readActivity with the uploader's seq", () => {
    const lines = [{ ts: "2026-01-01T00:00:00.000Z", seq: 5, kind: "say", text: "hello" }, { ts: "2026-01-01T00:00:01.000Z", seq: 9, kind: "info", text: "done" }];
    const activity = blob(TEXT(`${lines.map((l) => JSON.stringify(l)).join("\n")}\n`), "application/x-ndjson");
    const { id, body } = doc();
    ingestRun(id, { ...body, activity }, alice);
    expect(readActivity(id, { limit: 10 }).items.map((a) => a.seq)).toEqual([5, 9]);
  });

  test("a document that names a blob nobody uploaded is refused with the missing digests", () => {
    const ghost = { sha256: "a".repeat(64), bytes: 10, type: "image/png" as const };
    const { id, body } = doc({ screenshots: [{ path: "screenshots/g.png", ref: ghost }] });
    try {
      ingestRun(id, body, alice);
      throw new Error("expected 422");
    } catch (e) {
      expect(e).toMatchObject({ status: 422, code: "missing_blobs", extra: { missing: ["a".repeat(64)] } });
    }
    expect(getRun(id)).toBeNull();
  });

  test("an active run is refused", () => {
    const { id, body } = doc({ status: "running" });
    expectHttp(() => ingestRun(id, body, alice), 422, "not_terminal");
    expect(getRun(id)).toBeNull();
  });

  test("the first machine owns a run id: another machine gets 409 and nothing is overwritten", () => {
    const { id, body } = doc();
    ingestRun(id, body, alice);
    const hijack = { ...body, run: { ...body.run, title: "Hijacked" } } as RunUploadBodyT;
    expectHttp(() => ingestRun(id, hijack, bob), 409, "id_conflict");
    expectHttp(() => ingestRun(id, hijack, root), 409, "id_conflict");
    expect(getRun(id)?.title).toBe("Checkout flow");
  });

  test("a protocol outside the hub's range is 426 and names the range", () => {
    const { id, body } = doc();
    try {
      ingestRun(id, { ...body, protocol: HUB_PROTOCOL + 1 }, alice);
      throw new Error("expected 426");
    } catch (e) {
      expect(e).toMatchObject({ status: 426, code: "protocol_unsupported", extra: { minProtocol: 1, protocol: HUB_PROTOCOL } });
    }
    expect(getRun(id)).toBeNull();
  });

  test("a screenshot whose file name does not match its type is refused (it would be served under that extension)", () => {
    const shot = blob(PNG(`evil ${tag}`), "image/png");
    const { id, body } = doc({ screenshots: [{ path: "screenshots/evil.html", ref: shot }] });
    expectHttp(() => ingestRun(id, body, alice), 400, "invalid_run");
    expect(getRun(id)).toBeNull();
  });

  test("a body whose run id differs from the URL is refused", () => {
    const { body } = doc();
    expectHttp(() => ingestRun("20260101-000000-someoneelse", body, alice), 400);
  });

  test("who sent it and when are recorded; a skewed clock is noted, a close one is not", () => {
    const skewed = doc({ sentAt: new Date(Date.now() - 3_600_000).toISOString() });
    const close = doc();
    ingestRun(skewed.id, skewed.body, alice);
    ingestRun(close.id, close.body, bob);
    expect(getRun(skewed.id)?.hub).toMatchObject({ machine: alice.machine, uploader: "ann@example.com", localProjectId: "shop" });
    expect(getRun(skewed.id)?.hub?.clockSkewMs).toBeLessThan(-3_000_000);
    expect(getRun(close.id)?.hub).toMatchObject({ machine: bob.machine, uploader: null, clockSkewMs: null });
  });

  test("the live feed hears about every stored run", () => {
    const heard: string[] = [];
    const listener = (run: { id: string }) => heard.push(run.id);
    hubEvents.on("run", listener);
    const { id, body } = doc();
    ingestRun(id, body, alice);
    hubEvents.off("run", listener);
    expect(heard).toContain(id);
  });
});

describe("projects", () => {
  test("two machines' local ids for one repo land in one hub project; runs take the hub id", () => {
    const hubKey = `github.com/acme/merge-${tag}`;
    const a = doc({ hubKey, localId: "app" });
    const b = doc({ hubKey, localId: "acme-app", createdAt: "2026-01-02T00:00:00.000Z" });
    ingestRun(a.id, a.body, alice);
    ingestRun(b.id, b.body, bob);
    const project = hubProjectByKey(hubKey)!;
    expect(getRun(a.id)?.projectId).toBe(project.id);
    expect(getRun(b.id)?.projectId).toBe(project.id);
    expect(getRun(b.id)?.hub?.localProjectId).toBe("acme-app");
    expect(project.id).toBe(`merge-${tag}`);
    const view = hubProjectsView().find((p) => p.id === project.id)!;
    expect(view.hub.runs).toBe(2);
    expect(view.hub.machines.map((m) => m.name).sort()).toEqual([alice.machine, bob.machine].sort());
    expect(view.hub.lastUploadBy?.machine).toBe(bob.machine);
  });

  test("a colliding last path segment widens the id, and an id never changes once assigned", () => {
    const one = doc({ hubKey: `github.com/one-${tag}/widget` });
    const two = doc({ hubKey: `github.com/two-${tag}/widget` });
    ingestRun(one.id, one.body, alice);
    ingestRun(two.id, two.body, alice);
    const a = hubProjectByKey(`github.com/one-${tag}/widget`)!;
    const b = hubProjectByKey(`github.com/two-${tag}/widget`)!;
    expect(a.id).not.toBe(b.id);
    const again = doc({ hubKey: `github.com/one-${tag}/widget` });
    ingestRun(again.id, again.body, bob);
    expect(hubProjectByKey(`github.com/one-${tag}/widget`)!.id).toBe(a.id);
  });
});

describe("keys on the hub", () => {
  test("the uploader's keys are kept as origin and the run is re-keyed in the hub's key space", () => {
    const { id, body } = doc();
    ingestRun(id, body, alice);
    const run = getRun(id)!;
    expect(run.hub?.keys.testKey).toBe("brief:machine-local");
    expect(run.hub?.keys.checks.C1).toEqual({ checkKey: "t:machine-local-1", keyKind: "title" });
    expect(run.testKey).not.toBe("brief:machine-local");
    expect(run.checks[0]?.checkKey).toBeTruthy();
    expect(run.checks[0]?.checkKey).not.toBe("t:machine-local-1");
  });

  test("the same check on two machines gets one hub key", () => {
    const hubKey = `github.com/acme/same-${tag}`;
    const a = doc({ hubKey, localId: "app", checks: [{ id: "C1", title: "Cart badge shows item count", status: "pass", updatedAt: "x", checkKey: "t:alice-key" }] });
    const b = doc({ hubKey, localId: "shop-app", createdAt: "2026-01-02T00:00:00.000Z", checks: [{ id: "C7", title: "Cart badge shows item count", status: "fail", updatedAt: "x", checkKey: "t:bob-key" }] });
    ingestRun(a.id, a.body, alice);
    ingestRun(b.id, b.body, bob);
    expect(getRun(b.id)?.checks[0]?.checkKey).toBe(getRun(a.id)?.checks[0]?.checkKey);
  });

  test("checks one machine linked by hand follow the earliest of them; its other checks are untouched", () => {
    const hubKey = `github.com/acme/manual-${tag}`;
    const link = { checkKey: "t:alice-linked", keyKind: "manual" };
    const a = doc({ hubKey, createdAt: "2026-01-01T00:00:00.000Z", checks: [{ id: "C1", title: "Pay with saved card", status: "pass", updatedAt: "x", ...link }] });
    const b = doc({ hubKey, createdAt: "2026-01-02T00:00:00.000Z", checks: [{ id: "C1", title: "Pay using a stored card", status: "pass", updatedAt: "x", ...link }, { id: "C2", title: "Receipt email is sent", status: "pass", updatedAt: "x", checkKey: "t:alice-other" }] });
    ingestRun(a.id, a.body, alice);
    ingestRun(b.id, b.body, alice);
    const first = getRun(a.id)!.checks[0]!;
    const second = getRun(b.id)!.checks;
    expect(first.keyKind).toBe("manual");
    expect(second[0]).toMatchObject({ checkKey: first.checkKey, keyKind: "manual" });
    expect(second[1]?.checkKey).not.toBe(first.checkKey);
  });

  test("an older run arriving after a newer one re-keys the project oldest-first", async () => {
    setRekeyDelay(60_000);
    const hubKey = `github.com/acme/order-${tag}`;
    const newer = doc({ hubKey, title: "Wishlist sharing", brief: "Share a wishlist by link (variant two)", createdAt: "2026-03-02T00:00:00.000Z" });
    const older = doc({ hubKey, title: "Wishlist sharing", brief: "Share a wishlist by link", createdAt: "2026-03-01T00:00:00.000Z" });
    ingestRun(newer.id, newer.body, alice);
    ingestRun(older.id, older.body, alice);
    // Arrival order made the newer run's brief the test's identity; creation order says it is the older one's.
    expect(getRun(older.id)?.testKey).toBe(`brief:${briefFingerprint(newer.body.run.brief as string)}`);
    await flushRekeys();
    const expected = `brief:${briefFingerprint(older.body.run.brief as string)}`;
    expect(getRun(older.id)?.testKey).toBe(expected);
    expect(getRun(newer.id)?.testKey).toBe(expected);
    setRekeyDelay(30_000);
  });

  test("a run that arrives in order is not re-keyed again", async () => {
    const hubKey = `github.com/acme/inorder-${tag}`;
    const first = doc({ hubKey, createdAt: "2026-03-01T00:00:00.000Z" });
    const second = doc({ hubKey, createdAt: "2026-03-02T00:00:00.000Z" });
    ingestRun(first.id, first.body, alice);
    ingestRun(second.id, second.body, alice);
    const before = fs.readFileSync(path.join(runDir(first.id), "run.json"), "utf8");
    await flushRekeys();
    expect(fs.readFileSync(path.join(runDir(first.id), "run.json"), "utf8")).toBe(before);
  });
});

describe("unpublish", () => {
  test("the owner removes a run; another machine cannot; an admin can", () => {
    const mine = doc();
    const theirs = doc();
    ingestRun(mine.id, mine.body, alice);
    ingestRun(theirs.id, theirs.body, alice);
    expectHttp(() => unpublishRun(mine.id, bob), 403, "not_owner");
    unpublishRun(mine.id, alice);
    expect(getRun(mine.id)).toBeNull();
    unpublishRun(theirs.id, root);
    expect(getRun(theirs.id)).toBeNull();
    expectHttp(() => unpublishRun(mine.id, alice), 404);
  });

  test("the admin CLI removes every run of one machine in one project and nothing else", () => {
    const hubKey = `github.com/acme/bulk-${tag}`;
    const a = doc({ hubKey });
    const b = doc({ hubKey });
    const c = doc({ hubKey });
    ingestRun(a.id, a.body, alice);
    ingestRun(b.id, b.body, bob);
    ingestRun(c.id, c.body, bob);
    const removed = unpublishRuns({ machine: bob.machine, projectId: hubProjectByKey(hubKey)!.id });
    expect(removed.sort()).toEqual([b.id, c.id].sort());
    expect(getRun(a.id)).not.toBeNull();
    expect(unpublishRuns({})).toEqual([]);
  });
});
