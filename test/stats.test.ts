import { describe, expect, test } from "bun:test";
import { computeStats } from "../src/stats";
import type { Run, RunUsage, Verdict } from "../src/runs/types";

const NOW = new Date(2026, 5, 15, 12, 0, 0);

const usage = (cost: number | null): RunUsage => ({ cost, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, toolCalls: 0, model: null });

function run(daysAgo: number, extra: Partial<Run> = {}): Run {
  const created = new Date(2026, 5, 15 - daysAgo, 9, 0, 0);
  return {
    createdAt: created.toISOString(),
    verdict: null,
    usage: null,
    retriedBy: null,
    startedAt: null,
    endedAt: null,
    ...extra,
  } as Run;
}

const finished = (daysAgo: number, verdict: Verdict | null, minutes: number, cost: number | null = null): Run =>
  run(daysAgo, {
    verdict,
    usage: cost === null ? null : usage(cost),
    startedAt: new Date(2026, 5, 15 - daysAgo, 9, 0, 0).toISOString(),
    endedAt: new Date(2026, 5, 15 - daysAgo, 9, minutes, 0).toISOString(),
  });

describe("computeStats", () => {
  test("buckets verdicts, sums cost and takes the median duration", () => {
    const stats = computeStats(
      [
        finished(0, "PASS", 4, 0.5),
        finished(0, "FAIL", 10, 0.25),
        finished(1, "PASS WITH ISSUES", 6),
        finished(2, "BLOCKED", 2, 1),
        finished(2, "PARTIAL", 8),
        run(3),
      ],
      7,
      NOW,
    );
    expect(stats).toMatchObject({ days: 7, runs: 6, pass: 1, fail: 1, issues: 1, other: 3, cost: 1.75 });
    // durations 4, 10, 6, 2, 8 minutes → median 6
    expect(stats.medianDurationMs).toBe(6 * 60_000);
  });

  test("byDay is zero-filled, oldest first, and ends today", () => {
    const stats = computeStats([finished(0, "PASS", 1, 0.5), finished(2, "FAIL", 1)], 4, NOW);
    expect(stats.byDay.map((d) => d.date)).toEqual(["2026-06-12", "2026-06-13", "2026-06-14", "2026-06-15"]);
    expect(stats.byDay.map((d) => [d.runs, d.pass, d.fail, d.cost])).toEqual([
      [0, 0, 0, null],
      [1, 0, 1, null],
      [0, 0, 0, null],
      [1, 1, 0, 0.5],
    ]);
  });

  test("byDay splits runs with issues and other outcomes from passes and failures", () => {
    const stats = computeStats([finished(0, "PASS WITH ISSUES", 1), finished(0, "BLOCKED", 1), finished(0, "PARTIAL", 1), run(0), finished(1, "FAIL", 1)], 2, NOW);
    expect(stats.byDay.map((d) => [d.runs, d.pass, d.issues, d.fail, d.other])).toEqual([
      [1, 0, 0, 1, 0],
      [4, 0, 1, 0, 3],
    ]);
  });

  test("runs outside the window and runs replaced by an infra retry are not counted", () => {
    const stats = computeStats([finished(0, "PASS", 1), finished(10, "FAIL", 1), run(0, { retriedBy: "next" })], 7, NOW);
    expect(stats).toMatchObject({ runs: 1, pass: 1, fail: 0, other: 0 });
  });

  test("nothing to report yields null cost and duration", () => {
    expect(computeStats([], 7, NOW)).toMatchObject({ runs: 0, cost: null, medianDurationMs: null });
  });

  test("the median of an even count averages the middle two", () => {
    expect(computeStats([finished(0, "PASS", 2), finished(0, "PASS", 4)], 1, NOW).medianDurationMs).toBe(3 * 60_000);
  });
});
