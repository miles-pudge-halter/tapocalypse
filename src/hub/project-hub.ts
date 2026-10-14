// What the project form needs from the team-hub sync: the key a project would upload under and how its runs stand, and the
// "also upload the runs already on this machine" backfill.
import { type Project, listProjects } from "../projects/registry";
import type { GitRunner } from "../regression/baseline";
import { listRuns } from "../runs/store";
import type { Run } from "../runs/types";
import { hubIdentityFor, hubKeyFor } from "./identity";
import { activeHubConfig, hubSyncWorker } from "./sync";

export interface ProjectHubInfo {
  /** The key git gives (`host/org/app[#subpath]`); null = no usable remote, an explicit `hubKey` is then required. */
  derivedKey: string | null;
  remoteUrl: string | null;
  subpath: string | null;
  /** Finished runs of this project on this machine. */
  existingRuns: number;
  /** How many of them are uploaded (per this machine's outbox). */
  uploadedRuns: number;
  /** Another shared project here that uploads under the same key. */
  conflictWith: { id: string; name: string } | null;
}

export interface ProjectHubDeps {
  git?: GitRunner;
  projects?: () => Project[];
  runs?: (projectId: string) => Run[];
  uploaded?: () => string[];
}

const FINISHED: readonly Run["status"][] = ["done", "error", "cancelled", "interrupted"];

/** `ValidationResult.hub` of the project form. `id` is absent while a project is being created. */
export async function projectHubInfo(input: { repoPath: string; share?: boolean; hubKey?: string | null; id?: string }, deps: ProjectHubDeps = {}): Promise<ProjectHubInfo> {
  const identity = await hubIdentityFor({ repoPath: input.repoPath }, deps.git);
  const key = input.hubKey || identity.hubKey;

  const finished = input.id ? (deps.runs ?? ((projectId) => listRuns({ projectId })))(input.id).filter((r) => FINISHED.includes(r.status)) : [];
  const uploaded = new Set((deps.uploaded ?? (() => hubSyncWorker().uploadedRunIds()))());

  let conflictWith: ProjectHubInfo["conflictWith"] = null;
  if (key) {
    for (const other of (deps.projects ?? listProjects)()) {
      if (other.id === input.id || other.share !== true) continue;
      if ((other.hubKey ?? (await hubKeyFor(other, deps.git))) === key) {
        conflictWith = { id: other.id, name: other.name };
        break;
      }
    }
  }
  return { derivedKey: identity.hubKey, remoteUrl: identity.remoteUrl, subpath: identity.subpath, existingRuns: finished.length, uploadedRuns: finished.filter((r) => uploaded.has(r.id)).length, conflictWith };
}

/** Queues the project's finished runs that are not on the hub yet, oldest first. Nothing is queued while no hub is configured. */
export function queueBackfill(projectId: string): { queued: number } {
  if (!activeHubConfig()) return { queued: 0 };
  return { queued: hubSyncWorker().push({ projectId }) };
}
