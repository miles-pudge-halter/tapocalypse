import { describe, expect, test } from "bun:test";
import path from "node:path";
import { config, ConfigSchema, findEmulator, REPO_ROOT, resolveConfigPath, resolveDataDir } from "../src/config";

const HOME = "/home/me";
const legacyConfig = path.join(REPO_ROOT, "tapocalypse.config.json");
const legacyData = path.join(REPO_ROOT, "data");

describe("resolveConfigPath / resolveDataDir", () => {
  test("explicit env wins over everything", () => {
    expect(resolveConfigPath({ TAPOCALYPSE_CONFIG: "/x/c.json" }, () => true, HOME)).toBe("/x/c.json");
    expect(resolveDataDir({ TAPOCALYPSE_DATA_DIR: "/x/data" }, () => true, HOME)).toBe("/x/data");
  });

  test("legacy in-repo files keep being used when present", () => {
    expect(resolveConfigPath({}, (p) => p === legacyConfig, HOME)).toBe(legacyConfig);
    expect(resolveDataDir({}, (p) => p === legacyData, HOME)).toBe(legacyData);
  });

  test("fresh installs use XDG locations, honouring XDG_*_HOME", () => {
    expect(resolveConfigPath({}, () => false, HOME)).toBe("/home/me/.config/tapocalypse/config.json");
    expect(resolveConfigPath({ XDG_CONFIG_HOME: "/cfg" }, () => false, HOME)).toBe("/cfg/tapocalypse/config.json");
    expect(resolveDataDir({}, () => false, HOME)).toBe("/home/me/.local/share/tapocalypse");
    expect(resolveDataDir({ XDG_DATA_HOME: "/dat" }, () => false, HOME)).toBe("/dat/tapocalypse");
  });
});

describe("findEmulator", () => {
  test("finds the Linux SDK location", () => {
    const linux = path.join(HOME, "Android", "Sdk", "emulator", "emulator");
    expect(findEmulator({}, (p) => p === linux, HOME)).toBe(linux);
  });

  test("ANDROID_HOME precedes the default locations; EMULATOR_BIN precedes all", () => {
    const fromHome = path.join("/sdk", "emulator", "emulator");
    expect(findEmulator({ ANDROID_HOME: "/sdk" }, () => true, HOME)).toBe(fromHome);
    expect(findEmulator({ EMULATOR_BIN: "/custom/emu", ANDROID_HOME: "/sdk" }, () => true, HOME)).toBe("/custom/emu");
    expect(findEmulator({}, () => false, HOME)).toBeNull();
  });
});

describe("config defaults", () => {
  test("a config without retry/retention gets one infra retry and keeps everything", () => {
    expect(config.retry).toEqual({ infra: 1 });
    expect(config.retention).toEqual({});
  });
});

describe("ConfigSchema runMaxTime", () => {
  test("accepts the durations the runner and omp understand and rejects what parseDurationMs cannot read", () => {
    for (const ok of ["60m", "1h30m", "45s", "2h", "90"]) expect(ConfigSchema.safeParse({ ...config, runMaxTime: ok }).success).toBe(true);
    for (const bad of ["soon", "10 minutes", "m60", "0s"]) expect(ConfigSchema.safeParse({ ...config, runMaxTime: bad }).success).toBe(false);
  });
});
