import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { config, DATA_DIR } from "../src/config";
import { defaultServiceDeps, type ServiceDeps, serviceCommand, unitFile } from "../src/service";

interface Fake {
  deps: ServiceDeps;
  commands: string[][];
  files: Map<string, string>;
  removed: string[];
  dirs: string[];
  warnings: string[];
}

function fake(overrides: Partial<ServiceDeps> = {}, answers: (cmd: string[]) => { code?: number; text?: string; stderr?: string } = () => ({})): Fake {
  const commands: string[][] = [];
  const files = new Map<string, string>();
  const removed: string[] = [];
  const dirs: string[] = [];
  const warnings: string[] = [];
  const deps: ServiceDeps = {
    platform: "darwin",
    home: "/Users/tester",
    uid: 501,
    execPath: "/opt/bun/bin/bun",
    repoRoot: "/src/tapocalypse",
    dataDir: "/Users/tester/.local/share/tapocalypse",
    env: { PATH: "/usr/bin:/bin" },
    run: async (cmd) => {
      commands.push(cmd);
      const a = answers(cmd);
      return { code: a.code ?? 0, stdout: new TextEncoder().encode(a.text ?? ""), text: a.text ?? "", stderr: a.stderr ?? "" };
    },
    probe: async () => true,
    write: (file, text) => void files.set(file, text),
    remove: (file) => void removed.push(file),
    mkdir: (dir) => void dirs.push(dir),
    readLog: () => "",
    warn: (message) => void warnings.push(message),
    ...overrides,
  };
  return { deps, commands, files, removed, dirs, warnings };
}

describe("unitFile on macOS", () => {
  test("generates a launchd plist that runs `serve` from the checkout and keeps it alive", () => {
    const { deps } = fake();
    const { path, content } = unitFile(deps);
    expect(path).toBe("/Users/tester/Library/LaunchAgents/dev.tapocalypse.server.plist");
    expect(content.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(content).toContain("<key>Label</key>\n  <string>dev.tapocalypse.server</string>");
    for (const arg of ["/opt/bun/bin/bun", "/src/tapocalypse/src/cli.ts", "serve"]) expect(content).toContain(`<string>${arg}</string>`);
    expect(content).toContain("<key>WorkingDirectory</key>\n  <string>/src/tapocalypse</string>");
    expect(content).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(content).toMatch(/<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<\/dict>/);
    const log = "/Users/tester/.local/share/tapocalypse/logs/service.log";
    expect(content).toContain(`<key>StandardOutPath</key>\n  <string>${log}</string>`);
    expect(content).toContain(`<key>StandardErrorPath</key>\n  <string>${log}</string>`);
  });
});

describe("service environment", () => {
  const envBlock = (content: string) => content.slice(content.indexOf("<key>EnvironmentVariables</key>"), content.indexOf("<key>RunAtLoad</key>"));
  const env = {
    PATH: "/usr/local/bin:/usr/bin",
    TAPOCALYPSE_PORT: "4400",
    TAPOCALYPSE_DATA_DIR: "/data/tpc",
    ANDROID_HOME: "/sdk",
    OMP_BIN: "/bin/omp",
    SECRET_TOKEN: "do-not-leak",
    AWS_PROFILE: "nope",
    EMULATOR_BIN: undefined,
  };

  test("bakes in production mode, PATH, HOME and the tool/config variables that are set", () => {
    const block = envBlock(unitFile(fake({ env }).deps).content);
    expect(block).toContain("<key>NODE_ENV</key>\n    <string>production</string>");
    expect(block).toContain("<key>PATH</key>\n    <string>/usr/local/bin:/usr/bin</string>");
    expect(block).toContain("<key>HOME</key>\n    <string>/Users/tester</string>");
    expect(block).toContain("<key>TAPOCALYPSE_PORT</key>\n    <string>4400</string>");
    expect(block).toContain("<key>TAPOCALYPSE_DATA_DIR</key>\n    <string>/data/tpc</string>");
    expect(block).toContain("<key>ANDROID_HOME</key>\n    <string>/sdk</string>");
    expect(block).toContain("<key>OMP_BIN</key>\n    <string>/bin/omp</string>");
  });

  test("does not copy unrelated or unset variables", () => {
    const block = envBlock(unitFile(fake({ env }).deps).content);
    expect(block).not.toContain("SECRET_TOKEN");
    expect(block).not.toContain("do-not-leak");
    expect(block).not.toContain("AWS_PROFILE");
    expect(block).not.toContain("EMULATOR_BIN");
  });

  test("escapes XML metacharacters in every value", () => {
    const { content } = unitFile(fake({ env: { PATH: "/a&b:/c<d>", TAPOCALYPSE_X: `"q"'s` }, repoRoot: "/src/a&b" }).deps);
    expect(content).toContain("<string>/a&amp;b:/c&lt;d&gt;</string>");
    expect(content).toContain("<string>&quot;q&quot;&apos;s</string>");
    expect(content).toContain("<string>/src/a&amp;b</string>");
    expect(content).not.toContain("/a&b");
  });
});

describe("hub secrets never reach the unit", () => {
  const env = {
    PATH: "/usr/bin",
    TAPOCALYPSE_PORT: "4400",
    TAPOCALYPSE_HUB_TOKEN: "tpu_" + "a".repeat(20),
    TAPOCALYPSE_HUB_HEADERS: '{"CF-Access-Client-Secret":"proxy-secret"}',
    TAPOCALYPSE_HUB_HOSTS: "qa.example.com",
  };

  for (const platform of ["darwin", "linux"] as const) {
    test(`${platform}: the upload token and proxy headers are left out, other settings are kept`, () => {
      const { content } = unitFile(fake({ platform, env }).deps);
      expect(content).not.toContain("TAPOCALYPSE_HUB_TOKEN");
      expect(content).not.toContain("TAPOCALYPSE_HUB_HEADERS");
      expect(content).not.toContain("tpu_");
      expect(content).not.toContain("proxy-secret");
      expect(content).toContain("TAPOCALYPSE_PORT");
      expect(content).toContain("TAPOCALYPSE_HUB_HOSTS");
    });

    test(`${platform}: install warns on stderr that they were skipped and points to hub-credentials.json`, async () => {
      const f = fake({ platform, env });
      await serviceCommand("install", f.deps);
      const warning = f.warnings.join("\n");
      expect(warning).toContain("TAPOCALYPSE_HUB_TOKEN");
      expect(warning).toContain("TAPOCALYPSE_HUB_HEADERS");
      expect(warning).toContain("hub-credentials.json");
      expect(warning).not.toContain("proxy-secret");
    });

    test(`${platform}: install without them does not warn`, async () => {
      const f = fake({ platform, env: { PATH: "/usr/bin", TAPOCALYPSE_PORT: "4400" } });
      await serviceCommand("install", f.deps);
      expect(f.warnings).toEqual([]);
    });
  }

  test("only the variable that is set is named in the warning", async () => {
    const f = fake({ env: { PATH: "/usr/bin", TAPOCALYPSE_HUB_TOKEN: "tpu_x" } });
    await serviceCommand("install", f.deps);
    expect(f.warnings.join("\n")).toContain("TAPOCALYPSE_HUB_TOKEN");
    expect(f.warnings.join("\n")).not.toContain("TAPOCALYPSE_HUB_HEADERS");
  });
});

describe("unitFile on Linux", () => {
  test("generates a systemd user unit that restarts the server and carries the environment", () => {
    const { deps } = fake({ platform: "linux", env: { PATH: "/usr/bin", TAPOCALYPSE_PORT: "4400", SECRET_TOKEN: "x" } });
    const { path, content } = unitFile(deps);
    expect(path).toBe("/Users/tester/.config/systemd/user/tapocalypse.service");
    expect(content).toContain("[Service]");
    expect(content).toContain("ExecStart=/opt/bun/bin/bun /src/tapocalypse/src/cli.ts serve");
    expect(content).toContain("WorkingDirectory=/src/tapocalypse");
    expect(content).toContain('Environment="NODE_ENV=production"');
    expect(content).toContain('Environment="PATH=/usr/bin"');
    expect(content).toContain('Environment="TAPOCALYPSE_PORT=4400"');
    expect(content).not.toContain("SECRET_TOKEN");
    expect(content).toContain("Restart=on-failure");
    expect(content).not.toContain("Restart=always");
    expect(content).toContain("RestartSec=2");
    expect(content).toContain("[Install]\nWantedBy=default.target");
  });

  test("quotes paths with spaces so systemd keeps them as one word", () => {
    const { content } = unitFile(fake({ platform: "linux", execPath: "/opt/my bun/bun", repoRoot: "/src/my repo" }).deps);
    expect(content).toContain('ExecStart="/opt/my bun/bun" "/src/my repo/src/cli.ts" serve');
    expect(content).toContain('WorkingDirectory=/src/my repo');
  });

  test("refuses platforms without a service manager", () => {
    expect(() => unitFile(fake({ platform: "win32" }).deps)).toThrow(/not supported/);
  });
});

const PLIST = "/Users/tester/Library/LaunchAgents/dev.tapocalypse.server.plist";
const DOMAIN = "gui/501";
const TARGET = "gui/501/dev.tapocalypse.server";
const LOG_DIR = "/Users/tester/.local/share/tapocalypse/logs";

describe("service install on macOS", () => {
  test("writes the plist and bootstraps it into the user's launchd domain", async () => {
    const f = fake();
    const result = await serviceCommand("install", f.deps);
    expect(result.ok).toBe(true);
    expect(f.files.get(PLIST)).toBe(unitFile(f.deps).content);
    expect(f.dirs).toEqual([LOG_DIR]);
    expect(f.commands).toEqual([["launchctl", "bootstrap", DOMAIN, PLIST]]);
  });

  test("creates the log directory in-process and reports a failure instead of loading a job that cannot open its log", async () => {
    const f = fake({
      mkdir: () => {
        throw new Error("EACCES: permission denied, mkdir '/data/logs'");
      },
    });
    const result = await serviceCommand("install", f.deps);
    expect(result.ok).toBe(false);
    expect(result.lines.join("\n")).toContain("EACCES");
    expect(f.commands).toEqual([]);
  });

  test("warns that installing restarts the server and ends active runs as interrupted", async () => {
    const result = await serviceCommand("install", fake().deps);
    expect(result.lines.join("\n")).toContain("restarts the server: active runs end as interrupted");
  });

  test("restart warns the same way", async () => {
    const mac = await serviceCommand("restart", fake().deps);
    expect(mac.lines.join("\n")).toContain("restarts the server: active runs end as interrupted");
    const linux = await serviceCommand("restart", fake({ platform: "linux" }).deps);
    expect(linux.lines.join("\n")).toContain("restarts the server: active runs end as interrupted");
    const linuxInstall = await serviceCommand("install", fake({ platform: "linux" }).deps);
    expect(linuxInstall.lines.join("\n")).toContain("restarts the server: active runs end as interrupted");
  });

  test("is idempotent: an already loaded service is reloaded with the fresh plist, not an error", async () => {
    const f = fake({}, (cmd) => (cmd[1] === "bootstrap" && f.commands.filter((c) => c[1] === "bootstrap").length === 1 ? { code: 5, stderr: "Bootstrap failed: 5: Input/output error\nalready loaded" } : {}));
    const result = await serviceCommand("install", f.deps);
    expect(result.ok).toBe(true);
    expect(f.files.get(PLIST)).toBeDefined();
    expect(f.commands).toEqual([
      ["launchctl", "bootstrap", DOMAIN, PLIST],
      ["launchctl", "bootout", TARGET],
      ["launchctl", "bootstrap", DOMAIN, PLIST],
    ]);
  });

  test("a bootstrap failure that is not 'already loaded' is reported", async () => {
    const f = fake({}, (cmd) => (cmd[1] === "bootstrap" ? { code: 125, stderr: "Domain does not support specified action" } : cmd[1] === "print" ? { code: 113 } : {}));
    const result = await serviceCommand("install", f.deps);
    expect(result.ok).toBe(false);
    expect(result.lines.join("\n")).toContain("Domain does not support specified action");
  });
});

describe("service start/stop/restart/uninstall on macOS", () => {
  const notLoaded = (cmd: string[]) => (cmd[1] === "print" ? { code: 113, stderr: "Could not find service" } : {});

  test("start kickstarts a loaded job", async () => {
    const f = fake();
    const result = await serviceCommand("start", f.deps);
    expect(result.ok).toBe(true);
    expect(f.commands).toEqual([
      ["launchctl", "print", TARGET],
      ["launchctl", "kickstart", TARGET],
    ]);
  });

  test("start loads the plist first when the job is not loaded", async () => {
    const f = fake({}, notLoaded);
    const result = await serviceCommand("start", f.deps);
    expect(result.ok).toBe(true);
    expect(f.commands).toEqual([
      ["launchctl", "print", TARGET],
      ["launchctl", "bootstrap", DOMAIN, PLIST],
      ["launchctl", "kickstart", TARGET],
    ]);
  });

  test("start on a machine without the service says to install it", async () => {
    const f = fake({}, (cmd) => (cmd[1] === "print" ? { code: 113 } : cmd[1] === "bootstrap" ? { code: 5, stderr: "Bootstrap failed: 5: Input/output error" } : {}));
    const result = await serviceCommand("start", f.deps);
    expect(result.ok).toBe(false);
    expect(result.lines.join("\n")).toContain("tapocalypse service install");
    expect(f.commands.some((c) => c[1] === "kickstart")).toBe(false);
  });

  test("restart force-restarts the job (kickstart -k)", async () => {
    const f = fake();
    expect((await serviceCommand("restart", f.deps)).ok).toBe(true);
    expect(f.commands).toEqual([
      ["launchctl", "print", TARGET],
      ["launchctl", "kickstart", "-k", TARGET],
    ]);
  });

  test("stop boots the job out and treats an unloaded job as already stopped", async () => {
    const f = fake();
    expect((await serviceCommand("stop", f.deps)).ok).toBe(true);
    expect(f.commands).toEqual([["launchctl", "bootout", TARGET]]);
    const g = fake({}, () => ({ code: 3, stderr: "Boot-out failed: 3: No such process" }));
    expect((await serviceCommand("stop", g.deps)).ok).toBe(true);
  });

  test("stop reports a bootout failure that is not 'not loaded'", async () => {
    const f = fake({}, () => ({ code: 1, stderr: "Boot-out failed: 1: Operation not permitted" }));
    const result = await serviceCommand("stop", f.deps);
    expect(result.ok).toBe(false);
    expect(result.lines.join("\n")).toContain("Operation not permitted");
  });

  test("uninstall unloads the job and deletes the plist, even when it was not loaded", async () => {
    const f = fake({}, () => ({ code: 3, stderr: "No such process" }));
    const result = await serviceCommand("uninstall", f.deps);
    expect(result.ok).toBe(true);
    expect(f.commands).toEqual([["launchctl", "bootout", TARGET]]);
    expect(f.removed).toEqual([PLIST]);
  });
});

describe("service status and logs on macOS", () => {
  const printed = [
    `${TARGET} = {`,
    "\tactive count = 1",
    "\tstate = running",
    "\tprogram = /opt/bun/bin/bun",
    "\tpid = 4242",
    "\tlast exit code = (never exited)",
    "}",
  ].join("\n");

  test("running and reachable: reports the pid and that the server answers", async () => {
    const f = fake({ probe: async () => true }, () => ({ text: printed }));
    const result = await serviceCommand("status", f.deps);
    expect(f.commands).toEqual([["launchctl", "print", TARGET]]);
    expect(result.ok).toBe(true);
    expect(result.lines.join("\n")).toContain("running (pid 4242)");
    expect(result.lines.join("\n")).toMatch(/server: reachable/);
  });

  test("installed but not running: reports launchd's state and that the server is down", async () => {
    const text = `${TARGET} = {\n\tstate = waiting\n\tlast exit code = 78\n}`;
    const f = fake({ probe: async () => false }, () => ({ text }));
    const result = await serviceCommand("status", f.deps);
    expect(result.ok).toBe(false);
    const out = result.lines.join("\n");
    expect(out).toContain("installed, not running");
    expect(out).toContain("waiting");
    expect(out).toMatch(/server: not reachable/);
    expect(out).not.toContain("pid");
  });

  test("not installed: says so and points at install, still probes for a hand-started server", async () => {
    const f = fake({ probe: async () => true }, () => ({ code: 113, stderr: "Could not find service" }));
    const result = await serviceCommand("status", f.deps);
    expect(result.ok).toBe(false);
    const out = result.lines.join("\n");
    expect(out).toContain("not installed");
    expect(out).toContain("tapocalypse service install");
    expect(out).toMatch(/server: reachable/);
  });

  test("logs returns the tail of the service log file", async () => {
    const reads: [string, number][] = [];
    const f = fake({
      readLog: (file, lines) => {
        reads.push([file, lines]);
        return "boot\nlistening on 4310\n";
      },
    });
    const result = await serviceCommand("logs", f.deps);
    expect(result).toEqual({ ok: true, lines: ["boot", "listening on 4310"] });
    expect(reads).toEqual([[`${LOG_DIR}/service.log`, 100]]);
    expect(f.commands).toEqual([]);
  });

  test("logs of a service that never wrote anything is not an error", async () => {
    const result = await serviceCommand("logs", fake().deps);
    expect(result.ok).toBe(true);
    expect(result.lines.join("\n")).toMatch(/no log/i);
  });
});

describe("service on Linux", () => {
  const UNIT_PATH = "/Users/tester/.config/systemd/user/tapocalypse.service";
  const sysctl = (...args: string[]) => ["systemctl", "--user", ...args];

  test("install writes the unit, reloads systemd and enables it now", async () => {
    const f = fake({ platform: "linux" });
    const result = await serviceCommand("install", f.deps);
    expect(result.ok).toBe(true);
    expect(f.files.get(UNIT_PATH)).toBe(unitFile(f.deps).content);
    expect(f.commands).toEqual([sysctl("daemon-reload"), sysctl("enable", "--now", "tapocalypse")]);
    expect(result.lines.join("\n")).toContain("enable-linger");
  });

  test("install reports a systemctl failure", async () => {
    const f = fake({ platform: "linux" }, (cmd) => (cmd[2] === "enable" ? { code: 1, stderr: "Failed to connect to bus: No medium found" } : {}));
    const result = await serviceCommand("install", f.deps);
    expect(result.ok).toBe(false);
    expect(result.lines.join("\n")).toContain("Failed to connect to bus");
  });

  test("uninstall disables the unit, deletes the file and reloads systemd", async () => {
    const f = fake({ platform: "linux" }, (cmd) => (cmd[2] === "disable" ? { code: 1, stderr: "Unit file tapocalypse.service does not exist" } : {}));
    const result = await serviceCommand("uninstall", f.deps);
    expect(result.ok).toBe(true);
    expect(f.commands).toEqual([sysctl("disable", "--now", "tapocalypse"), sysctl("daemon-reload")]);
    expect(f.removed).toEqual([UNIT_PATH]);
  });

  for (const action of ["start", "stop", "restart"] as const) {
    test(`${action} addresses only the tapocalypse unit`, async () => {
      const f = fake({ platform: "linux" });
      expect((await serviceCommand(action, f.deps)).ok).toBe(true);
      expect(f.commands).toEqual([sysctl(action, "tapocalypse")]);
    });
  }

  test("a failing start is reported with systemd's message", async () => {
    const f = fake({ platform: "linux" }, () => ({ code: 5, stderr: "Unit tapocalypse.service not found." }));
    const result = await serviceCommand("start", f.deps);
    expect(result.ok).toBe(false);
    expect(result.lines.join("\n")).toContain("not found");
  });

  test("status: active unit and reachable server", async () => {
    const f = fake({ platform: "linux", probe: async () => true }, () => ({ text: "active\n" }));
    const result = await serviceCommand("status", f.deps);
    expect(f.commands).toEqual([sysctl("is-active", "tapocalypse")]);
    expect(result.ok).toBe(true);
    expect(result.lines.join("\n")).toContain("service: running");
    expect(result.lines.join("\n")).toContain("server: reachable");
  });

  test("status: installed but failed", async () => {
    const f = fake({ platform: "linux", probe: async () => false }, (cmd) => (cmd[2] === "is-active" ? { code: 3, text: "failed\n" } : {}));
    const result = await serviceCommand("status", f.deps);
    expect(result.ok).toBe(false);
    expect(result.lines.join("\n")).toContain("installed, not running (failed)");
    expect(f.commands).toEqual([sysctl("is-active", "tapocalypse"), sysctl("cat", "tapocalypse")]);
  });

  test("status: unit does not exist", async () => {
    const f = fake({ platform: "linux", probe: async () => false }, (cmd) => (cmd[2] === "is-active" ? { code: 4, text: "inactive\n" } : { code: 1, stderr: "No files found" }));
    const result = await serviceCommand("status", f.deps);
    expect(result.ok).toBe(false);
    expect(result.lines.join("\n")).toContain("not installed");
  });

  test("logs come from the user journal", async () => {
    const f = fake({ platform: "linux" }, () => ({ text: "line one\nline two\n" }));
    const result = await serviceCommand("logs", f.deps);
    expect(f.commands).toEqual([["journalctl", "--user", "-u", "tapocalypse", "-n", "100", "--no-pager"]]);
    expect(result).toEqual({ ok: true, lines: ["line one", "line two"] });
  });
});

describe("unsupported platforms", () => {
  for (const action of ["install", "uninstall", "start", "stop", "restart", "status", "logs"] as const) {
    test(`${action} on windows runs nothing and says it is not supported`, async () => {
      const f = fake({ platform: "win32" });
      const result = await serviceCommand(action, f.deps);
      expect(result.ok).toBe(false);
      expect(result.lines.join("\n")).toMatch(/not supported/);
      expect(f.commands).toEqual([]);
      expect(f.files.size).toBe(0);
      expect(f.removed).toEqual([]);
    });
  }
});

describe("defaultServiceDeps", () => {
  test("points at this checkout, the configured data dir and the live environment", () => {
    const deps = defaultServiceDeps();
    expect(existsSync(path.join(deps.repoRoot, "src", "cli.ts"))).toBe(true);
    expect(deps.dataDir).toBe(DATA_DIR);
    expect(deps.execPath).toBe(process.execPath);
    expect(deps.platform).toBe(process.platform);
    expect(deps.env.PATH).toBe(process.env.PATH);
  });

  test("probe is true only while /api/mcp/status answers ok on the configured port", async () => {
    const deps = defaultServiceDeps();
    expect(await deps.probe()).toBe(false);
    let status = 200;
    const server = Bun.serve({
      port: config.port,
      hostname: "127.0.0.1",
      fetch: (req) => (new URL(req.url).pathname === "/api/mcp/status" ? Response.json({}, { status }) : new Response("x", { status: 404 })),
    });
    try {
      expect(await deps.probe()).toBe(true);
      status = 500;
      expect(await deps.probe()).toBe(false);
    } finally {
      await server.stop(true);
    }
  });

  test("mkdir creates nested directories and tolerates an existing one", () => {
    const deps = defaultServiceDeps();
    const dir = mkdtempSync(path.join(os.tmpdir(), "tpc-service-"));
    try {
      const nested = path.join(dir, "a", "b", "logs");
      deps.mkdir(nested);
      deps.mkdir(nested);
      expect(existsSync(nested)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("write creates parent directories, remove tolerates a missing file, readLog returns the last lines", () => {
    const deps = defaultServiceDeps();
    const dir = mkdtempSync(path.join(os.tmpdir(), "tpc-service-"));
    try {
      const file = path.join(dir, "a", "b", "service.log");
      expect(deps.readLog(file, 5)).toBe("");
      deps.write(file, `${Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join("\n")}\n`);
      expect(deps.readLog(file, 3)).toBe("l8\nl9\nl10\n");
      deps.remove(file);
      deps.remove(file);
      expect(existsSync(file)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("defaultServiceDeps write", () => {
  test("the unit is written owner-only (0600), also over an existing world-readable file, and parents are created", async () => {
    const deps = defaultServiceDeps();
    const dir = mkdtempSync(path.join(os.tmpdir(), "tpc-service-"));
    try {
      const fresh = path.join(dir, "LaunchAgents", "x.plist");
      deps.write(fresh, "a");
      expect(statSync(fresh).mode & 0o777).toBe(0o600);

      const old = path.join(dir, "old.service");
      writeFileSync(old, "old", { mode: 0o644 });
      chmodSync(old, 0o644);
      deps.write(old, "new");
      expect(statSync(old).mode & 0o777).toBe(0o600);
      expect(await Bun.file(old).text()).toBe("new");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
