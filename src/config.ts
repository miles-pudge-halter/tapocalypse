import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { HarnessIdSchema } from "./harness/types";
import { parseDurationMs } from "./runs/outcome";

export const REPO_ROOT = path.resolve(import.meta.dir, "..");

const HarnessSettingsSchema = z.object({
  bin: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  effort: z.string().min(1).optional(),
  permissions: z.enum(["bypass", "allowlist"]).optional(),
  sandbox: z.enum(["danger-full-access", "workspace-write"]).optional(),
});

export const ConfigSchema = z.object({
  port: z.number().int().positive(),
  maxConcurrentRuns: z.number().int().positive(),
  /** Wall-clock budget per run (`90m`, `1h30m`, `45s`; a bare number is minutes). Validated so every harness gets a usable limit. */
  runMaxTime: z.string().refine((s) => (parseDurationMs(s) ?? 0) > 0, "must be a positive duration such as 90m, 1h30m or 45s"),
  artemisPath: z.string().min(1).optional(),
  /** Loose entries: the project registry validates them individually so one bad project never blocks boot. */
  projects: z.array(z.record(z.string(), z.unknown())),
  /**
   * Agent runtime settings. `harness` picks the default CLI (unset = first installed of omp, claude, codex); `model` /
   * `thinking` are the legacy omp-only fallbacks; `harnesses[id]` holds per-CLI settings; `maxTurns` / `maxBudgetUsd`
   * apply to harnesses that enforce them (Claude Code) and are ignored by the others.
   */
  agent: z
    .object({
      harness: HarnessIdSchema.optional(),
      model: z.string().min(1).optional(),
      thinking: z.string().min(1).optional(),
      maxTurns: z.number().int().positive().optional(),
      maxBudgetUsd: z.number().positive().optional(),
      harnesses: z.partialRecord(HarnessIdSchema, HarnessSettingsSchema).optional(),
    })
    .optional(),
  /** Automatic re-queue of runs that die from infrastructure causes (boot failure, omp crash) before any check resolved. */
  retry: z.object({ infra: z.number().int().nonnegative().default(1) }).default({ infra: 1 }),
  /** Run-history cleanup; unset = keep everything. Only run directories under the data dir are ever deleted. */
  retention: z
    .object({ days: z.number().positive().optional(), maxRuns: z.number().int().positive().optional() })
    .default({}),
  devicePool: z.object({
    android: z.object({
      avds: z.array(z.string()),
      basePort: z.number().int().positive(),
      maxBooted: z.number().int().nonnegative(),
      minSize: z.string().regex(/^\d+x\d+$/),
      minDensity: z.number().int().positive(),
      idleShutdownMinutes: z.number().positive(),
      excludeSerials: z.array(z.string()),
    }),
    ios: z.object({
      simulators: z.array(z.string()),
      idleShutdownMinutes: z.number().positive(),
    }),
  }),
});

export type Config = z.infer<typeof ConfigSchema>;

/** Config/data locations: the legacy in-repo files keep winning when they exist; fresh installs use XDG directories. */
export function resolveConfigPath(
  env: Record<string, string | undefined> = process.env,
  exists: (p: string) => boolean = existsSync,
  home: string = os.homedir(),
): string {
  if (env.TAPOCALYPSE_CONFIG) return env.TAPOCALYPSE_CONFIG;
  const legacy = path.join(REPO_ROOT, "tapocalypse.config.json");
  if (exists(legacy)) return legacy;
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "tapocalypse", "config.json");
}

export function resolveDataDir(
  env: Record<string, string | undefined> = process.env,
  exists: (p: string) => boolean = existsSync,
  home: string = os.homedir(),
): string {
  if (env.TAPOCALYPSE_DATA_DIR) return env.TAPOCALYPSE_DATA_DIR;
  const legacy = path.join(REPO_ROOT, "data");
  if (exists(legacy)) return legacy;
  return path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "tapocalypse");
}

export const CONFIG_PATH = resolveConfigPath();

const STARTER_CONFIG = {
  port: 4310,
  maxConcurrentRuns: 2,
  runMaxTime: "60m",
  projects: [],
  devicePool: {
    android: {
      avds: [],
      basePort: 5560,
      maxBooted: 1,
      minSize: "720x1280",
      minDensity: 320,
      idleShutdownMinutes: 20,
      excludeSerials: [],
    },
    ios: { simulators: [], idleShutdownMinutes: 20 },
  },
};

function fatal(msg: string): never {
  console.error(`fatal: ${msg}`);
  process.exit(1);
}

function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) {
    mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    writeFileSync(CONFIG_PATH, `${JSON.stringify(STARTER_CONFIG, null, 2)}\n`);
    console.log(`created ${CONFIG_PATH}; add a project at http://127.0.0.1:${process.env.TAPOCALYPSE_PORT || STARTER_CONFIG.port}/#/projects`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch (e) {
    fatal(`config: ${(e as Error).message}`);
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) fatal(`config: ${parsed.error.message}`);
  const envPort = Number(process.env.TAPOCALYPSE_PORT);
  if (process.env.TAPOCALYPSE_PORT && (!Number.isInteger(envPort) || envPort <= 0)) fatal(`TAPOCALYPSE_PORT must be a port number`);
  return deepFreeze(process.env.TAPOCALYPSE_PORT ? { ...parsed.data, port: envPort } : parsed.data);
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object") {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

export const config: Config = loadConfig();

export const DATA_DIR = resolveDataDir();
export const OMP_BIN = process.env.OMP_BIN ?? "omp";
export const ADB_BIN = process.env.ADB_BIN ?? "adb";
/** `xcrun` for simctl; overridable so tests and non-Xcode machines never start CoreSimulator. */
export const XCRUN_BIN = process.env.XCRUN_BIN ?? "xcrun";
export const GIT_BIN = process.env.GIT_BIN ?? "git";
export const GH_BIN = process.env.GH_BIN ?? "gh";
export const ARTEMIS_LOCK_DIR = path.join(os.tmpdir(), "artemis", "device-locks");

/** Android emulator binary: explicit env, then the SDK locations Android Studio uses on macOS and Linux. */
export function findEmulator(
  env: Record<string, string | undefined> = process.env,
  exists: (p: string) => boolean = existsSync,
  home: string = os.homedir(),
): string | null {
  if (env.EMULATOR_BIN) return env.EMULATOR_BIN;
  const candidates = [
    env.ANDROID_HOME && path.join(env.ANDROID_HOME, "emulator", "emulator"),
    env.ANDROID_SDK_ROOT && path.join(env.ANDROID_SDK_ROOT, "emulator", "emulator"),
    path.join(home, "Library", "Android", "sdk", "emulator", "emulator"),
    path.join(home, "Android", "Sdk", "emulator", "emulator"),
  ].filter((c): c is string => !!c);
  return candidates.find((c) => exists(c)) ?? null;
}
export const EMULATOR_BIN = findEmulator();

/** Longest message accepted by the steer endpoint and the `qa_steer_run` MCP tool. */
export const MAX_STEER_CHARS = 4000;

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
