import { GIT_BIN } from "../config";
import { exec } from "../devices/devices";
import type { Project } from "../projects/registry";
import type { GitRunner } from "../regression/baseline";
import { normalizeRemoteUrl } from "../runs/source";
import { HubKey } from "./protocol";

/** What the hub needs to know about where a project lives. `hubKey` null = underivable (no usable remote, no explicit key). */
export interface HubIdentity {
  hubKey: string | null;
  remoteUrl: string | null;
  subpath: string | null;
}

type KeyedProject = Pick<Project, "repoPath"> & { hubKey?: string };

const TTL_MS = 10 * 60_000;

const spawnGit: GitRunner = async (cwd, args) => {
  const r = await exec([GIT_BIN, ...args], { cwd, timeoutMs: 5000 });
  return r.code === 0 ? r.text.trim() : null;
};

const deps: { git: GitRunner; now: () => number } = { git: spawnGit, now: Date.now };

/** A URL without its query string and fragment: `?token=…` in a remote must not name a project or travel to the hub. */
export const withoutQueryAndFragment = (url: string): string => url.replace(/[?#].*$/s, "");

/** `https://host/Org/App` + `apps/mobile` → `host/org/app#apps/mobile`; null when the result is not a valid HubKey. */
function keyFrom(remoteUrl: string, subpath: string | null): string | null {
  const key = `${remoteUrl.replace(/^https:\/\//, "")}${subpath ? `#${subpath}` : ""}`.toLowerCase();
  return HubKey.safeParse(key).success ? key : null;
}

/** Remote URL (credentials dropped by normalisation) and monorepo subpath of the repo, from git. */
async function readGit(repoPath: string, git: GitRunner): Promise<{ remoteUrl: string | null; subpath: string | null }> {
  const [remote, prefix] = await Promise.all([
    git(repoPath, ["remote", "get-url", "origin"]),
    git(repoPath, ["rev-parse", "--show-prefix"]),
  ]);
  const remoteUrl = remote ? normalizeRemoteUrl(withoutQueryAndFragment(remote.trim())) : null;
  const subpath = prefix?.replace(/\/+$/, "").toLowerCase() || null;
  return { remoteUrl, subpath };
}

/**
 * The project's identity on the hub: its explicit `hubKey`, else `host/org/app[#subpath]` derived from the git
 * remote. A remote that is a local path or unreadable gives `hubKey: null`: sharing then needs an explicit key.
 */
export async function hubIdentityFor(project: KeyedProject, git: GitRunner = deps.git): Promise<HubIdentity> {
  const { remoteUrl, subpath } = await readGit(project.repoPath, git).catch(() => ({ remoteUrl: null, subpath: null }));
  const derived = remoteUrl ? keyFrom(remoteUrl, subpath) : null;
  return { hubKey: project.hubKey ?? derived, remoteUrl, subpath };
}

export async function hubKeyFor(project: KeyedProject, git: GitRunner = deps.git): Promise<string | null> {
  if (project.hubKey) return project.hubKey;
  const key = (await hubIdentityFor(project, git)).hubKey;
  remember(project.repoPath, key);
  return key;
}

// ---------------------------------------------------------------------------------------------------------------
// Synchronous view for validation, which cannot await git: remembered per repo, refreshed in the background.
// ---------------------------------------------------------------------------------------------------------------

const derived = new Map<string, { key: string | null; at: number }>();
const refreshing = new Set<string>();
const listeners = new Set<() => void>();
let epoch = 0;

function remember(repoPath: string, key: string | null): void {
  const before = derived.get(repoPath);
  derived.set(repoPath, { key, at: deps.now() });
  if (before === undefined || before.key !== key) for (const fn of listeners) fn();
}

/**
 * The key derived from the repo's git remote (explicit `hubKey` settings are the caller's business): the remembered
 * answer, null when the repo has no usable remote, undefined until git has been asked. Never blocks; asks git in the
 * background when nothing (or something older than 10 min) is remembered.
 */
export function derivedHubKey(repoPath: string): string | null | undefined {
  const hit = derived.get(repoPath);
  if ((!hit || deps.now() - hit.at >= TTL_MS) && !refreshing.has(repoPath)) {
    refreshing.add(repoPath);
    const started = epoch;
    const git = deps.git;
    void hubIdentityFor({ repoPath }, git)
      .then((id) => {
        if (started === epoch) remember(repoPath, id.hubKey);
      })
      .finally(() => refreshing.delete(repoPath));
  }
  return hit?.key;
}

/** Called whenever a remembered derived key changes (registry statuses depend on it). */
export function onDerivedHubKeyChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Test seam: swaps the git runner / clock and forgets what was remembered. No argument restores the defaults. */
export function setHubIdentityDeps(next: Partial<typeof deps> = {}): void {
  deps.git = next.git ?? spawnGit;
  deps.now = next.now ?? Date.now;
  derived.clear();
  refreshing.clear();
  epoch++;
}
