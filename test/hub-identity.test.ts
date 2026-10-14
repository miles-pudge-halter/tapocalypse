import { describe, expect, test } from "bun:test";
import { hubIdentityFor, hubKeyFor, setHubIdentityDeps } from "../src/hub/identity";
import { sharedHubProjects } from "../src/hub/sync";
import { HubKey } from "../src/hub/protocol";
import type { GitRunner } from "../src/regression/baseline";

/** A fake git: answers `remote get-url origin` and `rev-parse --show-prefix`; null = the command fails. */
function fakeGit(answers: { remote?: string | null; prefix?: string | null }): GitRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const run = async (_cwd: string, args: string[]): Promise<string | null> => {
    calls.push(args);
    if (args[0] === "remote") return answers.remote ?? null;
    if (args[0] === "rev-parse" && args.includes("--show-prefix")) return answers.prefix ?? "";
    return null;
  };
  return Object.assign(run, { calls });
}

const project = (extra: { hubKey?: string } = {}) => ({ repoPath: "/Users/you/acme-app", ...extra });

describe("hubKeyFor", () => {
  test("every spelling of the same remote derives one lowercase key", async () => {
    const spellings = [
      "https://github.com/Acme/App.git",
      "git@github.com:Acme/App.git",
      "ssh://git@github.com-work/Acme/App",
      "https://x-access-token:ghs_fakeSecretToken123@github.com/Acme/App.git",
    ];
    for (const remote of spellings) expect(await hubKeyFor(project(), fakeGit({ remote }))).toBe("github.com/acme/app");
  });

  test("credentials in the remote URL never reach the key or the remote URL", async () => {
    const id = await hubIdentityFor(project(), fakeGit({ remote: "https://bot:hunter2@git.example.com/team/app.git" }));
    expect(id).toEqual({ hubKey: "git.example.com/team/app", remoteUrl: "https://git.example.com/team/app", subpath: null });
  });

  test("a query string or fragment on the remote is dropped before it names the project", async () => {
    const id = await hubIdentityFor(project(), fakeGit({ remote: "https://github.com/Acme/App.git?token=abc#frag" }));
    expect(id).toEqual({ hubKey: "github.com/acme/app", remoteUrl: "https://github.com/Acme/App", subpath: null });
  });

  test("a monorepo subdirectory is appended as #subpath, and subgroups stay in the path", async () => {
    const id = await hubIdentityFor(project(), fakeGit({ remote: "git@gitlab.com:group/sub/app.git", prefix: "Apps/Mobile/" }));
    expect(id.hubKey).toBe("gitlab.com/group/sub/app#apps/mobile");
    expect(id.subpath).toBe("apps/mobile");
    expect(HubKey.safeParse(id.hubKey).success).toBe(true);
  });

  test("no usable remote derives null: missing, failing git, or a local path", async () => {
    expect(await hubKeyFor(project(), fakeGit({ remote: null }))).toBeNull();
    expect(await hubKeyFor(project(), fakeGit({ remote: "/srv/git/app.git" }))).toBeNull();
    expect(await hubKeyFor(project(), async () => null)).toBeNull();
    const none = await hubIdentityFor(project(), fakeGit({ remote: null }));
    expect(none).toEqual({ hubKey: null, remoteUrl: null, subpath: null });
  });

  test("an explicit hubKey wins over the remote but the remote URL is still reported", async () => {
    const id = await hubIdentityFor(project({ hubKey: "github.com/acme/app#com.acme.kiosk" }), fakeGit({ remote: "git@github.com:acme/app.git" }));
    expect(id).toEqual({ hubKey: "github.com/acme/app#com.acme.kiosk", remoteUrl: "https://github.com/acme/app", subpath: null });
    expect(await hubKeyFor(project({ hubKey: "local/acme-app" }), fakeGit({ remote: null }))).toBe("local/acme-app");
  });

  test("a remote whose path cannot form a valid key derives null instead of an invalid key", async () => {
    expect(await hubKeyFor(project(), fakeGit({ remote: "https://github.com/acme/ap p!.git" }))).toBeNull();
  });
});

describe("sharedHubProjects (the status frames)", () => {
  test("asks git once per repository, not on every status frame", async () => {
    const git = fakeGit({ remote: "git@github.com:acme/app.git" });
    setHubIdentityDeps({ git });
    try {
      const projects = [
        { id: "a", name: "App", repoPath: "/Users/you/acme-app", share: true as const },
        { id: "b", name: "Kiosk", repoPath: "/Users/you/kiosk", share: true as const, hubKey: "local/kiosk" },
        { id: "c", name: "Private", repoPath: "/Users/you/private" },
      ];
      const first = await sharedHubProjects(projects);
      expect(first).toEqual([
        { id: "a", name: "App", hubKey: "github.com/acme/app" },
        { id: "b", name: "Kiosk", hubKey: "local/kiosk" },
      ]);
      await Bun.sleep(20); // the background refresh the first call started
      const asked = git.calls.length;
      expect(asked).toBeGreaterThan(0);
      expect(await sharedHubProjects(projects)).toEqual(first);
      expect(git.calls.length).toBe(asked);
    } finally {
      setHubIdentityDeps();
    }
  });
});
