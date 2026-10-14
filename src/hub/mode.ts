import path from "node:path";
import { DATA_DIR } from "../config";

/** Test hook: `true`/`false` force the mode, `null` follows `TAPOCALYPSE_MODE`. */
let forced: boolean | null = null;

export function setHubMode(on: boolean | null): void {
  forced = on;
}

/** True when this process is the read-only team hub (`TAPOCALYPSE_MODE=hub`). Read lazily so tests and the CLI can switch it. */
export function isHub(env: Record<string, string | undefined> = process.env): boolean {
  return forced ?? env.TAPOCALYPSE_MODE === "hub";
}

/** Everything the hub keeps besides `runs/`: tokens, project registry, content-addressed blobs, activity log. */
export function hubDir(): string {
  return path.join(DATA_DIR, "hub");
}

/** Runs from this count on, the in-memory store gets slow to boot (see AGENTS.md, regression intelligence). */
export const HUB_STORE_WARN_RUNS = 8000;
export const HUB_PROTOCOL_MIN = 1;
const DEFAULT_MAX_BLOB_MB = 16;
const MAX_DOC_BYTES = 2 * 1024 * 1024;
const MAX_SCREENSHOTS = 500;
const DEFAULT_RETENTION_DAYS = 365;

export interface HubLimits {
  maxBlobBytes: number;
  maxDocBytes: number;
  maxScreenshots: number;
}

export function hubLimits(env: Record<string, string | undefined> = process.env): HubLimits {
  const mb = Number(env.TAPOCALYPSE_HUB_MAX_BLOB_MB);
  return {
    maxBlobBytes: Math.floor((Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_MAX_BLOB_MB) * 1024 * 1024),
    maxDocBytes: MAX_DOC_BYTES,
    maxScreenshots: MAX_SCREENSHOTS,
  };
}

/** `TAPOCALYPSE_HUB_HOSTS`: comma-separated public host names the proxy forwards (lowercased); empty when unset. */
export function hubHosts(env: Record<string, string | undefined> = process.env): string[] {
  return (env.TAPOCALYPSE_HUB_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

/** `TAPOCALYPSE_HUB_IDENTITY_HEADER`: the proxy header carrying the viewer's identity, or null. */
export function hubIdentityHeader(env: Record<string, string | undefined> = process.env): string | null {
  return env.TAPOCALYPSE_HUB_IDENTITY_HEADER?.trim() || null;
}

export interface HubRetention {
  days?: number;
  maxRuns?: number;
}

/** Hub retention: 365 days unless `TAPOCALYPSE_HUB_RETENTION_DAYS` says otherwise (`0` = keep everything); `_MAX_RUNS` caps the count. */
export function hubRetention(env: Record<string, string | undefined> = process.env): HubRetention {
  const raw = env.TAPOCALYPSE_HUB_RETENTION_DAYS?.trim();
  const days = raw === undefined || raw === "" ? DEFAULT_RETENTION_DAYS : Number(raw);
  const maxRuns = Number(env.TAPOCALYPSE_HUB_RETENTION_MAX_RUNS);
  return {
    ...(Number.isFinite(days) && days > 0 ? { days } : {}),
    ...(Number.isInteger(maxRuns) && maxRuns > 0 ? { maxRuns } : {}),
  };
}
