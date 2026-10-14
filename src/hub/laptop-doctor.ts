// Doctor checks for the laptop side of the team hub. Every one is optional: a machine without a hub is healthy.
import type { DoctorCheck } from "../doctor";
import { listProjects, type Project } from "../projects/registry";
import { hubCredentialsPath, resolveHubCredentials } from "./credentials";
import { hubKeyFor } from "./identity";
import { activeHubConfig, type HubConnection, hubSyncWorker } from "./sync";

export interface HubChecksDeps {
  /** Defaults to the registry's projects. */
  projects?: () => Project[];
  /** The key a shared project uploads under (explicit or derived); null = none. Defaults to `hubKeyFor`. */
  hubKey?: (project: Project) => Promise<string | null>;
}

const check = (id: string, label: string, status: DoctorCheck["status"], detail: string, fix?: string): DoctorCheck => ({ id, label, status, detail, ...(fix ? { fix } : {}), required: false });

const CONNECTION: Record<Exclude<HubConnection["state"], "ok" | "unknown">, { status: DoctorCheck["status"]; fix: string }> = {
  unauthorized: { status: "error", fix: "Run `tapocalypse hub login <hub-url>` with a valid upload token (ask the hub admin for `hub token create <name>`)." },
  proxy_login: { status: "error", fix: "The access proxy wants a login: pass its service token with `tapocalypse hub login <hub-url> --header \"Name: value\"`, or ask your admin to let /api/hub/v1/ through." },
  unreachable: { status: "warn", fix: "Uploads wait in the queue and retry on their own. Check the address and that this machine is on the right network (VPN or tailnet)." },
  protocol_unsupported: { status: "error", fix: "Update Tapocalypse on this machine; uploads resume once it speaks the hub's protocol." },
  not_a_hub: { status: "error", fix: "Use the hub's own address: `tapocalypse hub login <hub-url>`." },
};

/** Connection, credentials, queue and shared-project checks for `tapocalypse doctor` and `GET /api/doctor`. */
export async function hubChecks(deps: HubChecksDeps = {}): Promise<DoctorCheck[]> {
  const shared = (deps.projects ?? listProjects)().filter((p) => p.share === true);
  const settings = activeHubConfig();
  const checks: DoctorCheck[] = [];

  if (!settings) {
    checks.push(check("hub", "Team hub", "skip", "not connected (optional)", "To share runs with your team: `tapocalypse hub login <hub-url>`."));
  } else {
    const host = new URL(settings.url).host;
    const creds = resolveHubCredentials({ configHeaders: settings.headers });
    if (!creds.ok) {
      checks.push(check("hub", "Team hub", "error", creds.problem, creds.code === "insecure" ? `chmod 600 ${hubCredentialsPath()}` : "Run `tapocalypse hub login <hub-url>`."));
    } else {
      const worker = hubSyncWorker();
      const connection = await worker.testConnection();
      if (connection.state === "ok") checks.push(check("hub", "Team hub", "ok", `connected to ${host} as ${connection.machine ?? "this machine"} (hub ${connection.hubVersion ?? "?"})`));
      else if (connection.state === "unknown") checks.push(check("hub", "Team hub", "warn", connection.detail ?? `${host}: not checked`));
      else checks.push(check("hub", "Team hub", CONNECTION[connection.state].status, connection.detail ?? `${host}: ${connection.state}`, CONNECTION[connection.state].fix));

      const { queue, paused } = worker.status();
      if (paused) checks.push(check("hub-queue", "Team hub uploads", "warn", `paused (${paused.reason}): ${paused.detail}; ${queue.waiting} waiting`, "Fix the connection above; uploads resume on their own."));
      else if (queue.failed > 0 || queue.parked > 0) {
        const parts = [queue.failed > 0 ? `${queue.failed} failed (retrying)` : null, queue.parked > 0 ? `${queue.parked} not uploaded (id already taken on the hub)` : null].filter(Boolean);
        checks.push(check("hub-queue", "Team hub uploads", "warn", `${parts.join(", ")}; ${queue.uploaded} uploaded`, "`tapocalypse hub status` shows the reason per run."));
      } else checks.push(check("hub-queue", "Team hub uploads", "ok", `${queue.uploaded} uploaded, ${queue.waiting} waiting`));
    }
  }

  const keyOf = deps.hubKey ?? ((p: Project) => hubKeyFor(p).catch(() => null));
  const keyless: string[] = [];
  for (const project of shared) if (!project.hubKey && !(await keyOf(project))) keyless.push(project.name);
  if (keyless.length > 0) checks.push(check("hub-projects", "Shared projects", "warn", `${keyless.join(", ")}: no git remote to name the project on the hub, so its runs cannot upload`, "Set a hubKey on the project (for example local/<project-id>) or add a git remote."));
  else if (shared.length > 0 && !settings) checks.push(check("hub-projects", "Shared projects", "warn", `${shared.map((p) => p.name).join(", ")} ${shared.length === 1 ? "is" : "are"} shared but no team hub is connected`, "Run `tapocalypse hub login <hub-url>`."));
  return checks;
}
