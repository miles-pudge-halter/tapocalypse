import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { flushRekeys, ingestRun, rekeyProject, setRekeyDelay, setRekeyYieldEvery, type Uploader, unpublishRun } from "../src/hub/ingest";
import { hubDir } from "../src/hub/mode";
import { hubProjectByKey, renameHubProject } from "../src/hub/projects";
import { contentHashOf, HUB_PROTOCOL, type RunUploadBodyT } from "../src/hub/protocol";
import { projectEvents } from "../src/projects/registry";
import { deleteRun, getRun } from "../src/runs/store";

const tag = `h${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const created: string[] = [];
let counter = 0;

const alice: Uploader = { machine: `${tag}-alice`, admin: false, identity: null };
const bob: Uploader = { machine: `${tag}-bob`, admin: false, identity: null };

interface DocOptions {
  id?: string;
  hubKey?: string;
  name?: string;
  defaultBranch?: string | null;
  defaultBranchSource?: "explicit" | "detected";
  title?: string;
  brief?: string;
  createdAt?: string;
  checks?: Record<string, unknown>[];
  run?: Record<string, unknown>;
}

function doc(o: DocOptions = {}): { id: string; body: RunUploadBodyT } {
  const id = o.id ?? `20260101-0000${String(++counter).padStart(2, "0")}-${tag}-hard${counter}`;
  created.push(id);
  const checks = o.checks ?? [{ id: "C1", title: "Checkout total updates", status: "pass", updatedAt: "2026-01-01T00:00:00.000Z" }];
  return {
    id,
    body: {
      protocol: HUB_PROTOCOL,
      clientVersion: "0.1.0",
      sentAt: new Date().toISOString(),
      project: {
        hubKey: o.hubKey ?? `github.com/acme/hard-${tag}`,
        name: o.name ?? "Acme Shop",
        remoteUrl: "https://github.com/acme/shop",
        subpath: null,
        defaultBranch: o.defaultBranch === undefined ? "main" : o.defaultBranch,
        ...(o.defaultBranchSource ? { defaultBranchSource: o.defaultBranchSource } : {}),
        defaultPlatform: "android",
        localId: "shop",
      },
      run: {
        id,
        projectId: "shop",
        title: o.title ?? "Checkout flow",
        status: "done",
        createdAt: o.createdAt ?? "2026-01-01T00:00:00.000Z",
        checks,
        testKey: "brief:machine-local",
        brief: o.brief ?? "Walk through checkout",
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

afterAll(() => {
  for (const id of created) deleteRun(id);
  const registry = path.join(hubDir(), "projects.json");
  if (fs.existsSync(registry)) {
    const entries = JSON.parse(fs.readFileSync(registry, "utf8")) as { hubKey: string }[];
    fs.writeFileSync(registry, JSON.stringify(entries.filter((e) => !e.hubKey.includes(tag))));
  }
});

/** Deterministic pseudo-text: many distinct words per title, so token sets differ and nothing short-circuits. */
function longTitle(n: number): string {
  let state = n * 2654435761 + 12345;
  const words: string[] = [];
  while (words.join(" ").length < 1900) {
    state = (state * 1103515245 + 12345) % 2147483648;
    words.push(`w${state.toString(36)}`);
  }
  return words.join(" ").slice(0, 1900);
}

describe("keying cost", () => {
  test("a document of 500 long titles is keyed in well under two seconds, even against an earlier run of the same brief, and so is a re-key", async () => {
    const hubKey = `github.com/acme/heavy-${tag}`;
    const checks = (shift: number) =>
      Array.from({ length: 500 }, (_, i) => ({ id: `C${i}`, title: longTitle(i + shift), status: "pass", updatedAt: "2026-01-01T00:00:00.000Z" }));
    const first = doc({ hubKey, createdAt: "2026-01-01T00:00:00.000Z", checks: checks(0) });
    const second = doc({ hubKey, createdAt: "2026-01-02T00:00:00.000Z", checks: checks(250) });
    const third = doc({ hubKey, createdAt: "2026-01-03T00:00:00.000Z", checks: checks(125) });
    ingestRun(first.id, first.body, alice);
    ingestRun(second.id, second.body, alice);
    const started = performance.now();
    ingestRun(third.id, third.body, alice);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(getRun(third.id)?.checks.every((c) => c.checkKey)).toBe(true);

    const rekeyStarted = performance.now();
    await rekeyProject(hubProjectByKey(hubKey)!.id);
    expect(performance.now() - rekeyStarted).toBeLessThan(2000);
  });
});

describe("re-key", () => {
  test("an upload that lands while a re-key is suspended is not overwritten by the re-key's stale copy", async () => {
    setRekeyDelay(60_000);
    setRekeyYieldEvery(1);
    try {
      const hubKey = `github.com/acme/mid-${tag}`;
      const newer = doc({ hubKey, title: "Wishlist sharing", brief: "Share a wishlist by link (variant two)", createdAt: "2026-03-02T00:00:00.000Z", run: { verdict: "PASS" } });
      const older = doc({ hubKey, title: "Wishlist sharing", brief: "Share a wishlist by link", createdAt: "2026-03-01T00:00:00.000Z" });
      const filler = doc({ hubKey, title: "Other flow", brief: "Browse the catalogue", createdAt: "2026-03-03T00:00:00.000Z" });
      for (const d of [newer, older, filler]) ingestRun(d.id, d.body, alice);
      const projectId = hubProjectByKey(hubKey)!.id;

      const pass = rekeyProject(projectId);
      // The pass is now suspended; the laptop re-sends the newer run with a failing verdict.
      const edited = { ...newer.body, run: { ...newer.body.run, verdict: "FAIL", summary: "edited after the fact" } } as RunUploadBodyT;
      expect(ingestRun(newer.id, edited, alice).result.status).toBe("updated");
      await pass;
      await flushRekeys();

      const stored = getRun(newer.id)!;
      expect(stored.summary).toBe("edited after the fact");
      expect(stored.verdict).toBe("FAIL");
      expect(stored.hub?.contentHash).toBe(contentHashOf(edited));
      // and the older run's identity still won, so the pass did its job for runs that did not change
      expect(getRun(newer.id)?.testKey).toBe(getRun(older.id)?.testKey);
    } finally {
      setRekeyYieldEvery(200);
      setRekeyDelay(30_000);
    }
  });
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

describe("project registry stability", () => {
  test("the first upload names the project; later uploads from any machine never rename it, an admin can", () => {
    const hubKey = `github.com/acme/named-${tag}`;
    const first = doc({ hubKey, name: "Acme Shop" });
    ingestRun(first.id, first.body, alice);
    const other = doc({ hubKey, name: "shop-android (Bob's checkout)", createdAt: "2026-02-01T00:00:00.000Z" });
    ingestRun(other.id, other.body, bob);
    const backfill = doc({ hubKey, name: "Something else", createdAt: "2025-12-01T00:00:00.000Z" });
    ingestRun(backfill.id, backfill.body, alice);
    expect(hubProjectByKey(hubKey)?.name).toBe("Acme Shop");
    renameHubProject(hubKey, "Acme Storefront");
    const last = doc({ hubKey, name: "Yet another", createdAt: "2026-03-01T00:00:00.000Z" });
    ingestRun(last.id, last.body, bob);
    expect(hubProjectByKey(hubKey)?.name).toBe("Acme Storefront");
  });

  test("an old run backfilled from another machine does not flip the default branch; the newest run's explicit choice wins", () => {
    const hubKey = `github.com/acme/branch-${tag}`;
    const a = doc({ hubKey, createdAt: "2026-02-10T00:00:00.000Z", defaultBranch: "develop", defaultBranchSource: "explicit" });
    ingestRun(a.id, a.body, alice);
    expect(hubProjectByKey(hubKey)?.defaultBranch).toBe("develop");

    const backfilled = doc({ hubKey, createdAt: "2025-06-01T00:00:00.000Z", defaultBranch: "master", defaultBranchSource: "explicit" });
    ingestRun(backfilled.id, backfilled.body, bob);
    expect(hubProjectByKey(hubKey)?.defaultBranch).toBe("develop");

    const detectedNewer = doc({ hubKey, createdAt: "2026-03-10T00:00:00.000Z", defaultBranch: "main", defaultBranchSource: "detected" });
    ingestRun(detectedNewer.id, detectedNewer.body, bob);
    expect(hubProjectByKey(hubKey)?.defaultBranch).toBe("develop");

    const explicitNewer = doc({ hubKey, createdAt: "2026-03-11T00:00:00.000Z", defaultBranch: "trunk", defaultBranchSource: "explicit" });
    ingestRun(explicitNewer.id, explicitNewer.body, bob);
    expect(hubProjectByKey(hubKey)?.defaultBranch).toBe("trunk");
  });

  test("a detected branch fills an empty default and is replaced by a newer detected one", () => {
    const hubKey = `github.com/acme/detected-${tag}`;
    const a = doc({ hubKey, createdAt: "2026-02-10T00:00:00.000Z", defaultBranch: null });
    ingestRun(a.id, a.body, alice);
    expect(hubProjectByKey(hubKey)?.defaultBranch).toBeNull();
    const b = doc({ hubKey, createdAt: "2026-02-11T00:00:00.000Z", defaultBranch: "main", defaultBranchSource: "detected" });
    ingestRun(b.id, b.body, alice);
    expect(hubProjectByKey(hubKey)?.defaultBranch).toBe("main");
    const c = doc({ hubKey, createdAt: "2026-02-12T00:00:00.000Z", defaultBranch: "master", defaultBranchSource: "detected" });
    ingestRun(c.id, c.body, bob);
    expect(hubProjectByKey(hubKey)?.defaultBranch).toBe("master");
  });

  test("an upload that fails validation creates and renames nothing", () => {
    const hubKey = `github.com/acme/invalid-${tag}`;
    const bad = doc({ hubKey, checks: [{ id: "C1", title: "Pays", status: "bogus", updatedAt: "x" }] });
    expectHttp(() => ingestRun(bad.id, bad.body, alice), 400);
    expect(hubProjectByKey(hubKey)).toBeUndefined();
    const good = doc({ hubKey, name: "Acme Shop" });
    ingestRun(good.id, good.body, alice);
    const worse = doc({ hubKey, name: "Renamed", checks: [{ id: "C1", title: "Pays", status: "bogus", updatedAt: "x" }] });
    const before = hubProjectByKey(hubKey)!;
    expectHttp(() => ingestRun(worse.id, worse.body, alice), 400);
    expect(hubProjectByKey(hubKey)).toEqual(before);
  });
});

describe("stored run documents", () => {
  test("only known fields are kept: unknown keys on the run, its checks and its source are dropped", () => {
    const hubKey = `github.com/acme/strip-${tag}`;
    const { id, body } = doc({
      hubKey,
      checks: [{ id: "C1", title: "Pays", status: "pass", updatedAt: "x", evil: "check-level" }],
      run: { mcpToken: "secret", status2: "x", source: { path: "/p", branch: "main", commit: "abc", pr: { number: 3, url: "https://github.com/acme/shop/pull/3", sneaky: 1 }, extra: 1 } },
    });
    ingestRun(id, body, alice);
    const stored = getRun(id) as unknown as Record<string, unknown>;
    expect(stored.mcpToken).toBeUndefined();
    expect(stored.status2).toBeUndefined();
    expect((getRun(id)?.checks[0] as unknown as Record<string, unknown>).evil).toBeUndefined();
    const source = getRun(id)?.source as unknown as Record<string, unknown>;
    expect(source.extra).toBeUndefined();
    expect(source.branch).toBe("main");
    expect((source.pr as Record<string, unknown>).sneaky).toBeUndefined();
    expect((source.pr as Record<string, unknown>).url).toBe("https://github.com/acme/shop/pull/3");
  });

  test("a pull request link that is not https is dropped", () => {
    const { id, body } = doc({ run: { source: { path: "/p", branch: "main", pr: { number: 3, url: "javascript:alert(1)" } } } });
    ingestRun(id, body, alice);
    expect(getRun(id)?.source?.pr).toMatchObject({ number: 3, url: null });
    const http = doc({ run: { source: { path: "/p", branch: "main", pr: { number: 4, url: "http://phish.example/x" } } } });
    ingestRun(http.id, http.body, alice);
    expect(getRun(http.id)?.source?.pr?.url).toBeNull();
  });

  test("a transcript is refused: the hub never serves uploaded HTML", () => {
    const { id, body } = doc();
    const bytes = Buffer.from("<p>hi</p>");
    const sha = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    const withTranscript = { ...body, transcript: { sha256: sha, bytes: bytes.byteLength, type: "text/html" } } as RunUploadBodyT;
    expectHttp(() => ingestRun(id, withTranscript, alice), 422, "transcript_not_accepted");
    expect(getRun(id)).toBeNull();
  });
});

describe("unpublishing", () => {
  test("open pages are told when a run leaves the hub, so project counts refresh", () => {
    const { id, body } = doc({ hubKey: `github.com/acme/gone-${tag}` });
    ingestRun(id, body, alice);
    let told = 0;
    const listener = () => told++;
    projectEvents.on("change", listener);
    unpublishRun(id, alice);
    projectEvents.off("change", listener);
    expect(told).toBeGreaterThan(0);
  });
});
