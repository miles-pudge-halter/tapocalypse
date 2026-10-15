import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { config, HttpError } from "../config";
import { rekeyAll, rekeyProject, unpublishRuns } from "./ingest";
import { hubProjectById, listHubProjects, removeHubProject, renameHubProject, setHubDefaultBranch } from "./projects";
import { createToken, listTokens, removeToken, revokeToken } from "./tokens";

export interface AdminIo {
  out(line: string): void;
  err(line: string): void;
}

const EXIT = { OK: 0, ERROR: 2, USAGE: 3 } as const;

class Usage extends Error {}

export const HUB_ADMIN_USAGE = `Hub administration (run on the hub: \`docker compose exec hub bun src/cli.ts hub ...\`):
  tapocalypse hub token create <name> [--admin]   Create an upload token for a machine (printed once). --admin may also delete any run.
  tapocalypse hub token list                      Tokens by name: admin flag, created, last used, revoked.
  tapocalypse hub token revoke <name>             Stop accepting a token (its uploaded runs stay).
  tapocalypse hub rekey [--project <id>]          Recompute regression keys over the merged history, oldest first.
  tapocalypse hub project list                    Hub projects: id, hub key, name.
  tapocalypse hub project rename <hubKey> <name>  Pin a project's display name.
  tapocalypse hub project remove <hubKey>         Forget a project that has no runs (stored or live).
  tapocalypse hub project set-default-branch <hubKey> <branch>|--clear
                                                  Pin the default branch (uploads no longer change it); --clear unpins it.
  tapocalypse hub unpublish <runId>               Remove one uploaded run (alias: hub runs rm <runId>).
  tapocalypse hub unpublish --project <id> [--machine <name>]
  tapocalypse hub unpublish --machine <name>      Remove every run of a project and/or machine.`;

const tokenLine = (t: { name: string; admin: boolean; createdAt: string; lastUsedAt: string | null; revokedAt: string | null }): string =>
  [t.name, t.admin ? "admin" : "machine", `created ${t.createdAt.slice(0, 10)}`, t.lastUsedAt ? `last used ${t.lastUsedAt.slice(0, 16).replace("T", " ")}` : "never used", t.revokedAt ? "REVOKED" : "active"].join("  ");

/**
 * Runs `op` through the hub that is already serving this data directory when there is one: its in-memory run store would
 * otherwise keep stale runs and keys until restarted. The CLI mints a short-lived admin token (it has the data directory, so it
 * is the administrator by definition) and removes it again. Returns null when no server answers, so the caller works on disk directly.
 */
async function viaRunningHub<T>(path: string, body: unknown): Promise<T | null> {
  const name = `cli-${process.pid}-${randomBytes(3).toString("hex")}`;
  const { token } = createToken(name, { admin: true });
  try {
    const res = await fetch(`http://127.0.0.1:${config.port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }).catch(() => null);
    if (!res) return null;
    const json = (await res.json().catch(() => null)) as { error?: string } | null;
    if (!res.ok) throw new HttpError(res.status, json?.error ?? `the running hub answered ${res.status}`);
    return json as T;
  } finally {
    removeToken(name);
  }
}

async function token(args: string[], io: AdminIo): Promise<number> {
  const [action, ...rest] = args;
  if (action === "create") {
    const { values, positionals } = parseArgs({ args: rest, options: { admin: { type: "boolean" } }, allowPositionals: true, strict: true });
    if (positionals.length !== 1) throw new Usage("usage: tapocalypse hub token create <name> [--admin]");
    const { token: secret } = createToken(positionals[0]!, { admin: values.admin === true });
    io.err(`Created ${values.admin ? "admin " : ""}upload token for ${positionals[0]}. It is shown once; store it now (on the machine: tapocalypse hub login <hub url>).`);
    io.out(secret);
    return EXIT.OK;
  }
  if (action === "list" && rest.length === 0) {
    const tokens = listTokens();
    if (tokens.length === 0) io.out("no tokens yet: create one with `hub token create <name>`");
    for (const t of tokens) io.out(tokenLine(t));
    return EXIT.OK;
  }
  if (action === "revoke" && rest.length === 1) {
    if (!revokeToken(rest[0]!)) {
      io.err(`no active token named ${rest[0]}`);
      return EXIT.ERROR;
    }
    io.out(`revoked ${rest[0]}`);
    return EXIT.OK;
  }
  throw new Usage("usage: tapocalypse hub token create <name> [--admin] | list | revoke <name>");
}

async function rekey(args: string[], io: AdminIo): Promise<number> {
  const { values, positionals } = parseArgs({ args, options: { project: { type: "string" } }, allowPositionals: true, strict: true });
  if (positionals.length > 0) throw new Usage("usage: tapocalypse hub rekey [--project <id>]");
  if (values.project !== undefined && !hubProjectById(values.project)) {
    io.err(`unknown hub project ${values.project}`);
    return EXIT.ERROR;
  }
  const body = { projectId: values.project ?? null };
  const result = (await viaRunningHub<{ changed: number }>("/api/hub/v1/admin/rekey", body)) ?? { changed: values.project ? await rekeyProject(values.project) : await rekeyAll() };
  io.out(result.changed > 0 ? `re-keyed: ${result.changed} run(s) changed` : "re-keyed: every run already had its keys (unchanged)");
  return EXIT.OK;
}

async function project(args: string[], io: AdminIo): Promise<number> {
  const [action, ...rest] = args;
  if (action === "list" && rest.length === 0) {
    for (const p of listHubProjects()) io.out(`${p.id}  ${p.hubKey}  ${p.name}${p.nameLocked ? " (pinned)" : ""}`);
    return EXIT.OK;
  }
  if (action === "rename") {
    const [hubKey, ...name] = rest;
    if (!hubKey || name.length === 0) throw new Usage('usage: tapocalypse hub project rename <hubKey> "<name>"');
    const renamed = renameHubProject(hubKey, name.join(" "));
    io.out(`${renamed.hubKey} is now called ${renamed.name}`);
    return EXIT.OK;
  }
  if (action === "remove") {
    if (rest.length !== 1) throw new Usage("usage: tapocalypse hub project remove <hubKey>");
    const hubKey = rest[0]!;
    if ((await viaRunningHub<{ removed: string }>("/api/hub/v1/admin/project-remove", { hubKey })) === null) removeHubProject(hubKey);
    io.out(`removed project ${hubKey}`);
    return EXIT.OK;
  }
  if (action === "set-default-branch") {
    const { values, positionals } = parseArgs({ args: rest, options: { clear: { type: "boolean" } }, allowPositionals: true, strict: true });
    const [hubKey, branch] = positionals;
    if (!hubKey || positionals.length > 2 || (values.clear === true) === (branch !== undefined)) {
      throw new Usage("usage: tapocalypse hub project set-default-branch <hubKey> <branch> | <hubKey> --clear");
    }
    const next = branch ?? null;
    const result = (await viaRunningHub<{ defaultBranch: string | null }>("/api/hub/v1/admin/project-default-branch", { hubKey, branch: next })) ?? { defaultBranch: setHubDefaultBranch(hubKey, next).defaultBranch };
    io.out(result.defaultBranch ? `${hubKey} default branch is now ${result.defaultBranch} (pinned)` : `${hubKey} default branch cleared; the next upload detects one again`);
    return EXIT.OK;
  }
  throw new Usage('usage: tapocalypse hub project list | rename <hubKey> "<name>" | remove <hubKey> | set-default-branch <hubKey> <branch>|--clear');
}

async function unpublish(args: string[], io: AdminIo): Promise<number> {
  const { values, positionals } = parseArgs({ args, options: { project: { type: "string" }, machine: { type: "string" } }, allowPositionals: true, strict: true });
  const runId = positionals[0];
  if (positionals.length > 1 || (runId === undefined && values.project === undefined && values.machine === undefined) || (runId !== undefined && (values.project !== undefined || values.machine !== undefined))) {
    throw new Usage("usage: tapocalypse hub unpublish <runId> | --project <id> [--machine <name>] | --machine <name>");
  }
  const filter = { ...(runId ? { runId } : {}), ...(values.project ? { projectId: values.project } : {}), ...(values.machine ? { machine: values.machine } : {}) };
  const result = (await viaRunningHub<{ removed: string[] }>("/api/hub/v1/admin/unpublish", filter)) ?? { removed: unpublishRuns(filter) };
  if (result.removed.length === 0) {
    io.err("no uploaded run matches");
    return EXIT.ERROR;
  }
  io.out(`removed ${result.removed.length} run(s)`);
  return EXIT.OK;
}

/** `tapocalypse hub token|rekey|project|unpublish|runs ...`: what an administrator does on the hub itself. */
export async function hubAdminCommand(args: string[], io: AdminIo): Promise<number> {
  const [command, ...rest] = args;
  try {
    switch (command) {
      case "token":
        return await token(rest, io);
      case "rekey":
        return await rekey(rest, io);
      case "project":
        return await project(rest, io);
      case "unpublish":
        return await unpublish(rest, io);
      case "runs":
        if (rest[0] === "rm") return await unpublish(rest.slice(1), io);
        throw new Usage("usage: tapocalypse hub runs rm <runId>");
      default:
        throw new Usage(HUB_ADMIN_USAGE);
    }
  } catch (e) {
    if (e instanceof Usage || (e instanceof TypeError && "code" in e && String(e.code).startsWith("ERR_PARSE_ARGS"))) {
      io.err(e.message);
      return EXIT.USAGE;
    }
    io.err(`error: ${e instanceof Error ? e.message : String(e)}`);
    return EXIT.ERROR;
  }
}
