// The laptop's team-hub routes (local mode only): connection settings, status, retry/backfill and "remove from hub".
import { z } from "zod";
import { HttpError, HubUrlSchema } from "../config";
import { getRun } from "../runs/store";
import {
  hubPaths,
  readSavedHubCredentials,
  removeHubCredentials,
  writeHubConfig,
  writeHubCredentials,
} from "./credentials";
import { activeHubConfig, HubCallError, hubStatus, hubSyncWorker, refreshHubConfig } from "./sync";

const ConnectionBody = z.strictObject({
  url: z.string().trim().pipe(HubUrlSchema),
  /** Write-only: replaces the saved token. */
  token: z.string().trim().min(1).optional(),
  /** Proxy headers: absent keeps the saved set, present replaces it; a null value keeps that name's saved value. */
  headers: z.record(z.string().min(1), z.string().nullable()).optional(),
  screenshots: z.enum(["webp", "original"]).optional(),
});

const PushBody = z.strictObject({
  runIds: z.array(z.string().min(1)).max(1000).optional(),
  projectId: z.string().min(1).optional(),
  failed: z.boolean().optional(),
  since: z.iso.datetime().optional(),
  all: z.boolean().optional(),
  /** Ask the hub which uploaded runs it still has and queue the ones it lost, before queueing the selection. */
  verify: z.boolean().optional(),
});

async function readBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  return parsed.data;
}

const json = (data: unknown, status = 200): Response => Response.json(data, { status });

/** A failed call to the hub as the HTTP error the UI shows. */
function bad(e: unknown): never {
  if (e instanceof HubCallError) throw new HttpError(502, e.message, e.code);
  throw e;
}

/** `PUT /api/hub/connection`: writes the url (config) and the secrets (credentials file), applies them, then tests the connection. */
async function saveConnection(req: Request): Promise<Response> {
  const body = parse(ConnectionBody, await readBody(req));
  if (body.token && process.env.TAPOCALYPSE_HUB_TOKEN) throw new HttpError(400, "the upload token is set by TAPOCALYPSE_HUB_TOKEN; remove the environment variable to manage it here");
  if (body.headers && process.env.TAPOCALYPSE_HUB_HEADERS) throw new HttpError(400, "the proxy headers are set by TAPOCALYPSE_HUB_HEADERS; remove the environment variable to manage them here");

  const previous = activeHubConfig();
  const url = body.url.replace(/\/+$/, "");
  // The saved token and proxy secrets belong to the hub they were entered for: a different origin gets none of them unless
  // the form sends new ones, so a changed address (a typo, a hijacked settings page) cannot carry them to another host.
  const originChanged = previous !== null && new URL(url).origin !== new URL(previous.url).origin;
  if (originChanged && !body.token) {
    const hint = process.env.TAPOCALYPSE_HUB_TOKEN ? "the saved token comes from TAPOCALYPSE_HUB_TOKEN, which this form cannot replace: point the environment variable at the new hub's token first, or use `tapocalypse hub login`" : "enter the upload token for the new hub";
    throw new HttpError(400, `a different hub address needs its own upload token: ${hint}`, "token_required_for_new_hub");
  }
  if (originChanged && body.headers && Object.values(body.headers).includes(null)) {
    throw new HttpError(400, "a different hub address cannot keep the saved proxy header values: enter them again", "token_required_for_new_hub");
  }

  const saved = readSavedHubCredentials();
  const token = body.token ?? saved?.token;
  let headers = originChanged ? undefined : saved?.headers;
  if (body.headers) {
    headers = {};
    for (const [name, value] of Object.entries(body.headers)) {
      const kept = value ?? saved?.headers?.[name];
      if (kept !== undefined) headers[name] = kept;
    }
  }
  if (token) writeHubCredentials({ token, headers }, {});
  else if (headers && Object.keys(headers).length > 0) throw new HttpError(400, "enter the upload token before saving proxy headers");

  const keptHeaders = originChanged ? undefined : previous?.headers;
  const hub = {
    url,
    ...((body.screenshots ?? previous?.screenshots) ? { screenshots: body.screenshots ?? previous?.screenshots } : {}),
    ...(keptHeaders ? { headers: keptHeaders } : {}),
    ...(previous?.live !== undefined ? { live: previous.live } : {}),
  };
  writeHubConfig(hubPaths.configFile, hub);
  refreshHubConfig();
  await hubSyncWorker().testConnection();
  return json(await hubStatus());
}

/** `DELETE /api/hub/connection`: forgets the url and the saved secrets. The outbox is kept; nothing uploads until a hub is set again. */
async function removeConnection(): Promise<Response> {
  writeHubConfig(hubPaths.configFile, null);
  removeHubCredentials();
  refreshHubConfig();
  return json(await hubStatus());
}

async function push(req: Request): Promise<Response> {
  const body = parse(PushBody, await readBody(req));
  if (!activeHubConfig()) throw new HttpError(409, "no team hub is configured: connect one in Setup first", "hub_not_configured");
  const { verify, ...selection } = body;
  const worker = hubSyncWorker();
  let verified: { checked: number; requeued: number } | undefined;
  if (verify) {
    try {
      verified = await worker.verify({ projectId: selection.projectId, since: selection.since });
    } catch (e) {
      bad(e);
    }
  }
  return json({ queued: (verified?.requeued ?? 0) + worker.push(selection), ...(verified ? { verified } : {}) });
}

/** `GET /api/hub/uploaded?project=<id>`: the runs of a project this machine has on the hub (by the outbox, so it works after sharing was turned off). */
function uploaded(url: URL): Response {
  const projectId = url.searchParams.get("project");
  if (!projectId) throw new HttpError(400, "project: required");
  return json({ runIds: hubSyncWorker().uploadedRunIds().filter((id) => getRun(id)?.projectId === projectId) });
}

async function unpublish(runId: string): Promise<Response> {
  const worker = hubSyncWorker();
  if (!getRun(runId) && !worker.uploadedRunIds().includes(runId)) throw new HttpError(404, `unknown run ${runId}`);
  if (!activeHubConfig()) throw new HttpError(409, "no team hub is configured", "hub_not_configured");
  try {
    await worker.unpublish(runId);
  } catch (e) {
    bad(e);
  }
  return new Response(null, { status: 204 });
}

/**
 * `GET /api/hub/status`, `PUT|DELETE /api/hub/connection`, `POST /api/hub/test`, `POST /api/hub/push`,
 * `GET /api/hub/uploaded?project=`, `POST /api/runs/:id/unpublish`. Null for every other request.
 */
export async function laptopHubRoute(req: Request, url: URL): Promise<Response | null> {
  const parts = url.pathname.split("/").filter(Boolean);
  const method = req.method;
  if (parts[0] !== "api") return null;
  if (parts[1] === "hub" && parts.length === 3) {
    if (parts[2] === "status" && method === "GET") return json(await hubStatus());
    if (parts[2] === "connection" && method === "PUT") return saveConnection(req);
    if (parts[2] === "connection" && method === "DELETE") return removeConnection();
    if (parts[2] === "test" && method === "POST") {
      await hubSyncWorker().testConnection();
      return json(await hubStatus());
    }
    if (parts[2] === "push" && method === "POST") return push(req);
    if (parts[2] === "uploaded" && method === "GET") return uploaded(url);
  }
  if (parts[1] === "runs" && parts.length === 4 && parts[3] === "unpublish" && method === "POST") return unpublish(parts[2]);
  return null;
}
