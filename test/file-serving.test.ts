import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fetchHandler } from "../src/api";
import { config } from "../src/config";
import { createProject, deleteProject, getProject } from "../src/projects/registry";
import { listReports, renderReport, reportFilePath } from "../src/reports/reports";
import { runDir } from "../src/runs/store";
import { cleanupRuns, makeRun, updateRun } from "./support/regression";

const HOST = `127.0.0.1:${config.port}`;
const SERVE = "fs-serve";
const ESCAPE = "fs-escape";

const bytes = (...head: number[]): Uint8Array => new Uint8Array([...head, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0);
const GIF = bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61);
const WEBP = new Uint8Array([...Buffer.from("RIFF"), 4, 0, 0, 0, ...Buffer.from("WEBP"), 1, 2, 3]);
/** A document that is a valid PNG header to a magic-byte sniffer and markup to a browser that is told it is HTML. */
const POLYGLOT = Buffer.concat([Buffer.from(PNG.subarray(0, 8)), Buffer.from("<script>alert(1)</script>")]);

let tmp: string;
let repo: string;
let escapeRepo: string;
let outside: string;

const get = (p: string): Promise<Response> => fetchHandler(new Request(`http://${HOST}${p}`, { headers: { host: HOST } }));

/** Every served artefact is inert whatever it contains: sandboxed, no sniffing, and a type picked by the server. */
function expectInert(res: Response, type: string): void {
  expect(res.headers.get("content-type")).toBe(type);
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  const csp = res.headers.get("content-security-policy") ?? "";
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("img-src 'self' data:");
  expect(csp).toContain("sandbox");
}

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tapocalypse-file-serving-")));
  repo = path.join(tmp, "repo");
  escapeRepo = path.join(tmp, "escape-repo");
  outside = path.join(tmp, "outside");
  fs.mkdirSync(path.join(repo, "qa", "screenshots"), { recursive: true });
  fs.mkdirSync(path.join(escapeRepo, ".keep"), { recursive: true });
  fs.mkdirSync(outside);
  for (const [name, content] of Object.entries({ "a.png": PNG, "b.jpg": JPEG, "c.gif": GIF, "d.webp": WEBP })) {
    fs.writeFileSync(path.join(repo, "qa", "screenshots", name), content);
  }
  fs.writeFileSync(path.join(repo, "qa", "notes.txt"), "plain notes");
  fs.writeFileSync(path.join(repo, "qa", "data.json"), '{"ok":true}');
  fs.writeFileSync(path.join(repo, "qa", "fake.png"), "<html><script>alert(1)</script></html>");
  fs.writeFileSync(path.join(repo, "qa", "page.html"), "<html><script>alert(1)</script></html>");
  fs.writeFileSync(path.join(repo, "qa", "poly.html"), POLYGLOT);
  fs.symlinkSync("page.html", path.join(repo, "qa", "shot.png"));
  fs.symlinkSync("poly.html", path.join(repo, "qa", "poly.png"));
  fs.symlinkSync("page.html", path.join(repo, "qa", "notes-link.txt"));
  fs.writeFileSync(path.join(outside, "leak.png"), PNG);
  fs.writeFileSync(path.join(outside, "leak.md"), "# Leaked report\n");
  fs.symlinkSync(outside, path.join(escapeRepo, "qa"));
  for (const [id, repoPath] of [[SERVE, repo], [ESCAPE, escapeRepo]] as const) {
    createProject({ id, name: id, repoPath, defaultPackage: "com.example.app", defaultPlatform: "android" });
  }
});

afterEach(() => cleanupRuns());

afterAll(() => {
  deleteProject(SERVE, []);
  deleteProject(ESCAPE, []);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("/files/<project>/<rel> (legacy repo reports folder)", () => {
  test("real images, text and json are served with a server-chosen type and the inert headers", async () => {
    for (const [file, type, content] of [
      ["screenshots/a.png", "image/png", PNG],
      ["screenshots/b.jpg", "image/jpeg", JPEG],
      ["screenshots/c.gif", "image/gif", GIF],
      ["screenshots/d.webp", "image/webp", WEBP],
    ] as const) {
      const res = await get(`/files/${SERVE}/${file}`);
      expect(res.status).toBe(200);
      expectInert(res, type);
      expect(Buffer.from(await res.arrayBuffer())).toEqual(Buffer.from(content));
    }
    expectInert(await get(`/files/${SERVE}/notes.txt`), "text/plain; charset=utf-8");
    expectInert(await get(`/files/${SERVE}/data.json`), "application/json");
  });

  test("an image name over a file that is no image is refused", async () => {
    expect((await get(`/files/${SERVE}/fake.png`)).status).toBe(404);
  });

  test("a symlink named like an image that points at HTML is not served", async () => {
    expect((await get(`/files/${SERVE}/shot.png`)).status).toBe(404);
    expect((await get(`/files/${SERVE}/notes-link.txt`)).status).toBe(404);
    expect(reportFilePath(getProject(SERVE)!, "shot.png")).toBeNull();
  });

  test("a symlink to HTML is not served even when its bytes start like a PNG", async () => {
    const res = await get(`/files/${SERVE}/poly.png`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).not.toContain("text/html");
  });

  test("a qa folder that is a symlink out of the repo serves, lists and renders nothing", async () => {
    const p = getProject(ESCAPE)!;
    expect((await get(`/files/${ESCAPE}/leak.png`)).status).toBe(404);
    expect(reportFilePath(p, "leak.png")).toBeNull();
    expect(listReports(p)).toEqual([]);
    expect(() => renderReport(p, "leak.md")).toThrow();
    expect(await (await get(`/api/projects/${ESCAPE}/reports`)).json()).toEqual([]);
    expect((await get(`/api/projects/${ESCAPE}/reports/leak.md`)).status).toBe(404);
  });
});

describe("/api/runs/:id/files/<rel>", () => {
  /** A finished run whose artefacts sit in the run folder: `screenshots/` plus whatever the test links in. */
  function dataRun(): { id: string; dir: string } {
    const run = makeRun({ testKey: "t:files", at: 1, projectId: SERVE });
    const dir = path.join(runDir(run.id), "screenshots");
    fs.mkdirSync(dir, { recursive: true });
    return { id: run.id, dir };
  }

  test("a data-run image is served with its type and the inert headers", async () => {
    const { id, dir } = dataRun();
    fs.writeFileSync(path.join(dir, "01.png"), PNG);
    fs.writeFileSync(path.join(dir, "02.webp"), WEBP);
    const png = await get(`/api/runs/${id}/files/screenshots/01.png`);
    expect(png.status).toBe(200);
    expectInert(png, "image/png");
    expect(Buffer.from(await png.arrayBuffer())).toEqual(Buffer.from(PNG));
    expectInert(await get(`/api/runs/${id}/files/screenshots/02.webp`), "image/webp");
  });

  test("a screenshot symlinked to HTML is not served, even with PNG magic bytes", async () => {
    const { id, dir } = dataRun();
    fs.writeFileSync(path.join(dir, "poly.html"), POLYGLOT);
    fs.symlinkSync("poly.html", path.join(dir, "shot.png"));
    const res = await get(`/api/runs/${id}/files/screenshots/shot.png`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).not.toContain("text/html");
  });

  test("a legacy repo run's image gets the same treatment; a symlinked qa folder yields nothing", async () => {
    const legacy = makeRun({ testKey: "t:legacy", at: 2, projectId: SERVE });
    updateRun(legacy, (r) => void (r.storage = "repo"));
    fs.mkdirSync(path.join(repo, "qa", "screenshots", legacy.id), { recursive: true });
    fs.writeFileSync(path.join(repo, "qa", "screenshots", legacy.id, "01.png"), PNG);
    expectInert(await get(`/api/runs/${legacy.id}/files/qa/screenshots/${legacy.id}/01.png`), "image/png");
    expect((await get(`/api/runs/${legacy.id}/files/qa/poly.png`)).status).toBe(404);

    const escaped = makeRun({ testKey: "t:escaped", at: 3, projectId: ESCAPE });
    updateRun(escaped, (r) => void (r.storage = "repo"));
    expect((await get(`/api/runs/${escaped.id}/files/qa/leak.png`)).status).toBe(404);
  });
});
