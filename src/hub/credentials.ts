// Where a laptop's team-hub upload credentials and connection settings live.
// Secrets never go into the config: the upload token (and optional proxy headers) are in `hub-credentials.json` next to the
// config file, mode 600 like an SSH key, or in the environment (`TAPOCALYPSE_HUB_TOKEN`, `TAPOCALYPSE_HUB_HEADERS`). The file is
// read on every call, so `hub login` needs no restart and it works under `tapocalypse service`, whose unit carries no secrets.
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { CONFIG_PATH, type HubConfig, HubConfigSchema } from "../config";

const CREDENTIALS_FILE_NAME = "hub-credentials.json";

/** The config file and its directory (where `hub-credentials.json` lives). A seam for tests; `setHubPaths` swaps and returns the restore function. */
export const hubPaths = { configFile: CONFIG_PATH, configDir: path.dirname(CONFIG_PATH) };
export function setHubPaths(next: Partial<typeof hubPaths>): () => void {
  const before = { ...hubPaths };
  Object.assign(hubPaths, next);
  return () => Object.assign(hubPaths, before);
}

const FileCredentials = z.object({ token: z.string().min(1), headers: z.record(z.string().min(1), z.string()).optional() });
const EnvHeaders = z.record(z.string().min(1), z.string());
export type HubCredentialsFile = z.infer<typeof FileCredentials>;

export interface HubCredentialSources {
  /** Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Directory of the active config file, where `hub-credentials.json` lives. */
  configDir?: string;
  /** `share.hub.headers` from the config: the lowest layer of request headers. */
  configHeaders?: Record<string, string> | undefined;
}

export type ResolvedHubCredentials =
  | {
      ok: true;
      token: string;
      tokenSource: "file" | "env";
      /** Last 4 characters, safe to show. */
      tokenHint: string;
      /** Extra request headers for an access proxy: config, then the credentials file, then the environment. */
      headers: Record<string, string>;
      /** Where the replaceable header set comes from; `null` when there is none. */
      headersSource: "file" | "env" | null;
    }
  | { ok: false; code: "missing" | "insecure" | "invalid"; problem: string };

export function hubCredentialsPath(sources: HubCredentialSources = {}): string {
  return path.join(sources.configDir ?? hubPaths.configDir, CREDENTIALS_FILE_NAME);
}

type FileRead = { state: "absent" } | { state: "bad"; code: "insecure" | "invalid"; problem: string } | { state: "ok"; value: HubCredentialsFile };

function readFile(file: string): FileRead {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return { state: "absent" };
  }
  if (!stat.isFile()) return { state: "bad", code: "invalid", problem: `hub credentials file ${file} is not a regular file` };
  if ((stat.mode & 0o077) !== 0) {
    return { state: "bad", code: "insecure", problem: `hub credentials file ${file} is accessible by other users (mode ${(stat.mode & 0o777).toString(8)}); run: chmod 600 ${file}` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return { state: "bad", code: "invalid", problem: `hub credentials file ${file} is unreadable: ${e instanceof Error ? e.message : String(e)}` };
  }
  const parsed = FileCredentials.safeParse(raw);
  if (!parsed.success) return { state: "bad", code: "invalid", problem: `hub credentials file ${file} must be {"token": "tpu_...", "headers"?: {"Header-Name": "value"}}` };
  return { state: "ok", value: parsed.data };
}

function envHeaders(env: Record<string, string | undefined>): Record<string, string> | null | "invalid" {
  const raw = env.TAPOCALYPSE_HUB_HEADERS;
  if (!raw) return null;
  try {
    const parsed = EnvHeaders.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : "invalid";
  } catch {
    return "invalid";
  }
}

/** The upload token and request headers the sync worker sends, with the reason when there is no usable token. */
export function resolveHubCredentials(sources: HubCredentialSources = {}): ResolvedHubCredentials {
  const env = sources.env ?? process.env;
  const file = hubCredentialsPath(sources);
  const fromFile = readFile(file);
  const fromEnvHeaders = envHeaders(env);
  if (fromEnvHeaders === "invalid") return { ok: false, code: "invalid", problem: `TAPOCALYPSE_HUB_HEADERS must be a JSON object of header names to values` };

  const envToken = env.TAPOCALYPSE_HUB_TOKEN?.trim();
  let token: string;
  let tokenSource: "file" | "env";
  if (envToken) {
    token = envToken;
    tokenSource = "env";
  } else if (fromFile.state === "ok") {
    token = fromFile.value.token;
    tokenSource = "file";
  } else if (fromFile.state === "bad") {
    return { ok: false, code: fromFile.code, problem: fromFile.problem };
  } else {
    return { ok: false, code: "missing", problem: `no hub upload token: run \`tapocalypse hub login <url>\`, set TAPOCALYPSE_HUB_TOKEN, or create ${file} with mode 600` };
  }

  const fileHeaders = fromFile.state === "ok" ? (fromFile.value.headers ?? {}) : {};
  const headers = { ...sources.configHeaders, ...fileHeaders, ...fromEnvHeaders };
  const headersSource = fromEnvHeaders ? "env" : Object.keys({ ...sources.configHeaders, ...fileHeaders }).length > 0 ? "file" : null;
  return { ok: true, token, tokenSource, tokenHint: token.slice(-4), headers, headersSource };
}

/** Writes `hub-credentials.json` atomically with mode 600 and returns its path. */
export function writeHubCredentials(credentials: HubCredentialsFile, sources: HubCredentialSources = {}): string {
  const file = hubCredentialsPath(sources);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body: HubCredentialsFile = { token: credentials.token, ...(credentials.headers && Object.keys(credentials.headers).length > 0 ? { headers: credentials.headers } : {}) };
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  return file;
}

export function removeHubCredentials(sources: HubCredentialSources = {}): void {
  fs.rmSync(hubCredentialsPath(sources), { force: true });
}

/** The saved credentials file content for the settings form (header values never leave the server; this feeds the merge). */
export function readSavedHubCredentials(sources: HubCredentialSources = {}): HubCredentialsFile | null {
  const read = readFile(hubCredentialsPath(sources));
  return read.state === "ok" ? read.value : null;
}

function readConfigObject(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return {};
  const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`config ${file} must be a JSON object`);
  return Object.fromEntries(Object.entries(raw));
}

/** `share.hub` from a config file, or null when it has none. */
export function readHubConfig(file: string = hubPaths.configFile): HubConfig | null {
  const share = readConfigObject(file).share;
  if (share === null || typeof share !== "object" || !("hub" in share)) return null;
  return HubConfigSchema.parse(share.hub);
}

/** Sets or (with null) removes `share.hub` in the config file; every other key, including `share.s3`, is kept. */
export function writeHubConfig(file: string, hub: HubConfig | null): void {
  const root = readConfigObject(file);
  const share = root.share !== null && typeof root.share === "object" && !Array.isArray(root.share) ? Object.fromEntries(Object.entries(root.share)) : {};
  if (hub) share.hub = HubConfigSchema.parse(hub);
  else delete share.hub;
  if (Object.keys(share).length > 0) root.share = share;
  else delete root.share;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const mode = fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o644;
  fs.writeFileSync(tmp, `${JSON.stringify(root, null, 2)}\n`, { mode });
  fs.renameSync(tmp, file);
}
