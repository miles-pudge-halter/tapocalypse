import { describe, expect, test } from "bun:test";
import { normalizeUsage, UsageAccumulator } from "../src/harness/omp/usage";
import type { HarnessExit } from "../src/harness/types";
import type { Project } from "../src/projects/registry";
import { classifyExit, deriveVerdict, type ExitInput, parseDurationMs, UsageTotals } from "../src/runs/outcome";
import { buildPrompt } from "../src/runs/prompt";
import type { Check, CheckStatus, Run, Verdict } from "../src/runs/types";

const check = (status: CheckStatus, id = "C"): Check => ({ id, title: id, status, updatedAt: "2026-01-01T00:00:00.000Z" });
const checks = (...statuses: CheckStatus[]): Check[] => statuses.map((s, i) => check(s, `C${i + 1}`));

describe("deriveVerdict", () => {
  test.each([
    [["pass", "pass"], "PASS"],
    [["pass", "skipped"], "PASS"],
    [["pass", "fail", "blocked"], "FAIL"],
    [["pass", "blocked"], "PARTIAL"],
    [["pass", "pending"], "PARTIAL"],
    [["pass", "running"], "PARTIAL"],
    [["fail", "pending"], "FAIL"],
    [["skipped", "skipped"], "PARTIAL"],
    [["skipped"], "PARTIAL"],
  ] as [CheckStatus[], Verdict][])("%j → %s", (statuses, verdict) => {
    expect(deriveVerdict(checks(...statuses))?.verdict).toBe(verdict);
  });

  test("null when nothing resolved", () => {
    expect(deriveVerdict([])).toBeNull();
    expect(deriveVerdict(checks("pending", "running"))).toBeNull();
  });

  test("summary counts each bucket", () => {
    const d = deriveVerdict(checks("pass", "pass", "pass", "pass", "pass", "fail", "pending", "running"));
    expect(d?.summary).toBe("No report from the agent; verdict derived from checks: 5 pass · 1 fail · 2 unresolved.");
  });
});

const harnessExit = (over: Partial<HarnessExit> = {}): HarnessExit => ({ code: 0, signal: null, settled: true, started: true, limit: null, error: null, ...over });

const exit = (over: Partial<Omit<ExitInput, "exit">> & { exit?: Partial<HarnessExit> } = {}): ExitInput => ({
  cancelled: false,
  verdictRecorded: false,
  checks: [],
  harnessLabel: "omp",
  elapsedMs: 60_000,
  budgetMs: 3_600_000,
  budgetLabel: "60m",
  ...over,
  exit: harnessExit(over.exit),
});

describe("classifyExit", () => {
  test("cancel wins over everything", () => {
    expect(classifyExit(exit({ cancelled: true, verdictRecorded: true, exit: { code: 1 }, checks: checks("pass") }))).toMatchObject({
      status: "cancelled",
      errorKind: "cancelled",
      derived: null,
    });
  });

  test("a recorded verdict is done with no error", () => {
    expect(classifyExit(exit({ verdictRecorded: true, exit: { code: 1, settled: false } }))).toEqual({
      status: "done",
      errorKind: null,
      error: null,
      derived: null,
    });
  });

  test("agent ended without finish and nothing resolved: error / agent", () => {
    expect(classifyExit(exit())).toMatchObject({ status: "error", errorKind: "agent", error: "agent ended without qa_finish" });
  });

  test("a session that never ran is infra (retriable) and keeps the launch error, even for a non-crash exit code", () => {
    expect(classifyExit(exit({ exit: { code: 127, settled: false, started: false, error: "codex could not start: ENOENT" } }))).toMatchObject({
      status: "error",
      errorKind: "infra",
      error: "codex could not start: ENOENT",
    });
    expect(classifyExit(exit({ exit: { code: 1, settled: false, started: false } }))).toMatchObject({
      errorKind: "infra",
      error: "omp could not be started; see stderr.log",
    });
  });

  test("crash (exit 1, not settled) before any check resolved is infra", () => {
    expect(classifyExit(exit({ exit: { code: 1, settled: false }, checks: checks("pending") }))).toMatchObject({
      status: "error",
      errorKind: "infra",
      error: "omp exited with code 1; see stderr.log",
    });
  });

  test("crash after a check resolved derives a verdict instead, kind agent", () => {
    const out = classifyExit(exit({ exit: { code: 1, settled: false }, checks: checks("pass", "fail") }));
    expect(out).toMatchObject({ status: "done", errorKind: "agent", error: "omp exited with code 1; see stderr.log" });
    expect(out.derived?.verdict).toBe("FAIL");
  });

  test("exit 143 is SIGTERM, not an infra crash", () => {
    expect(classifyExit(exit({ exit: { code: 143, settled: false } }))).toMatchObject({
      status: "error",
      errorKind: "agent",
      error: "omp was stopped (SIGTERM): the run was cancelled or Tapocalypse shut down",
    });
  });

  test("elapsed past the budget is a timeout; resolved checks still derive a verdict", () => {
    const out = classifyExit(exit({ elapsedMs: 3_600_001, checks: checks("pass", "pass", "pending") }));
    expect(out).toMatchObject({ status: "done", errorKind: "timeout" });
    expect(out.error).toContain("60m");
    expect(out.derived?.verdict).toBe("PARTIAL");
  });

  test("a timeout with no resolved checks is an error / timeout", () => {
    expect(classifyExit(exit({ elapsedMs: 4_000_000, exit: { code: 143, settled: false } }))).toMatchObject({ status: "error", errorKind: "timeout" });
  });

  test("a failed prompt carries its message as the agent's cause", () => {
    expect(classifyExit(exit({ exit: { error: "overloaded" } }))).toMatchObject({
      status: "error",
      errorKind: "agent",
      error: "overloaded",
    });
  });

  test("a harness limit is a timeout naming the limit and the harness; resolved checks still derive a verdict", () => {
    const out = classifyExit(exit({ harnessLabel: "Claude Code", exit: { limit: "budget", error: "spent $1.00" }, checks: checks("pass", "fail") }));
    expect(out).toMatchObject({ status: "done", errorKind: "timeout", error: "Claude Code stopped at its budget limit: spent $1.00" });
    expect(out.derived?.verdict).toBe("FAIL");
    expect(classifyExit(exit({ exit: { limit: "turns" } }))).toMatchObject({ status: "error", errorKind: "timeout", error: "omp stopped at its turn limit" });
  });

  test("messages name the harness, never a hard-coded one", () => {
    expect(classifyExit(exit({ harnessLabel: "Codex CLI", exit: { code: 2, settled: false } })).error).toBe("Codex CLI exited with code 2; see stderr.log");
    expect(classifyExit(exit({ harnessLabel: "Codex CLI", exit: { code: 143, settled: false } })).error).toContain("Codex CLI was stopped (SIGTERM)");
  });

  test("an unparseable budget never reports a timeout", () => {
    expect(classifyExit(exit({ budgetMs: null, elapsedMs: 9e9 })).errorKind).toBe("agent");
  });
});

describe("parseDurationMs", () => {
  test.each([
    ["90m", 5_400_000],
    ["1h30m", 5_400_000],
    ["45s", 45_000],
    ["2h", 7_200_000],
    ["10", 600_000],
    ["1.5h", 5_400_000],
  ])("%s → %d", (text, ms) => expect(parseDurationMs(text)).toBe(ms));

  test.each(["", "soon", "10x", "5m later"])("rejects %j", (text) => expect(parseDurationMs(text)).toBeNull());
});

describe("normalizeUsage", () => {
  const stats = { toolCalls: 16, tokens: { input: 30, output: 4416, reasoning: 0, cacheRead: 438015, cacheWrite: 64719, total: 507180 }, cost: 0.69 };

  test("maps omp get_session_stats", () => {
    expect(normalizeUsage(stats, "anthropic/claude-opus-5-5")).toEqual({
      cost: 0.69,
      tokensIn: 30,
      tokensOut: 4416,
      cacheRead: 438015,
      cacheWrite: 64719,
      toolCalls: 16,
      model: "anthropic/claude-opus-5-5",
    });
  });

  test("missing cost stays null (not 0); junk becomes null usage", () => {
    expect(normalizeUsage({ tokens: { input: 1 } }, null)).toMatchObject({ cost: null, tokensIn: 1, tokensOut: 0, toolCalls: 0 });
    expect(normalizeUsage(null, null)).toBeNull();
    expect(normalizeUsage("x", null)).toBeNull();
  });
});

describe("UsageAccumulator", () => {
  const assistant = (input: number, cost: number) => ({
    type: "message_end",
    message: { role: "assistant", model: "claude-opus-5-5", provider: "anthropic", usage: { input, output: 10, cacheRead: 5, cacheWrite: 1, cost: { total: cost } } },
  });

  test("totals assistant turns and tool starts; ignores other roles", () => {
    const acc = new UsageAccumulator();
    expect(acc.snapshot(null)).toBeNull();
    acc.add(assistant(100, 0.25));
    acc.add(assistant(50, 0.5));
    acc.add({ type: "tool_execution_start" });
    acc.add({ type: "message_end", message: { role: "user", usage: { input: 999 } } });
    expect(acc.snapshot(null)).toEqual({
      cost: 0.75,
      tokensIn: 150,
      tokensOut: 20,
      cacheRead: 10,
      cacheWrite: 2,
      toolCalls: 1,
      model: "anthropic/claude-opus-5-5",
    });
    expect(acc.snapshot("pinned/model")?.model).toBe("pinned/model");
  });
});

describe("UsageTotals", () => {
  test("adds incremental events and counts tool calls; cumulative events replace the totals", () => {
    const t = new UsageTotals();
    expect(t.snapshot(null)).toBeNull();
    t.add({ tokensIn: 10, tokensOut: 2, cost: 0.1 }, false);
    t.add({ tokensIn: 5, cacheRead: 3 }, false);
    t.toolCall();
    expect(t.snapshot("m")).toEqual({ cost: 0.1, tokensIn: 15, tokensOut: 2, cacheRead: 3, cacheWrite: 0, toolCalls: 1, model: "m" });
    t.add({ tokensIn: 100, tokensOut: 20 }, true);
    expect(t.snapshot(null)).toMatchObject({ tokensIn: 100, tokensOut: 20, cacheRead: 0, cost: null, toolCalls: 1 });
  });

  test("cost stays null for harnesses that report none", () => {
    const t = new UsageTotals();
    t.add({ tokensIn: 1 }, false);
    expect(t.snapshot(null)?.cost).toBeNull();
  });
});

describe("buildPrompt", () => {
  const project = { id: "p", reportsDir: "qa" } as Project;
  const toolName = (server: string, tool: string) => (server === "tpc" ? tool : `mcp__${server}_${tool}`);
  const run = (over: Partial<Run> = {}): Run =>
    ({
      id: "r1",
      brief: "do it",
      packageId: "com.x",
      backend: "mobile-mcp",
      deviceSerial: "emulator-5554",
      deviceLabel: "Pixel",
      deviceRequest: { platform: "android" },
      source: null,
      build: null,
      suiteId: null,
      suiteChecks: null,
      ...over,
    }) as Run;

  test("states the time budget", () => {
    expect(buildPrompt(run(), project, toolName, { runMaxTime: "90m" })).toContain(
      "Time budget: 90m. If you are running out of time, stop testing, write the report with what you have and call qa_finish.",
    );
  });

  test("suite runs pin check ids and titles; ad-hoc runs do not", () => {
    const suite = buildPrompt(run({ suiteId: "smoke", suiteChecks: [{ id: "C1", title: "Launch" }, { id: "C2", title: 'Say "hi"' }] }), project, toolName, { runMaxTime: "60m" });
    expect(suite).toContain('Use exactly these check ids and titles in qa_plan: C1 "Launch", C2 "Say \\"hi\\""');
    expect(buildPrompt(run(), project, toolName, { runMaxTime: "60m" })).not.toContain("Use exactly these check ids");
  });
});

describe("buildPrompt harness neutrality", () => {
  const project = { id: "p", reportsDir: "qa" } as Project;
  const run = { id: "r1", brief: "do it", packageId: "com.x", backend: "mobile-mcp", deviceSerial: "emulator-5554", deviceLabel: "Pixel", deviceRequest: { platform: "android" }, source: null, build: null, suiteId: null, suiteChecks: null } as Run;

  test("names every tool through the harness's own tool names", () => {
    const prompt = buildPrompt(run, project, (server, tool) => `<${server}.${tool}>`, { runMaxTime: "60m" });
    expect(prompt).toContain("<mobile_mcp.mobile_list_elements_on_screen>");
    expect(prompt).toContain("<tpc.qa_plan>");
    expect(prompt).toContain("<tpc.qa_finish>");
    expect(prompt).not.toContain("ask tool");
    expect(prompt).not.toMatch(/\bomp\b/);
  });

  test("the persona is prepended only when asked to", () => {
    const names = (_s: string, t: string) => t;
    expect(buildPrompt(run, project, names, { runMaxTime: "60m" })).not.toContain("Be thorough.");
    const withPersona = buildPrompt(run, project, names, { runMaxTime: "60m", prependPersona: "Be thorough.\n" });
    expect(withPersona.startsWith("Your system instructions")).toBe(true);
    expect(withPersona).toContain("Be thorough.");
  });

  test("the artemis backend names the artemis tools and forbids run_task", () => {
    const prompt = buildPrompt({ ...run, backend: "artemis" } as Run, project, (s, t) => `${s}:${t}`, { runMaxTime: "60m" });
    expect(prompt).toContain("artemis:mobile_click");
    expect(prompt).toContain("NEVER call artemis:mobile_run_task");
  });
});
