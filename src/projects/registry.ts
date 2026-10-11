import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { CONFIG_PATH, HttpError, REPO_ROOT } from "../config";
import { HARNESS_IDS, type HarnessId } from "../harness/types";
import { resolveUnder } from "../reports/reports";
import { parsePersona } from "../runs/prompt";
import type { Platform } from "../runs/types";

export interface Project {
  id: string;
  name: string;
  repoPath: string;
  /** Relative to repoPath; null = the built-in default persona. */
  personaFile: string | null;
  /**
   * Legacy: the repo-relative folder older runs wrote reports and screenshots into. Read from config so those runs keep
   * rendering; never suggested, created or offered for editing. New runs store artefacts in Tapocalypse's data dir.
   */
  reportsDir?: string;
  defaultPackage: string;
  defaultPlatform: Platform;
  /** Branch regression baselines fall back to (e.g. `develop`); absent = origin/HEAD, then main/master. */
  defaultBranch?: string;
  /** Per-project agent runtime overrides (harness, harness-native model and effort); absent = defaults. */
  agent?: ProjectAgent;
}

export interface ProjectAgent {
  harness?: HarnessId;
  model?: string;
  effort?: string;
}

const ProjectAgentSchema = z.object({
  harness: z.enum(HARNESS_IDS).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  effort: z.string().trim().min(1).max(40).optional(),
});

export interface ProjectStatus extends Project {
  status: "ok" | "invalid";
  problems: string[];
}

export type ProjectInput = Omit<Project, "personaFile" | "reportsDir"> & {
  personaFile?: string | null;
};

export interface ValidationResult {
  ok: boolean;
  errors: Partial<Record<keyof Project, string>>;
  warnings: string[];
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const PACKAGE_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_-]+)+$/;
/** No leading dash (would read as a git option), no whitespace or control characters. */
const BRANCH_RE = /^[^\s\p{Cc}-][^\s\p{Cc}]*$/u;
const FIELD_ORDER: (keyof Project)[] = [
  "id",
  "name",
  "repoPath",
  "personaFile",
  "reportsDir",
  "defaultPackage",
  "defaultPlatform",
  "defaultBranch",
  "agent",
];
const BUNDLED_PERSONA = path.join(REPO_ROOT, "personas", "default-mobile-qa.md");

type Raw = Record<string, unknown>;
type Errors = ValidationResult["errors"];

interface Entry {
  /** What is written back to the config file (untouched for invalid entries loaded from disk). */
  raw: Raw;
  project: Project;
}

let entries: Entry[] = [];
let loaded = false;

export const projectEvents = new EventEmitter();

const isRaw = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Best-effort typed view of a stored entry, used when it fails validation. */
function coerce(raw: Raw): Project {
  const agent = ProjectAgentSchema.safeParse(raw.agent);
  return {
    id: str(raw.id),
    name: str(raw.name),
    repoPath: str(raw.repoPath),
    personaFile: typeof raw.personaFile === "string" && raw.personaFile ? raw.personaFile : null,
    ...(str(raw.reportsDir) ? { reportsDir: str(raw.reportsDir) } : {}),
    ...(str(raw.defaultBranch).trim() ? { defaultBranch: str(raw.defaultBranch).trim() } : {}),
    defaultPackage: str(raw.defaultPackage),
    defaultPlatform: raw.defaultPlatform === "ios" ? "ios" : "android",
    ...(agent.success && Object.keys(agent.data).length > 0 ? { agent: agent.data } : {}),
  };
}

interface Check {
  project: Project | null;
  result: ValidationResult;
}

/** Validates a complete project record. `unique` additionally requires the id to be unused. */
function check(input: Raw, unique: boolean): Check {
  const errors: Errors = {};
  const warnings: string[] = [];

  const id = str(input.id).trim();
  if (!ID_RE.test(id)) errors.id = "must be 1-40 chars: lowercase letters, digits and dashes, starting with a letter or digit";
  else if (unique && entries.some((e) => e.project.id === id)) errors.id = `project ${id} already exists`;

  const name = str(input.name).trim();
  if (name.length < 1 || name.length > 60) errors.name = "must be 1-60 characters";

  const repoRaw = str(input.repoPath).trim();
  const repoPath = path.resolve(expandHome(repoRaw));
  let repoOk = false;
  if (!repoRaw) errors.repoPath = "required";
  else if (!path.isAbsolute(expandHome(repoRaw))) errors.repoPath = "must be an absolute path";
  else if (!fs.existsSync(repoPath)) errors.repoPath = "does not exist";
  else if (!isDirectory(repoPath)) errors.repoPath = "is not a directory";
  else repoOk = true;

  let personaFile: string | null = null;
  if (input.personaFile !== undefined && input.personaFile !== null && input.personaFile !== "") {
    if (typeof input.personaFile !== "string") errors.personaFile = "must be a path relative to the repository";
    else {
      const rel = input.personaFile.trim();
      personaFile = rel;
      if (path.isAbsolute(rel)) errors.personaFile = "must be relative to the repository";
      else if (repoOk) {
        const file = resolveUnder(repoPath, rel);
        if (!file) errors.personaFile = "must stay inside the repository";
        else if (!isFile(file)) errors.personaFile = "file does not exist";
        else {
          try {
            if (!parsePersona(fs.readFileSync(file, "utf8")).body.trim()) errors.personaFile = "persona file is empty";
          } catch (e) {
            errors.personaFile = `cannot read persona: ${(e as Error).message}`;
          }
        }
      }
    }
  }

  let reportsDir: string | undefined;
  if (input.reportsDir !== undefined && input.reportsDir !== null && input.reportsDir !== "") {
    if (typeof input.reportsDir !== "string") errors.reportsDir = "must be a path relative to the repository";
    else {
      const rel = input.reportsDir.trim().replace(/[\\/]+$/, "");
      if (path.isAbsolute(rel)) errors.reportsDir = "must be relative to the repository";
      else if (rel.split(/[\\/]/).includes("..")) errors.reportsDir = 'must not contain ".." segments';
      else if (repoOk && !resolveUnder(repoPath, rel)) errors.reportsDir = "must stay inside the repository";
      else if (rel) reportsDir = rel;
    }
  }

  const defaultPackage = str(input.defaultPackage).trim();
  if (!PACKAGE_RE.test(defaultPackage)) errors.defaultPackage = "must look like com.example.app";

  const defaultPlatform = input.defaultPlatform;
  if (defaultPlatform !== "android" && defaultPlatform !== "ios") errors.defaultPlatform = 'must be "android" or "ios"';

  let defaultBranch: string | undefined;
  if (input.defaultBranch !== undefined && input.defaultBranch !== null && input.defaultBranch !== "") {
    if (typeof input.defaultBranch !== "string") errors.defaultBranch = "must be a branch name";
    else {
      const name = input.defaultBranch.trim();
      if (name.length > 200) errors.defaultBranch = "must be at most 200 characters";
      else if (!BRANCH_RE.test(name) || name.includes("..")) errors.defaultBranch = "must be a plain branch name such as develop or release/1.x";
      else defaultBranch = name;
    }
  }

  let agent: ProjectAgent | undefined;
  if (input.agent !== undefined && input.agent !== null) {
    const parsed = ProjectAgentSchema.safeParse(input.agent);
    if (!parsed.success) errors.agent = parsed.error.issues[0]!.message;
    else if (Object.keys(parsed.data).length > 0) agent = parsed.data;
  }

  if (repoOk) {
    if (!fs.existsSync(path.join(repoPath, ".git"))) warnings.push("Not a git repository: runs will not record branch/commit/PR.");
  }
  if (defaultPlatform === "ios" && !Bun.which("xcrun")) warnings.push("iOS simulators unavailable on this machine.");

  const result: ValidationResult = { ok: Object.keys(errors).length === 0, errors, warnings };
  if (!result.ok || (defaultPlatform !== "android" && defaultPlatform !== "ios")) return { project: null, result };
  return {
    project: {
      id,
      name,
      repoPath,
      personaFile,
      ...(reportsDir ? { reportsDir } : {}),
      defaultPackage,
      defaultPlatform,
      ...(defaultBranch ? { defaultBranch } : {}),
      ...(agent ? { agent } : {}),
    },
    result,
  };
}

function problemsOf(errors: Errors): string[] {
  return FIELD_ORDER.filter((f) => errors[f]).map((f) => `${f}: ${errors[f]}`);
}

function statusOf(entry: Entry): ProjectStatus {
  const problems = problemsOf(check(entry.raw, false).result.errors);
  const firstWithId = entries.find((e) => e.project.id === entry.project.id);
  if (firstWithId && firstWithId !== entry) problems.unshift("id: duplicate project id");
  return { ...entry.project, status: problems.length === 0 ? "ok" : "invalid", problems };
}

function readConfigFile(): Raw {
  const parsed: unknown = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  if (!isRaw(parsed)) throw new Error(`config: ${CONFIG_PATH} is not a JSON object`);
  return parsed;
}

function load(): void {
  const stored = readConfigFile().projects;
  entries = (Array.isArray(stored) ? stored : []).filter(isRaw).map((raw) => {
    const { project } = check(raw, false);
    return { raw: project ? { ...project } : raw, project: project ?? coerce(raw) };
  });
  loaded = true;
  for (const entry of entries) {
    for (const problem of statusOf(entry).problems) {
      console.warn(`project ${entry.project.id || "(no id)"} invalid: ${problem}`);
    }
  }
}

function ensureLoaded(): void {
  if (!loaded) load();
}

/** Atomically replaces `projects` in the config file, preserving every other key. */
function persist(next: Entry[]): void {
  const file = readConfigFile();
  file.projects = next.map((e) => e.raw);
  const tmp = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`);
  fs.renameSync(tmp, CONFIG_PATH);
}

function commit(next: Entry[]): void {
  persist(next);
  entries = next;
  projectEvents.emit("change");
}

function find(id: string): Entry {
  ensureLoaded();
  const entry = entries.find((e) => e.project.id === id);
  if (!entry) throw new HttpError(404, `unknown project ${id}`);
  return entry;
}

function firstError(result: ValidationResult): string {
  const field = FIELD_ORDER.find((f) => result.errors[f])!;
  return `${field}: ${result.errors[field]}`;
}

export function initProjects(): void {
  load();
}

export function listProjects(): ProjectStatus[] {
  ensureLoaded();
  return entries.map(statusOf);
}

export function getProject(id: string): Project | undefined {
  ensureLoaded();
  const entry = entries.find((e) => e.project.id === id);
  return entry && statusOf(entry).status === "ok" ? entry.project : undefined;
}

export function validateProject(input: unknown, mode: "create" | "update", existingId?: string): ValidationResult {
  ensureLoaded();
  const given: Raw = isRaw(input) ? input : {};
  if (mode === "create") return check(given, true).result;
  const existing = entries.find((e) => e.project.id === existingId);
  const result = check({ ...existing?.project, ...given }, false).result;
  if (existingId !== undefined && given.id !== undefined && given.id !== existingId) result.errors.id = "id cannot be changed";
  return { ...result, ok: Object.keys(result.errors).length === 0 };
}

export function createProject(input: unknown): ProjectStatus {
  ensureLoaded();
  if (!isRaw(input)) throw new HttpError(400, "body must be a JSON object");
  const id = str(input.id).trim();
  if (id && entries.some((e) => e.project.id === id)) throw new HttpError(409, `project ${id} already exists`);
  const { project, result } = check(input, true);
  if (!project) throw new HttpError(400, firstError(result));
  const entry: Entry = { raw: { ...project }, project };
  commit([...entries, entry]);
  return statusOf(entry);
}

export function updateProject(id: string, patch: unknown): ProjectStatus {
  const current = find(id);
  if (!isRaw(patch)) throw new HttpError(400, "body must be a JSON object");
  if (patch.id !== undefined && patch.id !== id) throw new HttpError(400, "id: id cannot be changed");
  const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  const { project, result } = check({ ...current.project, ...defined, id }, false);
  if (!project) throw new HttpError(400, firstError(result));
  const entry: Entry = { raw: { ...project }, project };
  commit(entries.map((e) => (e === current ? entry : e)));
  return statusOf(entry);
}

export function deleteProject(id: string, activeRunIds: string[]): void {
  const current = find(id);
  if (activeRunIds.length > 0) throw new HttpError(409, `project ${id} has active runs: ${activeRunIds.join(", ")}`);
  commit(entries.filter((e) => e !== current));
}

export function resolvePersonaPath(project: Project): string {
  return project.personaFile ? path.resolve(project.repoPath, project.personaFile) : BUNDLED_PERSONA;
}
