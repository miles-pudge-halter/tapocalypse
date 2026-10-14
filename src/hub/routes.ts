import { z } from "zod";
import pkg from "../../package.json";
import { HttpError } from "../config";
import { listRuns } from "../runs/store";
import { readCappedBody } from "./body";
import { ingestLiveRun, ingestRun, missingBlobs, putBlob, rekeyAll, rekeyProject, runState, unpublishRun, unpublishRuns, type Uploader } from "./ingest";
import { HUB_PROTOCOL_MIN, hubIdentityHeader, hubLimits } from "./mode";
import { BlobCheckBody, HUB_PROTOCOL, LIVE_MAX_BYTES, RunId, Sha256 } from "./protocol";
import { hubMachines, hubSummary } from "./status";
import { verifyToken } from "./tokens";

const MAX_SMALL_BODY_BYTES = 64 * 1024;
const IDENTITY_MAX = 200;
const AdminRekeyBody = z.object({ projectId: z.string().min(1).max(64).nullable() });
const AdminUnpublishBody = z.strictObject({ runId: z.string().max(200).optional(), projectId: z.string().max(64).optional(), machine: z.string().max(64).optional() });

/** `GET /api/health`: the boot gate of the UI and the container healthcheck. Both modes. */
export function healthView(mode: "local" | "hub"): { ok: true; mode: "local" | "hub"; version: string; runs: number } {
  return { ok: true, mode, version: pkg.version, runs: listRuns().length };
}

/** The proxy's identity header for this request, trimmed and bounded; null when none is configured or sent. Control characters are refused. */
export function requestIdentity(req: Request): string | null {
  const header = hubIdentityHeader();
  const value = header ? req.headers.get(header)?.trim() : undefined;
  if (!value || value.length > IDENTITY_MAX || /\p{Cc}/u.test(value)) return null;
  return value;
}

function bearer(req: Request): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
  return match?.[1] ?? null;
}

function authenticate(req: Request): Uploader | null {
  const token = bearer(req);
  const record = token ? verifyToken(token) : null;
  return record ? { machine: record.name, admin: record.admin, identity: requestIdentity(req) } : null;
}

function requireUploader(req: Request): Uploader {
  const uploader = authenticate(req);
  if (!uploader) throw new HttpError(401, "an active upload token is required (Authorization: Bearer tpu_…)", "unauthorized");
  return uploader;
}

/**
 * Writes one token may make per minute: a run document costs keying work, a blob costs disk. A backfill of a few hundred runs
 * fits; a leaked token cannot grind the hub. `live` is its own budget: a laptop sends progress at most every 3 s per run
 * (and a heartbeat a minute), which must neither starve nor be starved by finished-run uploads.
 */
const RATE_WINDOW_MS = 60_000;
const RATE_LIMITS = { run: 120, blob: 600, live: 240 } as const;
const rateWindows = new Map<string, { start: number; count: number }>();

/** A 429 once `uploader` has used up this minute's budget for `kind`, else null. Answered before any body is read. */
function overRate(uploader: Uploader, kind: keyof typeof RATE_LIMITS, now: number = Date.now()): Response | null {
  const key = `${kind}\0${uploader.machine}`;
  let window = rateWindows.get(key);
  if (!window || now - window.start >= RATE_WINDOW_MS) rateWindows.set(key, (window = { start: now, count: 0 }));
  if (++window.count <= RATE_LIMITS[kind]) return null;
  const retryAfter = Math.max(1, Math.ceil((window.start + RATE_WINDOW_MS - now) / 1000));
  return Response.json({ error: `too many uploads from this token; retry in ${retryAfter}s`, code: "rate_limited" }, { status: 429, headers: { "Retry-After": String(retryAfter) } });
}

const notAllowed = (allow: string): Response => Response.json({ error: "method not allowed" }, { status: 405, headers: { Allow: allow } });

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "the body is not valid JSON");
  }
}

async function smallJson(req: Request): Promise<unknown> {
  return safeJson(new TextDecoder().decode(await readCappedBody(req, { maxBytes: MAX_SMALL_BODY_BYTES, allowGzip: true })));
}

/** The JSON document of an upload: `application/json` (415 otherwise), optionally gzipped, at most `maxBytes` once decoded (413). */
async function jsonBody(req: Request, maxBytes: number): Promise<unknown> {
  if (!req.headers.get("content-type")?.startsWith("application/json")) throw new HttpError(415, "content-type must be application/json");
  return safeJson(new TextDecoder().decode(await readCappedBody(req, { maxBytes, allowGzip: true })));
}

/** `POST /api/hub/v1/admin/rekey|unpublish`: what the admin CLI asks of a running hub so its in-memory store never goes stale. */
async function adminRoute(req: Request, action: string): Promise<Response> {
  if (req.method !== "POST") return notAllowed("POST");
  if (!requireUploader(req).admin) throw new HttpError(403, "an admin token is required", "admin_required");
  const body = await smallJson(req);
  if (action === "rekey") {
    const parsed = AdminRekeyBody.safeParse(body);
    if (!parsed.success) throw new HttpError(400, "body must be { projectId: string | null }");
    return Response.json({ changed: parsed.data.projectId ? await rekeyProject(parsed.data.projectId) : await rekeyAll() });
  }
  if (action === "unpublish") {
    const parsed = AdminUnpublishBody.safeParse(body);
    if (!parsed.success) throw new HttpError(400, "body must select runs with runId, projectId and/or machine");
    return Response.json({ removed: unpublishRuns(parsed.data) });
  }
  throw new HttpError(404, "not found");
}

/** The versioned ingest API, `/api/hub/v1/*`. Reads need no token (viewers use `info` and `machines`); every write needs one. */
export async function hubV1Route(req: Request, parts: string[]): Promise<Response> {
  const [, , , resource, id, action] = parts;
  const method = req.method;

  if (resource === "info" && parts.length === 4) {
    if (method !== "GET") return notAllowed("GET");
    const { maxBlobBytes, maxDocBytes, maxScreenshots } = hubLimits();
    return Response.json({
      protocol: HUB_PROTOCOL,
      minProtocol: HUB_PROTOCOL_MIN,
      version: pkg.version,
      serverTime: new Date().toISOString(),
      machine: authenticate(req)?.machine ?? null,
      limits: { maxBlobBytes, maxDocBytes, maxScreenshots },
      ...hubSummary(),
    });
  }

  if (resource === "machines" && parts.length === 4) {
    if (method !== "GET") return notAllowed("GET");
    return Response.json({ machines: hubMachines() });
  }

  if (resource === "admin" && id && parts.length === 5) return adminRoute(req, id);

  if (resource === "blobs" && id === "check" && parts.length === 5) {
    if (method !== "POST") return notAllowed("POST");
    requireUploader(req);
    const body = BlobCheckBody.safeParse(await smallJson(req));
    if (!body.success) throw new HttpError(400, "body must be { sha256: string[] } of up to 500 hex digests");
    return Response.json({ missing: missingBlobs([...new Set(body.data.sha256)]) });
  }

  if (resource === "blobs" && id && parts.length === 5) {
    if (method !== "PUT") return notAllowed("PUT");
    const limited = overRate(requireUploader(req), "blob");
    if (limited) return limited;
    if (!Sha256.safeParse(id).success) throw new HttpError(400, "invalid blob digest");
    const bytes = await readCappedBody(req, { maxBytes: hubLimits().maxBlobBytes, allowGzip: true });
    const status = putBlob(id, req.headers.get("content-type"), bytes);
    return Response.json({ sha256: id, status }, { status: status === "created" ? 201 : 200 });
  }

  if (resource === "runs" && id && parts.length === 5) {
    if (!RunId.safeParse(id).success) throw new HttpError(400, "invalid run id");
    if (method === "PUT") {
      const uploader = requireUploader(req);
      const limited = overRate(uploader, "run");
      if (limited) return limited;
      const { result } = ingestRun(id, await jsonBody(req, hubLimits().maxDocBytes), uploader);
      return Response.json(result, { status: result.status === "created" ? 201 : 200 });
    }
    if (method === "DELETE") {
      unpublishRun(id, requireUploader(req));
      return new Response(null, { status: 204 });
    }
    return notAllowed("PUT, DELETE");
  }

  if (resource === "runs" && id && action === "live" && parts.length === 6) {
    if (method !== "PUT") return notAllowed("PUT");
    if (!RunId.safeParse(id).success) throw new HttpError(400, "invalid run id");
    const uploader = requireUploader(req);
    const limited = overRate(uploader, "live");
    if (limited) return limited;
    const { result } = ingestLiveRun(id, await jsonBody(req, LIVE_MAX_BYTES), uploader);
    return Response.json(result);
  }

  if (resource === "runs" && id && action === "state" && parts.length === 6) {
    if (method !== "GET") return notAllowed("GET");
    requireUploader(req);
    const state = runState(id);
    if (!state) throw new HttpError(404, `unknown run ${id}`);
    return Response.json(state);
  }

  throw new HttpError(404, "not found");
}
