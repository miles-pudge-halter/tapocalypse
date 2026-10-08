import fs from "node:fs";
import path from "node:path";
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import { HttpError } from "../config";
import type { Project } from "../projects/registry";
import { getRun } from "../runs/store";
import type { Verdict } from "../runs/types";

const VERDICT_RE = /Verdict:?\**\s*\**\s*(PASS WITH ISSUES|PASS|FAIL|BLOCKED|PARTIAL)/i;
const REPORT_NAME_RE = /^[^/\\]+\.md$/;
const FILE_EXTENSIONS: Record<string, true> = { ".png": true, ".jpg": true, ".jpeg": true, ".webp": true, ".gif": true, ".txt": true, ".json": true };
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
/** Image sources that leave the app origin: a scheme, or a protocol-relative / backslash authority (ASCII controls and spaces ignored like browsers do). */
const EXTERNAL_SRC_RE = /^(?:[a-z][a-z0-9+.-]*:|[\\/]{2})/i;
const LINK_ATTR_RE = /\b(src|href)="([^"]*)"/gi;
const REPORT_RUN_ID_RE = /^QA-REPORT-(.+)\.md$/;
const HEADING_RE = /<h([1-6])(\s[^>]*)?>([\s\S]*?)<\/h\1>/g;
const IMG_TAG_RE = /<img\b[^>]*>/g;

export interface ReportEntry {
  name: string;
  title: string;
  verdict: Verdict | null;
  mtime: string;
  /** Run that wrote this report (from `QA-REPORT-<runId>.md`), when that run still exists. */
  runId: string | null;
}

export interface ReportHeading {
  level: 2 | 3;
  id: string;
  text: string;
}

export interface ReportImage {
  src: string;
  alt: string;
}

export interface RenderedReport {
  name: string;
  title: string;
  verdict: Verdict | null;
  /** Sanitized HTML: no script, handlers, iframes or styles. Headings carry ids; the first h1 is dropped when it repeats `title`. */
  html: string;
  runId: string | null;
  headings: ReportHeading[];
  images: ReportImage[];
}

/**
 * Reports are agent-written and rendered into the app origin, so raw HTML in them is reduced to what markdown itself produces.
 * Author `id`s are dropped (they could shadow the app's own element ids); heading ids are generated afterwards.
 */
const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    "h1", "h2", "h3", "h4", "h5", "h6", "p", "ul", "ol", "li", "a", "img", "table", "thead", "tbody", "tr", "th", "td",
    "code", "pre", "blockquote", "em", "strong", "del", "hr", "br", "details", "summary", "span", "sup", "sub", "input",
  ],
  allowedAttributes: {
    "*": ["title", "align"],
    a: ["href", "title"],
    img: ["src", "alt", "title"],
    th: ["colspan", "rowspan", "align"],
    td: ["colspan", "rowspan", "align"],
    ol: ["start"],
    input: ["type", "checked", "disabled"],
  },
  allowedSchemes: ["http", "https", "mailto"],
  allowedSchemesAppliedToAttributes: ["href", "src"],
  allowProtocolRelative: false,
  disallowedTagsMode: "discard",
  // Markdown task lists are the only legitimate inputs: always a disabled checkbox, never an editable control.
  transformTags: {
    // The page CSP (img-src 'self' data: blob:) blocks external images anyway; keep their alt text instead of a broken box.
    img: (tag, attribs) => {
      const src = (attribs.src ?? "").replace(/[\u0000-\u0020]/g, "");
      return EXTERNAL_SRC_RE.test(src) ? { tagName: "span", attribs: {}, text: attribs.alt ? `[image: ${attribs.alt}]` : "[image]" } : { tagName: tag, attribs };
    },
    input: (_tag, attribs) => ({
      tagName: "input",
      attribs: { type: attribs.type === "checkbox" ? "checkbox" : "hidden", disabled: "disabled", ...(attribs.checked === undefined ? {} : { checked: "checked" }) },
    }),
  },
  exclusiveFilter: (frame) => frame.tag === "input" && frame.attribs.type !== "checkbox",
};

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

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(s: string): string {
  return s.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (whole, dec?: string, hex?: string, name?: string) => {
    if (name) return ENTITIES[name.toLowerCase()] ?? whole;
    const code = dec ? Number(dec) : Number.parseInt(hex!, 16);
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

/** Visible text of an HTML fragment. */
const htmlText = (html: string) => decodeEntities(html.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();

/** The first `# ` line as plain text (inline markdown such as `**x**` or backticks is rendered away). */
function extractTitle(md: string, fallback: string): string {
  const raw = /^# (.+)$/m.exec(md)?.[1]?.trim();
  if (!raw) return fallback;
  return htmlText(marked.parseInline(raw, { async: false })) || fallback;
}

/** `QA-REPORT-<runId>.md` → runId, only when that run still exists in this project. */
function reportRunId(project: Project, name: string): string | null {
  const id = REPORT_RUN_ID_RE.exec(name)?.[1];
  if (!id) return null;
  return getRun(id)?.projectId === project.id ? id : null;
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
        runId: reportRunId(project, name),
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

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "") || "section"
  );
}

/** Gives every heading a unique slug id, collects h2/h3 for a table of contents, and drops the first h1 when it repeats the title. */
function annotateHeadings(html: string, title: string): { html: string; headings: ReportHeading[] } {
  const headings: ReportHeading[] = [];
  const used = new Set<string>();
  let titleDropped = false;
  const out = html.replace(HEADING_RE, (_whole, level: string, attrs: string | undefined, inner: string) => {
    const text = htmlText(inner);
    if (level === "1" && !titleDropped && text === title) {
      titleDropped = true;
      return "";
    }
    const base = slugify(text);
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    if (level === "2" || level === "3") headings.push({ level: Number(level) as 2 | 3, id, text });
    return `<h${level}${attrs ?? ""} id="${id}">${inner}</h${level}>`;
  });
  return { html: out, headings };
}

function extractImages(html: string): ReportImage[] {
  const images: ReportImage[] = [];
  for (const tag of html.match(IMG_TAG_RE) ?? []) {
    const src = /\ssrc="([^"]*)"/.exec(tag)?.[1];
    if (src) images.push({ src: decodeEntities(src), alt: decodeEntities(/\salt="([^"]*)"/.exec(tag)?.[1] ?? "") });
  }
  return images;
}

export function renderReport(project: Project, name: string): RenderedReport {
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
  const title = extractTitle(md, name);
  // Sanitize first: it normalizes attribute quoting, so link rewriting sees every src/href and only ever prefixes safe values.
  const clean = rewriteLinks(sanitizeHtml(marked.parse(md, { async: false }), SANITIZE_OPTIONS), project.id);
  const { html, headings } = annotateHeadings(clean, title);
  return { name, title, verdict: extractVerdict(md), html, runId: reportRunId(project, name), headings, images: extractImages(html) };
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
