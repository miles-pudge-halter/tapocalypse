import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { makeBatchId, pruneBatchMeta, saveBatchMeta } from "../src/batches";
import { packageRun } from "../src/hub/package";
import { hasImageMagic, RunUploadBody } from "../src/hub/protocol";
import type { Project } from "../src/projects/registry";
import { type GitRunner, setDefaultBranchDeps } from "../src/regression/baseline";
import { runArtefactDir } from "../src/runs/artefacts";
import { appendEvent, appendStderr, createRun, deleteRun, type NewRun, runDir, saveRun } from "../src/runs/store";
import type { Check, Run } from "../src/runs/types";

const HOME = os.homedir();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tpc-hub-package-"));
const created: string[] = [];
afterAll(() => {
  for (const id of created) deleteRun(id);
  fs.rmSync(tmp, { recursive: true, force: true });
});

const b64url = (s: string) => Buffer.from(s).toString("base64url");
const JWT = [b64url('{"alg":"HS256","typ":"JWT"}'), b64url('{"sub":"acme-test-user"}'), b64url("fake-signature")].join(".");

/** A real, decodable PNG: a w×h gradient. */
function png(w: number, h: number, seed = 0): Uint8Array<ArrayBuffer> {
  const rows = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rows.writeUIntBE(((x * 4 + seed) << 16) | ((y * 4) << 8) | ((x + y) & 255), y * (w * 3 + 1) + 1 + x * 3, 3);
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "latin1");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(Bun.hash.crc32(Buffer.concat([head.subarray(4), data])) >>> 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return new Uint8Array(Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]));
}

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function newRun(over: Partial<NewRun> = {}): Run {
  const run = createRun({
    projectId: "acme-app",
    title: "Checkout total updates",
    brief: "Check ACME-12 on the checkout screen",
    requestedBy: "web",
    deviceRequest: { platform: "android", serial: "emulator-5554" },
    deviceSerial: "emulator-5554",
    deviceName: "Pixel 8",
    deviceLabel: "Pixel_8_API_35",
    bootedByRun: false,
    packageId: "com.acme.shop",
    status: "done",
    verdict: "PASS",
    summary: "All good",
    reportPath: null,
    checks: [],
    error: null,
    startedAt: null,
    endedAt: null,
    stats: { sessionFile: `${HOME}/.omp/sessions/abc.jsonl`, tokens: 5 },
    transcriptHtml: false,
    storage: "data",
    testKey: "brief:abc",
    ...over,
  });
  created.push(run.id);
  return run;
}

const check = (id: string, extra: Partial<Check> = {}): Check => ({ id, title: `Check ${id}`, status: "pass", updatedAt: "2026-01-01T00:00:00.000Z", ...extra });

/** `remote get-url` / `rev-parse --show-prefix` / `worktree list` answers, for a repo at `repo`. */
const fakeGit =
  (repo: string, remote: string | null = "git@github.com:acme/shop.git", worktrees: string[] = []): GitRunner =>
  async (_cwd, args) => {
    if (args[0] === "remote") return remote;
    if (args.includes("--show-prefix")) return "";
    if (args.includes("--show-toplevel")) return repo;
    if (args[0] === "worktree") return [repo, ...worktrees].map((w) => `worktree ${w}\nHEAD abc\n`).join("\n");
    return null;
  };

function project(repo: string, over: Partial<Project> = {}): Project {
  return { id: "acme-app", name: "Acme Shop", repoPath: repo, personaFile: null, defaultPackage: "com.acme.shop", defaultPlatform: "android", defaultBranch: "main", ...over };
}

function dataRun(over: Partial<NewRun> = {}, repo = fs.mkdtempSync(path.join(tmp, "repo-"))): { run: Run; repo: string } {
  const run = newRun({ reportPath: "report.md", ...over });
  const dir = runArtefactDir(run.id);
  fs.mkdirSync(path.join(dir, "screenshots"), { recursive: true });
  return { run, repo };
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const allBlobText = (blobs: Map<string, { bytes: Uint8Array; type: string }>) => [...blobs.values()].filter((b) => !b.type.startsWith("image/")).map((b) => text(b.bytes)).join("\n");

describe("packageRun: the document", () => {
  test("a data-storage run becomes a valid upload with report, activity and WebP screenshots in the blob map", async () => {
    const { run, repo } = dataRun({ checks: [check("C1", { screenshot: "screenshots/01.png", note: "ok" })] });
    const dir = runArtefactDir(run.id);
    fs.writeFileSync(path.join(dir, "screenshots", "01.png"), png(64, 64));
    fs.writeFileSync(path.join(dir, "report.md"), "# Report\n\n![total](screenshots/01.png)\n\n[full size](screenshots/01.png)\n");
    appendEvent(run.id, { type: "_activity", kind: "say", text: "Opened the cart" });
    saveRun(run);

    const { doc, blobs, contentHash } = await packageRun(run, project(repo), { git: fakeGit(repo), now: () => Date.parse("2026-02-03T04:05:06.000Z"), clientVersion: "9.9.9" });

    expect(RunUploadBody.safeParse(doc).success).toBe(true);
    expect(doc).toMatchObject({ protocol: 1, clientVersion: "9.9.9", sentAt: "2026-02-03T04:05:06.000Z", batch: null, transcript: null });
    expect(doc.project).toEqual({
      hubKey: "github.com/acme/shop",
      name: "Acme Shop",
      remoteUrl: "https://github.com/acme/shop",
      subpath: null,
      defaultBranch: "main",
      defaultBranchSource: "explicit",
      defaultPlatform: "android",
      localId: "acme-app",
    });
    expect(doc.run).toMatchObject({ id: run.id, status: "done", storage: "data", reportPath: "report.md", testKey: "brief:abc" });
    expect(doc.run.checks[0]).toMatchObject({ id: "C1", screenshot: "screenshots/01.webp" });

    expect(doc.screenshots).toHaveLength(1);
    const shot = doc.screenshots[0]!;
    expect(shot).toMatchObject({ path: "screenshots/01.webp", type: "image/webp" });
    const blob = blobs.get(shot.sha256)!;
    expect(blob.type).toBe("image/webp");
    expect(hasImageMagic(blob.bytes, "image/webp")).toBe(true);
    expect([sha(blob.bytes), blob.bytes.length]).toEqual([shot.sha256, shot.bytes]);

    const report = blobs.get(doc.report!.sha256)!;
    expect(report.type).toBe("text/markdown");
    expect(text(report.bytes)).toBe("# Report\n\n![total](screenshots/01.webp)\n\n[full size](screenshots/01.webp)\n");

    const activity = blobs.get(doc.activity!.sha256)!;
    expect(activity.type).toBe("application/x-ndjson");
    const items = text(activity.bytes).trim().split("\n").map((l) => JSON.parse(l) as { seq: number; text: string });
    expect(items.map((i) => i.text)).toEqual(["Opened the cart"]);
    expect(items[0]!.seq).toBe(0);
    expect(contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('screenshots: "original" keeps the exact bytes and the extension', async () => {
    const { run, repo } = dataRun({ checks: [check("C1", { screenshot: "screenshots/01.png" })] });
    const original = png(32, 32, 7);
    fs.writeFileSync(path.join(runArtefactDir(run.id), "screenshots", "01.png"), original);
    fs.writeFileSync(path.join(runArtefactDir(run.id), "report.md"), "![x](screenshots/01.png)");
    const { doc, blobs } = await packageRun(run, project(repo), { git: fakeGit(repo), screenshots: "original" });
    expect(doc.screenshots[0]).toMatchObject({ path: "screenshots/01.png", type: "image/png", sha256: sha(original) });
    expect(blobs.get(sha(original))!.bytes).toEqual(original);
    expect(doc.run.checks[0]).toMatchObject({ screenshot: "screenshots/01.png" });
  });

  test("a legacy repo-storage run is normalised to the data layout: links, checks and report path are rewritten", async () => {
    const repo = fs.mkdtempSync(path.join(tmp, "repo-"));
    const run = newRun({ storage: "repo", reportPath: "qa/QA-REPORT-legacy.md", checks: [check("C1", { screenshot: "qa/screenshots/RUNID/01.png" }), check("C2", { screenshot: "qa/screenshots/RUNID/missing.png" })] });
    const folder = path.join(repo, "qa", "screenshots", run.id);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "01.png"), png(40, 40));
    fs.writeFileSync(path.join(folder, "02.png"), png(40, 40, 3));
    for (const c of run.checks) if (c.screenshot) c.screenshot = c.screenshot.replace("RUNID", run.id);
    saveRun(run);
    fs.writeFileSync(
      path.join(repo, "qa", "QA-REPORT-legacy.md"),
      `# Legacy\n\n![a](screenshots/${run.id}/01.png)\n<img src="screenshots/${run.id}/02.png" width="200">\n[doc](https://example.com/x.png)\n![gone](screenshots/${run.id}/nope.png)\n`,
    );

    const { doc, blobs } = await packageRun(run, project(repo, { reportsDir: "qa" }), { git: fakeGit(repo) });

    expect(doc.run).toMatchObject({ storage: "data", reportPath: "report.md" });
    expect(doc.screenshots.map((s) => s.path)).toEqual(["screenshots/01.webp", "screenshots/02.webp"]);
    expect(doc.run.checks.map((c) => c.screenshot)).toEqual(["screenshots/01.webp", undefined]);
    expect(text(blobs.get(doc.report!.sha256)!.bytes)).toBe(
      `# Legacy\n\n![a](screenshots/01.webp)\n<img src="screenshots/02.webp" width="200">\n[doc](https://example.com/x.png)\n![gone](screenshots/${run.id}/nope.png)\n`,
    );
  });

  test("two images with the same file name in different folders get distinct hub paths", async () => {
    const { run, repo } = dataRun();
    const dir = path.join(runArtefactDir(run.id), "screenshots");
    fs.mkdirSync(path.join(dir, "a"));
    fs.mkdirSync(path.join(dir, "b"));
    fs.writeFileSync(path.join(dir, "a", "shot.png"), png(24, 24, 1));
    fs.writeFileSync(path.join(dir, "b", "shot.png"), png(24, 24, 2));
    const { doc } = await packageRun(run, project(repo), { git: fakeGit(repo) });
    const paths = doc.screenshots.map((s) => s.path);
    expect(new Set(paths).size).toBe(2);
    expect(paths.every((p) => /^screenshots\/[A-Za-z0-9._-]+\.webp$/.test(p))).toBe(true);
  });

  test("a run without report or activity has neither blob", async () => {
    const { run, repo } = dataRun({ reportPath: null });
    const { doc, blobs } = await packageRun(run, project(repo), { git: fakeGit(repo) });
    expect([doc.report, doc.activity, doc.screenshots]).toEqual([null, null, []]);
    expect(doc.run.reportPath).toBeNull();
    expect(blobs.size).toBe(0);
  });

  test("transcripts are uploaded only on request, and redacted", async () => {
    const { run, repo } = dataRun({ transcriptHtml: true });
    fs.writeFileSync(path.join(runDir(run.id), "transcript.html"), `<p>Bearer ${JWT} at ${HOME}/x</p>`);
    const off = await packageRun(run, project(repo), { git: fakeGit(repo) });
    expect(off.doc.transcript).toBeNull();
    expect(off.doc.run).toMatchObject({ transcriptHtml: false });
    const on = await packageRun(run, project(repo), { git: fakeGit(repo), transcript: true });
    expect(on.doc.transcript).toMatchObject({ type: "text/html" });
    expect(on.doc.run).toMatchObject({ transcriptHtml: true });
    expect(text(on.blobs.get(on.doc.transcript!.sha256)!.bytes)).toBe("<p>«redacted:bearer» at ~/x</p>");
  });

  test("the batch the run belongs to travels along as metadata", async () => {
    const { run, repo } = dataRun();
    const batchId = makeBatchId();
    saveBatchMeta({ id: batchId, projectId: "acme-app", title: "Nightly sweep", createdAt: "2026-01-01T00:00:00.000Z" });
    run.batchId = batchId;
    const { doc } = await packageRun(run, project(repo), { git: fakeGit(repo) });
    expect(doc.batch).toEqual({ id: batchId, title: "Nightly sweep", createdAt: "2026-01-01T00:00:00.000Z" });
    pruneBatchMeta(batchId);
  });
});

describe("packageRun: what never leaves the machine", () => {
  test("paths, secrets and device identifiers are removed from the document, the report and the activity", async () => {
    const repo = fs.mkdtempSync(path.join(tmp, "repo-"));
    const { run } = dataRun({
      brief: `Test ${HOME}/Projects/acme-shop/lib and mail tester@acme.example (ACME-12)`,
      checks: [check("C1", { note: `token was Bearer ${JWT} in ${repo}/lib/a.dart` })],
      install: { path: `${HOME}/Downloads/app-release.apk` },
      source: {
        path: `${repo}/.worktrees/hotfix`,
        branch: "release/1.0",
        commit: null,
        commitSubject: null,
        dirty: false,
        remoteUrl: null,
        pr: null,
        prStatus: "none",
        tickets: ["ACME-12"],
        labels: {},
      },
    }, repo);
    fs.writeFileSync(path.join(runArtefactDir(run.id), "report.md"), `Saw ${HOME}/.tapocalypse and key sk-ant-api03-FAKEFAKEFAKEFAKEFAKE12`);
    appendEvent(run.id, { type: "_activity", kind: "info", text: `cwd ${repo}/.worktrees/hotfix` });
    appendEvent(run.id, { type: "_activity", kind: "say", text: `Authorization: Bearer ${JWT}` });
    saveRun(run);

    const { doc, blobs } = await packageRun(run, project(repo), { git: fakeGit(repo, "git@github.com:acme/shop.git", [`${repo}/.worktrees/hotfix`]) });
    const everything = JSON.stringify(doc) + allBlobText(blobs);

    for (const leak of [HOME + "/", repo, JWT, "sk-ant-api03", "emulator-5554", "Pixel_8_API_35", "sessionFile", "abc.jsonl"]) expect(everything).not.toContain(leak);
    expect(doc.run.brief).toBe("Test ~/Projects/acme-shop/lib and mail tester@acme.example (ACME-12)");
    expect(doc.run).toMatchObject({ stats: null, deviceSerial: null, deviceName: "Pixel 8", install: { path: "app-release.apk" } });
    expect("deviceLabel" in doc.run).toBe(false);
    expect(doc.run.deviceRequest).toEqual({ platform: "android" });
    expect(doc.run).toMatchObject({ source: { path: "<repo>" } });
    expect(doc.run.checks[0]!.note).toBe("token was «redacted:bearer» in <repo>/lib/a.dart");
    expect(doc.redaction.replaced).toEqual({ home: 2, repo: 3, bearer: 2, "sk-ant": 1 });
  });

  test("codex file_change paths (an array in the tool arguments, truncated at 2 KB mid-path) leave no temp or other-user path behind", async () => {
    const { run, repo } = dataRun({ harness: "codex" });
    const first = `/Users/bob/${"x".repeat(991)}`; // makes the 2048-character cut land inside the next path's temp dir
    const changes = [{ path: first, kind: "update" }, { path: "/var/folders/ab/cd12_efgh/T/w/a.dart", kind: "add" }];
    appendEvent(run.id, { type: "item.started", item: { type: "file_change", id: "fc1", changes, status: "in_progress" } });
    saveRun(run);
    const { blobs, doc } = await packageRun(run, project(repo), { git: fakeGit(repo) });
    const feed = text(blobs.get(doc.activity!.sha256)!.bytes);
    expect(feed).toContain('"tool":"edit"');
    for (const leak of ["/var/folders", "folders/ab", "/Users/bob", "bob"]) expect(feed).not.toContain(leak);
  });

  test("batch titles and the project name are redacted like every other string", async () => {
    const { run, repo } = dataRun();
    const batchId = makeBatchId();
    saveBatchMeta({ id: batchId, projectId: "acme-app", title: `Sweep from ${HOME}/Projects/x token=abc123def`, createdAt: "2026-01-01T00:00:00.000Z" });
    run.batchId = batchId;
    const { doc } = await packageRun(run, project(repo, { name: `Shop ${HOME}/p` }), { git: fakeGit(repo) });
    pruneBatchMeta(batchId);
    expect(doc.batch?.title).toBe("Sweep from ~/Projects/x token=«redacted:secret-assignment»");
    expect(doc.project.name).toBe("Shop ~/p");
  });

  test("a remote URL's query string and fragment never travel, in the project and in the run's source", async () => {
    const repo = fs.mkdtempSync(path.join(tmp, "repo-"));
    const { run } = dataRun({ source: { path: repo, branch: "main", commit: null, commitSubject: null, dirty: false, remoteUrl: "https://github.com/acme/shop?token=abc#frag", pr: null, prStatus: "none", tickets: [], labels: {} } }, repo);
    const { doc } = await packageRun(run, project(repo), { git: fakeGit(repo, "https://github.com/acme/shop?token=abc#frag") });
    expect(doc.project.remoteUrl).toBe("https://github.com/acme/shop");
    expect(doc.run).toMatchObject({ source: { remoteUrl: "https://github.com/acme/shop" } });
    expect(JSON.stringify(doc)).not.toContain("token=abc");
  });

  test("the project's default branch is marked explicit when the project sets it and detected otherwise", async () => {
    const { run, repo } = dataRun();
    const explicit = await packageRun(run, project(repo, { defaultBranch: "develop" }), { git: fakeGit(repo) });
    expect(explicit.doc.project).toMatchObject({ defaultBranch: "develop", defaultBranchSource: "explicit" });
    setDefaultBranchDeps({ git: async (_cwd, args) => (args[0] === "symbolic-ref" ? "origin/trunk" : null) });
    try {
      const detected = await packageRun(run, project(repo, { defaultBranch: undefined }), { git: fakeGit(repo) });
      expect(detected.doc.project).toMatchObject({ defaultBranch: "trunk", defaultBranchSource: "detected" });
    } finally {
      setDefaultBranchDeps();
    }
  });

  test("the raw event stream, stderr and the run's progress token are never part of an upload", async () => {
    const { run, repo } = dataRun();
    appendEvent(run.id, { type: "message_end", message: { content: [{ type: "image", data: "RAWIMAGEBYTES" }, { type: "text", text: "RAWSECRETTEXT" }] } });
    appendEvent(run.id, { type: "_activity", kind: "info", text: "visible" });
    appendStderr(run.id, "STDERRMARKER");
    fs.writeFileSync(path.join(runDir(run.id), "tpc-mcp.json"), '{"token":"PROGRESSTOKEN"}');
    fs.mkdirSync(path.join(runDir(run.id), "plugin", "tpc"), { recursive: true });
    fs.writeFileSync(path.join(runDir(run.id), "plugin", "tpc", ".mcp.json"), "PLUGINMARKER");
    const { doc, blobs } = await packageRun(run, project(repo), { git: fakeGit(repo) });
    const everything = JSON.stringify(doc) + allBlobText(blobs);
    for (const marker of ["RAWIMAGEBYTES", "RAWSECRETTEXT", "STDERRMARKER", "PROGRESSTOKEN", "PLUGINMARKER"]) expect(everything).not.toContain(marker);
    expect(everything).toContain("visible");
  });
});

describe("packageRun: identity of the content", () => {
  test("the content hash ignores the attempt (time, client version) and changes with the content", async () => {
    const { run, repo } = dataRun({ checks: [check("C1", { screenshot: "screenshots/01.png" })] });
    fs.writeFileSync(path.join(runArtefactDir(run.id), "screenshots", "01.png"), png(48, 48));
    fs.writeFileSync(path.join(runArtefactDir(run.id), "report.md"), "![a](screenshots/01.png)");
    appendEvent(run.id, { type: "_activity", kind: "say", text: "hello" });
    const first = await packageRun(run, project(repo), { git: fakeGit(repo), now: () => 1_000_000, clientVersion: "1.0.0" });
    const again = await packageRun(run, project(repo), { git: fakeGit(repo), now: () => 9_000_000, clientVersion: "2.0.0" });
    expect(again.contentHash).toBe(first.contentHash);
    expect(again.doc.screenshots).toEqual(first.doc.screenshots);

    const edited = structuredClone(run);
    edited.checks[0]!.checkKey = "k:renamed";
    edited.checks[0]!.keyKind = "manual";
    expect((await packageRun(edited, project(repo), { git: fakeGit(repo) })).contentHash).not.toBe(first.contentHash);
  });

  test("an unfinished run, or a project with no way to name it on the hub, is refused with a clear message", async () => {
    const { run, repo } = dataRun({ status: "running" });
    await expect(packageRun(run, project(repo), { git: fakeGit(repo) })).rejects.toThrow(/not finished/);
    const done = dataRun().run;
    await expect(packageRun(done, project(repo), { git: fakeGit(repo, null) })).rejects.toThrow(/hubKey/);
    const keyed = await packageRun(done, project(repo, { hubKey: "local/acme-app" }), { git: fakeGit(repo, null) });
    expect(keyed.doc.project).toMatchObject({ hubKey: "local/acme-app", remoteUrl: null });
  });
});
