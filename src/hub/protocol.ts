// Wire protocol between a laptop's sync worker and a hub. Shared by client and hub; parsed once with zod on both sides.
import { createHash } from "node:crypto";
import { z } from "zod";

export const HUB_PROTOCOL = 1;

export const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
export const RunId = z.string().regex(/^[A-Za-z0-9-]{1,160}$/);
/** host[:port]/path, lowercased, plus "#subpath" for a project inside a monorepo. */
export const HubKey = z
  .string()
  .max(300)
  .regex(/^[a-z0-9.-]+(?::\d+)?\/[a-z0-9._~\/-]+(?:#[a-z0-9._~\/-]+)?$/);
export const BlobType = z.enum([
  "image/webp",
  "image/png",
  "image/jpeg",
  "image/gif",
  "text/markdown",
  "application/x-ndjson",
  "text/html",
]);
export const BlobRef = z.object({ sha256: Sha256, bytes: z.number().int().positive(), type: BlobType });

// GET /api/hub/v1/info (also the connectivity + auth probe: `machine` is null without a valid token)
export const HubInfo = z.object({
  protocol: z.number().int(),
  minProtocol: z.number().int(),
  version: z.string(),
  serverTime: z.string().datetime(),
  machine: z.string().nullable(),
  limits: z.object({ maxBlobBytes: z.number().int(), maxDocBytes: z.number().int(), maxScreenshots: z.number().int() }),
  /** The hub deletes finished runs older than this many days (by end time); null or absent keeps everything. */
  retentionDays: z.number().nullable().optional(),
});

// POST /api/hub/v1/blobs/check
export const BlobCheckBody = z.object({ sha256: z.array(Sha256).max(500) });
export const BlobCheckResult = z.object({ missing: z.array(Sha256) });

// PUT /api/hub/v1/blobs/:sha256: raw bytes, Content-Type from BlobType; text types may be sent with Content-Encoding: gzip.
// The hub hashes the (decoded) bytes, refuses a mismatch (400), checks image magic bytes, size <= maxBlobBytes.
// 201 created | 200 already present. Idempotent.

export const HubProjectMeta = z.object({
  hubKey: HubKey,
  name: z.string().min(1).max(60),
  remoteUrl: z.string().url().nullable(),
  subpath: z.string().max(200).nullable(),
  defaultBranch: z.string().max(200).nullable(), // explicit Project.defaultBranch, else the detected origin/HEAD
  defaultBranchSource: z.enum(["explicit", "detected"]).optional(), // which of the two `defaultBranch` is; absent = detected
  defaultPlatform: z.enum(["android", "ios"]),
  localId: z.string().max(40),
});

/** Run core the hub needs; additive fields from newer clients pass through and are stored verbatim. */
export const UploadedRun = z
  .object({
    id: RunId,
    projectId: z.string().max(40),
    title: z.string().max(500),
    status: z.enum(["done", "error", "cancelled", "interrupted"]), // terminal only; 422 otherwise
    createdAt: z.string().datetime(),
    checks: z
      .array(z.object({ id: z.string().max(64), title: z.string().max(2000), status: z.string() }).passthrough())
      .max(500),
    testKey: z.string().max(200).nullable(),
  })
  .passthrough();

// PUT /api/hub/v1/runs/:id (Content-Encoding: gzip; <= maxDocBytes after decoding)
export const RunUploadBody = z.object({
  protocol: z.number().int(),
  clientVersion: z.string().max(40),
  sentAt: z.string().datetime(), // clock-skew detection
  project: HubProjectMeta,
  run: UploadedRun,
  batch: z.object({ id: z.string(), title: z.string().max(500), createdAt: z.string().datetime() }).nullable(),
  report: BlobRef.nullable(),
  activity: BlobRef.nullable(),
  screenshots: z.array(BlobRef.extend({ path: z.string().regex(/^screenshots\/[A-Za-z0-9._-]{1,160}$/) })).max(500),
  transcript: BlobRef.nullable(),
  redaction: z.object({ replaced: z.record(z.string(), z.number().int()) }),
});
export const RunUploadResult = z.object({
  runId: RunId,
  status: z.enum(["created", "updated", "unchanged"]),
  contentHash: Sha256, // sha256 of the canonical upload document; "unchanged" when equal to the stored one
  url: z.string(), // hub run page, for the laptop's "uploaded" chip
});
// Errors: 401 bad/revoked token · 409 {code:"id_conflict"} (id owned by another machine) · 413 · 415 ·
// 422 {code:"missing_blobs", missing: Sha256[]} · 422 {code:"not_terminal"} · 426 {code:"protocol_unsupported", minProtocol, protocol}

// GET /api/hub/v1/runs/:id/state → { contentHash, machine } | 404 (backfill verification after a hub restore)
export const RunState = z.object({ contentHash: Sha256, machine: z.string() });
// DELETE /api/hub/v1/runs/:id → 204 (owning machine or admin token)

export type HubInfoT = z.infer<typeof HubInfo>;
export type BlobRefT = z.infer<typeof BlobRef>;
export type BlobTypeT = z.infer<typeof BlobType>;
export type HubProjectMetaT = z.infer<typeof HubProjectMeta>;
export type UploadedRunT = z.infer<typeof UploadedRun>;
export type RunUploadBodyT = z.infer<typeof RunUploadBody>;
export type RunUploadResultT = z.infer<typeof RunUploadResult>;
export type RunStateT = z.infer<typeof RunState>;

/** JSON with object keys sorted at every level, so equal documents serialise to equal bytes. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v ?? null)).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * sha256 of the canonical upload document, without `sentAt` and `clientVersion` (they change per attempt and say
 * nothing about the run). Laptop and hub both call this, so "unchanged" means the same thing on both sides.
 */
export function contentHashOf(body: RunUploadBodyT): string {
  const { sentAt: _sentAt, clientVersion: _clientVersion, ...rest } = body;
  return createHash("sha256").update(canonicalJson(rest)).digest("hex");
}

const startsWith = (bytes: Uint8Array, at: number, sig: number[]): boolean => sig.every((b, i) => bytes[at + i] === b);
const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

/** Whether `bytes` carry the signature of the declared blob type; types that are not images always pass. */
export function hasImageMagic(bytes: Uint8Array, type: BlobTypeT): boolean {
  switch (type) {
    case "image/png":
      return startsWith(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/jpeg":
      return startsWith(bytes, 0, [0xff, 0xd8, 0xff]);
    case "image/gif":
      return startsWith(bytes, 0, ascii("GIF87a")) || startsWith(bytes, 0, ascii("GIF89a"));
    case "image/webp":
      return startsWith(bytes, 0, ascii("RIFF")) && startsWith(bytes, 8, ascii("WEBP"));
    default:
      return true;
  }
}
