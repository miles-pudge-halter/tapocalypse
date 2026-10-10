import { afterAll, beforeEach, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ApiClient,
  buildStartRequest,
  EXIT,
  exitCodeForError,
  exitCodeForRun,
  exitCodeForRuns,
  executeReport,
  executeRun,
  executeService,
  formatRun,
  oneLine,
  progressLine,
  ApiError,
  parseCli,
  parseDuration,
  parseFailOn,
  renderJUnit,
  ServerUnreachableError,
  summarizeRun,
  UsageError,
  type RunDeps,
  type RunLite,
  type RunOptions,
} from "../src/cli";

function run(overrides: Partial<RunLite> = {}): RunLite {
  return {
    id: "20260101-000000-abcd-smoke",
    projectId: "my-app",
    title: "Smoke",
    status: "done",
    verdict: "PASS",
    summary: null,
    error: null,
    deviceSerial: "emulator-5554",
    checks: [],
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:02:00.000Z",
    reportFile: null,
    ...overrides,
  };
}

function runOptions(argv: string[]): RunOptions {
  const cmd = parseCli(["run", "--project", "my-app", ...argv]);
  if (cmd.name !== "run") throw new Error("expected run command");
  return cmd.options;
}

describe("parseCli", () => {
  test("--harness accepts omp, claude and codex only", () => {
    for (const id of ["omp", "claude", "codex"] as const) expect(runOptions(["--brief", "x", "--harness", id]).harness).toBe(id);
    expect(runOptions(["--brief", "x"]).harness).toBeNull();
    expect(() => runOptions(["--brief", "x", "--harness", "gemini"])).toThrow(UsageError);
  });

  test("run with a brief applies the documented defaults", () => {
    const o = runOptions(["--brief", "open settings"]);
    expect(o).toMatchObject({
      projectId: "my-app",
      brief: "open settings",
      wait: false,
      json: false,
      junit: null,
      serials: [],
      timeoutMs: 90 * 60_000,
      failOn: ["FAIL", "BLOCKED", "PARTIAL"],
      url: "http://127.0.0.1:4310",
    });
  });

  test("--junit implies --wait, repeated --serial collects, URL comes from env", () => {
    const cmd = parseCli(["run", "--project", "p", "--suite", "smoke", "--serial", "a", "--serial", "b", "--junit", "out.xml"], {
      TAPOCALYPSE_URL: "http://localhost:4400/",
    });
    if (cmd.name !== "run") throw new Error("expected run");
    expect(cmd.options.wait).toBe(true);
    expect(cmd.options.serials).toEqual(["a", "b"]);
    expect(cmd.options.url).toBe("http://localhost:4400");
  });

  test("rejects invalid combinations with a UsageError", () => {
    const bad: string[][] = [
      ["run", "--brief", "x"], // no project
      ["run", "--project", "p"], // no brief source
      ["run", "--project", "p", "--brief", "x", "--suite", "s"], // two sources
      ["run", "--project", "p", "--brief", "x", "--serial", "a", "--devices", "2"],
      ["run", "--project", "p", "--brief", "x", "--devices", "9"],
      ["run", "--project", "p", "--brief", "x", "--platform", "windows"],
      ["run", "--project", "p", "--brief", "x", "--devices", "2", "--install", "a.apk"],
      ["run", "--project", "p", "--brief", "x", "--fail-on", "MAYBE"],
      ["run", "--project", "p", "--brief", "x", "--nope"],
      ["serve", "--port", "0"],
      ["status"],
      ["frobnicate"],
    ];
    for (const argv of bad) expect(() => parseCli(argv)).toThrow(UsageError);
  });

  test("serve is production unless --dev is given", () => {
    expect(parseCli(["serve"])).toEqual({ name: "serve", port: null, dev: false });
    expect(parseCli(["serve", "--dev", "--port", "4400"])).toEqual({ name: "serve", port: 4400, dev: true });
  });

  test("report takes one run id, an optional --export dir (resolved absolute) and --json", () => {
    expect(parseCli(["report", "r1"])).toEqual({ name: "report", id: "r1", exportDir: null, json: false, url: "http://127.0.0.1:4310" });
    expect(parseCli(["report", "r1", "--json", "--url", "http://localhost:4400/"])).toMatchObject({ json: true, url: "http://localhost:4400" });
    expect(parseCli(["report", "r1", "--export", "out/qa"])).toMatchObject({ exportDir: path.resolve("out/qa") });
    expect(parseCli(["report", "r1", "--export", "/abs/qa"])).toMatchObject({ exportDir: "/abs/qa" });
    expect(() => parseCli(["report"])).toThrow(UsageError);
    expect(() => parseCli(["report", "a", "b"])).toThrow(UsageError);
    expect(() => parseCli(["report", "r1", "--export"])).toThrow(UsageError);
  });

  test("service takes exactly one known action", () => {
    for (const action of ["install", "uninstall", "start", "stop", "restart", "status", "logs"] as const) {
      expect(parseCli(["service", action])).toEqual({ name: "service", action });
    }
    expect(() => parseCli(["service"])).toThrow(UsageError);
    expect(() => parseCli(["service", "reboot"])).toThrow(UsageError);
    expect(() => parseCli(["service", "start", "stop"])).toThrow(UsageError);
  });

  test("the unreachable-server hint names the always-on service", () => {
    expect(new ServerUnreachableError("http://x").message).toContain("tapocalypse service start");
  });

  test("help and version short-circuit, even after a command", () => {
    expect(parseCli([]).name).toBe("help");
    expect(parseCli(["run", "--help"]).name).toBe("help");
    expect(parseCli(["--version"]).name).toBe("version");
  });

  test("durations and fail-on lists", () => {
    expect(parseDuration("90m")).toBe(5_400_000);
    expect(parseDuration("30")).toBe(30_000);
    expect(parseDuration("1.5h")).toBe(5_400_000);
    expect(() => parseDuration("soon")).toThrow(UsageError);
    expect(parseFailOn("fail, pass_with_issues,FAIL")).toEqual(["FAIL", "PASS WITH ISSUES"]);
  });
});

describe("exit codes", () => {
  test("verdicts map through --fail-on", () => {
    const failOn = parseFailOn("FAIL,BLOCKED");
    expect(exitCodeForRun(run({ verdict: "PASS" }), failOn)).toBe(EXIT.OK);
    expect(exitCodeForRun(run({ verdict: "PASS WITH ISSUES" }), failOn)).toBe(EXIT.OK);
    expect(exitCodeForRun(run({ verdict: "PARTIAL" }), failOn)).toBe(EXIT.OK);
    expect(exitCodeForRun(run({ verdict: "FAIL" }), failOn)).toBe(EXIT.VERDICT);
  });

  test("runs without a trustworthy outcome are 2 whatever the verdict", () => {
    const failOn = parseFailOn("FAIL");
    expect(exitCodeForRun(run({ status: "error", verdict: null, error: "boom" }), failOn)).toBe(EXIT.ERROR);
    expect(exitCodeForRun(run({ status: "cancelled", verdict: null }), failOn)).toBe(EXIT.ERROR);
    expect(exitCodeForRun(run({ status: "done", verdict: "PASS", errorKind: "timeout" }), failOn)).toBe(EXIT.ERROR);
    expect(exitCodeForRun(run({ status: "running", verdict: null }), failOn)).toBe(EXIT.ERROR);
  });

  test("a batch takes the worst code; a timed-out wait is 2", () => {
    const failOn = parseFailOn("FAIL");
    const pass = run({ id: "a" });
    const fail = run({ id: "b", verdict: "FAIL" });
    const err = run({ id: "c", status: "error", verdict: null });
    expect(exitCodeForRuns([pass, pass], failOn, false)).toBe(0);
    expect(exitCodeForRuns([pass, fail], failOn, false)).toBe(1);
    expect(exitCodeForRuns([pass, fail, err], failOn, false)).toBe(2);
    expect(exitCodeForRuns([pass], failOn, true)).toBe(2);
  });

  test("client errors are usage (3), server errors are 2", () => {
    expect(exitCodeForError(new UsageError("x"))).toBe(3);
    expect(exitCodeForError(new ServerUnreachableError("http://x"))).toBe(3);
    expect(exitCodeForError(new ApiError(400, "bad"))).toBe(3);
    expect(exitCodeForError(new ApiError(500, "boom"))).toBe(2);
  });
});

describe("buildStartRequest", () => {
  const platformFor = (serial: string | null) => (serial === "ios-sim" ? "ios" : "android");

  test("one device is a plain run; platform comes from the serial's device", () => {
    const req = buildStartRequest(runOptions(["--brief", "check login\nmore", "--serial", "ios-sim", "--model", "m"]), "check login\nmore", platformFor, "cli");
    expect(req.kind).toBe("run");
    expect(req.path).toBe("/api/runs");
    expect(req.body).toMatchObject({
      projectId: "my-app",
      title: "check login",
      brief: "check login\nmore",
      model: "m",
      device: { platform: "ios", serial: "ios-sim" },
      requestedBy: "cli",
    });
  });

  test("--harness picks the agent harness for a run and for a batch; omitted it is not sent", () => {
    const single = buildStartRequest(runOptions(["--brief", "x", "--harness", "codex"]), "x", platformFor, "cli");
    expect(single.body.harness).toBe("codex");
    const batch = buildStartRequest(runOptions(["--brief", "x", "--devices", "2", "--harness", "claude"]), "x", platformFor, "cli");
    expect(batch.body.harness).toBe("claude");
    expect("harness" in buildStartRequest(runOptions(["--brief", "x"]), "x", platformFor, "cli").body).toBe(false);
  });

  test("several serials or --devices N fan out to a batch; suites send no brief or default title", () => {
    const byDevices = buildStartRequest(runOptions(["--brief", "x", "--devices", "3", "--platform", "ios"]), "x", platformFor, "ci");
    expect(byDevices.kind).toBe("batch");
    expect(byDevices.body.devices).toEqual([{ platform: "ios" }, { platform: "ios" }, { platform: "ios" }]);

    const bySerials = buildStartRequest(runOptions(["--suite", "smoke", "--serial", "emulator-1", "--serial", "ios-sim"]), null, platformFor, "cli");
    expect(bySerials.path).toBe("/api/batches");
    expect(bySerials.body.devices).toEqual([
      { platform: "android", serial: "emulator-1" },
      { platform: "ios", serial: "ios-sim" },
    ]);
    expect(bySerials.body).toMatchObject({ suiteId: "smoke" });
    expect("brief" in bySerials.body).toBe(false);
    expect("title" in bySerials.body).toBe(false);
  });
});

describe("renderJUnit", () => {
  const failing = run({
    id: "r1",
    title: 'Login <flow> & "co"',
    verdict: "FAIL",
    summary: "Login broke.",
    reportFile: "/data/runs/r1/report.md",
    checks: [
      { id: "C1", title: "Launch", status: "pass", startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:00:12.500Z" },
      { id: "C2", title: "Sign in", status: "fail", note: "button <Sign in> missing\nsecond line" },
      { id: "C3", title: "Profile", status: "blocked", note: "needs login" },
      { id: "C4", title: "Logout", status: "skipped" },
      { id: "C5", title: "Never ran", status: "pending" },
    ],
  });
  const xml = renderJUnit([failing], "http://127.0.0.1:4310");

  test("counts and per-check outcomes", () => {
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<testsuites name="tapocalypse" tests="5" failures="1" errors="0" skipped="3" time="120.000">');
    expect(xml).toContain('tests="5" failures="1" errors="0" skipped="3" time="120.000" timestamp="2026-01-01T00:00:00.000Z"');
    expect(xml).toContain('name="C1: Launch" time="12.500"/>');
    expect(xml).toContain('name="C2: Sign in" time="0.000"><failure message="button &lt;Sign in&gt; missing&#10;second line">button &lt;Sign in&gt; missing\nsecond line</failure>');
    expect(xml).toContain('<skipped message="blocked: needs login"/>');
    expect(xml).toContain('name="C4: Logout" time="0.000"><skipped message="skipped"/>');
    expect(xml).toContain('<skipped message="not completed (pending)"/>');
  });

  test("escapes attributes and carries run metadata", () => {
    expect(xml).toContain('name="Login &lt;flow&gt; &amp; &quot;co&quot;"');
    expect(xml).toContain('<property name="run.url" value="http://127.0.0.1:4310/#/runs/r1"/>');
    expect(xml).toContain('<property name="report" value="/data/runs/r1/report.md"/>');
    expect(xml).toContain("<system-out>Login broke.</system-out>");
    // every tag opened is closed: a crude well-formedness check
    expect(xml.match(/<testsuite /g)?.length).toBe(xml.match(/<\/testsuite>/g)?.length);
    expect(xml.match(/<testcase /g)?.length).toBe(5);
  });

  test("an errored run with no checks still yields a failing testcase; FAIL without a failed check adds one", () => {
    const errored = renderJUnit([run({ status: "error", verdict: null, error: "omp exited", errorKind: "infra" })], "http://x");
    expect(errored).toContain('tests="1" failures="0" errors="1" skipped="0"');
    expect(errored).toContain('<error message="omp exited">omp exited</error>');

    const failOnly = renderJUnit([run({ verdict: "FAIL", summary: "bad" })], "http://x");
    expect(failOnly).toContain('<testcase classname="Smoke" name="verdict" time="0.000"><failure message="verdict FAIL">bad</failure>');
  });

  test("control characters that XML forbids are dropped", () => {
    const x = renderJUnit([run({ title: "a\u0000b\u001Fc" })], "http://x");
    expect(x).toContain('name="abc"');
  });
});

describe("terminal output of agent-written text", () => {
  const hostile = run({
    verdict: "FAIL",
    title: "T\u001b[2Jitle",
    summary: "ok\n::error::forged\r\u001b]0;pwned\u0007",
    error: "boom\n::warning::x",
    checks: [{ id: "C1", title: "t", status: "fail", note: "line1\n::error::forged\u009b31m" }],
  });

  test("oneLine drops control characters and folds newlines", () => {
    expect(oneLine("a\u001b[31mb\r\nc\u0007  d")).toBe("a [31mb c d");
  });

  test("formatRun and progressLine print no control characters and no line that starts with ::", () => {
    const out = `${formatRun(hostile, "http://127.0.0.1:4310")}\n${progressLine(hostile)}`;
    // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional
    expect(out).not.toMatch(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/);
    for (const line of out.split("\n")) expect(line.trimStart().startsWith("::")).toBe(false);
  });
});

describe("report location", () => {
  const finished = run({ id: "r9", reportFile: "/data/runs/r9/report.md" });

  test("formatRun and --json print the absolute report path; nothing when the run has none", () => {
    expect(formatRun(finished, "http://x")).toContain("  report: /data/runs/r9/report.md");
    expect(formatRun(run(), "http://x")).not.toContain("report:");
    expect(summarizeRun(finished, "http://x").reportPath).toBe("/data/runs/r9/report.md");
    expect(summarizeRun(run(), "http://x").reportPath).toBeNull();
  });
});

describe("executeReport", () => {
  let server: Server<undefined>;
  const exported: unknown[] = [];
  const io = () => {
    const out: string[] = [];
    return { out, io: { out: (t: string) => out.push(t), err: (t: string) => out.push(`ERR ${t}`) } };
  };
  const client = () => ({ api: new ApiClient(`http://127.0.0.1:${server.port}`) });

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/runs/r1") return Response.json(run({ id: "r1", reportFile: "/data/runs/r1/report.md" }));
        if (url.pathname === "/api/runs/r1/report") return Response.json({ markdown: "# Report\n\nAll good.\n" });
        if (url.pathname === "/api/runs/r1/export" && req.method === "POST") {
          exported.push(await req.json());
          return Response.json({ report: "/out/QA-REPORT-r1.md", screenshots: ["/out/screenshots/01.png", "/out/screenshots/02.png"] });
        }
        if (url.pathname === "/api/runs/none") return Response.json(run({ id: "none" }));
        if (url.pathname === "/api/runs/none/report") return Response.json({ error: "run none has no report" }, { status: 404 });
        return Response.json({ error: "unknown run" }, { status: 404 });
      },
    });
  });
  afterAll(() => server.stop(true));

  test("prints the markdown, or the JSON triple with --json", async () => {
    const text = io();
    expect(await executeReport({ id: "r1", exportDir: null, json: false }, { ...client(), io: text.io })).toBe(EXIT.OK);
    expect(text.out).toEqual(["# Report\n\nAll good.\n"]);
    const json = io();
    expect(await executeReport({ id: "r1", exportDir: null, json: true }, { ...client(), io: json.io })).toBe(EXIT.OK);
    expect(JSON.parse(json.out[0]!)).toEqual({ runId: "r1", reportPath: "/data/runs/r1/report.md", markdown: "# Report\n\nAll good.\n" });
  });

  test("--export posts the absolute directory and lists what was written", async () => {
    const text = io();
    expect(await executeReport({ id: "r1", exportDir: "/out", json: false }, { ...client(), io: text.io })).toBe(EXIT.OK);
    expect(exported).toEqual([{ dir: "/out" }]);
    expect(text.out.join("\n")).toContain("/out/QA-REPORT-r1.md");
    expect(text.out.join("\n")).toContain("2 screenshots");
    const json = io();
    await executeReport({ id: "r1", exportDir: "/out", json: true }, { ...client(), io: json.io });
    expect(JSON.parse(json.out[0]!)).toEqual({ report: "/out/QA-REPORT-r1.md", screenshots: ["/out/screenshots/01.png", "/out/screenshots/02.png"] });
  });

  test("a run without a report fails with the server's message", async () => {
    await expect(executeReport({ id: "none", exportDir: null, json: false }, { ...client(), io: io().io })).rejects.toThrow("has no report");
  });
});

describe("executeService", () => {
  test("prints the service lines and exits 0 when ok, 2 when not", async () => {
    const out: string[] = [];
    const io = { out: (t: string) => out.push(t), err: (t: string) => out.push(`ERR ${t}`) };
    expect(await executeService("status", async (a) => ({ ok: true, lines: [`${a}: running`, "pid 1"] }), io)).toBe(EXIT.OK);
    expect(out).toEqual(["status: running", "pid 1"]);
    out.length = 0;
    expect(await executeService("start", async () => ({ ok: false, lines: ["not supported"] }), io)).toBe(EXIT.ERROR);
    expect(out).toEqual(["ERR not supported"]);
  });
});

describe("executeRun against a fake server", () => {
  let server: Server<undefined>;
  let tmp: string;
  const polls = new Map<string, number>();
  const posted: { path: string; body: unknown }[] = [];

  const checks = (status: "running" | "pass" | "fail") => [
    { id: "C1", title: "Launch", status: "pass" as const },
    { id: "C2", title: "Settings", status: status === "fail" ? ("fail" as const) : status === "pass" ? ("pass" as const) : ("running" as const), note: status === "fail" ? "toggle did nothing" : undefined },
  ];

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tapocalypse-cli-"));
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);
        if (req.method === "POST") posted.push({ path: url.pathname, body: await req.json() });
        if (url.pathname === "/api/projects") return Response.json([{ id: "my-app", defaultPlatform: "android" }]);
        if (url.pathname === "/api/runs" && req.method === "POST") {
          return Response.json(run({ id: "run-a", title: "Settings", status: "queued", verdict: null }), { status: 201 });
        }
        const m = /^\/api\/runs\/([^/]+)$/.exec(url.pathname);
        if (m) {
          const id = m[1]!;
          const n = (polls.get(id) ?? 0) + 1;
          polls.set(id, n);
          if (id === "run-a") {
            // Infra failure on the first attempt, retried as run-b.
            return Response.json(run({ id, title: "Settings", status: "error", verdict: null, errorKind: "infra", error: "boot failed", retriedBy: "run-b" }));
          }
          if (id === "run-b") {
            return n < 2
              ? Response.json(run({ id, title: "Settings", status: "running", verdict: null, endedAt: null, checks: checks("running") }))
              : Response.json(run({ id, title: "Settings", status: "done", verdict: "FAIL", summary: "Toggle broken.", checks: checks("fail") }));
          }
        }
        return Response.json({ error: "not found" }, { status: 404 });
      },
    });
  });
  afterAll(() => {
    server.stop(true);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  // Tests mutate the poll counters (e.g. pinning run-b as running); reset so order doesn't matter.
  beforeEach(() => {
    polls.clear();
    posted.length = 0;
  });

  function deps(base: string, out: string[], err: string[]): RunDeps {
    return {
      api: new ApiClient(base),
      io: { out: (t) => out.push(t), err: (t) => err.push(t) },
      env: {},
      pollMs: 1,
      sleep: () => Promise.resolve(),
      now: () => Date.now(),
      writeFile: async (file, text) => {
        await Bun.write(file, text);
      },
    };
  }

  test("--wait follows the infra retry, writes JUnit and exits 1 on a failing verdict", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const junit = path.join(tmp, "out", "junit.xml");
    const options = runOptions(["--brief", "toggle dark mode", "--wait", "--json", "--junit", junit, "--url", `http://127.0.0.1:${server.port}`]);
    const code = await executeRun(options, deps(options.url, out, err));

    expect(code).toBe(EXIT.VERDICT);
    expect(posted.find((p) => p.path === "/api/runs")?.body).toMatchObject({
      projectId: "my-app",
      brief: "toggle dark mode",
      device: { platform: "android" },
    });
    const result = JSON.parse(out.join("\n")) as { exitCode: number; timedOut: boolean; runs: { runId: string; verdict: string }[] };
    expect(result).toMatchObject({ exitCode: 1, timedOut: false });
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]).toMatchObject({ runId: "run-b", verdict: "FAIL" });
    expect(err.some((l) => l.includes("2/2 checks") && l.includes("FAIL"))).toBe(true);

    const xml = fs.readFileSync(junit, "utf8");
    expect(xml).toContain('<failure message="toggle did nothing">');
    expect(xml).toContain('<property name="run.id" value="run-b"/>');
  });

  test("a wait that exceeds --timeout exits 2 without cancelling", async () => {
    const out: string[] = [];
    const err: string[] = [];
    polls.set("run-b", -1_000_000); // keep run-b "running"
    const options = runOptions(["--brief", "x", "--wait", "--timeout", "30ms", "--url", `http://127.0.0.1:${server.port}`]);
    let now = 0;
    const d = deps(options.url, out, err);
    d.now = () => (now += 20);
    const code = await executeRun(options, d);
    expect(code).toBe(EXIT.ERROR);
    expect(err.some((l) => l.startsWith("timed out waiting"))).toBe(true);
    expect(posted.some((p) => p.path.endsWith("/cancel"))).toBe(false);
  });

  test("unknown project is a usage error listing the known ids", async () => {
    const options = { ...runOptions(["--brief", "x"]), projectId: "nope", url: `http://127.0.0.1:${server.port}` };
    const promise = executeRun(options, deps(options.url, [], []));
    await expect(promise).rejects.toThrow('unknown project "nope" (known: my-app)');
  });

  test("an unreachable server raises ServerUnreachableError", async () => {
    const options = runOptions(["--brief", "x", "--url", "http://127.0.0.1:1"]);
    await expect(executeRun(options, deps(options.url, [], []))).rejects.toBeInstanceOf(ServerUnreachableError);
  });
});
