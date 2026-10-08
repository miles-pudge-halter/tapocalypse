import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

export const REPO_ROOT = path.resolve(import.meta.dir, "..");

const ConfigSchema = z.object({
  port: z.number().int().positive(),
  maxConcurrentRuns: z.number().int().positive(),
  runMaxTime: z.string().min(1),
  artemisPath: z.string().min(1).optional(),
  /** Loose entries: the project registry validates them individually so one bad project never blocks boot. */
  projects: z.array(z.record(z.string(), z.unknown())),
  /** Fallback model/thinking when a project persona has no `model:`; neither set = omp's own default. */
  agent: z.object({ model: z.string().min(1).optional(), thinking: z.string().min(1).optional() }).optional(),
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

export const CONFIG_PATH = process.env.TAPOCALYPSE_CONFIG ?? path.join(REPO_ROOT, "tapocalypse.config.json");

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

export const DATA_DIR = process.env.TAPOCALYPSE_DATA_DIR ?? path.join(REPO_ROOT, "data");
export const OMP_BIN = process.env.OMP_BIN ?? "omp";
export const ADB_BIN = process.env.ADB_BIN ?? "adb";
export const GIT_BIN = process.env.GIT_BIN ?? "git";
export const GH_BIN = process.env.GH_BIN ?? "gh";
export const ARTEMIS_LOCK_DIR = path.join(os.tmpdir(), "artemis", "device-locks");

function findEmulator(): string | null {
  if (process.env.EMULATOR_BIN) return process.env.EMULATOR_BIN;
  const candidates = [
    process.env.ANDROID_HOME && path.join(process.env.ANDROID_HOME, "emulator", "emulator"),
    process.env.ANDROID_SDK_ROOT && path.join(process.env.ANDROID_SDK_ROOT, "emulator", "emulator"),
    path.join(os.homedir(), "Library", "Android", "sdk", "emulator", "emulator"),
  ].filter((c): c is string => !!c);
  return candidates.find((c) => existsSync(c)) ?? null;
}
export const EMULATOR_BIN = findEmulator();

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
