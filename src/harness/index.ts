// Registry of harness adapters and the default-harness resolution shared by the scheduler, doctor and API.
import { config as defaultConfig, type Config } from "../config";
import { type ExecResult, exec } from "../devices/devices";
import type { DoctorCheck } from "../doctor";
import { harness as claude } from "./claude";
import { harness as codex } from "./codex";
import { harness as omp } from "./omp";
import { HARNESS_IDS, type Harness, type HarnessId } from "./types";

/** Getters, not values: adapters transitively import the run store, which imports this registry, so bindings may still be uninitialized while modules load. */
export const harnesses: Record<HarnessId, Harness> = {
  get omp() {
    return omp;
  },
  get claude() {
    return claude;
  },
  get codex() {
    return codex;
  },
};

export function getHarness(id: HarnessId): Harness {
  return harnesses[id];
}

const BIN_ENV: Record<HarnessId, string> = { omp: "OMP_BIN", claude: "CLAUDE_BIN", codex: "CODEX_BIN" };

/** Binary for a harness: its `<ID>_BIN` env var, then `config.agent.harnesses[id].bin`, then the default name. */
export function harnessBin(
  id: HarnessId,
  cfg: Pick<Config, "agent"> = defaultConfig,
  env: Record<string, string | undefined> = process.env,
): string {
  return env[BIN_ENV[id]] ?? cfg.agent?.harnesses?.[id]?.bin ?? id;
}

export type ProbeRunner = (cmd: string[]) => Promise<ExecResult>;
export type InstalledMap = Record<HarnessId, boolean>;

const PROBE_TIMEOUT_MS = 8_000;
/** Installs rarely change; re-probing at most once a minute keeps enqueue and the picker cheap. */
const INSTALLED_TTL_MS = 60_000;

let installedCache: { at: number; value: Promise<InstalledMap> } | null = null;

const probe: ProbeRunner = (cmd) => exec(cmd, { timeoutMs: PROBE_TIMEOUT_MS });

/** Which harness CLIs answer `--version`; never a model call. Cached for a minute (`run` is injectable for tests). */
export function detectInstalled(run: ProbeRunner = probe): Promise<InstalledMap> {
  if (installedCache && Date.now() - installedCache.at < INSTALLED_TTL_MS) return installedCache.value;
  const value = Promise.all(
    HARNESS_IDS.map(async (id) => [id, (await run([harnessBin(id), "--version"])).code === 0] as const),
  ).then((entries) => Object.fromEntries(entries) as InstalledMap);
  installedCache = { at: Date.now(), value };
  return value;
}

export function resetProbeCache(): void {
  installedCache = null;
  readinessCache = null;
}

export interface HarnessReadiness {
  installed: boolean;
  signedIn: boolean;
}
export type Readiness = Partial<Record<HarnessId, HarnessReadiness>>;

/** Installed and signed in exactly as the harness's own doctor rows (`<id>`, `<id>-auth`) report it: both `ok`. */
export function readinessOf(id: HarnessId, checks: readonly DoctorCheck[]): HarnessReadiness {
  const status = (checkId: string) => checks.find((c) => c.id === checkId)?.status;
  const installed = status(id) === "ok";
  return { installed, signedIn: installed && status(`${id}-auth`) === "ok" };
}

/**
 * The one default-harness rule, shared by run defaulting, `/api/harnesses` and doctor: the first of omp, claude, codex that
 * is installed and signed in, else the first installed, else omp.
 */
export function pickDefaultHarness(ready: Readiness): HarnessId {
  return HARNESS_IDS.find((id) => ready[id]?.signedIn) ?? HARNESS_IDS.find((id) => ready[id]?.installed) ?? "omp";
}

let readinessCache: { at: number; value: Promise<Record<HarnessId, HarnessReadiness>> } | null = null;

/**
 * Install and sign-in of every harness from its adapter's doctor probes (`--version`, auth status: never a model call).
 * Cached for a minute like `detectInstalled`; `run` and `adapter` are injectable for tests.
 */
export function detectReadiness(
  run: ProbeRunner = probe,
  adapter: (id: HarnessId) => Pick<Harness, "doctor"> = getHarness,
): Promise<Record<HarnessId, HarnessReadiness>> {
  if (readinessCache && Date.now() - readinessCache.at < INSTALLED_TTL_MS) return readinessCache.value;
  const value = Promise.all(
    HARNESS_IDS.map(async (id) => {
      const checks = await adapter(id)
        .doctor({ bin: harnessBin(id), platform: process.platform, run, selected: false })
        .catch((): DoctorCheck[] => []);
      return [id, readinessOf(id, checks)] as const;
    }),
  ).then((entries) => Object.fromEntries(entries) as Record<HarnessId, HarnessReadiness>);
  readinessCache = { at: Date.now(), value };
  return value;
}

export interface HarnessChoice {
  /** Explicit run request. */
  run?: HarnessId | null;
  /** Project `agent.harness`. */
  project?: HarnessId | null;
  /** Persona frontmatter `harness:`. */
  persona?: HarnessId | null;
  /** Config `agent.harness`. */
  config?: HarnessId | null;
  /** Probe result for the final fallback (`pickDefaultHarness`). */
  readiness?: Readiness;
}

/** run request > project > persona > config > `pickDefaultHarness(readiness)`. */
export function resolveHarnessId(c: HarnessChoice): HarnessId {
  return c.run ?? c.project ?? c.persona ?? c.config ?? pickDefaultHarness(c.readiness ?? {});
}

/** Like `resolveHarnessId`, probing readiness only when no explicit layer decided. */
export async function resolveHarness(c: Omit<HarnessChoice, "readiness">): Promise<HarnessId> {
  const explicit = c.run ?? c.project ?? c.persona ?? c.config;
  return resolveHarnessId({ ...c, readiness: explicit ? undefined : await detectReadiness() });
}

/** The harness used when nothing overrides it: config `agent.harness`, else `pickDefaultHarness`. */
export function defaultHarness(): Promise<HarnessId> {
  return resolveHarness({ config: defaultConfig.agent?.harness });
}
