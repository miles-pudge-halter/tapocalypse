import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { HttpError, REPO_ROOT } from "./config";
import type { Project } from "./projects/registry";
import type { Platform } from "./runs/types";

export interface SuiteCheck {
  id: string;
  title: string;
}

/** A reusable, version-controlled QA brief stored in the project repo at `.tapocalypse/suites/<id>.md`. */
export interface Suite {
  id: string;
  title: string;
  brief: string;
  checks?: SuiteCheck[];
  /** Absent = runnable on any platform. */
  platforms?: Platform[];
  model?: string;
}

export interface SaveSuiteInput extends Suite {
  overwrite?: boolean;
}

/** Built-in brief starter shipped with Tapocalypse (`templates/briefs/*.md`). */
export interface Template {
  id: string;
  title: string;
  description: string;
  brief: string;
}

export const MAX_TITLE_LENGTH = 200;
export const MAX_BRIEF_LENGTH = 20_000;
export const MAX_SUITE_CHECKS = 50;

const SUITE_ID_RE = /^[a-z0-9-]+$/;
const CHECK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/;
const PLATFORMS: Platform[] = ["android", "ios"];

/** Frontmatter values: scalar, list of scalars, or list of flat maps (the only shapes suites need). */
export type FrontmatterValue = string | string[] | Record<string, string>[];

function parseScalar(raw: string): string {
  const v = raw.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(v);
      if (typeof parsed === "string") return parsed;
    } catch {
      // not valid JSON escaping: fall through to the plain unquote below
    }
    return v.slice(1, -1);
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

function parseInlineList(raw: string): string[] {
  const inner = raw.trim().replace(/^\[/, "").replace(/\]$/, "");
  const items = inner.match(/"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^,]+/g) ?? [];
  return items.map(parseScalar).filter(Boolean);
}

/**
 * Parses the small YAML subset used by suites and templates: `key: scalar`, `key: [a, b]`, and block lists
 * (`- scalar` or `- k: v` + indented `k: v` lines). Text without a closing `---` has no frontmatter.
 */
export function parseFrontmatter(text: string): { meta: Record<string, FrontmatterValue>; body: string } {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[0]?.trim() !== "---") return { meta: {}, body: lines.join("\n").trim() };
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (end < 0) return { meta: {}, body: lines.join("\n").trim() };

  const meta: Record<string, FrontmatterValue> = {};
  let i = 1;
  while (i < end) {
    const m = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(lines[i]!);
    i++;
    if (!m) continue;
    const key = m[1]!;
    const rest = m[2]!.trim();
    if (rest.startsWith("[")) {
      meta[key] = parseInlineList(rest);
      continue;
    }
    if (rest) {
      meta[key] = parseScalar(rest);
      continue;
    }
    const scalars: string[] = [];
    const maps: Record<string, string>[] = [];
    while (i < end) {
      const line = lines[i]!;
      if (line.trim() === "" || line.trimStart().startsWith("#")) {
        i++;
        continue;
      }
      const item = /^\s*-\s*(.*)$/.exec(line);
      if (item) {
        const kv = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(item[1]!);
        if (kv) maps.push({ [kv[1]!]: parseScalar(kv[2]!) });
        else scalars.push(parseScalar(item[1]!));
      } else if (/^\s+\S/.test(line) && maps.length > 0) {
        const kv = /^\s+([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(line);
        if (kv) maps[maps.length - 1]![kv[1]!] = parseScalar(kv[2]!);
      } else {
        break;
      }
      i++;
    }
    meta[key] = maps.length > 0 ? maps : scalars.length > 0 ? scalars : "";
  }
  return { meta, body: lines.slice(end + 1).join("\n").trim() };
}

function metaString(meta: Record<string, FrontmatterValue>, key: string): string | undefined {
  const v = meta[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function quote(value: string): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return /^[A-Za-z0-9][A-Za-z0-9 _.,()/+-]*$/.test(oneLine) ? oneLine : JSON.stringify(oneLine);
}

function suitesDir(project: Project): string {
  return path.join(project.repoPath, ".tapocalypse", "suites");
}

function suiteFile(project: Project, id: string): string {
  return path.join(suitesDir(project), `${id}.md`);
}

function assertSuiteId(id: string): void {
  if (!SUITE_ID_RE.test(id)) throw new HttpError(400, "suite id must match [a-z0-9-]+");
}

/** `platforms: [android, ios]`, `platforms: android` or `platforms: android, ios`; case-insensitive, unknown names are an error. */
function parsePlatforms(suiteId: string, value: FrontmatterValue | undefined): Platform[] {
  const names = (typeof value === "string" ? value.split(/[,\s]+/) : Array.isArray(value) ? value : [])
    .filter((p): p is string => typeof p === "string")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  const unknown = names.filter((p) => !PLATFORMS.includes(p as Platform));
  if (unknown.length > 0) {
    throw new HttpError(400, `suite ${suiteId}: unknown platform ${unknown.map((p) => JSON.stringify(p)).join(", ")} (use android and/or ios)`);
  }
  return [...new Set(names as Platform[])];
}

function parseSuite(id: string, text: string): Suite {
  const { meta, body } = parseFrontmatter(text);
  const suite: Suite = { id, title: metaString(meta, "title") ?? id, brief: body };
  const checks = Array.isArray(meta.checks) ? meta.checks : [];
  const parsedChecks = checks
    .flatMap((c) => (typeof c === "object" && c.id && c.title ? [{ id: c.id, title: c.title.slice(0, MAX_TITLE_LENGTH) }] : []))
    .slice(0, MAX_SUITE_CHECKS);
  if (parsedChecks.length > 0) suite.checks = parsedChecks;
  const platforms = parsePlatforms(id, meta.platforms);
  if (platforms.length > 0) suite.platforms = platforms;
  const model = metaString(meta, "model");
  if (model) suite.model = model;
  return suite;
}

export function getSuite(project: Project, id: string): Suite | null {
  if (!SUITE_ID_RE.test(id)) return null;
  let text: string;
  try {
    text = readFileSync(suiteFile(project, id), "utf8");
  } catch {
    return null;
  }
  return parseSuite(id, text);
}

export function listSuites(project: Project): Suite[] {
  let names: string[];
  try {
    names = readdirSync(suitesDir(project));
  } catch {
    return [];
  }
  return names
    .flatMap((name) => {
      const id = name.endsWith(".md") ? name.slice(0, -3) : null;
      return id && SUITE_ID_RE.test(id) ? [id] : [];
    })
    .sort()
    .flatMap((id) => {
      try {
        const suite = getSuite(project, id);
        return suite ? [suite] : [];
      } catch (e) {
        console.warn(`suites: skipping ${id}: ${e instanceof Error ? e.message : String(e)}`);
        return [];
      }
    });
}

/** Validates and writes `<repo>/.tapocalypse/suites/<id>.md`; 409 when it exists and `overwrite` is not set. */
export function saveSuite(project: Project, input: SaveSuiteInput): Suite {
  assertSuiteId(input.id);
  const title = input.title.replace(/\s+/g, " ").trim();
  const brief = input.brief.trim();
  if (!title || !brief) throw new HttpError(400, "title and brief are required");
  if (title.length > MAX_TITLE_LENGTH) throw new HttpError(400, `title must be at most ${MAX_TITLE_LENGTH} characters`);
  if (brief.length > MAX_BRIEF_LENGTH) throw new HttpError(400, `brief must be at most ${MAX_BRIEF_LENGTH} characters`);

  const checks = input.checks ?? [];
  if (checks.length > MAX_SUITE_CHECKS) throw new HttpError(400, `a suite can have at most ${MAX_SUITE_CHECKS} checks`);
  const seen = new Set<string>();
  for (const c of checks) {
    if (!CHECK_ID_RE.test(c.id)) throw new HttpError(400, `invalid check id ${JSON.stringify(c.id)}`);
    if (!c.title.trim()) throw new HttpError(400, `check ${c.id} needs a title`);
    if (c.title.length > MAX_TITLE_LENGTH) throw new HttpError(400, `check ${c.id} title must be at most ${MAX_TITLE_LENGTH} characters`);
    if (seen.has(c.id)) throw new HttpError(400, `duplicate check id ${c.id}`);
    seen.add(c.id);
  }
  const platforms = input.platforms ?? [];
  if (platforms.some((p) => !PLATFORMS.includes(p))) throw new HttpError(400, "platforms must be android and/or ios");
  const model = input.model?.trim();

  const head = ["---", `title: ${quote(title)}`];
  if (platforms.length > 0) head.push(`platforms: [${[...new Set(platforms)].join(", ")}]`);
  if (model) head.push(`model: ${quote(model)}`);
  if (checks.length > 0) {
    head.push("checks:");
    for (const c of checks) head.push(`  - id: ${quote(c.id)}`, `    title: ${quote(c.title)}`);
  }
  head.push("---");

  const file = suiteFile(project, input.id);
  if (!input.overwrite && getSuite(project, input.id)) throw new HttpError(409, `suite ${input.id} already exists`);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${head.join("\n")}\n\n${brief}\n`);
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
  const saved = getSuite(project, input.id);
  if (!saved) throw new HttpError(500, `suite ${input.id} was not written`);
  return saved;
}

export function listTemplates(dir = path.join(REPO_ROOT, "templates", "briefs")): Template[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith(".md"))
    .sort()
    .flatMap((name) => {
      const id = name.slice(0, -3);
      try {
        const { meta, body } = parseFrontmatter(readFileSync(path.join(dir, name), "utf8"));
        if (!body) return [];
        return [{ id, title: metaString(meta, "title") ?? id, description: metaString(meta, "description") ?? "", brief: body }];
      } catch {
        return [];
      }
    });
}
