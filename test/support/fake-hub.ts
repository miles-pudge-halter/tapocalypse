// An in-process stand-in for a hub's ingest API (research §3.4), strict enough to catch a client that sends a malformed
// document: bodies are parsed with the real protocol schemas. Used by the laptop sync tests.
import { createHash } from "node:crypto";
import { BlobCheckBody, HUB_PROTOCOL, RunUploadBody, type RunUploadBodyT } from "../../src/hub/protocol";

export interface HubRequestLog {
  method: string;
  path: string;
  /** For run documents: the parsed body; for blobs: the sha. */
  detail?: string;
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export interface FakeHub {
  fetch(req: Request): Promise<Response>;
  log: HubRequestLog[];
  blobs: Map<string, { type: string; bytes: Uint8Array }>;
  runs: Map<string, { doc: RunUploadBodyT; hash: string; machine: string }>;
  /** Network failure for every request (throws like a refused connection). */
  down: boolean;
  /** Bearer token the hub accepts; null accepts none. */
  token: string | null;
  minProtocol: number;
  /** Run ids owned by another machine: PUT answers 409 id_conflict. */
  conflicts: Set<string>;
  /** Behave like an access proxy that wants a login: answer every request with an HTML login redirect. */
  proxyLogin: boolean;
  /** Answer the next PUT of a run with 422 missing_blobs for every blob of the document, once. */
  forgetBlobsOnce: boolean;
  /** `retentionDays` of GET /info: runs older than this are deleted by the hub; null keeps everything. */
  retentionDays: number | null;
  puts(): HubRequestLog[];
}

export function createFakeHub(token: string): FakeHub {
  const hub: FakeHub = {
    log: [],
    blobs: new Map(),
    runs: new Map(),
    down: false,
    token,
    minProtocol: 1,
    conflicts: new Set(),
    proxyLogin: false,
    forgetBlobsOnce: false,
    retentionDays: null,
    puts: () => hub.log.filter((l) => l.method === "PUT" && l.path.startsWith("/api/hub/v1/runs/")),
    async fetch(req: Request): Promise<Response> {
      if (hub.down) throw new TypeError("Unable to connect. Is the computer able to access the url?");
      const url = new URL(req.url);
      hub.log.push({ method: req.method, path: url.pathname });
      if (hub.proxyLogin) return new Response("<html>Sign in</html>", { status: 302, headers: { location: "https://login.example.com/", "content-type": "text/html" } });
      const authorised = hub.token !== null && req.headers.get("authorization") === `Bearer ${hub.token}`;
      if (url.pathname === "/api/hub/v1/info") {
        return json({
          protocol: HUB_PROTOCOL,
          minProtocol: hub.minProtocol,
          version: "9.9.9",
          serverTime: new Date().toISOString(),
          machine: authorised ? "ann-mbp" : null,
          limits: { maxBlobBytes: 16_000_000, maxDocBytes: 2_000_000, maxScreenshots: 500 },
          retentionDays: hub.retentionDays,
        });
      }
      if (!authorised) return json({ error: "unauthorized" }, 401);

      if (url.pathname === "/api/hub/v1/blobs/check" && req.method === "POST") {
        const body = BlobCheckBody.parse(await req.json());
        return json({ missing: body.sha256.filter((s) => !hub.blobs.has(s)) });
      }
      const blob = /^\/api\/hub\/v1\/blobs\/([0-9a-f]{64})$/.exec(url.pathname);
      if (blob && req.method === "PUT") {
        let bytes = new Uint8Array(await req.arrayBuffer());
        if (req.headers.get("content-encoding") === "gzip") bytes = Bun.gunzipSync(bytes);
        if (sha256(bytes) !== blob[1]) return json({ error: "hash mismatch" }, 400);
        const existed = hub.blobs.has(blob[1]);
        hub.blobs.set(blob[1], { type: req.headers.get("content-type") ?? "", bytes });
        hub.log[hub.log.length - 1].detail = blob[1];
        return new Response(null, { status: existed ? 200 : 201 });
      }
      const run = /^\/api\/hub\/v1\/runs\/([A-Za-z0-9-]+)(\/state)?$/.exec(url.pathname);
      if (run && req.method === "PUT") {
        if (req.headers.get("content-encoding") !== "gzip") return json({ error: "expected gzip" }, 415);
        const doc = RunUploadBody.parse(JSON.parse(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await req.arrayBuffer())))));
        hub.log[hub.log.length - 1].detail = doc.run.id;
        if (doc.protocol < hub.minProtocol) return json({ code: "protocol_unsupported", minProtocol: hub.minProtocol, protocol: doc.protocol }, 426);
        if (hub.conflicts.has(doc.run.id)) return json({ code: "id_conflict" }, 409);
        const refs = [doc.report, doc.activity, doc.transcript, ...doc.screenshots].filter((b) => b !== null);
        const missing = hub.forgetBlobsOnce ? refs.map((b) => b.sha256) : refs.filter((b) => !hub.blobs.has(b.sha256)).map((b) => b.sha256);
        if (hub.forgetBlobsOnce) {
          hub.forgetBlobsOnce = false;
          for (const b of refs) hub.blobs.delete(b.sha256);
          return json({ code: "missing_blobs", missing: refs.map((b) => b.sha256) }, 422);
        }
        if (missing.length > 0) return json({ code: "missing_blobs", missing }, 422);
        const hash = sha256(new TextEncoder().encode(JSON.stringify({ ...doc, sentAt: "", clientVersion: "" })));
        const before = hub.runs.get(doc.run.id);
        hub.runs.set(doc.run.id, { doc, hash, machine: "ann-mbp" });
        return json({ runId: doc.run.id, status: !before ? "created" : before.hash === hash ? "unchanged" : "updated", contentHash: hash, url: `/#/runs/${doc.run.id}` }, before ? 200 : 201);
      }
      if (run?.[2] && req.method === "GET") {
        const stored = hub.runs.get(run[1]);
        return stored ? json({ contentHash: stored.hash, machine: stored.machine }) : json({ error: "not found" }, 404);
      }
      if (run && req.method === "DELETE") {
        hub.runs.delete(run[1]);
        return new Response(null, { status: 204 });
      }
      return json({ error: "not found" }, 404);
    },
  };
  return hub;
}
