import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { S3Client } from "bun";
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import { z } from "zod";
import pkg from "../../package.json";
import { CONFIG_PATH, config, HttpError } from "../config";
import { getProject, type Project } from "../projects/registry";
import { readHead, reportFile, runImages, screenshotFile } from "../runs/artefacts";
import { getRun } from "../runs/store";
import { ACTIVE, type Check, type CheckStatus, type Run } from "../runs/types";
import { decodeEntities, SANITIZE_OPTIONS } from "./reports";

export interface StandaloneOptions {
  /** Total bytes of screenshots embedded in the document (default 25 MB); images past it become a placeholder. */
  maxInlineBytes?: number;
}

export const CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'";

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const IMG_TAG_RE = /<img\b[^>]*>/g;

// The mark and wordmark are the web UI's (web/components/brand.tsx), inlined so the file needs no request.
const MARK = `<svg viewBox="0 0 200 200" width="32" height="32" role="img" aria-label="Tapocalypse"><rect x="10" y="10" width="180" height="180" rx="44" fill="#0f0b07"/><rect x="56" y="26" width="88" height="148" rx="16" fill="none" stroke="#f6efe6" stroke-width="9"/><ellipse cx="96" cy="150" rx="22" ry="5.5" fill="none" stroke="#ff8a1f" stroke-width="4"/><rect x="70" y="50" width="60" height="15" rx="3" fill="#ffc21a"/><polygon points="91,64 113,64 105,94 120,94 94,146 100,106 85,106" fill="#ffc21a" stroke-linejoin="round"/></svg>`;
const WORDMARK_TAP =
  "M18.1 70L28.4 11.5L7.5 11.5L9.5 0L64.9 0L62.8 11.5L42 11.5L31.7 70M56.2 70L94.1 0L106.5 0L119.8 70L106 70L103.2 54.5L78.6 54.5L70 70L56.2 70M83.4 43.3L101.9 43.3L97.4 16.7L97.2 16.7M128.6 70L140.9 0L183.9 0L193.4 11.6L189 36.4L177.5 46.2L146.4 46.2L142.2 70L128.6 70M148.4 34.8L172.4 34.8L176.5 31.3L179.4 14.9L176.5 11.4L152.5 11.4";
const WORDMARK_REST =
  "M206.3 70L196.1 57.6L204.4 10.7L216.9 0L252.9 0L263.1 12.3L254.7 59.7L242.5 70L206.3 70M214.6 58.4L236.2 58.4L242.2 53.3L248.7 16.7L244.5 11.6L223 11.6L217 16.7L210.4 53.3M278 70L267.8 57.6L276.1 10.7L288.6 0L322.7 0L332.8 12.1L331 22L317.4 22L318.4 16.3L314.6 11.6L294.6 11.6L288.6 16.7L282.1 53.3L286.3 58.4L306.3 58.4L311.8 53.7L312.9 48L326.5 48L324.4 59.5L312.1 70M327.8 70L365.7 0L378.1 0L391.4 70L377.6 70L374.8 54.5L350.2 54.5L341.6 70L327.8 70M355 43.3L373.5 43.3L369 16.7L368.8 16.7M400.2 70L412.5 0L426.1 0L415.8 58.5L450.7 58.5L448.7 70M476.5 70L481.5 41.4L463.9 0L478 0L489.6 28.7L489.8 28.7L511.6 0L527.3 0L495.1 41.4L490.1 70M523.2 70L535.5 0L578.5 0L588 11.6L583.6 36.4L572.1 46.2L541 46.2L536.8 70L523.2 70M543 34.8L567 34.8L571.1 31.3L574 14.9L571.1 11.4L547.1 11.4M599.6 70L590 58.4L591.7 49.2L605.1 49.2L604 55.1L606.7 58.4L627.3 58.4L631.3 55L633.4 43.4L630.7 40.1L605 40.1L595.4 28.5L598.6 10L610.4 0L641.9 0L651.6 11.6L650 20.9L636.6 20.9L637.6 14.9L634.9 11.6L615.1 11.6L611.2 14.9L609.4 25.2L612.1 28.5L637.8 28.5L647.4 40.1L643.8 60L632.1 70M654.9 70L667.2 0L717.7 0L715.7 11.5L678.8 11.5L675.7 29.2L709.7 29.2L707.7 40.5L673.7 40.5L670.5 58.5L707.4 58.5L705.4 70";
const WORDMARK = `<svg viewBox="7 0 711 70" height="14" role="img" aria-label="Tapocalypse"><path class="tap" d="${WORDMARK_TAP}"/><path fill="currentColor" d="${WORDMARK_REST}"/></svg>`;

const STYLE = `
:root{color-scheme:light dark;--bg:oklch(0.9801 0.0074 80.721);--fg:oklch(0.1899 0.0201 66.111);--card:oklch(0.9945 0.0057 84.566);--muted:oklch(0.9453 0.0136 78.262);--muted-fg:oklch(0.5009 0.0273 69.218);--border:oklch(0.9067 0.0184 78.236);--tap:oklch(0.7253 0.1547 72.8);--pass:#15803d;--fail:#b91c1c;--warn:#b45309;--idle:oklch(0.5009 0.0273 69.218)}
@media (prefers-color-scheme:dark){:root{--bg:oklch(0.1532 0.0112 68.966);--fg:oklch(0.9551 0.0142 74.424);--card:oklch(0.1899 0.0201 66.111);--muted:oklch(0.2525 0.0223 63.532);--muted-fg:oklch(0.6934 0.0305 74.166);--border:oklch(0.2987 0.0211 66.3);--tap:oklch(0.8464 0.1693 84.902);--pass:#4ade80;--fail:#f87171;--warn:#fbbf24;--idle:oklch(0.6934 0.0305 74.166)}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:960px;margin:0 auto;padding:20px 16px 48px}
.brand{display:flex;align-items:center;gap:10px;color:var(--fg);margin-bottom:20px}
.brand .tap{fill:var(--tap)}
h1{font-size:1.6rem;line-height:1.25;margin:0 0 8px;overflow-wrap:anywhere}
h2{font-size:1.15rem;margin:28px 0 10px}
.badge{display:inline-block;padding:2px 10px;border-radius:999px;border:1px solid currentColor;font-size:.8rem;font-weight:600;white-space:nowrap}
.pass{color:var(--pass)}.fail{color:var(--fail)}.warn{color:var(--warn)}.idle{color:var(--idle)}
.meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:8px 20px;margin:16px 0;padding:14px 16px;background:var(--card);border:1px solid var(--border);border-radius:10px}
.meta dt{font-size:.72rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted-fg)}
.meta dd{margin:0;overflow-wrap:anywhere}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9em}
.summary{padding:12px 16px;background:var(--card);border:1px solid var(--border);border-left:4px solid var(--tap);border-radius:10px;overflow-wrap:anywhere}
.table-wrap{overflow-x:auto}
table{border-collapse:collapse;width:100%}
th,td{padding:8px 10px;border-bottom:1px solid var(--border);text-align:left;vertical-align:top}
th{font-size:.75rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted-fg)}
td.note{overflow-wrap:anywhere;min-width:140px}
.thumb{display:block;width:72px;height:auto;border-radius:6px;border:1px solid var(--border)}
.report{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:4px 18px 14px;overflow-wrap:anywhere}
.report img{max-width:100%;height:auto;border-radius:6px;border:1px solid var(--border)}
.report pre{overflow-x:auto;background:var(--muted);padding:10px 12px;border-radius:8px}
.report code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9em}
.report a{color:inherit;text-decoration-color:var(--tap)}
.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:14px}
.gallery figure{margin:0;padding:8px;background:var(--card);border:1px solid var(--border);border-radius:10px;break-inside:avoid}
.gallery img{display:block;width:100%;height:auto;border-radius:6px}
.gallery figcaption{margin-top:6px;font-size:.78rem;color:var(--muted-fg);overflow-wrap:anywhere}
.omitted{display:inline-block;padding:6px 10px;border:1px dashed var(--border);border-radius:6px;color:var(--muted-fg);font-size:.8rem}
.empty{color:var(--muted-fg)}
footer{margin-top:40px;padding-top:14px;border-top:1px solid var(--border);font-size:.8rem;color:var(--muted-fg)}
@media print{body{background:#fff;color:#000}.meta,.summary,.report,.gallery figure{background:#fff}main{max-width:none;padding:0}}
`;

const STATUS_CLASS: Record<CheckStatus, string> = { pass: "pass", fail: "fail", blocked: "warn", skipped: "idle", pending: "idle", running: "idle" };

function verdictClass(label: string): string {
  if (label === "PASS") return "pass";
  if (label === "FAIL") return "fail";
  if (label === "PASS WITH ISSUES" || label === "BLOCKED" || label === "PARTIAL" || label === "error") return "warn";
  return "idle";
}

const utc = (iso: string): string => `${iso.slice(0, 16).replace("T", " ")} UTC`;

function duration(run: Run): string | null {
  if (!run.startedAt || !run.endedAt) return null;
  const s = Math.max(0, Math.round((Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m${String(s % 60).padStart(2, "0")}s` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

function metaRows(run: Run, project: Project | null): [string, string][] {
  const rows: [string, string][] = [["Project", esc(project?.name ?? run.projectId)]];
  const src = run.source;
  if (src?.branch) rows.push(["Branch", `<span class="mono">${esc(src.branch)}</span>`]);
  if (src?.commit) rows.push(["Commit", `<span class="mono">${esc(src.commit.slice(0, 10))}</span>${src.commitSubject ? ` ${esc(src.commitSubject)}` : ""}`]);
  if (src?.pr) rows.push(["Pull request", `#${src.pr.number}${src.pr.title ? ` ${esc(src.pr.title)}` : ""}`]);
  if (src?.tickets.length) rows.push(["Tickets", src.tickets.map((t) => `<span class="mono">${esc(t)}</span>`).join(", ")]);
  const device = run.deviceName ?? run.deviceSerial;
  rows.push(["Device", `${device ? esc(device) : "unknown"} (${esc(run.deviceRequest.platform)})`]);
  const model = run.model ?? run.usage?.model ?? null;
  rows.push(["Agent", `${esc(run.harness)}${model ? ` · <span class="mono">${esc(model)}</span>` : ""}`]);
  rows.push(["Started", esc(utc(run.startedAt ?? run.createdAt))]);
  const took = duration(run);
  if (took) rows.push(["Duration", took]);
  if (run.usage?.cost != null) rows.push(["Cost", `$${run.usage.cost.toFixed(2)}`]);
  return rows;
}

const checkRow = (c: Check, thumb: string): string =>
  `<tr><td class="mono">${esc(c.id)}</td><td>${esc(c.title)}</td><td><span class="badge ${STATUS_CLASS[c.status]}">${c.status}</span></td><td class="note">${c.note ? esc(c.note) : ""}</td><td>${thumb}</td></tr>`;

const DEFAULT_MAX_INLINE_BYTES = 25 * 1024 * 1024;
const OMITTED = `<span class="omitted">screenshot omitted (size limit)</span>`;

function mimeOf(head: Buffer): string {
  if (head.subarray(0, 4).equals(Buffer.from("89504e47", "hex"))) return "image/png";
  if (head.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))) return "image/jpeg";
  if (head.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  return "image/webp";
}

/** Embeds run screenshots as data URIs within a byte budget; every embedded copy counts, repeats included. */
class Inliner {
  private used = 0;
  private readonly cache = new Map<string, string>();
  private readonly outcome = new Map<string, "inlined" | "omitted">();

  constructor(private readonly max: number) {}

  get inlined(): number {
    return [...this.outcome.values()].filter((o) => o === "inlined").length;
  }

  get omitted(): number {
    return [...this.outcome.values()].filter((o) => o === "omitted").length;
  }

  /** `<img>` for a screenshot (an absolute path already vetted by `screenshotFile`), or the size-limit placeholder. */
  async img(abs: string, alt: string, cls?: string): Promise<string> {
    const size = Bun.file(abs).size;
    if (this.used + size > this.max) {
      if (!this.outcome.has(abs)) this.outcome.set(abs, "omitted");
      return OMITTED;
    }
    this.used += size;
    if (!this.outcome.has(abs)) this.outcome.set(abs, "inlined");
    let uri = this.cache.get(abs);
    if (!uri) {
      const bytes = Buffer.from(await Bun.file(abs).arrayBuffer());
      uri = `data:${mimeOf(readHead(abs) ?? bytes)};base64,${bytes.toString("base64")}`;
      this.cache.set(abs, uri);
    }
    return `<img src="${uri}" alt="${esc(alt)}"${cls ? ` class="${cls}"` : ""}>`;
  }
}

/** The run screenshot a report-relative link points at (resolved against the report's folder, through the artefact guards). */
function linkedScreenshot(run: Run, project: Project | null, link: string): { rel: string; abs: string } | null {
  if (/^(?:[a-z][a-z0-9+.-]*:|[\\/])/i.test(link)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(link.replace(/[?#].*$/, ""));
  } catch {
    return null;
  }
  const rel = path.posix.normalize(path.posix.join(path.posix.dirname(run.reportPath ?? "."), decoded.replace(/\\/g, "/")));
  const abs = screenshotFile(run, project, rel);
  return abs ? { rel, abs } : null;
}

/**
 * The report markdown as safe HTML: agent text is untrusted, so it goes through the same sanitizer as the web UI. Images that are
 * not run screenshots are dropped; links to screenshots point at the gallery, other relative links lose their target.
 */
async function reportBody(md: string, run: Run, project: Project | null, inliner: Inliner, gallery: Map<string, number>): Promise<string> {
  const clean = sanitizeHtml(marked.parse(md, { async: false }), SANITIZE_OPTIONS);
  let out = "";
  let last = 0;
  for (const m of clean.matchAll(IMG_TAG_RE)) {
    const alt = decodeEntities(/\salt="([^"]*)"/.exec(m[0])?.[1] ?? "");
    const src = /\ssrc="([^"]*)"/.exec(m[0])?.[1];
    const shot = src ? linkedScreenshot(run, project, decodeEntities(src)) : null;
    out += clean.slice(last, m.index) + (shot ? await inliner.img(shot.abs, alt) : `<span class="omitted">[image${alt ? `: ${esc(alt)}` : ""}]</span>`);
    last = m.index + m[0].length;
  }
  out += clean.slice(last);
  return out.replace(/<a href="([^"]*)"/g, (_whole, href: string) => {
    const target = decodeEntities(href);
    if (target.startsWith("#")) return `<a href="${href}"`;
    if (/^(?:https?:|mailto:)/i.test(target)) return `<a rel="noopener noreferrer" href="${href}"`;
    const shot = linkedScreenshot(run, project, target);
    const index = shot ? gallery.get(shot.rel) : undefined;
    return index === undefined ? "<a" : `<a href="#shot-${index}"`;
  });
}

/**
 * One self-contained HTML document for a run: header, summary, checks and the report, with no scripts and no network requests
 * (a CSP meta forbids both). Everything agent-written is escaped or sanitized.
 */
export async function renderStandaloneReport(run: Run, project: Project | null, opts: StandaloneOptions = {}): Promise<{ html: string; inlined: number; omitted: number }> {
  const inliner = new Inliner(opts.maxInlineBytes ?? DEFAULT_MAX_INLINE_BYTES);
  const file = reportFile(run, project);
  const md = file ? await Bun.file(file).text() : null;
  const images = runImages(run, project);
  const gallery = new Map(images.map((im, i) => [im.rel, i]));
  const label = run.verdict ?? run.status;
  const meta = metaRows(run, project)
    .map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`)
    .join("");
  const checkRows: string[] = [];
  for (const c of run.checks) {
    const rel = c.screenshot ? path.posix.normalize(c.screenshot.replace(/\\/g, "/")) : null;
    const abs = rel ? screenshotFile(run, project, rel) : null;
    const shot = abs ? await inliner.img(abs, `${c.id} screenshot`, "thumb") : "";
    const index = rel === null ? undefined : gallery.get(rel);
    checkRows.push(checkRow(c, index === undefined || !shot ? shot : `<a href="#shot-${index}">${shot}</a>`));
  }
  const checks = run.checks.length
    ? `<h2>Checks</h2><div class="table-wrap"><table><thead><tr><th>ID</th><th>Check</th><th>Status</th><th>Note</th><th>Screenshot</th></tr></thead><tbody>${checkRows.join("")}</tbody></table></div>`
    : "";
  const body = md === null ? "" : `<h2>Report</h2><article class="report">${await reportBody(md, run, project, inliner, gallery)}</article>`;
  const figures: string[] = [];
  for (const [i, im] of images.entries()) {
    figures.push(`<figure id="shot-${i}">${await inliner.img(im.abs, im.name)}<figcaption>${im.checkId ? `${esc(im.checkId)} · ` : ""}${esc(im.name)}</figcaption></figure>`);
  }
  const shots = figures.length ? `<h2>Screenshots</h2><div class="gallery">${figures.join("")}</div>` : "";
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(run.title)} · Tapocalypse</title><style>${STYLE}</style></head>
<body><main>
<div class="brand">${MARK}${WORDMARK}</div>
<h1>${esc(run.title)}</h1>
<span class="badge ${verdictClass(label)}">${esc(label)}</span>
<dl class="meta">${meta}</dl>
${run.summary ? `<div class="summary">${esc(run.summary)}</div>` : ""}
${checks}
${body}
${shots}
<footer>Generated by Tapocalypse ${esc(pkg.version)} on ${esc(new Date().toISOString().slice(0, 10))}</footer>
</main></body></html>
`;
  return { html, inlined: inliner.inlined, omitted: inliner.omitted };
}

export type ShareConfig = NonNullable<typeof config.share>;

/** What the upload needs from Bun's `S3Client`; tests inject a fake. */
export interface ShareClient {
  write(key: string, data: string, options: { type: string }): Promise<unknown>;
  presign(key: string, options: { method: "GET"; expiresIn: number }): string;
}

export interface CredentialSources {
  /** Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Directory of the active config file, where `share-credentials.json` lives by default. */
  configDir?: string;
  /** What `~` in `credentialsFile` means; defaults to the user's home directory. */
  home?: string;
}

export interface ShareDeps extends CredentialSources {
  /** Defaults to the loaded config's `share`. */
  share?: ShareConfig | undefined;
  /** Defaults to Bun's `S3Client` built from `share.s3` and the resolved credentials. */
  client?: ShareClient;
  now?: () => number;
}

const CREDENTIALS_FILE_NAME = "share-credentials.json";
const FileCredentials = z.object({ accessKeyId: z.string().min(1), secretAccessKey: z.string().min(1), sessionToken: z.string().min(1).optional() });

export type ShareCredentials = { source: "env" } | ({ source: "file" } & z.infer<typeof FileCredentials>);

/**
 * Where the S3 credentials come from. The environment wins (`S3_*` or `AWS_*`, a complete pair; Bun's client reads those itself);
 * otherwise a JSON file `{accessKeyId, secretAccessKey, sessionToken?}` that must not be readable by group or others, like an SSH
 * key. The file is read on every call, so adding it needs no restart, and it works under `tapocalypse service`, whose unit carries
 * no secrets.
 */
export function resolveShareCredentials(s3: ShareConfig["s3"], sources: CredentialSources = {}): { ok: true; credentials: ShareCredentials } | { ok: false; problem: string } {
  const env = sources.env ?? process.env;
  const pair = (id: string, secret: string) => Boolean(env[id] && env[secret]);
  if (pair("S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY") || pair("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY")) return { ok: true, credentials: { source: "env" } };

  const home = sources.home ?? os.homedir();
  const configured = s3.credentialsFile;
  const file = configured ? (configured.startsWith("~/") ? path.join(home, configured.slice(2)) : configured) : path.join(sources.configDir ?? path.dirname(CONFIG_PATH), CREDENTIALS_FILE_NAME);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return { ok: false, problem: `sharing is not configured: no S3 credentials (set S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY or create ${file} with mode 600)` };
  }
  if (!stat.isFile()) return { ok: false, problem: `S3 credentials file ${file} is not a regular file` };
  if ((stat.mode & 0o077) !== 0) {
    return { ok: false, problem: `S3 credentials file ${file} is accessible by other users (mode ${(stat.mode & 0o777).toString(8)}); run: chmod 600 ${file}` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return { ok: false, problem: `S3 credentials file ${file} is unreadable: ${e instanceof Error ? e.message : String(e)}` };
  }
  const parsed = FileCredentials.safeParse(raw);
  if (!parsed.success) return { ok: false, problem: `S3 credentials file ${file} must be {"accessKeyId": "...", "secretAccessKey": "...", "sessionToken"?: "..."}` };
  return { ok: true, credentials: { source: "file", ...parsed.data } };
}

export function shareConfigured(): boolean {
  return shareStatus(config.share).configured;
}

/** `GET /api/share/status`: whether links can be made now, how long they last, and why not when credentials are the problem. */
export function shareStatus(
  share: ShareConfig | undefined,
  sources: CredentialSources = {},
): { configured: boolean; provider: "s3" | null; expiresInDays: number | null; problem: string | null } {
  if (!share) return { configured: false, provider: null, expiresInDays: null, problem: null };
  const creds = resolveShareCredentials(share.s3, sources);
  return { configured: creds.ok, provider: "s3", expiresInDays: share.s3.expiresInDays, problem: creds.ok ? null : creds.problem };
}

/**
 * Uploads the run's standalone report to the private bucket as `<prefix><projectId>/<runId>-<random>.html` and returns a presigned
 * GET link. The random suffix keeps links unguessable and makes every share a new object.
 */
export async function shareRun(runId: string, deps: ShareDeps = {}): Promise<{ url: string; expiresAt: string; key: string; omitted: number }> {
  const share = "share" in deps ? deps.share : config.share;
  const run = getRun(runId);
  if (!run) throw new HttpError(404, `unknown run ${runId}`);
  if (!share) throw new HttpError(400, "sharing is not configured");
  const { s3 } = share;
  const creds = resolveShareCredentials(s3, deps);
  if (!creds.ok) throw new HttpError(400, creds.problem);
  if (ACTIVE.includes(run.status)) throw new HttpError(409, `run ${runId} is still ${run.status}; share it once it has finished`);
  const { html, omitted } = await renderStandaloneReport(run, getProject(run.projectId) ?? null);
  const key = `${s3.prefix}${run.projectId}/${run.id}-${randomBytes(6).toString("base64url")}.html`;
  const c = creds.credentials;
  const keys = c.source === "file" ? { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, sessionToken: c.sessionToken } : {};
  const client: ShareClient = deps.client ?? new S3Client({ bucket: s3.bucket, endpoint: s3.endpoint, region: s3.region, ...keys });
  const expiresIn = s3.expiresInDays * 86_400;
  try {
    await client.write(key, html, { type: "text/html; charset=utf-8" });
  } catch (e) {
    throw new HttpError(502, `upload failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return {
    url: client.presign(key, { method: "GET", expiresIn }),
    expiresAt: new Date((deps.now?.() ?? Date.now()) + expiresIn * 1000).toISOString(),
    key,
    omitted,
  };
}
