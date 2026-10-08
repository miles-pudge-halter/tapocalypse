import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { GH_BIN, GIT_BIN, HttpError } from "../config";
import type { Project } from "../projects/registry";
import { exec } from "../devices/devices";
import type { PrStatus, PullRequestInfo, Run, RunSource } from "./types";

const optionalText = z.string().trim().optional();

/** Requester-supplied source metadata (POST /api/runs body, `qa_start_run`). */
export const SourceInputSchema = z.object({
  /** Requester's working dir (worktree). Default: project.repoPath. */
  path: optionalText,
  branch: optionalText,
  commit: optionalText,
  prNumber: z.number().int().positive().optional(),
  prTitle: optionalText,
  prUrl: optionalText,
  tickets: z.array(z.string().trim()).optional(),
  labels: z
    .record(z.string(), z.string().trim().max(200))
    .refine((l) => Object.keys(l).length <= 20, "at most 20 labels")
    .optional(),
});
export type SourceInput = z.infer<typeof SourceInputSchema>;

const TICKET_RE = /\b[A-Z][A-Z0-9]+-\d+\b/g;

/** Ticket keys found in the given texts, deduped, first-seen order. */
export function extractTickets(...texts: (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  for (const t of texts) {
    if (!t) continue;
    for (const m of t.matchAll(TICKET_RE)) seen.add(m[0]);
  }
  return [...seen];
}

const URL_REMOTE_RE = /^(?:https?|ssh|git|git\+ssh):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/;
const SCP_REMOTE_RE = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/;
/** `github.com-alias` (ssh config Host alias) → `github.com`. */
const HOST_ALIAS_RE = /^(.+\.[a-z]{2,})-[^.]+$/i;

/** Normalizes a git remote to `https://host/owner/repo`; null when it is not a recognizable remote. */
export function normalizeRemoteUrl(url: string): string | null {
  const raw = url.trim();
  const m = URL_REMOTE_RE.exec(raw) ?? SCP_REMOTE_RE.exec(raw);
  if (!m) return null;
  const host = (HOST_ALIAS_RE.exec(m[1]!)?.[1] ?? m[1]!).toLowerCase();
  if (!host.includes(".")) return null;
  const segments = m[2]!
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/, "")
    .split("/");
  if (segments.length < 2 || segments.some((s) => !s)) return null;
  return `https://${host}/${segments.join("/")}`;
}

async function git(cwd: string, ...args: string[]): Promise<string | null> {
  const r = await exec([GIT_BIN, ...args], { cwd, timeoutMs: 5000 });
  return r.code === 0 ? r.text.trim() : null;
}

/** Absolute realpath of the repo's shared `.git` dir; null when `dir` is not inside a git repo. */
async function commonDir(dir: string): Promise<string | null> {
  const out = await git(dir, "rev-parse", "--git-common-dir");
  if (!out) return null;
  try {
    return realpathSync(path.resolve(dir, out));
  } catch {
    return null;
  }
}

function realpathOrNull(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/** Throws 400 unless `dir` is an absolute path to the project repo or one of its git worktrees. */
async function assertProjectWorktree(project: Project, dir: string): Promise<void> {
  const reject = new HttpError(400, `source.path ${dir} is not a worktree of project ${project.id}`);
  if (!path.isAbsolute(dir) || !existsSync(dir) || !statSync(dir).isDirectory()) throw reject;
  const real = realpathOrNull(dir);
  if (real !== null && real === realpathOrNull(project.repoPath)) return;
  const [theirs, ours] = await Promise.all([commonDir(dir), commonDir(project.repoPath)]);
  if (theirs === null || theirs !== ours) throw reject;
}

/** Reads git state for the run's source (git only — fast; never calls gh). */
export async function resolveSource(project: Project, input: SourceInput | undefined, runTitle: string): Promise<RunSource> {
  if (input?.path) await assertProjectWorktree(project, input.path);
  const dir = path.resolve(input?.path || project.repoPath);

  const [abbrev, sha, subject, status, remote] = await Promise.all([
    git(dir, "rev-parse", "--abbrev-ref", "HEAD"),
    git(dir, "rev-parse", "HEAD"),
    git(dir, "log", "-1", "--format=%s"),
    git(dir, "status", "--porcelain"),
    git(dir, "remote", "get-url", "origin"),
  ]);

  const branch = input?.branch || (abbrev && abbrev !== "HEAD" ? abbrev : null);
  const commit = input?.commit || sha || null;
  const pr: PullRequestInfo | null = input?.prNumber
    ? {
        number: input.prNumber,
        title: input.prTitle || null,
        url: input.prUrl || null,
        state: null,
        baseBranch: null,
        isDraft: null,
        author: null,
      }
    : null;
  const prStatus: PrStatus = pr ? "provided" : branch ? "pending" : "none";

  return {
    path: dir,
    branch,
    commit,
    commitSubject: subject || null,
    dirty: status === null ? null : status.length > 0,
    remoteUrl: remote ? normalizeRemoteUrl(remote) : null,
    pr,
    prStatus,
    tickets: extractTickets(...(input?.tickets ?? []), branch, pr?.title, runTitle),
    labels: { ...input?.labels },
  };
}

const GhPrSchema = z.object({
  number: z.number().int(),
  title: z.string().nullish(),
  url: z.string().nullish(),
  state: z.string().nullish(),
  baseRefName: z.string().nullish(),
  isDraft: z.boolean().nullish(),
  author: z.object({ login: z.string().nullish() }).nullish(),
});

/** Asks gh for the PR of the source's branch (or the provided number). Never throws. */
export async function lookupPullRequest(source: RunSource): Promise<{ pr: PullRequestInfo | null; prStatus: PrStatus }> {
  const provided = source.pr && source.prStatus === "provided" ? source.pr : null;
  const failure = provided ? { pr: provided, prStatus: "provided" as const } : null;
  // Tests point GH_BIN at a nonexistent path after config has loaded, so read the env at call time.
  const gh = process.env.GH_BIN ?? GH_BIN;
  // A branch is passed explicitly so an overridden `source.branch` is honoured; `-`-prefixed values would parse as flags.
  const target = provided ? String(provided.number) : source.branch && !source.branch.startsWith("-") ? source.branch : null;
  const r = await exec(
    [gh, "pr", "view", ...(target ? [target] : []), "--json", "number,title,url,state,baseRefName,isDraft,author"],
    { cwd: source.path, timeoutMs: 15_000, env: { GH_PROMPT_DISABLED: "1" } },
  );
  if (r.code !== 0) {
    if (failure) return failure;
    return /no pull requests found/i.test(r.stderr) ? { pr: null, prStatus: "none" } : { pr: null, prStatus: "error" };
  }
  let parsed: z.infer<typeof GhPrSchema>;
  try {
    parsed = GhPrSchema.parse(JSON.parse(r.text));
  } catch {
    return failure ?? { pr: null, prStatus: "error" };
  }
  const pr: PullRequestInfo = {
    number: parsed.number,
    title: provided?.title ?? parsed.title ?? null,
    url: provided?.url ?? parsed.url ?? null,
    state: parsed.state ?? null,
    baseBranch: parsed.baseRefName ?? null,
    isDraft: parsed.isDraft ?? null,
    author: parsed.author?.login ?? null,
  };
  return { pr, prStatus: provided ? "provided" : "found" };
}

/** All given filters must match; runs without source match none. `commit` is a prefix match. */
export function runMatches(run: Run, f: { branch?: string; pr?: number; ticket?: string; commit?: string }): boolean {
  const s = run.source;
  if (!s) return false;
  if (f.branch !== undefined && s.branch !== f.branch) return false;
  if (f.pr !== undefined && s.pr?.number !== f.pr) return false;
  if (f.ticket !== undefined && !s.tickets.includes(f.ticket.toUpperCase())) return false;
  if (f.commit !== undefined && !(s.commit !== null && f.commit !== "" && s.commit.toLowerCase().startsWith(f.commit.toLowerCase()))) {
    return false;
  }
  return true;
}
