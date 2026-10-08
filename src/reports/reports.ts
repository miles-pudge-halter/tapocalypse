import fs from "node:fs";
import path from "node:path";
import { marked } from "marked";
import { HttpError } from "../config";
import type { Project } from "../projects/registry";
import type { Verdict } from "../runs/types";

const VERDICT_RE = /Verdict:?\**\s*\**\s*(PASS WITH ISSUES|PASS|FAIL|BLOCKED|PARTIAL)/i;
const REPORT_NAME_RE = /^[^/\\]+\.md$/;
const FILE_EXTENSIONS: Record<string, true> = { ".png": true, ".jpg": true, ".jpeg": true, ".webp": true, ".gif": true, ".txt": true, ".json": true };
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const LINK_ATTR_RE = /\b(src|href)="([^"]*)"/gi;

export interface ReportEntry {
  name: string;
  title: string;
  verdict: Verdict | null;
  mtime: string;
}

/** Realpath of the deepest existing ancestor of `p`, with the non-existent remainder re-appended. */
function realpathLoose(p: string): string {
  const rest: string[] = [];
  let cur = p;
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...rest.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return p;
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** Resolves `rel` against `root`; null unless the real path stays inside `root` (symlinks followed). */
export function resolveUnder(root: string, rel: string): string | null {
  if (!rel || rel.includes("\0")) return null;
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return null;
  }
  const resolved = realpathLoose(path.resolve(realRoot, rel));
  if (resolved === realRoot || resolved.startsWith(realRoot + path.sep)) return resolved;
  return null;
}

export function extractVerdict(md: string): Verdict | null {
  const m = VERDICT_RE.exec(md);
  return m ? (m[1]!.toUpperCase() as Verdict) : null;
}

function extractTitle(md: string, fallback: string): string {
  return /^# (.+)$/m.exec(md)?.[1]?.trim() ?? fallback;
}

const reportsRoot = (project: Project) => path.join(project.repoPath, project.reportsDir);

export function listReports(project: Project): ReportEntry[] {
  const dir = reportsRoot(project);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const entries: (ReportEntry & { ms: number })[] = [];
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    const file = path.join(dir, name);
    try {
      const st = fs.statSync(file);
      if (!st.isFile()) continue;
      const md = fs.readFileSync(file, "utf8");
      entries.push({
        name,
        title: extractTitle(md, name),
        verdict: extractVerdict(md),
        mtime: st.mtime.toISOString(),
        ms: st.mtimeMs,
      });
    } catch {
      // file vanished between readdir and stat; skip it
    }
  }
  entries.sort((a, b) => b.ms - a.ms);
  return entries.map(({ ms: _ms, ...entry }) => entry);
}

/** Rewrites relative `src`/`href` values (relative to the reports dir) to app routes. */
export function rewriteLinks(html: string, projectId: string): string {
  return html.replace(LINK_ATTR_RE, (whole, attr: string, value: string) => {
    if (!value || value.startsWith("/") || value.startsWith("#") || URL_SCHEME_RE.test(value)) return whole;
    const hashAt = value.indexOf("#");
    const beforeHash = hashAt === -1 ? value : value.slice(0, hashAt);
    const frag = hashAt === -1 ? "" : value.slice(hashAt);
    const queryAt = beforeHash.indexOf("?");
    const pathPart = queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt);
    const normalized = path.posix.normalize(pathPart);
    if (!pathPart || normalized === ".." || normalized.startsWith("../")) return whole;
    if (normalized.toLowerCase().endsWith(".md")) {
      return `${attr}="#/p/${projectId}/reports/${path.posix.basename(normalized)}${frag}"`;
    }
    return `${attr}="/files/${projectId}/${normalized}${frag}"`;
  });
}

export function renderReport(
  project: Project,
  name: string,
): { name: string; title: string; verdict: Verdict | null; html: string } {
  const notFound = () => new HttpError(404, "report not found");
  if (!REPORT_NAME_RE.test(name)) throw notFound();
  const file = resolveUnder(reportsRoot(project), name);
  if (!file) throw notFound();
  let md: string;
  try {
    md = fs.readFileSync(file, "utf8");
  } catch {
    throw notFound();
  }
  const html = rewriteLinks(marked.parse(md, { async: false }), project.id);
  return { name, title: extractTitle(md, name), verdict: extractVerdict(md), html };
}

/** Absolute path of a servable file under the project's reports dir, or null. */
export function reportFilePath(project: Project, rel: string): string | null {
  if (!FILE_EXTENSIONS[path.extname(rel).toLowerCase()]) return null;
  const file = resolveUnder(reportsRoot(project), rel);
  if (!file) return null;
  try {
    return fs.statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}
