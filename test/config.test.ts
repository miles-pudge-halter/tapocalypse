import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config, ConfigSchema, ensurePrivateDir, findEmulator, HubConfigSchema, REPO_ROOT, resolveConfigPath, resolveDataDir } from "../src/config";

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

describe("team hub address", () => {
  test("the config accepts https, and plain http only for this machine", () => {
    for (const ok of ["https://hub.example.com", "https://hub.example.com/qa", "http://localhost:4311", "http://127.0.0.1:4311", "http://[::1]:4311"]) {
      expect(HubConfigSchema.safeParse({ url: ok }).success).toBe(true);
    }
    for (const bad of ["http://hub.example.com", "http://127.0.0.1.example.com", "http://localhost.example.com", "ftp://hub.example.com", "hub.example.com", "javascript:alert(1)"]) {
      expect(HubConfigSchema.safeParse({ url: bad }).success).toBe(false);
    }
  });

  test("a config file naming an insecure hub address is refused as a whole", () => {
    expect(ConfigSchema.safeParse({ ...config, share: { hub: { url: "http://hub.example.com" } } }).success).toBe(false);
  });
});

describe("private data directory", () => {
  const mode = (p: string) => fs.statSync(p).mode & 0o777;
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "tpc-private-"));

  test("ensurePrivateDir creates the directory 0700 (its missing parents keep the default mode)", () => {
    const root = tmp();
    const umask = process.umask(0o022);
    try {
      const dir = path.join(root, "a", "data");
      ensurePrivateDir(dir);
      expect(mode(dir)).toBe(0o700);
      expect(mode(path.join(root, "a"))).toBe(0o755);
    } finally {
      process.umask(umask);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("ensurePrivateDir tightens an existing 0755 directory and leaves its contents alone", () => {
    const root = tmp();
    try {
      const dir = path.join(root, "data");
      fs.mkdirSync(dir, { mode: 0o755 });
      fs.chmodSync(dir, 0o755);
      const file = path.join(dir, "keep.txt");
      fs.writeFileSync(file, "x", { mode: 0o644 });
      fs.chmodSync(file, 0o644);
      ensurePrivateDir(dir);
      expect(mode(dir)).toBe(0o700);
      expect(mode(file)).toBe(0o644);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
