import { EventEmitter } from "node:events";
import { closeSync, copyFileSync, existsSync, linkSync, mkdirSync, openSync, readdirSync, readSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { getBatchMeta, isBatchId, pruneBatchMeta, saveBatchMeta } from "../batches";
import { HttpError } from "../config";
import { HarnessIdSchema } from "../harness/types";
import { projectEvents } from "../projects/registry";
import { createKeyPass, keyLookup, keyRun } from "../regression/index";
import type { KeyLookup } from "../regression/keys";
import { deleteRun, getRun, listRuns, normalizeRun, runDir, saveRun } from "../runs/store";
import { ACTIVE, type Check, type CheckHints, type HubOrigin, type Run, VERDICTS } from "../runs/types";
import { HUB_PROTOCOL_MIN, hubDir, hubLimits } from "./mode";
import { touchHubProject } from "./projects";
import {
  type BlobRefT,
  type BlobTypeT,
  BlobType,
  contentHashOf,
  HUB_PROTOCOL,
  hasImageMagic,
  RunUploadBody,
  type RunUploadBodyT,
  type RunUploadResultT,
  Sha256,
} from "./protocol";

/** An HttpError whose JSON body carries more than `error` and `code` (missing blobs, protocol range). */
export class HubHttpError extends HttpError {
  constructor(status: number, message: string, code: string, readonly extra: Record<string, unknown> = {}) {
    super(status, message, code);
  }
}

/** Who is uploading: the token's name, whether it may touch other machines' runs, and the proxy identity if configured. */
export interface Uploader {
  machine: string;
  admin: boolean;
  identity: string | null;
}

/** `run`: a run was added or changed (the API forwards it to the live lists). A removal is announced on `projectEvents`. */
export const hubEvents = new EventEmitter();

const CLOCK_SKEW_NOTE_MS = 5 * 60 * 1000;
const BLOB_GC_MS = 7 * 24 * 3600 * 1000;
const TMP_GC_MS = 24 * 3600 * 1000;
let rekeyDelayMs = 30_000;

/** Test hook: the debounce between an out-of-order arrival and the project re-key. */
export function setRekeyDelay(ms: number): void {
  rekeyDelayMs = ms;
}

const blobsDir = () => path.join(hubDir(), "blobs");
const blobFile = (sha: string) => path.join(blobsDir(), sha);

// ---------------------------------------------------------------------------------------------------------------
// Blobs

export function missingBlobs(shas: readonly string[]): string[] {
  return shas.filter((sha) => !existsSync(blobFile(sha)));
}

const sha256Hex = (bytes: Uint8Array): string => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

/** Stores one content-addressed blob. `bytes` are already gunzipped. 201-style `created` or `exists`; idempotent. */
export function putBlob(sha: string, contentType: string | null, bytes: Uint8Array): "created" | "exists" {
  if (!Sha256.safeParse(sha).success) throw new HttpError(400, "invalid blob digest");
  const type = BlobType.safeParse(contentType?.split(";")[0]?.trim().toLowerCase());
  if (!type.success) throw new HttpError(415, `unsupported blob type; use one of ${BlobType.options.join(", ")}`);
  const { maxBlobBytes } = hubLimits();
  if (bytes.byteLength === 0) throw new HttpError(400, "empty blob");
  if (bytes.byteLength > maxBlobBytes) throw new HttpError(413, `blob exceeds ${maxBlobBytes} bytes`);
  if (sha256Hex(bytes) !== sha) throw new HttpError(400, "blob does not match its sha256");
  if (!hasImageMagic(bytes, type.data)) throw new HttpError(415, `blob is not a valid ${type.data}`);
  const target = blobFile(sha);
  if (existsSync(target)) return "exists";
  mkdirSync(blobsDir(), { recursive: true });
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, target);
  return "created";
}

function readHead(file: string): Uint8Array {
  const fd = openSync(file, "r");
  try {
    const head = new Uint8Array(16);
    return head.subarray(0, readSync(fd, head, 0, 16, 0));
  } finally {
    closeSync(fd);
  }
}

/** Removes blobs nothing links to (`nlink === 1`) older than 7 days, and abandoned half-written uploads. Returns how many went. */
export function gcBlobs(now: number = Date.now()): number {
  let removed = 0;
  let names: string[];
  try {
    names = readdirSync(blobsDir());
  } catch {
    return 0;
  }
  for (const name of names) {
    const file = path.join(blobsDir(), name);
    try {
      const st = statSync(file);
      const age = now - st.mtimeMs;
      const orphan = name.endsWith(".tmp") ? age > TMP_GC_MS : st.nlink === 1 && age > BLOB_GC_MS;
      if (orphan) {
        unlinkSync(file);
        removed++;
      }
    } catch {
      // vanished while scanning
    }
  }
  return removed;
}

// ---------------------------------------------------------------------------------------------------------------
// Run documents

const CheckStatusZ = z.enum(["pending", "running", "pass", "fail", "blocked", "skipped"]);
const KeyKindZ = z.enum(["suite", "lineage", "carried", "title", "inferred", "manual"]);
const text = (max: number) => z.string().max(max);
const nullableText = (max: number) => text(max).nullable().catch(null);

const HubCheck = z.object({
  id: text(64),
  title: text(2000),
  status: CheckStatusZ,
  note: text(20_000).optional().catch(undefined),
  screenshot: text(300).optional().catch(undefined),
  updatedAt: text(40).catch(""),
  startedAt: text(40).optional().catch(undefined),
  endedAt: text(40).optional().catch(undefined),
  checkKey: text(300).optional().catch(undefined),
  keyKind: KeyKindZ.optional().catch(undefined),
  was: text(64).optional().catch(undefined),
  });

const CheckHintsZ = z.object({
  fromRunIds: z.array(text(200)).max(20),
  checks: z.array(z.object({ id: text(64), title: text(400), checkKey: text(300) })).max(500),
  more: z.number().int().optional(),
});

/** An https link (a pull request page); anything else, a `javascript:` or plain-http URL included, is dropped. */
const httpsUrl = z
  .string()
  .max(1000)
  .refine((u) => {
    try {
      return new URL(u).protocol === "https:";
    } catch {
      return false;
    }
  })
  .nullable()
  .catch(null);

/**
 * The fields the hub keeps from an uploaded run: a whitelist, so a key a newer or hostile client adds never reaches the store.
 * A malformed optional field falls back to a default instead of refusing the upload.
 */
const RunFields = z
  .object({
    brief: text(200_000).catch(""),
    requestedBy: text(200).catch(""),
    deviceRequest: z.object({ platform: z.enum(["android", "ios"]) }).catch({ platform: "android" }),
    deviceName: nullableText(200),
    packageId: text(300).catch(""),
    verdict: z.enum(VERDICTS).nullable().catch(null),
    summary: nullableText(50_000),
    error: nullableText(50_000),
    startedAt: nullableText(40),
    endedAt: nullableText(40),
    source: z
      .object({
        path: text(1000).catch(""),
        branch: nullableText(300),
        commit: nullableText(80),
        commitSubject: nullableText(1000),
        dirty: z.boolean().nullable().catch(null),
        remoteUrl: nullableText(500),
        pr: z
          .object({
            number: z.number().int(),
            title: nullableText(500),
            url: httpsUrl,
            state: nullableText(40),
            baseBranch: nullableText(300),
            isDraft: z.boolean().nullable().catch(null),
            author: nullableText(200),
          })
          .nullable()
          .catch(null),
        prStatus: z.enum(["pending", "found", "none", "error", "provided"]).catch("none"),
        tickets: z.array(text(80)).max(100).catch([]),
        labels: z.record(z.string(), z.string()).catch({}),
      })
      .nullable()
      .catch(null),
    build: z
      .object({ packageId: text(300).catch(""), versionName: nullableText(100), versionCode: nullableText(100), capturedAt: text(40).catch("") })
      .nullable()
      .catch(null),
    batchId: nullableText(80),
    suiteId: nullableText(200),
    suiteChecks: z.array(z.object({ id: text(64), title: text(2000) })).max(500).nullable().catch(null),
    harness: HarnessIdSchema.catch("omp"),
    model: nullableText(200),
    thinking: nullableText(100),
    effort: nullableText(100),
    errorKind: z.enum(["infra", "agent", "timeout", "cancelled"]).nullable().catch(null),
    verdictSource: z.enum(["agent", "derived"]).nullable().catch(null),
    usage: z
      .object({
        cost: z.number().nullable().catch(null),
        tokensIn: z.number().catch(0),
        tokensOut: z.number().catch(0),
        cacheRead: z.number().catch(0),
        cacheWrite: z.number().catch(0),
        toolCalls: z.number().catch(0),
        model: nullableText(200),
      })
      .nullable()
      .catch(null),
    attempt: z.number().int().positive().catch(1),
    retryOf: nullableText(200),
    retriedBy: nullableText(200),
    rerunOf: nullableText(200),
    gated: z.boolean().catch(false),
    checkHints: CheckHintsZ.nullable().catch(null),
    reuseChecks: z.boolean().catch(true),
  });

const IMAGE_EXT: Record<string, string[]> = {
  "image/webp": [".webp"],
  "image/png": [".png"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/gif": [".gif"],
};

function linkOrCopy(source: string, target: string): void {
  rmSync(target, { force: true });
  try {
    linkSync(source, target);
  } catch {
    // another filesystem or one without hard links: copy (loses only the free dedupe)
    copyFileSync(source, target);
  }
}

/** Every blob the document references, deduped, with the artefact path it gets inside the run dir. */
function artefacts(body: RunUploadBodyT): { rel: string; ref: BlobRefT }[] {
  const out: { rel: string; ref: BlobRefT }[] = [];
  if (body.report) out.push({ rel: "report.md", ref: body.report });
  if (body.activity) out.push({ rel: "activity.jsonl", ref: body.activity });
  for (const shot of body.screenshots) out.push({ rel: shot.path, ref: shot });
  return out;
}

function validateArtefacts(body: RunUploadBodyT): void {
  const paths = new Set<string>();
  for (const { rel, ref } of artefacts(body)) {
    if (paths.has(rel)) throw new HttpError(400, `duplicate artefact path ${rel}`, "invalid_run");
    paths.add(rel);
    if (rel.startsWith("screenshots/")) {
      const exts = IMAGE_EXT[ref.type];
      if (!exts?.includes(path.extname(rel).toLowerCase())) throw new HttpError(400, `${rel} is not a ${ref.type} file name`, "invalid_run");
    }
  }
  const expected: Record<string, BlobTypeT> = { "report.md": "text/markdown", "activity.jsonl": "application/x-ndjson" };
  for (const { rel, ref } of artefacts(body)) {
    if (expected[rel] && expected[rel] !== ref.type) throw new HttpError(400, `${rel} must be ${expected[rel]}`, "invalid_run");
  }
}

/** Throws 422 `missing_blobs` for blobs not on disk, 400 for a blob whose size or magic bytes do not match what the document says. */
function verifyBlobs(body: RunUploadBodyT): void {
  const refs = artefacts(body).map((a) => a.ref);
  const missing = [...new Set(missingBlobs(refs.map((r) => r.sha256)))];
  if (missing.length > 0) throw new HubHttpError(422, `${missing.length} blob(s) not uploaded yet`, "missing_blobs", { missing });
  for (const ref of refs) {
    const file = blobFile(ref.sha256);
    if (statSync(file).size !== ref.bytes) throw new HttpError(400, `blob ${ref.sha256} has a different size than the document says`, "invalid_run");
    if (ref.type.startsWith("image/") && !hasImageMagic(readHead(file), ref.type)) throw new HttpError(400, `blob ${ref.sha256} is not a ${ref.type}`, "invalid_run");
  }
}

function writeArtefacts(id: string, body: RunUploadBodyT): void {
  const dir = runDir(id);
  mkdirSync(path.join(dir, "screenshots"), { recursive: true });
  const wanted = new Set<string>();
  for (const { rel, ref } of artefacts(body)) {
    wanted.add(rel);
    linkOrCopy(blobFile(ref.sha256), path.join(dir, rel));
  }
  for (const rel of ["report.md", "activity.jsonl", "transcript.html"]) if (!wanted.has(rel)) rmSync(path.join(dir, rel), { force: true });
  for (const name of readdirSync(path.join(dir, "screenshots"))) {
    if (!wanted.has(`screenshots/${name}`)) rmSync(path.join(dir, "screenshots", name), { recursive: true, force: true });
  }
}

type OriginKeys = HubOrigin["keys"];

function originKeysOf(checks: Check[], testKey: string | null, hints: CheckHints | null): OriginKeys {
  const keys: OriginKeys["checks"] = {};
  for (const c of checks) if (c.checkKey) keys[c.id] = { checkKey: c.checkKey, keyKind: c.keyKind ?? "title" };
  return { testKey, checks: keys, checkHints: hints };
}

interface RunDoc {
  fields: z.infer<typeof RunFields>;
  checks: Check[];
}

/** The whitelisted fields and checks of the uploaded run; 400 when they are malformed. Runs before anything is stored, the project registry included. */
function parseRunDoc(body: RunUploadBodyT): RunDoc {
  const parsed = RunFields.safeParse(body.run);
  if (!parsed.success) throw new HttpError(400, "the run document is malformed", "invalid_run");
  const checkList = z.array(HubCheck).safeParse(body.run.checks);
  if (!checkList.success) throw new HttpError(400, "a check in the run document is malformed", "invalid_run");
  return { fields: parsed.data, checks: checkList.data as unknown as Check[] };
}

function buildRun(body: RunUploadBodyT, doc: RunDoc, projectId: string, uploader: Uploader, contentHash: string, shots: Set<string>, now: Date): Run {
  const { fields, checks: uploadedChecks } = doc;
  const origin: HubOrigin = {
    machine: uploader.machine,
    uploader: uploader.identity,
    receivedAt: now.toISOString(),
    localProjectId: body.project.localId,
    clockSkewMs: skewOf(body.sentAt, now),
    contentHash,
    clientVersion: body.clientVersion,
    keys: originKeysOf(uploadedChecks, body.run.testKey, fields.checkHints),
  };
  const checks = uploadedChecks.map((c): Check => {
    const { checkKey: _k, keyKind: _kind, keyScore: _score, ...rest } = c as Check & { keyScore?: number };
    // A screenshot the document does not ship cannot be served, so the reference is dropped rather than left dangling.
    if (rest.screenshot !== undefined && !shots.has(rest.screenshot)) delete rest.screenshot;
    return rest;
  });
  const { deviceLabel: _label, ...rest } = fields as Record<string, unknown>;
  const batchMeta = body.batch && isBatchId(body.batch.id) ? getBatchMeta(body.batch.id) : null;
  const batchOk = body.batch !== null && isBatchId(body.batch.id) && (!batchMeta || batchMeta.projectId === projectId);
  return normalizeRun({
    ...rest,
    id: body.run.id,
    projectId,
    title: body.run.title,
    status: body.run.status,
    createdAt: body.run.createdAt,
    checks,
    testKey: null,
    checkHints: null,
    batchId: batchOk && body.batch ? body.batch.id : null,
    storage: "data",
    reportPath: body.report ? "report.md" : null,
    transcriptHtml: false,
    deviceSerial: null,
    deviceLabel: undefined,
    bootedByRun: false,
    stats: null,
    install: null,
    hub: origin,
  } as unknown as Run);
}

function skewOf(sentAt: string, now: Date): number | null {
  const skew = Date.parse(sentAt) - now.getTime();
  return Math.abs(skew) > CLOCK_SKEW_NOTE_MS ? skew : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Keys: the hub recomputes them over the merged history (research §5)

interface ManualMember {
  id: string;
  createdAt: string;
}
/** Runs of one machine that carry the same manual (linked) key from that machine's own key space, oldest first. */
type ManualGroups = Map<string, ManualMember[]>;

const groupKey = (machine: string, originKey: string): string => `${machine}\0${originKey}`;

function manualKeys(run: Run): { checkId: string; originKey: string }[] {
  const keys = run.hub?.keys.checks ?? {};
  return Object.entries(keys).flatMap(([checkId, k]) => (k.keyKind === "manual" ? [{ checkId, originKey: k.checkKey }] : []));
}

function buildManualGroups(runs: readonly Run[]): ManualGroups {
  const groups: ManualGroups = new Map();
  for (const run of runs) {
    if (!run.hub) continue;
    for (const { originKey } of manualKeys(run)) {
      if (originKey.startsWith("u:")) continue;
      const key = groupKey(run.hub.machine, originKey);
      const list = groups.get(key) ?? [];
      list.push({ id: run.id, createdAt: run.createdAt });
      groups.set(key, list);
    }
  }
  for (const list of groups.values()) list.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return groups;
}

function resetKeys(run: Run): void {
  run.testKey = null;
  for (const check of run.checks) {
    delete check.checkKey;
    delete check.keyKind;
    delete check.keyScore;
  }
}

/** The uploader's hints name its own keys; the hub's key of the same check is found through the (uploaded) runs the hints came from. */
function translateHints(run: Run, lookup: KeyLookup): CheckHints | null {
  const original = run.hub?.keys.checkHints;
  if (!original) return null;
  const fromRunIds: string[] = [];
  const checks: CheckHints["checks"] = [];
  for (const hint of original.checks) {
    for (const sourceId of original.fromRunIds) {
      const source = lookup.getRun(sourceId);
      if (source?.hub?.keys.checks[hint.id]?.checkKey !== hint.checkKey) continue;
      const hubKey = source.checks.find((c) => c.id === hint.id)?.checkKey;
      if (!hubKey) continue;
      checks.push({ id: hint.id, title: hint.title, checkKey: hubKey });
      if (!fromRunIds.includes(sourceId)) fromRunIds.push(sourceId);
      break;
    }
  }
  return checks.length > 0 ? { fromRunIds, checks, ...(original.more === undefined ? {} : { more: original.more }) } : null;
}

/**
 * Gives a hub copy its hub-side identity: the uploader's keys are set aside (`hub.keys`), carried hints are translated, and
 * checks the uploader linked by hand follow the earliest check of that link on the same machine. Everything else goes through
 * the same `keyRun` laptops use, against the hub's merged history, so title keys are salted with the hub project id.
 */
function keyHubRun(run: Run, groups: ManualGroups, lookup: KeyLookup = keyLookup): void {
  resetKeys(run);
  run.checkHints = translateHints(run, lookup);
  const used = new Set<string>();
  const unpinned: string[] = [];
  for (const { checkId, originKey } of manualKeys(run)) {
    const check = run.checks.find((c) => c.id === checkId);
    if (!check || !run.hub) continue;
    if (originKey.startsWith("u:")) {
      if (used.has(originKey)) continue;
      check.checkKey = originKey;
      check.keyKind = "manual";
      used.add(originKey);
      continue;
    }
    const members = (groups.get(groupKey(run.hub.machine, originKey)) ?? []).filter((m) => m.id !== run.id);
    const earlier = members.find((m) => m.createdAt < run.createdAt || (m.createdAt === run.createdAt && m.id < run.id));
    const source = earlier ? lookup.getRun(earlier.id) : null;
    const sourceCheckId = source ? manualKeys(source).find((k) => k.originKey === originKey)?.checkId : undefined;
    const hubKey = source?.checks.find((c) => c.id === sourceCheckId)?.checkKey;
    if (hubKey && !used.has(hubKey)) {
      check.checkKey = hubKey;
      check.keyKind = "manual";
      used.add(hubKey);
    } else unpinned.push(checkId);
  }
  keyRun(run, lookup);
  for (const id of unpinned) {
    const check = run.checks.find((c) => c.id === id);
    if (check?.checkKey) check.keyKind = "manual";
  }
}

const keysSignature = (run: Run): string => JSON.stringify([run.testKey, run.checks.map((c) => [c.id, c.checkKey, c.keyKind]), run.checkHints]);

const rekeyTimers = new Map<string, NodeJS.Timeout>();
/** The last re-key queued per project: passes of one project run one after the other, never interleaved. */
const rekeyChains = new Map<string, Promise<number>>();

/** Re-keys the project on a debounce: a backfill that delivers 500 older runs causes one pass. */
export function scheduleRekey(projectId: string): void {
  clearTimeout(rekeyTimers.get(projectId));
  const timer = setTimeout(() => {
    rekeyTimers.delete(projectId);
    void rekeyProject(projectId).catch((e: unknown) => console.error(`hub re-key of ${projectId} failed:`, e));
  }, rekeyDelayMs);
  timer.unref();
  rekeyTimers.set(projectId, timer);
}

/** Runs every pending re-key now. */
export async function flushRekeys(): Promise<void> {
  const pending = [...rekeyTimers.keys()];
  for (const id of pending) clearTimeout(rekeyTimers.get(id));
  rekeyTimers.clear();
  for (const id of pending) await rekeyProject(id);
}

let yieldEvery = 200;

/** Test hook: how many runs a re-key handles between yields to the event loop. */
export function setRekeyYieldEvery(n: number): void {
  yieldEvery = n;
}

/** Copies the fields `keyHubRun` assigns from a re-keyed working copy onto the stored run. */
function applyKeys(target: Run, from: Run): void {
  target.testKey = from.testKey;
  target.checkHints = from.checkHints;
  // Same content hash, so the same checks in the same order.
  target.checks.forEach((check, i) => {
    const source = from.checks[i];
    delete check.checkKey;
    delete check.keyKind;
    delete check.keyScore;
    if (source?.checkKey) check.checkKey = source.checkKey;
    if (source?.keyKind) check.keyKind = source.keyKind;
    if (source?.keyScore !== undefined) check.keyScore = source.keyScore;
  });
}

async function rekeyPass(projectId: string): Promise<number> {
  const runs = listRuns({ projectId })
    .filter((r) => r.hub)
    .reverse()
    .map((r) => structuredClone(r));
  const before = new Map(runs.map((r) => [r.id, keysSignature(r)]));
  const hashes = new Map(runs.map((r) => [r.id, r.hub?.contentHash]));
  const groups = buildManualGroups(runs);
  for (const run of runs) {
    resetKeys(run);
    run.checkHints = null;
  }
  // Keyed in memory against only what this pass has assigned so far: nothing half-cleared is ever stored or read.
  const pass = createKeyPass(new Map(runs.map((r) => [r.id, r])));
  let n = 0;
  for (const run of runs) {
    keyHubRun(run, groups, pass.lookup);
    pass.add(run);
    if (++n % yieldEvery === 0) await Bun.sleep(0);
  }
  let changed = 0;
  let stale = false;
  n = 0;
  for (const run of runs) {
    if (keysSignature(run) === before.get(run.id)) continue;
    // Re-read: an upload may have replaced this run while the pass was suspended; its newer document wins.
    const fresh = getRun(run.id);
    if (!fresh?.hub) continue;
    if (fresh.hub.contentHash !== hashes.get(run.id)) {
      stale = true;
      continue;
    }
    applyKeys(fresh, run);
    saveRun(fresh);
    changed++;
    if (++n % yieldEvery === 0) await Bun.sleep(0);
  }
  if (stale) scheduleRekey(projectId);
  return changed;
}

/**
 * Recomputes every key of the project's uploaded runs, oldest first, so the earliest-run rules (same brief, same title) see
 * only what this pass assigns. Passes of a project are serialised; only runs whose keys changed are written, and a run an
 * upload replaced in the meantime is left to that upload (and a follow-up pass). Returns how many runs changed.
 */
export function rekeyProject(projectId: string): Promise<number> {
  const previous = rekeyChains.get(projectId) ?? Promise.resolve(0);
  const next = previous.catch(() => 0).then(() => rekeyPass(projectId));
  rekeyChains.set(projectId, next);
  const settle = (): void => {
    if (rekeyChains.get(projectId) === next) rekeyChains.delete(projectId);
  };
  next.then(settle, settle);
  return next;
}

export async function rekeyAll(): Promise<number> {
  const projects = new Set(listRuns().flatMap((r) => (r.hub ? [r.projectId] : [])));
  let changed = 0;
  for (const id of projects) changed += await rekeyProject(id);
  return changed;
}

// ---------------------------------------------------------------------------------------------------------------
// Ingest

/**
 * Stores one uploaded run. Protocol and shape are checked first, then ownership of the id, then that every referenced blob
 * is present; only then is anything written. The same document twice is `unchanged` and writes nothing.
 */
export function ingestRun(id: string, raw: unknown, uploader: Uploader, now: Date = new Date()): { result: RunUploadResultT; run: Run } {
  const head = (typeof raw === "object" && raw !== null ? raw : {}) as { protocol?: unknown; run?: { status?: unknown } };
  if (typeof head.protocol !== "number" || head.protocol < HUB_PROTOCOL_MIN || head.protocol > HUB_PROTOCOL) {
    throw new HubHttpError(426, `protocol ${String(head.protocol)} is not supported; this hub speaks ${HUB_PROTOCOL_MIN}-${HUB_PROTOCOL}`, "protocol_unsupported", {
      minProtocol: HUB_PROTOCOL_MIN,
      protocol: HUB_PROTOCOL,
    });
  }
  if (typeof head.run?.status === "string" && ACTIVE.includes(head.run.status as Run["status"])) {
    throw new HttpError(422, "only finished runs can be uploaded", "not_terminal");
  }
  const parsed = RunUploadBody.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, `invalid run upload: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, "invalid_run");
  const body = parsed.data;
  if (body.run.id !== id) throw new HttpError(400, "the run id in the body does not match the URL", "invalid_run");
  if (body.screenshots.length > hubLimits().maxScreenshots) throw new HttpError(413, "too many screenshots");
  // Active HTML must never be served from the hub's own origin; the shipped client does not send transcripts.
  if (body.transcript !== null) throw new HttpError(422, "the hub does not accept transcripts", "transcript_not_accepted");

  const existing = getRun(id);
  if (existing && existing.hub?.machine !== uploader.machine) {
    throw new HubHttpError(409, `run ${id} already exists and was uploaded by another machine`, "id_conflict");
  }
  validateArtefacts(body);
  verifyBlobs(body);
  const doc = parseRunDoc(body);

  const contentHash = contentHashOf(body);
  const url = `/#/runs/${encodeURIComponent(id)}`;
  if (existing?.hub?.contentHash === contentHash) return { result: { runId: id, status: "unchanged", contentHash, url }, run: existing };

  const project = touchHubProject(body.project, { machine: uploader.machine, uploader: uploader.identity }, body.run.createdAt, now);
  const shots = new Set(body.screenshots.map((s) => s.path));
  const run = buildRun(body, doc, project.id, uploader, contentHash, shots, now);
  if (body.batch && run.batchId && !getBatchMeta(run.batchId)) {
    saveBatchMeta({ id: body.batch.id, projectId: project.id, title: body.batch.title, createdAt: body.batch.createdAt });
  }
  const others = listRuns({ projectId: project.id }).filter((r) => r.id !== id);
  const newest = others[0]?.createdAt ?? "";
  writeArtefacts(id, body);
  keyHubRun(run, buildManualGroups([...others, run]));
  saveRun(run);
  // An older run arriving after newer ones changes what "earliest with this brief/title" means; a re-upload may change manual links.
  const keysMoved = existing !== null && JSON.stringify(existing.hub?.keys) !== JSON.stringify(run.hub?.keys);
  if (run.createdAt < newest || keysMoved) scheduleRekey(project.id);
  hubEvents.emit("run", run);
  return { result: { runId: id, status: existing ? "updated" : "created", contentHash, url }, run };
}

export function runState(id: string): { contentHash: string; machine: string } | null {
  const run = getRun(id);
  return run?.hub ? { contentHash: run.hub.contentHash, machine: run.hub.machine } : null;
}

/** Deletes a run the caller owns (any run for an admin token). 404 for an unknown run, 403 for someone else's. */
export function unpublishRun(id: string, uploader: Uploader): void {
  const run = getRun(id);
  if (!run?.hub) throw new HttpError(404, `unknown run ${id}`);
  if (run.hub.machine !== uploader.machine && !uploader.admin) throw new HttpError(403, "this run was uploaded by another machine", "not_owner");
  removeRun(run);
}

function removeRun(run: Run): void {
  deleteRun(run.id);
  if (run.batchId) pruneBatchMeta(run.batchId);
  // Run counts live on the project cards; the live lists refetch on this.
  projectEvents.emit("change");
}

/** Admin: removes uploaded runs by id, project or machine. Returns the removed ids. */
export function unpublishRuns(filter: { runId?: string; projectId?: string; machine?: string }): string[] {
  const targets = listRuns().filter(
    (r) => r.hub && (filter.runId === undefined || r.id === filter.runId) && (filter.projectId === undefined || r.projectId === filter.projectId) && (filter.machine === undefined || r.hub.machine === filter.machine),
  );
  if (filter.runId === undefined && filter.projectId === undefined && filter.machine === undefined) return [];
  for (const run of targets) removeRun(run);
  return targets.map((r) => r.id);
}
