import { hubHosts } from "./mode";

/** Run sub-resources a viewer may read. */
const RUN_VIEWS = new Set(["events", "activity", "screenshots", "report", "report.html", "transcript", "compare", "baseline-candidates"]);
/** Project sub-resources a viewer may read (`reports` is served from the data dir only, see `legacyReports`). */
const PROJECT_VIEWS = new Set(["flaky", "refs", "overview", "reports", "releases"]);

/**
 * Routes a hub serves, over the decoded path segments: read-only GETs. Everything that starts a run, touches a device or reads
 * a repository is absent, so a viewer (or a misconfigured proxy) can read but never write. The ingest API under
 * `/api/hub/v1/` is routed before this check and does its own method and token handling.
 */
export function hubRouteAllowed(method: string, parts: string[]): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  const [root, a, b, c, d, e] = parts;
  if (root !== "api") return false;
  if (parts.length === 2) return a === "health" || a === "events" || a === "stats" || a === "runs" || a === "projects";
  if (a === "runs" && b) {
    if (c === "files") return parts.length >= 5;
    if (parts.length === 3) return true;
    if (parts.length === 4) return RUN_VIEWS.has(c!);
    return parts.length === 6 && c === "checks" && e === "history";
  }
  if (a === "batches") return parts.length === 3;
  if (a === "projects" && b) {
    // A branch name typed with raw slashes spreads over several segments after /releases/<kind>/.
    if (c === "releases") return parts.length === 4 || (parts.length >= 6 && !!d);
    if (parts.length === 4) return PROJECT_VIEWS.has(c!);
    if (parts.length === 5) return c === "reports";
    return parts.length === 6 && c === "checks" && e === "history";
  }
  return false;
}

/** Host header values the hub accepts: the loopback pair (healthcheck, local admin) plus every `TAPOCALYPSE_HUB_HOSTS` entry. */
export function hubAllowedHosts(port: number, env: Record<string, string | undefined> = process.env): string[] {
  return [`127.0.0.1:${port}`, `localhost:${port}`, ...hubHosts(env)];
}

/** Origins a hub accepts on writes: loopback over http, the configured public hosts over https. */
export function hubAllowedOrigins(port: number, env: Record<string, string | undefined> = process.env): string[] {
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...hubHosts(env).map((h) => `https://${h}`)];
}
