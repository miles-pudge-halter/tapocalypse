import { afterEach, describe, expect, jest, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type {
  Harness,
  HarnessCapabilities,
  HarnessEvent,
  HarnessExit,
  HarnessId,
  HarnessSession,
  SessionInfo,
  SpawnOptions,
} from "../src/harness/types";
import { HttpError } from "../src/config";
import type { Device } from "../src/devices/devices";
import { createRunner, type Runner, type RunnerScheduler } from "../src/runs/runner";
import { createRun, deleteRun, getRun, readEvents, runDir, saveRun } from "../src/runs/store";
import type { Activity, Run, RunUsage } from "../src/runs/types";

const CAPS: HarnessCapabilities = {
  steer: false,
  interrupt: true,
  appendSystemPrompt: true,
  nativeProgressTools: false,
  costReported: true,
  limits: { maxTime: false, maxTurns: true, maxBudgetUsd: true },
  transcriptExport: false,
  backends: ["mobile-mcp"],
};

const MCP_OK: SessionInfo["mcp"] = [
  { name: "mobile_mcp", ok: true },
  { name: "tpc", ok: true },
];

interface Controls {
  opts: SpawnOptions;
  /** Order in which the runner touched the session: `ready`, `send`, `steer`, `abort`, `kill`, `usage`. */
  calls: string[];
  prompts: string[];
  steers: string[];
  emit(e: HarnessEvent): void;
  exit(over?: Partial<HarnessExit>): void;
}

interface FakeOptions {
  caps?: Partial<HarnessCapabilities>;
  mcp?: SessionInfo["mcp"];
  usage?: RunUsage | null;
  transcript?: boolean;
  /** Runs once the prompt has been sent; the "agent". Omit to leave the session running until the test ends it. */
  script?: (c: Controls) => void | Promise<void>;
  /** Raw stats payload (`HarnessSession.rawStats`); omit for a harness without one. */
  stats?: unknown;
  /** Model `ready()` reports; undefined = "fake-model", null = the harness does not say. */
  readyModel?: string | null;
  /** Runs inside `ready()` before it answers. */
  beforeReady?: (c: Controls) => Promise<void>;
  /** Makes `ready()` reject. */
  readyError?: string;
  /** Runs right after `spawn` created the session (e.g. to end it immediately). */
  onSpawn?: (c: Controls) => void;
}

function fakeHarness(id: HarnessId, o: FakeOptions, onSent: (c: Controls) => void) {
  const spawned: Controls[] = [];
  const capabilities = { ...CAPS, ...o.caps };
  const harness: Harness = {
    id,
    label: "Fake CLI",
    capabilities,
    spawn(opts): HarnessSession {
      const { promise: exited, resolve } = Promise.withResolvers<HarnessExit>();
      const controls: Controls = {
        opts,
        calls: [],
        prompts: [],
        steers: [],
        emit: (e) => opts.onEvent(e),
        exit: (over = {}) => resolve({ code: 0, signal: null, settled: true, started: true, limit: null, error: null, ...over }),
      };
      spawned.push(controls);
      const session: HarnessSession = {
        ready: async () => {
          controls.calls.push("ready");
          await o.beforeReady?.(controls);
          if (o.readyError) throw new Error(o.readyError);
          return { sessionId: "s1", model: o.readyModel === undefined ? "fake-model" : o.readyModel, mcp: o.mcp ?? MCP_OK };
        },
        toolName: (server, tool) => `fake:${server}:${tool}`,
        send: async (prompt) => {
          controls.calls.push("send");
          controls.prompts.push(prompt);
          onSent(controls);
          if (o.script) void Promise.resolve(o.script(controls));
        },
        abort: async () => {
          controls.calls.push("abort");
          controls.exit({ code: 143, settled: false });
          await exited;
        },
        kill: () => {
          controls.calls.push("kill");
          controls.exit({ code: 143, settled: false });
        },
        usage: async () => {
          controls.calls.push("usage");
          return o.usage ?? null;
        },
        exited,
      };
      if (capabilities.steer) {
        session.steer = async (message) => {
          controls.calls.push("steer");
          controls.steers.push(message);
        };
      }
      if (o.transcript) {
        session.exportTranscript = async (file) => {
          fs.writeFileSync(file, "<html></html>");
          return true;
        };
      }
      if (o.stats !== undefined) session.rawStats = async () => o.stats;
      o.onSpawn?.(controls);
      return session;
    },
    toActivity: () => null,
    doctor: async () => [],
    listModels: async () => [],
  };
  return { harness, spawned };
}

interface Env {
  runner: Runner;
  run: Run;
  activities: Activity[];
  updates: string[];
  retried: string[];
  /** Resolves once the runner released the run (terminal state persisted). */
  done: Promise<void>;
  spawned: Controls[];
  /** Resolves with the session controls once the QA prompt was sent. */
  sent: Promise<Controls>;
}

const created: string[] = [];
afterEach(() => {
  for (const id of created.splice(0)) deleteRun(id);
});

const device: Device = {
  serial: "emulator-5554",
  platform: "android",
  kind: "emulator",
  model: "sdk",
  name: "sdk",
  osVersion: "Android 14",
  screen: "1080×2400",
  deviceType: "phone",
  state: "ready",
  idleShutdownAt: null,
};

function setup(harnessId: HarnessId, o: FakeOptions = {}, runOver: Partial<Run> = {}): Env {
  const { promise: sent, resolve: markSent } = Promise.withResolvers<Controls>();
  const { harness, spawned } = fakeHarness(harnessId, o, markSent);
  const run = createRun({
    projectId: "test-proj",
    title: "runner test",
    brief: "Open the app and check the home screen.",
    requestedBy: "test",
    deviceRequest: { platform: "android" },
    deviceSerial: null,
    deviceName: null,
    bootedByRun: false,
    backend: "mobile-mcp",
    packageId: "com.example.app",
    status: "queued",
    verdict: null,
    summary: null,
    reportPath: null,
    checks: [],
    error: null,
    startedAt: null,
    endedAt: null,
    stats: null,
    transcriptHtml: false,
    source: null,
    build: null,
    harness: harnessId,
    ...runOver,
  });
  created.push(run.id);
  const activities: Activity[] = [];
  const updates: string[] = [];
  const retried: string[] = [];
  const { promise: done, resolve } = Promise.withResolvers<void>();
  const scheduler: RunnerScheduler = {
    activity: (_id, a) => void activities.push(a),
    update: (r) => {
      updates.push(r.status);
      saveRun(r);
    },
    release: () => resolve(),
    retry: (r) => {
      retried.push(r.id);
      return { ...r, id: `${r.id}-retry`, attempt: r.attempt + 1 };
    },
    bootComplete: () => {},
    getLive: () => undefined,
    waitForPrLookup: async () => {},
  };
  const runner = createRunner(scheduler, { getHarness: () => harness, listDevices: async () => [device] });
  return { runner, run, activities, updates, retried, done, spawned, sent };
}

/** Lets every already-scheduled continuation of the runner run (the run is released before `execute` has returned). */
async function flush(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  await promise;
}

const start = (env: Env) => env.runner.startRun(env.run, { serial: "emulator-5554" });

const progressSink = (env: Env, c: Controls) => {
  const lookup = env.runner.progressLookup(env.run.id);
  if (!lookup) throw new Error("no progress lookup");
  const tpc = c.opts.mcpServers.find((s) => s.name === "tpc");
  return { lookup, tpc };
};

describe("runner with a fake harness", () => {
  test("sends the prompt after ready, records progress through the run endpoint, captures usage and finishes", async () => {
    const env = setup("claude", {
      script: async (c) => {
        const { lookup } = progressSink(env, c);
        c.opts.onRaw({ type: "fake_frame", n: 1 });
        c.emit({ type: "tool_call", callId: "t1", tool: "mcp__mobile_mcp_mobile_click", server: "mobile_mcp", args: {} });
        c.emit({ type: "usage", usage: { tokensIn: 7, tokensOut: 3, cost: 0.5 }, cumulative: false });
        c.emit({ type: "usage", usage: { tokensIn: 2, tokensOut: 1 }, cumulative: false });
        await lookup.sink.record("qa_plan", { checks: [{ id: "C1", title: "Home loads" }] });
        await lookup.sink.record("qa_check", { id: "C1", status: "pass", note: "ok" });
        await lookup.sink.record("qa_finish", { verdict: "PASS", summary: "all good", reportPath: "qa/QA-REPORT-x.md" });
        c.emit({ type: "turn_end", ok: true, error: null, limit: null });
        c.exit();
      },
    });
    start(env);
    await env.done;
    const [c] = env.spawned;

    expect(c!.calls.slice(0, 2)).toEqual(["ready", "send"]);
    expect(c!.prompts[0]).toContain("fake:mobile_mcp:mobile_list_elements_on_screen");
    expect(c!.prompts[0]).toContain("fake:tpc:qa_plan");
    expect(c!.prompts[0]).not.toContain("You are a QA agent."); // persona is appended as system prompt, not duplicated

    expect(env.run).toMatchObject({ status: "done", verdict: "PASS", verdictSource: "agent", errorKind: null, model: "fake-model" });
    expect(env.run.checks).toMatchObject([{ id: "C1", status: "pass", note: "ok" }]);
    expect(env.run.usage).toEqual({ cost: 0.5, tokensIn: 9, tokensOut: 4, cacheRead: 0, cacheWrite: 0, toolCalls: 1, model: "fake-model" });

    const checkLines = env.activities.filter((a) => a.kind === "check");
    expect(checkLines.map((a) => a.text)).toEqual(["Test plan: 1 check", "C1: pass — ok", "Finished: PASS"]);
    expect(checkLines[1]).toMatchObject({ checkId: "C1", checkStatus: "pass" });
    const events = readEvents(env.run.id);
    expect(events).toContainEqual(expect.objectContaining({ type: "fake_frame", n: 1 }));
    expect(events).toContainEqual(expect.objectContaining({ type: "_activity", kind: "check", checkId: "C1", checkStatus: "pass" }));
  });

  test("the session's own usage report wins over what the events accumulated", async () => {
    const reported: RunUsage = { cost: 1.25, tokensIn: 100, tokensOut: 50, cacheRead: 1, cacheWrite: 2, toolCalls: 9, model: "fake-model" };
    const env = setup("claude", {
      usage: reported,
      script: (c) => {
        c.emit({ type: "usage", usage: { tokensIn: 1 }, cumulative: false });
        c.emit({ type: "turn_end", ok: true, error: null, limit: null });
        c.exit();
      },
    });
    start(env);
    await env.done;
    expect(env.run.usage).toEqual(reported);
  });

  test("a harness-enforced limit ends the run as a timeout naming the limit, with the derived verdict", async () => {
    const env = setup("claude", {
      script: async (c) => {
        const { lookup } = progressSink(env, c);
        await lookup.sink.record("qa_plan", { checks: [{ id: "C1", title: "a" }, { id: "C2", title: "b" }] });
        await lookup.sink.record("qa_check", { id: "C1", status: "pass" });
        c.emit({ type: "turn_end", ok: false, error: "max turns", limit: "turns" });
        c.exit({ limit: "turns", error: "max turns" });
      },
    });
    start(env);
    await env.done;
    expect(env.run).toMatchObject({ status: "done", errorKind: "timeout", verdict: "PARTIAL", verdictSource: "derived" });
    expect(env.run.error).toContain("turn limit");
    expect(env.run.error).toContain("Fake CLI");
  });

  test("steering a harness without steer support is a 409 naming the harness; the session is untouched", async () => {
    const env = setup("claude");
    start(env);
    const c = await env.sent;
    const err = await env.runner.steerRun(env.run.id, "look at settings").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(409);
    expect((err as HttpError).message).toBe("steering is not supported by Fake CLI");
    expect(c.calls).not.toContain("steer");
    c.exit();
    c.emit({ type: "turn_end", ok: true, error: null, limit: null });
    await env.done;
  });

  test("steering a harness with steer support forwards the message and logs it", async () => {
    const env = setup("claude", { caps: { steer: true } });
    start(env);
    const c = await env.sent;
    await env.runner.steerRun(env.run.id, "look at settings");
    expect(c.steers).toEqual(["look at settings"]);
    expect(env.activities).toContainEqual(expect.objectContaining({ kind: "user", text: "look at settings" }));
    c.exit();
    await env.done;
  });

  test("cancel aborts the session and ends the run cancelled", async () => {
    const env = setup("claude");
    start(env);
    const c = await env.sent;
    await env.runner.cancelActive(env.run.id);
    await env.done;
    expect(c.calls).toContain("abort");
    expect(env.run).toMatchObject({ status: "cancelled", errorKind: "cancelled" });
    expect(env.retried).toEqual([]);
  });

  test("a required MCP server that did not mount fails the run early as infra, without prompting", async () => {
    const env = setup("claude", {
      mcp: [
        { name: "mobile_mcp", ok: false, error: "spawn npx ENOENT" },
        { name: "tpc", ok: true },
      ],
    });
    start(env);
    await env.done;
    const [c] = env.spawned;
    expect(c!.prompts).toEqual([]);
    expect(env.run).toMatchObject({ status: "error", errorKind: "infra" });
    expect(env.run.error).toContain("mobile_mcp");
    expect(env.run.error).toContain("spawn npx ENOENT");
    expect(c!.calls).toEqual(expect.arrayContaining(["kill"]));
  });

  test("a missing progress server fails a non-native harness early; a native-progress harness needs none", async () => {
    const missing = setup("claude", { mcp: [{ name: "mobile_mcp", ok: true }, { name: "tpc", ok: false, error: "401" }] });
    start(missing);
    await missing.done;
    expect(missing.run.error).toContain("tpc");
    expect(missing.spawned[0]!.prompts).toEqual([]);

    const native = setup("omp", {
      caps: { nativeProgressTools: true },
      mcp: [{ name: "mobile_mcp", ok: true }],
      script: (c) => {
        c.emit({ type: "turn_end", ok: true, error: null, limit: null });
        c.exit();
      },
    });
    start(native);
    await native.done;
    expect(native.spawned[0]!.prompts).toHaveLength(1);
    expect(native.spawned[0]!.opts.onProgress).toBeDefined();
    expect(native.spawned[0]!.opts.mcpServers.map((s) => s.name)).toEqual(["mobile_mcp"]);
  });

  test("the run-scoped progress server carries a per-run bearer token and is dropped once the run ends", async () => {
    const env = setup("claude");
    start(env);
    const c = await env.sent;
    const { lookup, tpc } = progressSink(env, c);
    expect(tpc).toMatchObject({ transport: "http" });
    if (tpc?.transport !== "http") throw new Error("tpc must be http");
    expect(tpc.url).toMatch(new RegExp(`/mcp/runs/${env.run.id}$`));
    expect(tpc.headers.Authorization).toBe(`Bearer ${lookup.token}`);
    expect(lookup.token).toMatch(/^[0-9a-f]{64}$/);
    expect(env.runner.progressLookup("no-such-run")).toBeNull();
    c.exit();
    await env.done;
    expect(env.runner.progressLookup(env.run.id)).toBeNull();
  });

  test("persona text is prepended to the prompt when the harness cannot append a system prompt", async () => {
    const env = setup("claude", {
      caps: { appendSystemPrompt: false },
      script: (c) => {
        c.emit({ type: "turn_end", ok: true, error: null, limit: null });
        c.exit();
      },
    });
    start(env);
    await env.done;
    expect(env.spawned[0]!.prompts[0]).toContain("You are a QA agent.");
  });

  test("a persona model applies only to the harness the persona names (none = omp)", async () => {
    const finish = (c: Controls) => {
      c.emit({ type: "turn_end", ok: true, error: null, limit: null });
      c.exit();
    };
    const omp = setup("omp", { caps: { nativeProgressTools: true }, mcp: [{ name: "mobile_mcp", ok: true }], script: finish });
    start(omp);
    await omp.done;
    expect(omp.spawned[0]!.opts.model).toBe("anthropic/claude-haiku-4-5");

    const claude = setup("claude", { script: finish });
    start(claude);
    await claude.done;
    expect(claude.spawned[0]!.opts.model).toBeNull();

    const explicit = setup("claude", { script: finish }, { model: "opus", effort: "high" });
    start(explicit);
    await explicit.done;
    expect(explicit.spawned[0]!.opts).toMatchObject({ model: "opus", effort: "high" });
  });

  test("writes persona.md and brief.md into the run dir and hands the harness its paths", async () => {
    const env = setup("claude", {
      script: (c) => {
        c.emit({ type: "turn_end", ok: true, error: null, limit: null });
        c.exit();
      },
    });
    start(env);
    await env.done;
    const { opts } = env.spawned[0]!;
    expect(opts.personaFile).toBe(path.join(runDir(env.run.id), "persona.md"));
    expect(fs.readFileSync(opts.personaFile, "utf8")).toContain("You are a QA agent.");
    expect(opts.persona).toContain("You are a QA agent.");
    expect(fs.readFileSync(path.join(runDir(env.run.id), "brief.md"), "utf8")).toBe(env.run.brief);
  });

  test("exports the transcript when the harness can", async () => {
    const env = setup("omp", {
      caps: { nativeProgressTools: true, transcriptExport: true },
      mcp: [{ name: "mobile_mcp", ok: true }],
      transcript: true,
      script: (c) => {
        c.emit({ type: "turn_end", ok: true, error: null, limit: null });
        c.exit();
      },
    });
    start(env);
    await env.done;
    expect(env.run.transcriptHtml).toBe(true);
    expect(fs.existsSync(path.join(runDir(env.run.id), "transcript.html"))).toBe(true);
    expect(getRun(env.run.id)?.transcriptHtml).toBe(true);
  });

  test("a session that never ran is an infra failure carrying the launch error, is retried and is never prompted", async () => {
    const env = setup("claude", {
      onSpawn: (c) => c.exit({ code: 127, settled: false, started: false, error: "codex could not start: ENOENT" }),
    });
    start(env);
    await env.done;
    expect(env.run).toMatchObject({ status: "error", errorKind: "infra", error: "codex could not start: ENOENT" });
    expect(env.retried).toEqual([env.run.id]);
    await flush();
    expect(env.spawned[0]!.calls).not.toContain("send");
  });

  test("the raw stats payload of a harness that has one is kept in run.stats", async () => {
    const stats = { tokens: { input: 5, output: 6 }, cost: 0.25 };
    const env = setup("omp", {
      caps: { nativeProgressTools: true },
      mcp: [{ name: "mobile_mcp", ok: true }],
      stats,
      usage: { cost: 0.25, tokensIn: 5, tokensOut: 6, cacheRead: 0, cacheWrite: 0, toolCalls: 0, model: "m" },
      script: (c) => {
        c.emit({ type: "turn_end", ok: true, error: null, limit: null });
        c.exit();
      },
    });
    start(env);
    await env.done;
    expect(env.run.stats).toEqual(stats);
    expect(getRun(env.run.id)?.stats).toEqual(stats);
  });

  test("a cancel that lands while the session is still becoming ready never sends the prompt", async () => {
    const env: Env = setup("claude", { beforeReady: () => env.runner.cancelActive(env.run.id) });
    start(env);
    await env.done;
    await flush();
    expect(env.spawned[0]!.calls).not.toContain("send");
    expect(env.run).toMatchObject({ status: "cancelled", errorKind: "cancelled" });
  });

  test("steering after the agent ended its turn is a 409, not a 500 from the dead session", async () => {
    const env = setup("claude", { caps: { steer: true } });
    start(env);
    const c = await env.sent;
    c.emit({ type: "turn_end", ok: true, error: null, limit: null });
    const err = await env.runner.steerRun(env.run.id, "one more thing").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(409);
    expect(c.steers).toEqual([]);
    c.exit();
    await env.done;
  });

  test("the model the harness reports fills an unset run model; an explicit one is kept", async () => {
    const finish = (c: Controls) => {
      c.emit({ type: "session", sessionId: "s", model: "claude-reported-1" });
      c.emit({ type: "turn_end", ok: true, error: null, limit: null });
      c.exit();
    };
    const unset = setup("claude", { readyModel: null, script: finish });
    start(unset);
    await unset.done;
    expect(unset.run.model).toBe("claude-reported-1");
    expect(getRun(unset.run.id)?.model).toBe("claude-reported-1");

    const explicit = setup("claude", { readyModel: null, script: finish }, { model: "opus" });
    start(explicit);
    await explicit.done;
    expect(explicit.run.model).toBe("opus");
  });

  // The hard kill is a real timer in the runner; fake timers keep the test instant.
  test("a harness that cannot enforce the time budget is killed exactly at it; one that can gets five more minutes", async () => {
    jest.useFakeTimers();
    try {
      const plain = setup("claude", { caps: { limits: { maxTime: false, maxTurns: true, maxBudgetUsd: true } } });
      start(plain);
      const c = await plain.sent;
      jest.advanceTimersByTime(600_000 - 1);
      expect(c.calls).not.toContain("kill");
      jest.advanceTimersByTime(1);
      expect(c.calls).toContain("kill");
      await plain.done;

      const self = setup("omp", {
        caps: { nativeProgressTools: true, limits: { maxTime: true, maxTurns: false, maxBudgetUsd: false } },
        mcp: [{ name: "mobile_mcp", ok: true }],
      });
      start(self);
      const o = await self.sent;
      jest.advanceTimersByTime(600_000 + 5 * 60_000 - 1);
      expect(o.calls).not.toContain("kill");
      jest.advanceTimersByTime(1);
      expect(o.calls).toContain("kill");
      await self.done;
    } finally {
      jest.useRealTimers();
    }
  });
});
