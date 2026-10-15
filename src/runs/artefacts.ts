import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, HttpError } from "../config";
import type { Project } from "../projects/registry";
import { legacyReportsRoot, realpathLoose, resolveUnder } from "../reports/reports";
import { runDir } from "./store";
import type { Run } from "./types";

/** `<DATA_DIR>/runs/<id>`: where a `storage: "data"` run keeps `report.md` and `screenshots/`. */
export function runArtefactDir(runId: string): string {
  return runDir(runId);
}

export function screenshotsDir(runId: string): string {
  return path.join(runArtefactDir(runId), "screenshots");
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Absolute path of the run's report for either storage; null when it has none or the file is gone. */
export function reportFile(run: Run, project: Project | null): string | null {
  if (!run.reportPath) return null;
  const root = run.storage === "data" ? runArtefactDir(run.id) : project?.repoPath;
  if (!root) return null;
  const file = resolveUnder(root, run.reportPath);
  return file && isFile(file) ? file : null;
}

/** Where the run's report is stored, from the run record alone (no filesystem access, so it may not exist); null when the run has none. */
export function reportLocation(run: Run, project: Project | null): string | null {
  if (!run.reportPath) return null;
  const root = run.storage === "data" ? runArtefactDir(run.id) : project?.repoPath;
  if (!root) return null;
  const file = path.resolve(root, run.reportPath);
  return file.startsWith(path.resolve(root) + path.sep) ? file : null;
}

/** Image extensions served as run screenshots (lowercase, no dot). */
export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(["png", "jpg", "jpeg", "webp", "gif"]);

/** Reports folder of runs from before artefacts moved to the data dir, when the project config no longer names one. */
export const LEGACY_REPORTS_DIR = "qa";

/** True when `head` (the first 12 bytes of a file) starts like a PNG, JPEG, WEBP or GIF. */
export function hasImageMagic(head: Buffer): boolean {
  const startsWith = (hex: string) => head.subarray(0, hex.length / 2).equals(Buffer.from(hex, "hex"));
  return (
    startsWith("89504e47") ||
    startsWith("ffd8ff") ||
    startsWith("47494638") ||
    (head.length >= 12 && head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP")
  );
}

/** The first 12 bytes of a file (fewer when it is shorter); null when it cannot be read. */
export function readHead(file: string): Buffer | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const head = Buffer.alloc(12);
    return head.subarray(0, fs.readSync(fd, head, 0, 12, 0));
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/**
 * Content types of the files the app serves from run folders and repo report folders, keyed by the lowercase extension of the
 * RESOLVED file (symlinks followed). The server states the type itself; nothing is left to be inferred from a path or the bytes.
 */
const ARTEFACT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json",
};

/** Served artefacts are inert: nothing but their own bytes (and `data:` images) may load, and the sandbox gives them an opaque origin. */
const ARTEFACT_CSP = "default-src 'none'; img-src 'self' data:; sandbox";

export const isImagePath = (p: string): boolean => IMAGE_EXTENSIONS.has(path.extname(p).slice(1).toLowerCase());

/**
 * The Content-Type to serve `file` (an already resolved path, so a symlink named `x.png` that points at `x.html` is judged as
 * `.html`) with; null when its extension is not served or it is an image whose first bytes are not an image's.
 */
export function artefactType(file: string): string | null {
  const type = ARTEFACT_TYPES[path.extname(file).toLowerCase()];
  if (!type) return null;
  if (type.startsWith("image/")) {
    const head = readHead(file);
    if (!head || !hasImageMagic(head)) return null;
  }
  return type;
}

/** Streams a resolved artefact with an explicit type, `nosniff` and a sandboxing CSP; 404 unless it is an existing file of a served type. */
export function artefactResponse(file: string | null): Response {
  const type = file && isFile(file) ? artefactType(file) : null;
  if (!file || !type) throw new HttpError(404, "not found");
  return new Response(Bun.file(file), {
    headers: { "Content-Type": type, "X-Content-Type-Options": "nosniff", "Content-Security-Policy": ARTEFACT_CSP },
  });
}

/**
 * Absolute path of a run screenshot, or null when it is outside the run's screenshots folder (data runs: `rel` is
 * relative to the run folder, e.g. `screenshots/01.png`) or the project's reports folder (legacy runs: `rel` is
 * repo-relative), is not an image (extension and magic bytes), or does not exist.
 */
export function screenshotFile(run: Run, project: Project | null, rel: string): string | null {
  if (!isImagePath(rel)) return null;
  let file: string | null;
  if (run.storage === "data") {
    file = resolveUnder(runArtefactDir(run.id), rel);
    file &&= resolveUnder(screenshotsDir(run.id), file);
  } else {
    if (!project) return null;
    const root = legacyReportsRoot(project);
    if (!root) return null;
    file = resolveUnder(project.repoPath, rel);
    file &&= resolveUnder(root, file);
  }
  // `file` is symlink-resolved: a `.png` that links to an `.html` is judged by its target.
  return file && isFile(file) && isImagePath(file) && artefactType(file) ? file : null;
}

export interface RunImage {
  /** Data runs: relative to the run folder (`screenshots/<name>`). Legacy: relative to the project repo. Same form as `Check.screenshot`. */
  rel: string;
  abs: string;
  name: string;
  mtime: string;
  checkId: string | null;
}

const posix = (p: string): string => path.posix.normalize(p.replace(/\\/g, "/")).replace(/^\.\//, "");

/** Images in the run's screenshots folder plus every image a check points at, oldest first; unreadable or out-of-bounds ones are dropped. */
export function runImages(run: Run, project: Project | null): RunImage[] {
  let folder: string;
  let prefix: string;
  if (run.storage === "data") {
    folder = screenshotsDir(run.id);
    prefix = "screenshots";
  } else {
    const root = project ? legacyReportsRoot(project) : null;
    if (!project || !root) return [];
    const reportsDir = posix(project.reportsDir ?? LEGACY_REPORTS_DIR);
    folder = path.join(root, "screenshots", run.id);
    prefix = path.posix.join(reportsDir, "screenshots", run.id);
  }
  const candidates = new Set<string>();
  try {
    for (const file of fs.readdirSync(folder, { recursive: true })) candidates.add(posix(path.posix.join(prefix, String(file))));
  } catch {
    // no screenshots folder yet
  }
  const checkByRel = new Map<string, string>();
  for (const c of run.checks) {
    if (!c.screenshot) continue;
    const rel = posix(c.screenshot);
    candidates.add(rel);
    if (!checkByRel.has(rel)) checkByRel.set(rel, c.id);
  }
  const out: RunImage[] = [];
  for (const rel of candidates) {
    const abs = screenshotFile(run, project, rel);
    if (!abs) continue;
    out.push({ rel, abs, name: path.posix.basename(rel), mtime: fs.statSync(abs).mtime.toISOString(), checkId: checkByRel.get(rel) ?? null });
  }
  return out.sort((a, b) => a.mtime.localeCompare(b.mtime) || a.name.localeCompare(b.name));
}

const insideDir = (dir: string, target: string): boolean => target === dir || target.startsWith(dir + path.sep);

/** Refuses export folders that would write into Tapocalypse's own data or into a git folder. `real` is the symlink-resolved path. */
function assertExportDir(real: string): void {
  if (real.split(path.sep).includes(".git")) throw new HttpError(400, "export directory must not be inside a .git folder");
  if (insideDir(fs.realpathSync(DATA_DIR), real)) throw new HttpError(400, "export directory must not be inside Tapocalypse's data directory");
}

/** Replaces whatever sits at `target` (never following a symlink there) with a copy of `source`. A destination that already is `source` is left alone. */
async function copyReplacing(source: string, target: string): Promise<void> {
  const existing = await fs.promises.lstat(target).catch(() => null);
  if (existing) {
    if (existing.isDirectory()) throw new HttpError(400, `cannot export over a folder: ${target}`);
    if (!existing.isSymbolicLink()) {
      const src = await fs.promises.stat(source);
      if (existing.ino === src.ino && existing.dev === src.dev) return;
    }
    await fs.promises.unlink(target);
  }
  await fs.promises.copyFile(source, target, fs.constants.COPYFILE_EXCL);
}

/**
 * Copies the run's report (as `QA-REPORT-<id>.md`) and screenshots (under `screenshots/`, keeping the layout the report's image
 * links use) into `dir`, which must be absolute and is created. Returns the absolute destination paths. Refuses (400) a folder inside
 * the data dir or a `.git` folder, never writes through a symlink and never leaves `dir`.
 */
export async function exportRun(run: Run, project: Project | null, dir: string): Promise<{ report: string | null; screenshots: string[] }> {
  if (dir.includes("\0")) throw new HttpError(400, "export directory must not contain a NUL byte");
  if (!path.isAbsolute(dir)) throw new HttpError(400, "export directory must be an absolute path");
  assertExportDir(realpathLoose(dir));
  await fs.promises.mkdir(dir, { recursive: true }).catch((e: NodeJS.ErrnoException) => {
    throw new HttpError(400, `cannot create the export directory: ${e.code === "EEXIST" || e.code === "ENOTDIR" ? "a file is in the way" : (e.code ?? e.message)}`);
  });
  const realDir = await fs.promises.realpath(dir);
  assertExportDir(realDir);
  await fs.promises.access(realDir, fs.constants.W_OK).catch(() => {
    throw new HttpError(400, "the export directory is not writable");
  });
  const source = reportFile(run, project);
  let report: string | null = null;
  if (source) {
    report = path.join(dir, `QA-REPORT-${run.id}.md`);
    await copyReplacing(source, report);
  }
  const legacyBase = run.storage === "data" ? null : posix(project?.reportsDir ?? LEGACY_REPORTS_DIR);
  const screenshots: string[] = [];
  for (const image of runImages(run, project)) {
    const rel = legacyBase === null ? image.rel : path.posix.relative(legacyBase, image.rel);
    if (rel.startsWith("..") || path.posix.isAbsolute(rel)) continue;
    const target = path.join(dir, ...rel.split("/"));
    if (!insideDir(realDir, realpathLoose(path.dirname(target)))) throw new HttpError(400, "export folder contains a symlink that leaves it");
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await copyReplacing(image.abs, target);
    screenshots.push(target);
  }
  return { report, screenshots };
}
