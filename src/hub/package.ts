import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import pkg from "../../package.json";
import { getBatchMeta } from "../batches";
import { DATA_DIR } from "../config";
import type { Project } from "../projects/registry";
import { type GitRunner, refreshDefaultBranch } from "../regression/baseline";
import { reportFile, runImages, type RunImage } from "../runs/artefacts";
import { readActivity, runDir } from "../runs/store";
import { ACTIVE, type Check, type Run } from "../runs/types";
import { hubIdentityFor, withoutQueryAndFragment } from "./identity";
import { type BlobRefT, type BlobTypeT, contentHashOf, hasImageMagic, HUB_PROTOCOL, RunUploadBody, type RunUploadBodyT } from "./protocol";
import { createRedactor } from "./redact";

export interface PackageOptions {
  /** `webp` (default): re-encode screenshots to WebP q80; `original`: upload the exact bytes. */
  screenshots?: "webp" | "original";
  /** Upload the run's transcript (redacted) when it has one. Default false. */
  transcript?: boolean;
  now?: () => number;
  clientVersion?: string;
  /** Git runner for the project's remote, subpath and worktrees (test seam). */
  git?: GitRunner;
}

/** `Uint8Array<ArrayBuffer>` (never shared memory) so the bytes are a valid `fetch` body. */
type Bytes = Uint8Array<ArrayBuffer>;

export interface Blob {
  type: BlobTypeT;
  bytes: Bytes;
}

export interface PackagedRun {
  doc: RunUploadBodyT;
  /** Everything the document references, by sha256 of the bytes. */
  blobs: Map<string, Blob>;
  /** `contentHashOf(doc)`: equal across attempts while nothing the hub would store has changed. */
  contentHash: string;
}

const MAX_SCREENSHOTS = 500;
const IMAGE_TYPES: [BlobTypeT, string][] = [
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
];

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const encoder = new TextEncoder();

function imageTypeOf(bytes: Uint8Array): [BlobTypeT, string] | null {
  return IMAGE_TYPES.find(([type]) => hasImageMagic(bytes, type)) ?? null;
}

/** Spawned lazily by `git`; null/empty answers are simply absent. */
async function worktreePaths(repoPath: string, git: GitRunner): Promise<string[]> {
  const [list, top] = await Promise.all([git(repoPath, ["worktree", "list", "--porcelain"]), git(repoPath, ["rev-parse", "--show-toplevel"])]);
  const paths = (list ?? "")
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length).trim());
  return top ? [...paths, top] : paths;
}

/** The path and its symlink-resolved form (macOS `/var` → `/private/var`), when they differ. */
function withRealpath(p: string): string[] {
  try {
    const real = fs.realpathSync(p);
    return real === p ? [p] : [p, real];
  } catch {
    return [p];
  }
}

const readBytes = (file: string): Bytes | null => {
  try {
    return new Uint8Array(fs.readFileSync(file));
  } catch {
    return null;
  }
};

/** Re-encodes to WebP q80 unless asked not to; keeps the original when it is WebP already or cannot be decoded. */
async function encodeImage(bytes: Bytes, mode: "webp" | "original"): Promise<{ bytes: Bytes; type: BlobTypeT; ext: string } | null> {
  const original = imageTypeOf(bytes);
  if (!original) return null;
  if (mode === "webp" && original[0] !== "image/webp") {
    try {
      return { bytes: new Uint8Array(await new Bun.Image(bytes).webp({ quality: 80 }).bytes()), type: "image/webp", ext: "webp" };
    } catch {
      // undecodable here (unsupported variant): the original still uploads
    }
  }
  return { bytes, type: original[0], ext: original[1] };
}

/** `screenshots/<stem>.<ext>`, unique within the run; the stem keeps the source file name. */
function hubName(rel: string, ext: string, taken: Set<string>): string {
  const stem = path.posix.basename(rel, path.posix.extname(rel)).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "image";
  for (let n = 1; ; n++) {
    const name = `screenshots/${stem}${n === 1 ? "" : `-${n}`}.${ext}`;
    if (!taken.has(name)) {
      taken.add(name);
      return name;
    }
  }
}

const EXTERNAL_LINK = /^(?:[a-z][a-z0-9+.-]*:|[\\/]|#)/i;

/** Rewrites the destinations of markdown links/images, reference definitions and `<img src>` for which `swap` has an answer. */
function rewriteLinks(md: string, swap: (link: string) => string | null): string {
  const unwrap = (dest: string) => (dest.startsWith("<") && dest.endsWith(">") ? dest.slice(1, -1) : dest);
  const replace = (whole: string, open: string, dest: string) => {
    const to = swap(unwrap(dest));
    return to === null ? whole : `${open}${to}`;
  };
  return md
    .replace(/(\]\(\s*)(<[^>\n]*>|[^\s)]*)/g, replace)
    .replace(/^(\s{0,3}\[[^\]\n]+\]:\s*)(<[^>\n]*>|\S+)/gm, replace)
    .replace(/(<img\b[^>]*?\bsrc\s*=\s*)(["'])(.*?)\2/gi, (whole, open: string, quote: string, src: string) => {
      const to = swap(src);
      return to === null ? whole : `${open}${quote}${to}${quote}`;
    });
}

const clamp = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/**
 * Builds the upload for one finished run: a redacted run document, the report with its image links rewritten to the hub
 * layout, the mapped activity feed (never the raw event stream), the screenshots, and the content hash that tells
 * whether anything changed since the last upload. Throws (with a message fit for the user) when the run is not finished
 * or its project cannot be named on the hub.
 */
export async function packageRun(run: Run, project: Project, opts: PackageOptions = {}): Promise<PackagedRun> {
  if (ACTIVE.includes(run.status)) throw new Error(`run ${run.id} is not finished (${run.status})`);
  const git = opts.git;
  const identity = await hubIdentityFor(project, git);
  if (!identity.hubKey) {
    throw new Error(`project ${project.id} has no git remote to name it on the hub: set a hubKey on the project (for example local/${project.id})`);
  }
  const defaultBranch = project.defaultBranch ?? (await refreshDefaultBranch(project));
  const defaultBranchSource = project.defaultBranch ? "explicit" : "detected";

  const [worktrees] = await Promise.all([git ? worktreePaths(project.repoPath, git) : Promise.resolve([])]);
  const redact = createRedactor({
    home: os.homedir(),
    repos: [project.repoPath, run.source?.path, ...worktrees].filter((p): p is string => Boolean(p)).flatMap(withRealpath),
    dataDir: DATA_DIR,
    tmpDirs: [...withRealpath(os.tmpdir()), "/tmp", "/private/tmp"],
  });
  const mode = opts.screenshots ?? "webp";
  const blobs = new Map<string, Blob>();
  const keep = (bytes: Bytes, type: BlobTypeT): BlobRefT => {
    blobs.set(sha256(bytes), { type, bytes });
    return { sha256: sha256(bytes), bytes: bytes.length, type };
  };
  const textBlob = (s: string, type: BlobTypeT): BlobRefT | null => (s.length > 0 ? keep(encoder.encode(s), type) : null);

  // Screenshots, in a stable order (not mtime: it changes on restore), each under its hub path.
  const taken = new Set<string>();
  const hubPathOf = new Map<string, string>();
  const screenshots: RunUploadBodyT["screenshots"] = [];
  const images: RunImage[] = runImages(run, project).sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  for (const image of images) {
    if (screenshots.length >= MAX_SCREENSHOTS) break;
    const source = readBytes(image.abs);
    const encoded = source && (await encodeImage(source, mode));
    if (!encoded) continue;
    const name = hubName(image.rel, encoded.ext, taken);
    hubPathOf.set(image.rel, name);
    screenshots.push({ ...keep(encoded.bytes, encoded.type), path: name });
  }
  screenshots.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  // Report: image links point at the hub layout (the report sits at the run's root there).
  const reportDir = path.posix.dirname(run.reportPath ?? ".");
  const swapLink = (link: string): string | null => {
    if (EXTERNAL_LINK.test(link)) return null;
    try {
      const target = decodeURIComponent(link.replace(/[?#].*$/, "")).replace(/\\/g, "/");
      return hubPathOf.get(path.posix.normalize(path.posix.join(reportDir, target))) ?? null;
    } catch {
      return null;
    }
  };
  const reportSource = reportFile(run, project);
  const reportText = reportSource ? fs.readFileSync(reportSource, "utf8") : "";
  const report = textBlob(redact.text(rewriteLinks(reportText, swapLink)), "text/markdown");

  // Activity: the feed the run page shows, redacted; the raw frames (images, tool output, session) stay local.
  const feed = readActivity(run.id, { limit: Number.POSITIVE_INFINITY }).items;
  const activity = textBlob(feed.map((item) => `${JSON.stringify(redact.value(item))}\n`).join(""), "application/x-ndjson");

  const transcriptFile = path.join(runDir(run.id), "transcript.html");
  const transcript =
    opts.transcript && run.transcriptHtml && fs.existsSync(transcriptFile) ? textBlob(redact.text(fs.readFileSync(transcriptFile, "utf8")), "text/html") : null;

  const { stats: _stats, deviceLabel: _deviceLabel, ...rest } = run;
  const checks: Check[] = run.checks.map((c) => {
    const { screenshot, ...other } = c;
    const hubPath = screenshot ? swapLink(screenshot) ?? hubPathOf.get(path.posix.normalize(screenshot.replace(/\\/g, "/"))) : undefined;
    return { ...other, title: clamp(c.title, 2000), ...(hubPath ? { screenshot: hubPath } : {}) };
  });
  const runDoc = redact.value({
    ...rest,
    title: clamp(run.title, 500),
    checks,
    source: run.source ? { ...run.source, remoteUrl: run.source.remoteUrl ? withoutQueryAndFragment(run.source.remoteUrl) : null } : null,
    storage: "data",
    reportPath: report ? "report.md" : null,
    transcriptHtml: transcript !== null,
    stats: null,
    deviceSerial: null,
    deviceRequest: { platform: run.deviceRequest.platform },
    install: run.install ? { path: path.basename(run.install.path) } : null,
  });

  const batchMeta = run.batchId ? getBatchMeta(run.batchId) : null;
  const body = {
    protocol: HUB_PROTOCOL,
    clientVersion: opts.clientVersion ?? pkg.version,
    sentAt: new Date((opts.now ?? Date.now)()).toISOString(),
    project: {
      hubKey: identity.hubKey,
      name: clamp(redact.text(project.name), 60),
      remoteUrl: identity.remoteUrl,
      subpath: identity.subpath,
      defaultBranch: defaultBranch ?? null,
      ...(defaultBranch ? { defaultBranchSource } : {}),
      defaultPlatform: project.defaultPlatform,
      localId: project.id,
    },
    run: runDoc,
    batch: batchMeta ? { id: batchMeta.id, title: clamp(redact.text(batchMeta.title), 500), createdAt: batchMeta.createdAt } : null,
    report,
    activity,
    screenshots,
    transcript,
    redaction: { replaced: redact.replaced },
  };
  const parsed = RunUploadBody.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new Error(`run ${run.id} cannot be uploaded: ${issue.path.join(".") || "document"}: ${issue.message}`);
  }
  return { doc: parsed.data, blobs, contentHash: contentHashOf(parsed.data) };
}
