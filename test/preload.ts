// Runs before any test file: points config/data at a throwaway fake project so tests never touch real state.
// Must not import src modules (config loads at import time and reads the env vars set here).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tapocalypse-test-"));
const repo = path.join(root, "repo");
fs.mkdirSync(path.join(repo, ".omp", "agents"), { recursive: true });
fs.mkdirSync(path.join(repo, "qa"), { recursive: true });
fs.writeFileSync(
  path.join(repo, ".omp", "agents", "qa.md"),
  "---\nname: qa\nmodel: anthropic/claude-haiku-4-5\n---\nYou are a QA agent.\n",
);

const configFile = path.join(root, "tapocalypse.config.json");
fs.writeFileSync(
  configFile,
  JSON.stringify({
    port: 4399,
    maxConcurrentRuns: 4,
    runMaxTime: "10m",
    projects: [
      {
        id: "test-proj",
        name: "Test Project",
        repoPath: repo,
        personaFile: ".omp/agents/qa.md",
        reportsDir: "qa",
        defaultPackage: "com.example.app",
        defaultPlatform: "android",
      },
    ],
    devicePool: {
      android: {
        avds: ["AVD_A", "AVD_B"],
        basePort: 5560,
        maxBooted: 1,
        minSize: "720x1280",
        minDensity: 320,
        idleShutdownMinutes: 20,
        excludeSerials: ["emulator-5999"],
      },
      ios: { simulators: [], idleShutdownMinutes: 20 },
    },
  }),
);

// Tests must never reach a real emulator or adb server: an unrunnable binary fails fast (ENOENT) instead.
process.env.EMULATOR_BIN = path.join(root, "no-emulator");
process.env.ADB_BIN = path.join(root, "no-adb");
process.env.XCRUN_BIN = path.join(root, "no-xcrun");
// Likewise for agent harnesses: `/api/harnesses` and doctor probes must never launch a real omp/claude/codex.
process.env.OMP_BIN = path.join(root, "no-omp");
process.env.CLAUDE_BIN = path.join(root, "no-claude");
process.env.CODEX_BIN = path.join(root, "no-codex");
// And for the device gateway: a test that lists tools or calls a device tool without a fake client must fail fast, never `npx` the real mobile-mcp.
process.env.MOBILE_MCP_BIN = path.join(root, "no-mobile-mcp");

process.env.TAPOCALYPSE_CONFIG = configFile;
process.env.TAPOCALYPSE_DATA_DIR = path.join(root, "data");

process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
