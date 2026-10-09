import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HttpError } from "../src/config";
import type { Project } from "../src/projects/registry";
import { extractTickets, lookupPullRequest, normalizeRemoteUrl, resolveSource, runMatches } from "../src/runs/source";
import type { Run, RunSource } from "../src/runs/types";

// gh must never be reached for real: config's GH_BIN is read at import time, so lookup also honours this env at call time.
const savedGh = process.env.GH_BIN;
process.env.GH_BIN = "/nonexistent/gh-for-tests";

const savedGitEnv = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM };
// Keep the developer's gitconfig (url.insteadOf, hooks, signing) out of both the fixtures and the code under test.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: GIT_ENV });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

let root: string;
let repo: string;
let worktree: string;
let unrelated: string;
let plain: string;
let project: Project;
let headSha: string;

const projectAt = (repoPath: string): Project => ({ ...project, repoPath });

beforeAll(() => {
  // macOS tmpdir is under the /var → /private/var symlink; git reports resolved paths.
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tapocalypse-source-")));
  repo = path.join(root, "repo");
  worktree = path.join(root, "wt");
  unrelated = path.join(root, "unrelated");
  plain = path.join(root, "plain");
  for (const d of [repo, unrelated, plain]) fs.mkdirSync(d);

  git(repo, "init", "-q", "-b", "main");
  git(repo, "commit", "-q", "--allow-empty", "-m", "initial commit");
  git(repo, "remote", "add", "origin", "git@github.com-work:acme/shop-app.git");
  git(repo, "worktree", "add", "-q", "-b", "feat/ABC-1-x", worktree);
  headSha = git(repo, "rev-parse", "HEAD");
  git(unrelated, "init", "-q", "-b", "main");
  git(unrelated, "commit", "-q", "--allow-empty", "-m", "other");

  project = {
    id: "p",
    name: "P",
    repoPath: repo,
    personaFile: "persona.md",
    reportsDir: "qa",
    defaultPackage: "com.example",
    defaultPlatform: "android",
  };
});

afterAll(() => {
  for (const [k, v] of Object.entries(savedGitEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (savedGh === undefined) delete process.env.GH_BIN;
  else process.env.GH_BIN = savedGh;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("extractTickets", () => {
  test("finds keys in branch names", () => {
    expect(extractTickets("fix/ACME-528-redact")).toEqual(["ACME-528"]);
  });

  test("dedupes across texts and keeps first-seen order", () => {
    expect(extractTickets("fix/ACME-528-redact", "Redact tokens [ACME-528]", "ABC-7 and ACME-528 and XY9-12", null, undefined)).toEqual([
      "ACME-528",
      "ABC-7",
      "XY9-12",
    ]);
  });

  test("ignores lowercase and number-less keys", () => {
    expect(extractTickets("acme-528 ABC- X-1 ABC-x")).toEqual([]);
  });
});

describe("normalizeRemoteUrl", () => {
  test("ssh scp-style with a host alias", () => {
    expect(normalizeRemoteUrl("git@github.com-work:acme/shop-app.git")).toBe(
      "https://github.com/acme/shop-app",
    );
  });

  test("https with .git suffix", () => {
    expect(normalizeRemoteUrl("https://github.com/o/r.git")).toBe("https://github.com/o/r");
  });

  test("ssh:// url", () => {
    expect(normalizeRemoteUrl("ssh://git@github.com/o/r.git")).toBe("https://github.com/o/r");
  });

  test("embedded credentials are dropped", () => {
    expect(normalizeRemoteUrl("https://user:token@github.com/o/r")).toBe("https://github.com/o/r");
  });

  test("garbage and local paths are null", () => {
    expect(normalizeRemoteUrl("not a url")).toBeNull();
    expect(normalizeRemoteUrl("/srv/git/repo.git")).toBeNull();
    expect(normalizeRemoteUrl("")).toBeNull();
  });
});

describe("resolveSource", () => {
  test("defaults to the project repo and detects git state", async () => {
    const s = await resolveSource(project, undefined, "smoke run");
    expect(s).toMatchObject({
      path: repo,
      branch: "main",
      commit: headSha,
      commitSubject: "initial commit",
      dirty: false,
      remoteUrl: "https://github.com/acme/shop-app",
      pr: null,
      prStatus: "pending",
      tickets: [],
      labels: {},
    });
  });

  test("a worktree of the project is accepted and its branch detected", async () => {
    const s = await resolveSource(project, { path: worktree }, "smoke");
    expect(s).toMatchObject({
      path: worktree,
      branch: "feat/ABC-1-x",
      commit: headSha,
      commitSubject: "initial commit",
      dirty: false,
      tickets: ["ABC-1"],
      prStatus: "pending",
    });
  });

  test("uncommitted changes mark the source dirty", async () => {
    fs.writeFileSync(path.join(worktree, "scratch.txt"), "x");
    try {
      expect((await resolveSource(project, { path: worktree }, "t")).dirty).toBe(true);
    } finally {
      fs.rmSync(path.join(worktree, "scratch.txt"));
    }
  });

  test("tickets: explicit first, then branch, then run title", async () => {
    const s = await resolveSource(project, { path: worktree, tickets: ["ZZ-9"] }, "check XY-2");
    expect(s.tickets).toEqual(["ZZ-9", "ABC-1", "XY-2"]);
  });

  test("a path from an unrelated repo is rejected", async () => {
    const err = await resolveSource(project, { path: unrelated }, "t").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ status: 400, message: `source.path ${unrelated} is not a worktree of project p` });
  });

  test("relative, missing and non-git paths are rejected", async () => {
    for (const p of ["relative/dir", path.join(root, "missing"), plain]) {
      const err = await resolveSource(project, { path: p }, "t").catch((e: unknown) => e);
      expect(err).toMatchObject({ status: 400, message: `source.path ${p} is not a worktree of project p` });
    }
  });

  test("explicit branch, commit and prNumber override detection", async () => {
    const s = await resolveSource(
      project,
      { path: worktree, branch: "release/9", commit: "abc1234", prNumber: 609, prTitle: "Fix it [QQ-3]", prUrl: "https://x/pr/609", labels: { flavor: "dev" } },
      "t",
    );
    expect(s).toMatchObject({
      branch: "release/9",
      commit: "abc1234",
      commitSubject: "initial commit",
      pr: { number: 609, title: "Fix it [QQ-3]", url: "https://x/pr/609", state: null, baseBranch: null, isDraft: null, author: null },
      prStatus: "provided",
      labels: { flavor: "dev" },
    });
    expect(s.tickets).toEqual(["QQ-3"]);
  });

  test("a non-git default repoPath yields nulls instead of an error", async () => {
    const s = await resolveSource(projectAt(plain), undefined, "t");
    expect(s).toEqual({
      path: plain,
      branch: null,
      commit: null,
      commitSubject: null,
      dirty: null,
      remoteUrl: null,
      pr: null,
      prStatus: "none",
      tickets: [],
      labels: {},
    });
  });

  test("the project's own path is accepted even when it is not a git repo", async () => {
    const s = await resolveSource(projectAt(plain), { path: plain }, "t");
    expect(s).toMatchObject({ path: plain, branch: null, prStatus: "none" });
  });
});

describe("lookupPullRequest", () => {
  const source = (over: Partial<RunSource> = {}): RunSource => ({
    path: repo,
    branch: "main",
    commit: null,
    commitSubject: null,
    dirty: null,
    remoteUrl: null,
    pr: null,
    prStatus: "pending",
    tickets: [],
    labels: {},
    ...over,
  });

  test("an unavailable gh is reported as error", async () => {
    expect(await lookupPullRequest(source())).toEqual({ pr: null, prStatus: "error" });
  });

  test("a provided PR survives a failed lookup", async () => {
    const pr = { number: 5, title: "t", url: null, state: null, baseBranch: null, isDraft: null, author: null };
    expect(await lookupPullRequest(source({ pr, prStatus: "provided" }))).toEqual({ pr, prStatus: "provided" });
  });
});

describe("runMatches", () => {
  const withSource = (over: Partial<RunSource>): Run =>
    ({
      source: {
        path: repo,
        branch: "fix/ACME-528-redact",
        commit: "0123456789abcdef0123456789abcdef01234567",
        commitSubject: null,
        dirty: false,
        remoteUrl: null,
        pr: { number: 609, title: null, url: null, state: null, baseBranch: null, isDraft: null, author: null },
        prStatus: "found",
        tickets: ["ACME-528"],
        labels: {},
        ...over,
      },
    }) as Run;

  test("each filter matches on its own", () => {
    const run = withSource({});
    expect(runMatches(run, { branch: "fix/ACME-528-redact" })).toBe(true);
    expect(runMatches(run, { branch: "fix/ACME" })).toBe(false);
    expect(runMatches(run, { pr: 609 })).toBe(true);
    expect(runMatches(run, { pr: 610 })).toBe(false);
    expect(runMatches(run, { ticket: "ACME-528" })).toBe(true);
    expect(runMatches(run, { ticket: "acme-528" })).toBe(true);
    expect(runMatches(run, { ticket: "ACME-5" })).toBe(false);
    expect(runMatches(run, { commit: "01234567" })).toBe(true);
    expect(runMatches(run, { commit: "0123abc" })).toBe(false);
  });

  test("all given filters must match", () => {
    const run = withSource({});
    expect(runMatches(run, { pr: 609, ticket: "ACME-528", commit: "0123" })).toBe(true);
    expect(runMatches(run, { pr: 609, ticket: "OTHER-1" })).toBe(false);
  });

  test("runs without source or PR match none", () => {
    expect(runMatches({ source: null } as Run, { branch: "main" })).toBe(false);
    expect(runMatches({ source: null } as Run, {})).toBe(false);
    expect(runMatches(withSource({ pr: null, commit: null }), { pr: 609 })).toBe(false);
    expect(runMatches(withSource({ commit: null }), { commit: "0" })).toBe(false);
  });
});
