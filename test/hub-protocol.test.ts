import { describe, expect, test } from "bun:test";
import { BlobCheckBody, contentHashOf, HUB_PROTOCOL, hasImageMagic, HubKey, RunUploadBody, type RunUploadBodyT, UploadedRun } from "../src/hub/protocol";

const sha = "a".repeat(64);
const run = {
  id: "20260101-101010-ab12-checkout",
  projectId: "acme-app",
  title: "Checkout total updates",
  status: "done",
  createdAt: "2026-01-01T10:10:10.000Z",
  checks: [{ id: "c1", title: "Total shows 12.00", status: "pass", note: "ACME-12" }],
  testKey: null,
};
const body = {
  protocol: HUB_PROTOCOL,
  clientVersion: "0.1.0",
  sentAt: "2026-01-01T10:12:00.000Z",
  project: {
    hubKey: "github.com/acme/app",
    name: "Acme Shop",
    remoteUrl: "https://github.com/acme/app",
    subpath: null,
    defaultBranch: "main",
    defaultPlatform: "android",
    localId: "acme-app",
  },
  run,
  batch: null,
  report: { sha256: sha, bytes: 10, type: "text/markdown" },
  activity: null,
  screenshots: [{ sha256: sha, bytes: 10, type: "image/webp", path: "screenshots/01.webp" }],
  transcript: null,
  redaction: { replaced: { jwt: 2 } },
};

describe("hub protocol", () => {
  test("protocol version is 1", () => expect(HUB_PROTOCOL).toBe(1));

  test("HubKey accepts host/path with port and monorepo subpath, rejects the rest", () => {
    for (const ok of ["github.com/acme/app", "git.example.com:8443/team/sub/app", "github.com/acme/app#apps/mobile", "local/acme-app"]) {
      expect(HubKey.safeParse(ok).success).toBe(true);
    }
    for (const bad of ["GitHub.com/acme/app", "github.com", "https://github.com/acme/app", "github.com/acme app", "", `a.com/${"x".repeat(300)}`]) {
      expect(HubKey.safeParse(bad).success).toBe(false);
    }
  });

  test("UploadedRun is terminal-only and keeps fields from newer clients", () => {
    const parsed = UploadedRun.parse({ ...run, futureField: { a: 1 } });
    expect((parsed as Record<string, unknown>).futureField).toEqual({ a: 1 });
    for (const status of ["queued", "running", "starting"]) expect(UploadedRun.safeParse({ ...run, status }).success).toBe(false);
  });

  test("RunUploadBody parses a full document and rejects traversal in screenshot paths", () => {
    expect(RunUploadBody.safeParse(body).success).toBe(true);
    const evil = { ...body, screenshots: [{ sha256: sha, bytes: 10, type: "image/webp", path: "screenshots/../../etc/passwd" }] };
    expect(RunUploadBody.safeParse(evil).success).toBe(false);
    const nested = { ...body, screenshots: [{ sha256: sha, bytes: 10, type: "image/webp", path: "report.md" }] };
    expect(RunUploadBody.safeParse(nested).success).toBe(false);
  });

  test("blob check caps the batch at 500 hashes of 64 hex chars", () => {
    expect(BlobCheckBody.safeParse({ sha256: Array.from({ length: 500 }, () => sha) }).success).toBe(true);
    expect(BlobCheckBody.safeParse({ sha256: Array.from({ length: 501 }, () => sha) }).success).toBe(false);
    expect(BlobCheckBody.safeParse({ sha256: ["ABC"] }).success).toBe(false);
  });

  test("contentHashOf ignores sentAt, clientVersion and key order, and changes with any other content", () => {
    const parsed: RunUploadBodyT = RunUploadBody.parse(body);
    const base = contentHashOf(parsed);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(contentHashOf({ ...parsed, sentAt: "2027-01-01T00:00:00.000Z", clientVersion: "9.9.9" })).toBe(base);
    const reordered = RunUploadBody.parse({ ...body, run: { testKey: null, checks: run.checks, createdAt: run.createdAt, status: run.status, title: run.title, projectId: run.projectId, id: run.id } });
    expect(contentHashOf(reordered)).toBe(base);
    expect(contentHashOf({ ...parsed, run: { ...parsed.run, title: "Other" } })).not.toBe(base);
    expect(contentHashOf({ ...parsed, redaction: { replaced: { jwt: 3 } } })).not.toBe(base);
  });

  test("hasImageMagic matches the declared type's signature and only images", () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
    const gif = new TextEncoder().encode("GIF89a....");
    const webp = new TextEncoder().encode("RIFF\u0000\u0000\u0000\u0000WEBPVP8 ");
    expect(hasImageMagic(png, "image/png")).toBe(true);
    expect(hasImageMagic(jpeg, "image/jpeg")).toBe(true);
    expect(hasImageMagic(gif, "image/gif")).toBe(true);
    expect(hasImageMagic(webp, "image/webp")).toBe(true);
    expect(hasImageMagic(png, "image/webp")).toBe(false);
    expect(hasImageMagic(new TextEncoder().encode("<html>"), "image/png")).toBe(false);
    expect(hasImageMagic(new TextEncoder().encode("# report"), "text/markdown")).toBe(true);
  });
});
