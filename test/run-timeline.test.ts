import { describe, expect, test } from "bun:test";
import type { Activity, Check } from "../web/lib/api";
import { checkDurationMs } from "../web/components/run/evidence";
import { buildTimeline, countProblems, filterTimeline, formatOffset } from "../web/components/run/timeline-model";

let seq = 0;
function act(partial: Partial<Activity> & Pick<Activity, "kind" | "text">): Activity {
  const n = seq++;
  return { ts: new Date(Date.UTC(2026, 9, 8, 12, 0, n)).toISOString(), seq: n, ...partial };
}
const MCP = "mcp__mobile_mcp_mobile_";

function run(): Activity[] {
  seq = 0;
  return [
    act({ kind: "tool", text: "bash", tool: "bash", args: { command: "adb devices" }, callId: "a" }),
    act({ kind: "tool_end", text: "ok", callId: "a", ok: true, durationMs: 120 }),
    act({ kind: "check", text: "Test plan: 2 checks" }),
    act({ kind: "check", text: "C1 running", checkId: "C1", checkStatus: "running" }),
    act({ kind: "tool", text: "tap", tool: `${MCP}click_on_screen_at_coordinates`, args: { ref: "@e1" }, callId: "b" }),
    act({ kind: "say", text: "Tapped the Plan tab" }),
    act({ kind: "tool_end", text: "boom", callId: "b", ok: false, durationMs: 900 }),
    act({ kind: "check", text: "C1 pass", checkId: "C1", checkStatus: "pass" }),
    act({ kind: "warn", text: "backend violation: x" }),
    act({ kind: "check", text: "C2 running", checkId: "C2", checkStatus: "running" }),
    act({ kind: "check", text: "C2 pass", checkId: "C2", checkStatus: "pass" }),
    act({ kind: "check", text: "Finished: PASS" }),
  ];
}

describe("buildTimeline", () => {
  const sections = buildTimeline(run());

  test("groups rows into setup, per-check and between sections", () => {
    expect(sections.map((s) => [s.kind, s.checkId])).toEqual([
      ["setup", null],
      ["check", "C1"],
      ["between", null],
      ["check", "C2"],
      ["between", null],
    ]);
    // The resolving milestone stays in its own check's section; the warning after it does not.
    expect(sections[1]?.rows.map((r) => r.type)).toEqual(["milestone", "tool", "say", "milestone"]);
    expect(sections[2]?.rows.map((r) => r.type)).toEqual(["note"]);
  });

  test("pairs a tool with its end even when other rows arrive in between", () => {
    const tool = sections[1]?.rows.find((r) => r.type === "tool");
    if (tool?.type !== "tool") throw new Error("tool row missing");
    expect(tool.human.label).toBe("Tap @e1");
    expect(tool.end?.ok).toBe(false);
    expect(tool.end?.durationMs).toBe(900);
    // paired ends do not become rows of their own
    expect(sections.flatMap((s) => s.rows).filter((r) => r.type === "tool")).toHaveLength(2);
  });

  test("an end whose start is on an unloaded page still renders", () => {
    seq = 100;
    const result = buildTimeline([act({ kind: "tool_end", text: "late", tool: "bash", callId: "gone", ok: true })]);
    const row = result[0]?.rows[0];
    expect(row?.type === "tool" && row.start === null && row.end?.text === "late").toBe(true);
  });

  test("legacy runs: qa_* tool lines become milestones and open check sections", () => {
    seq = 0;
    const legacy = buildTimeline([
      act({ kind: "tool", text: 'qa_plan {"checks":[{"id":"C1","title":"t"}]}' }),
      act({ kind: "tool", text: 'qa_check {"id":"C1","status":"running"}' }),
      act({ kind: "tool", text: "bash {\"command\":\"ls\"}" }),
    ]);
    expect(legacy.map((s) => s.kind)).toEqual(["setup", "check"]);
    expect(legacy[1]?.rows.map((r) => r.type)).toEqual(["milestone", "tool"]);
  });

  test("new-format runs drop duplicate qa_* tool lines", () => {
    seq = 0;
    const result = buildTimeline([
      act({ kind: "check", text: "C1 running", checkId: "C1", checkStatus: "running" }),
      act({ kind: "tool", text: "qa_check", tool: "qa_check", args: { id: "C1", status: "running" } }),
    ]);
    expect(result.flatMap((s) => s.rows)).toHaveLength(1);
  });
});

describe("filterTimeline / countProblems", () => {
  const sections = buildTimeline(run());

  test("problems keeps failed tools and warnings, and drops emptied sections", () => {
    const filtered = filterTimeline(sections, "problems", "");
    expect(filtered.map((s) => s.rows.length)).toEqual([1, 1]);
    expect(countProblems(sections)).toEqual({ errors: 1, warnings: 1 });
  });

  test("device filter excludes shell, shell filter excludes device", () => {
    expect(filterTimeline(sections, "device", "").flatMap((s) => s.rows)).toHaveLength(1);
    expect(filterTimeline(sections, "shell", "").flatMap((s) => s.rows)).toHaveLength(1);
  });

  test("search matches args and result text, case-insensitively", () => {
    expect(filterTimeline(sections, "all", "ADB DEVICES").flatMap((s) => s.rows)).toHaveLength(1);
    expect(filterTimeline(sections, "all", "boom").flatMap((s) => s.rows)).toHaveLength(1);
    expect(filterTimeline(sections, "all", "nope")).toEqual([]);
  });
});

describe("formatOffset", () => {
  test("mm:ss under an hour, h:mm:ss after, clamps negatives", () => {
    const start = "2026-10-08T12:00:00.000Z";
    expect(formatOffset("2026-10-08T12:12:04.000Z", start)).toBe("+12:04");
    expect(formatOffset("2026-10-08T13:02:09.000Z", start)).toBe("+1:02:09");
    expect(formatOffset("2026-10-08T11:59:00.000Z", start)).toBe("+0:00");
    expect(formatOffset("garbage", start)).toBe("");
  });
});

describe("checkDurationMs", () => {
  const started = "2026-10-08T12:00:00.000Z";
  const check = (partial: Partial<Check>): Check => ({ id: "C1", title: "t", status: "running", updatedAt: started, startedAt: started, ...partial });

  test("a running check counts up to `now`", () => {
    expect(checkDurationMs(check({}), Date.parse("2026-10-08T12:00:30.000Z"))).toBe(30_000);
  });

  test("a check stranded in running on an ended run stops at the run's end, not at the wall clock", () => {
    const runEnd = Date.parse("2026-10-08T12:05:00.000Z");
    expect(checkDurationMs(check({}), runEnd)).toBe(300_000);
  });

  test("a resolved check uses its own end; a never-started check has no duration", () => {
    expect(checkDurationMs(check({ status: "pass", endedAt: "2026-10-08T12:00:10.000Z" }), Date.now())).toBe(10_000);
    expect(checkDurationMs(check({ status: "pending", startedAt: undefined }), Date.now())).toBeNull();
    expect(checkDurationMs(check({ status: "blocked" }), Date.now())).toBeNull();
  });
});
