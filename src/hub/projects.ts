import path from "node:path";
import { z } from "zod";
import { HttpError } from "../config";
import { type Project, projectEvents, type ProjectStatus, setProjectSource } from "../projects/registry";
import { listRuns } from "../runs/store";
import { readJsonCached, writeJsonAtomic } from "./files";
import { listLiveRuns } from "./live";
import { hubDir } from "./mode";
import { HubKey, type HubProjectMetaT } from "./protocol";

const UploadBy = z.object({ machine: z.string(), uploader: z.string().nullable() });
const Entry = z.object({
  hubKey: HubKey,
  /** The hub's project id: assigned once, never changes. Uploaded runs get it as `projectId`. */
  id: z.string(),
  name: z.string(),
  remoteUrl: z.string().nullable(),
  subpath: z.string().nullable(),
  defaultBranch: z.string().nullable(),
  /** Where `defaultBranch` came from and the creation time of the run that supplied it: an explicit choice beats a detected one, then the newest run wins. */
  defaultBranchSource: z.enum(["explicit", "detected"]).nullable().default(null),
  defaultBranchRunAt: z.string().nullable().default(null),
  defaultPlatform: z.enum(["android", "ios"]),
  firstSeenAt: z.string(),
  lastUploadAt: z.string(),
  lastUploadBy: UploadBy.nullable().default(null),
  /** An admin set the name with `hub project rename`. Uploads never rename a project (the first upload names it); this only marks an admin-chosen name. */
  nameLocked: z.boolean().default(false),
  /** An admin set the default branch with `hub project set-default-branch`: uploads no longer change it. */
  defaultBranchLocked: z.boolean().default(false),
  /** The token (machine) whose upload first named this hub key; it counts against that token's new-key budget. Null for projects from before this was recorded. */
  createdBy: z.string().nullable().default(null),
});
export type HubProjectEntry = z.infer<typeof Entry>;

const registryFile = () => path.join(hubDir(), "projects.json");
const load = (): HubProjectEntry[] => readJsonCached(registryFile(), z.array(Entry), []);

function save(entries: HubProjectEntry[]): void {
  writeJsonAtomic(registryFile(), entries);
  projectEvents.emit("change");
}

const slugOf = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36)
    .replace(/-+$/, "");

/** `app`, widened to `acme-app` (owner + name) on a collision, then `acme-app-2`, `-3`… */
function allocateId(meta: Pick<HubProjectMetaT, "hubKey" | "subpath">, taken: ReadonlySet<string>): string {
  const segments = (meta.hubKey.split("#")[0] ?? "").split("/").slice(1).filter(Boolean);
  const last = segments.at(-1) ?? "project";
  const subLast = meta.subpath?.split("/").filter(Boolean).at(-1);
  const base = slugOf(subLast ? `${last}-${subLast}` : last) || "project";
  const owner = segments.at(-2);
  const widened = owner ? slugOf(`${owner}-${base}`) : "";
  for (const candidate of [base, widened]) {
    if (candidate && /^[a-z0-9]/.test(candidate) && !taken.has(candidate)) return candidate;
  }
  const stem = widened || base;
  for (let n = 2; ; n++) {
    const candidate = `${stem.slice(0, 36)}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** The default branch after an upload: an explicit setting beats a detected one, and between equals the run created last wins, so backfilling an old run cannot flip it. */
function nextDefaultBranch(existing: HubProjectEntry, meta: HubProjectMetaT, runCreatedAt: string): Pick<HubProjectEntry, "defaultBranch" | "defaultBranchSource" | "defaultBranchRunAt"> {
  const keep = { defaultBranch: existing.defaultBranch, defaultBranchSource: existing.defaultBranchSource, defaultBranchRunAt: existing.defaultBranchRunAt };
  if (existing.defaultBranchLocked || !meta.defaultBranch) return keep;
  const source = meta.defaultBranchSource ?? "detected";
  const take = { defaultBranch: meta.defaultBranch, defaultBranchSource: source, defaultBranchRunAt: runCreatedAt };
  if (existing.defaultBranch === null) return take;
  const rank = (s: "explicit" | "detected" | null): number => (s === "explicit" ? 1 : 0);
  if (rank(source) !== rank(existing.defaultBranchSource)) return rank(source) > rank(existing.defaultBranchSource) ? take : keep;
  return runCreatedAt >= (existing.defaultBranchRunAt ?? "") ? take : keep;
}

/** How many hub keys one token may introduce per 24 hours (uploads and live updates together). */
const NEW_KEYS_PER_DAY = 20;
const DAY_MS = 24 * 3600 * 1000;

/**
 * The hub project for an upload's `hubKey`, created on first sight: two machines' local ids ("app", "acme-app") land in one project.
 * The first upload names it, supplies its repository URL and subpath, and only `hub project rename` changes the name afterwards;
 * the default branch follows `nextDefaultBranch` unless an admin locked it. A token that already introduced 20 new keys in the
 * last 24 hours gets 429 `too_many_projects` for a 21st.
 */
export function touchHubProject(meta: HubProjectMetaT, by: { machine: string; uploader: string | null }, runCreatedAt: string, now: Date = new Date()): HubProjectEntry {
  const entries = load();
  const at = now.toISOString();
  const existing = entries.find((e) => e.hubKey === meta.hubKey);
  if (!existing) {
    const since = now.getTime() - DAY_MS;
    const introduced = entries.filter((e) => e.createdBy === by.machine && Date.parse(e.firstSeenAt) > since).length;
    if (introduced >= NEW_KEYS_PER_DAY) {
      throw new HttpError(429, `this token already created ${NEW_KEYS_PER_DAY} new projects in the last 24 hours; retry later or ask an admin`, "too_many_projects");
    }
    const created: HubProjectEntry = {
      hubKey: meta.hubKey,
      id: allocateId(meta, new Set(entries.map((e) => e.id))),
      name: meta.name,
      remoteUrl: meta.remoteUrl,
      subpath: meta.subpath,
      defaultBranch: meta.defaultBranch,
      defaultBranchSource: meta.defaultBranch ? (meta.defaultBranchSource ?? "detected") : null,
      defaultBranchRunAt: meta.defaultBranch ? runCreatedAt : null,
      defaultPlatform: meta.defaultPlatform,
      firstSeenAt: at,
      lastUploadAt: at,
      lastUploadBy: by,
      nameLocked: false,
      defaultBranchLocked: false,
      createdBy: by.machine,
    };
    save([...entries, created]);
    return created;
  }
  const next: HubProjectEntry = {
    ...existing,
    ...nextDefaultBranch(existing, meta, runCreatedAt),
    remoteUrl: existing.remoteUrl ?? meta.remoteUrl,
    subpath: existing.subpath ?? meta.subpath,
    lastUploadAt: at,
    lastUploadBy: by,
  };
  save(entries.map((e) => (e.hubKey === meta.hubKey ? next : e)));
  return next;
}

/** `hub project rename`: pins the display name so later uploads do not change it. */
export function renameHubProject(hubKey: string, name: string): HubProjectEntry {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 60) throw new HttpError(400, "name must be 1-60 characters");
  const entries = load();
  const found = entries.find((e) => e.hubKey === hubKey);
  if (!found) throw new HttpError(404, `unknown hub project ${hubKey}`);
  const next = { ...found, name: trimmed, nameLocked: true };
  save(entries.map((e) => (e.hubKey === hubKey ? next : e)));
  return next;
}

/** `hub project set-default-branch`: pins the branch (`null` clears it and unlocks, so the next upload detects one again). */
export function setHubDefaultBranch(hubKey: string, branch: string | null): HubProjectEntry {
  const trimmed = branch === null ? null : branch.trim();
  if (trimmed !== null && (!trimmed || trimmed.length > 200)) throw new HttpError(400, "branch must be 1-200 characters");
  const entries = load();
  const found = entries.find((e) => e.hubKey === hubKey);
  if (!found) throw new HttpError(404, `unknown hub project ${hubKey}`);
  const next: HubProjectEntry =
    trimmed === null
      ? { ...found, defaultBranch: null, defaultBranchSource: null, defaultBranchRunAt: null, defaultBranchLocked: false }
      : { ...found, defaultBranch: trimmed, defaultBranchSource: "explicit", defaultBranchRunAt: null, defaultBranchLocked: true };
  save(entries.map((e) => (e.hubKey === hubKey ? next : e)));
  return next;
}

/** `hub project remove`: forgets a project that has no stored and no live runs; 409 `project_not_empty` otherwise. */
export function removeHubProject(hubKey: string): void {
  const entries = load();
  const found = entries.find((e) => e.hubKey === hubKey);
  if (!found) throw new HttpError(404, `unknown hub project ${hubKey}`);
  const runs = listRuns({ projectId: found.id }).length + listLiveRuns().filter((r) => r.projectId === found.id).length;
  if (runs > 0) throw new HttpError(409, `${hubKey} still has ${runs} run(s); remove them first with \`hub unpublish --project ${found.id}\``, "project_not_empty");
  save(entries.filter((e) => e.hubKey !== hubKey));
}

export const listHubProjects = (): HubProjectEntry[] => load();

export const hubProjectById = (id: string): HubProjectEntry | undefined => load().find((e) => e.id === id);

export const hubProjectByKey = (hubKey: string): HubProjectEntry | undefined => load().find((e) => e.hubKey === hubKey);

/** What the overview needs beyond a `Project`: when and by whom the project was first and last seen. */
export function hubProjectInfo(projectId: string): { hubKey: string; firstSeenAt: string; lastUploadAt: string; lastUploadBy: { machine: string; uploader: string | null } | null } | null {
  const entry = hubProjectById(projectId);
  return entry ? { hubKey: entry.hubKey, firstSeenAt: entry.firstSeenAt, lastUploadAt: entry.lastUploadAt, lastUploadBy: entry.lastUploadBy } : null;
}

/** A hub project as the rest of the app sees a project: no repo, no persona, nothing to run. */
function asProject(entry: HubProjectEntry): Project {
  return {
    id: entry.id,
    name: entry.name,
    repoPath: "",
    personaFile: null,
    defaultPackage: "",
    defaultPlatform: entry.defaultPlatform,
    ...(entry.defaultBranch ? { defaultBranch: entry.defaultBranch } : {}),
    hubKey: entry.hubKey,
  };
}

/** Makes `listProjects`/`getProject` (and so every existing caller) answer from the hub registry. */
export function installHubProjects(): void {
  setProjectSource({
    list: () => load().map((e): ProjectStatus => ({ ...asProject(e), status: "ok", problems: [] })),
    get: (id) => {
      const entry = hubProjectById(id);
      return entry ? asProject(entry) : undefined;
    },
  });
}

export interface HubProjectStats {
  runs: number;
  machines: { name: string; uploader: string | null }[];
}

/** Run count and uploaders per hub project, from the stored runs (newest uploader wins per machine). */
export function hubProjectStats(): Map<string, HubProjectStats> {
  const stats = new Map<string, HubProjectStats>();
  for (const run of listRuns()) {
    const entry = stats.get(run.projectId) ?? { runs: 0, machines: [] };
    stats.set(run.projectId, entry);
    entry.runs++;
    if (run.hub && !entry.machines.some((m) => m.name === run.hub!.machine)) entry.machines.push({ name: run.hub.machine, uploader: run.hub.uploader });
  }
  return stats;
}

/** `GET /api/projects` on the hub: the registry view plus what the Projects page and hub home show per project. */
export function hubProjectsView(): (ProjectStatus & {
  hub: { hubKey: string; runs: number; machines: { name: string; uploader: string | null }[]; firstSeenAt: string; lastUploadAt: string; lastUploadBy: { machine: string; uploader: string | null } | null };
})[] {
  const stats = hubProjectStats();
  return load().map((e) => ({
    ...asProject(e),
    status: "ok" as const,
    problems: [],
    hub: {
      hubKey: e.hubKey,
      runs: stats.get(e.id)?.runs ?? 0,
      machines: stats.get(e.id)?.machines ?? [],
      firstSeenAt: e.firstSeenAt,
      lastUploadAt: e.lastUploadAt,
      lastUploadBy: e.lastUploadBy,
    },
  }));
}
