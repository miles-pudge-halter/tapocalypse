import { listRuns } from "../runs/store";
import { HUB_STORE_WARN_RUNS, hubIdentityHeader, hubRetention } from "./mode";
import { listHubProjects } from "./projects";
import { listTokens } from "./tokens";

/** One uploading machine (an upload token) as viewers see it; never carries a token digest. */
export interface HubMachine {
  name: string;
  uploader: string | null;
  lastUploadAt: string | null;
  runs30d: number;
  clockSkewMs: number | null;
  revoked: boolean;
}

/** What the hub knows about every machine: tokens that never uploaded, and machines whose token was revoked, included. */
export function hubMachines(now: number = Date.now()): HubMachine[] {
  const since = new Date(now - 30 * 86_400_000).toISOString();
  const byName = new Map<string, HubMachine>();
  for (const run of listRuns()) {
    if (!run.hub) continue;
    const { machine, receivedAt, uploader, clockSkewMs } = run.hub;
    const entry = byName.get(machine) ?? { name: machine, uploader: null, lastUploadAt: null, runs30d: 0, clockSkewMs: null, revoked: false };
    byName.set(machine, entry);
    if (receivedAt >= since) entry.runs30d++;
    if (!entry.lastUploadAt || receivedAt > entry.lastUploadAt) {
      entry.lastUploadAt = receivedAt;
      entry.uploader = uploader;
      entry.clockSkewMs = clockSkewMs;
    }
  }
  const tokens = listTokens();
  for (const name of new Set(tokens.map((t) => t.name))) {
    const entry = byName.get(name) ?? { name, uploader: null, lastUploadAt: null, runs30d: 0, clockSkewMs: null, revoked: false };
    entry.revoked = !tokens.some((t) => t.name === name && t.revokedAt === null);
    byName.set(name, entry);
  }
  return [...byName.values()].sort((a, b) => (b.lastUploadAt ?? "").localeCompare(a.lastUploadAt ?? "") || a.name.localeCompare(b.name));
}

/** The viewer-facing totals on `GET /api/hub/v1/info`. */
export function hubSummary(): { runs: number; projects: number; retentionDays: number | null; identityHeader: boolean; storeWarning: boolean } {
  const runs = listRuns().length;
  return {
    runs,
    projects: listHubProjects().length,
    retentionDays: hubRetention().days ?? null,
    identityHeader: hubIdentityHeader() !== null,
    storeWarning: runs >= HUB_STORE_WARN_RUNS,
  };
}
