import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { flakyView, historyView } from "../src/app";
import type { CheckStatus } from "../src/runs/types";
import { cleanupRuns, makeRun, type RunSpec, uniqueTest } from "./support/regression";

afterEach(() => cleanupRuns());

const sha = (n: number): string => String(n).repeat(40).slice(0, 40);

/** Isolated project + test so key counts are exact whatever else is in the shared store. */
function history(spec: { commit?: string | null; device?: string | null; dirty?: boolean | null; platform?: "android" | "ios"; branch?: string }[], statuses: CheckStatus[]) {
  const projectId = `flaky-${randomBytes(3).toString("hex")}`;
  const testKey = uniqueTest();
  const runs = statuses.map((status, i) => {
    const s = spec[i] ?? spec[0] ?? {};
    const input: RunSpec = {
      testKey,
      projectId,
      at: i + 1,
      branch: s.branch ?? "main",
      commit: s.commit === undefined ? sha(1) : s.commit,
      dirty: s.dirty,
      device: s.device === undefined ? "Pixel" : s.device,
      platform: s.platform ?? "android",
      checks: [["c", status]],
    };
    return makeRun(input);
  });
  return { projectId, checkKey: `${testKey}/c`, runs };
}

describe("flakyView", () => {
  test("two or more pass↔fail flips on the same clean commit, platform and device make a check flaky", () => {
    const h = history([{}], ["pass", "fail", "pass", "fail"]);
    const view = flakyView(h.projectId, { window: 20 });
    expect(view.checks).toHaveLength(1);
    expect(view.checks[0]).toMatchObject({
      checkKey: h.checkKey,
      confidence: "flaky",
      flips: 3,
      window: 4,
      passRate: 0.5,
      recent: ["pass", "fail", "pass", "fail"],
      lastFlipAt: h.runs[3]!.createdAt,
      lastFlipBranch: "main",
    });
    expect(view).toMatchObject({ trackedKeys: 1, repeatedKeys: 1 });
  });

  test("a single flip is only a suspect", () => {
    const h = history([{}], ["pass", "fail"]);
    expect(flakyView(h.projectId, { window: 20 }).checks[0]).toMatchObject({ confidence: "suspect", flips: 1 });
  });

  test("the same check passing on one device and failing on another is device-sensitive, not flaky", () => {
    const h = history([{ device: "Pixel" }, { device: "Tablet" }, { device: "Pixel" }, { device: "Tablet" }], ["pass", "fail", "pass", "fail"]);
    expect(flakyView(h.projectId, { window: 20 }).checks).toEqual([]);
    const hist = historyView({ projectId: h.projectId, checkKey: h.checkKey }, { limit: 30 });
    expect(hist).toMatchObject({ flaky: null, deviceSensitive: true, flips: 0 });
  });

  test("results on different commits are never counted as flips", () => {
    const h = history([{ commit: sha(1) }, { commit: sha(2) }, { commit: sha(3) }, { commit: sha(4) }], ["pass", "fail", "pass", "fail"]);
    expect(flakyView(h.projectId, { window: 20 }).checks).toEqual([]);
    expect(historyView({ projectId: h.projectId, checkKey: h.checkKey }, { limit: 30 })).toMatchObject({ flaky: null, flips: 0 });
  });

  test("dirty trees and runs with neither commit nor build are ignored; a build version can stand in for a missing commit", () => {
    const dirty = history([{ dirty: true }], ["pass", "fail", "pass"]);
    expect(flakyView(dirty.projectId, { window: 20 }).checks).toEqual([]);
    const unknown = history([{ commit: null }], ["pass", "fail", "pass"]);
    expect(flakyView(unknown.projectId, { window: 20 }).checks).toEqual([]);

    const projectId = `flaky-${randomBytes(3).toString("hex")}`;
    const testKey = uniqueTest();
    (["pass", "fail", "pass"] as const).forEach((status, i) =>
      makeRun({ testKey, projectId, at: i + 1, commit: null, build: { versionName: "1.2", versionCode: "30" }, checks: [["c", status]] }),
    );
    expect(flakyView(projectId, { window: 20 }).checks[0]).toMatchObject({ confidence: "flaky", flips: 2 });
  });

  test("superseded attempts do not count", () => {
    const projectId = `flaky-${randomBytes(3).toString("hex")}`;
    const testKey = uniqueTest();
    makeRun({ testKey, projectId, at: 1, commit: sha(1), checks: [["c", "pass"]] });
    // The failing attempt was retried: its successor stands for it.
    makeRun({ testKey, projectId, at: 2, commit: sha(1), retriedBy: "successor", checks: [["c", "fail"]] });
    makeRun({ testKey, projectId, at: 3, commit: sha(1), checks: [["c", "pass"]] });
    expect(flakyView(projectId, { window: 20 }).checks).toEqual([]);
  });

  test("the label clears once the newest five results show no flip", () => {
    const h = history([{ commit: sha(1) }, { commit: sha(1) }, { commit: sha(1) }, ...Array.from({ length: 5 }, () => ({ commit: sha(2) }))], [
      "pass",
      "fail",
      "pass",
      "pass",
      "pass",
      "pass",
      "pass",
      "pass",
    ]);
    expect(flakyView(h.projectId, { window: 20 }).checks).toEqual([]);
    const justFlipped = history([{ commit: sha(1) }, { commit: sha(1) }, { commit: sha(1) }, ...Array.from({ length: 3 }, () => ({ commit: sha(2) }))], [
      "pass",
      "fail",
      "pass",
      "pass",
      "pass",
      "pass",
    ]);
    expect(flakyView(justFlipped.projectId, { window: 20 }).checks).toHaveLength(1);
  });

  test("only the newest `window` decisive results count", () => {
    const h = history([{}], ["pass", "fail", "pass", "fail", "pass", "pass", "pass", "pass"]);
    expect(flakyView(h.projectId, { window: 20 }).checks[0]).toMatchObject({ flips: 4 });
    // Window 4: the four newest results are all passes.
    expect(flakyView(h.projectId, { window: 4 }).checks).toEqual([]);
  });

  test("filters by platform, and orders flaky before suspect", () => {
    const projectId = `flaky-${randomBytes(3).toString("hex")}`;
    const [t1, t2] = [uniqueTest(), uniqueTest()];
    (["pass", "fail"] as const).forEach((s, i) => makeRun({ testKey: t1, projectId, at: i + 1, commit: sha(1), platform: "ios", checks: [["c", s]] }));
    (["pass", "fail", "pass"] as const).forEach((s, i) => makeRun({ testKey: t2, projectId, at: i + 1, commit: sha(1), platform: "android", checks: [["c", s]] }));
    expect(flakyView(projectId, { window: 20 }).checks.map((c) => c.confidence)).toEqual(["flaky", "suspect"]);
    expect(flakyView(projectId, { platform: "ios", window: 20 }).checks.map((c) => c.confidence)).toEqual(["suspect"]);
    expect(flakyView(projectId, { window: 20 })).toMatchObject({ trackedKeys: 2, repeatedKeys: 2 });
  });

  test("says how little history there is when nothing repeats", () => {
    const projectId = `flaky-${randomBytes(3).toString("hex")}`;
    makeRun({ testKey: uniqueTest(), projectId, at: 1, checks: [["a", "pass"], ["b", "fail"]] });
    expect(flakyView(projectId, { window: 20 })).toEqual({ checks: [], trackedKeys: 2, repeatedKeys: 0 });
  });
});

describe("historyView", () => {
  test("lists results newest first with run context, flips and pagination", () => {
    const h = history([{ branch: "main" }, { branch: "main" }, { branch: "feature/x" }, { branch: "feature/x", platform: "ios", device: "iPhone" }], ["pass", "fail", "pass", "fail"]);
    const full = historyView({ projectId: h.projectId, checkKey: h.checkKey }, { limit: 30 });
    expect(full.entries.map((e) => e.runId)).toEqual([...h.runs].reverse().map((r) => r.id));
    expect(full).toMatchObject({ projectId: h.projectId, checkKey: h.checkKey, keyKind: "title", title: "Check c", hasMore: false });
    expect(full.entries[0]).toMatchObject({ status: "fail", branch: "feature/x", platform: "ios", deviceName: "iPhone", runTitle: "regression fixture", verdict: "PASS", harness: "omp" });
    // The iPhone run is alone on its platform+device, so it flips against nothing there.
    expect(full.entries[0]).toMatchObject({ flip: false, flippedOnSameCode: false });
    expect(full.entries[1]).toMatchObject({ status: "pass", flip: true, flippedOnSameCode: true });
    expect(full.entries[2]).toMatchObject({ status: "fail", flip: true });
    expect(full.entries[3]!.flip).toBe(false);

    const page1 = historyView({ projectId: h.projectId, checkKey: h.checkKey }, { limit: 2 });
    expect(page1.entries).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
    const page2 = historyView({ projectId: h.projectId, checkKey: h.checkKey }, { limit: 2, before: page1.entries[1]!.createdAt });
    expect(page2.entries.map((e) => e.runId)).toEqual([h.runs[1]!.id, h.runs[0]!.id]);
    expect(page2.hasMore).toBe(false);

    expect(historyView({ projectId: h.projectId, checkKey: h.checkKey }, { limit: 30, branch: "feature/x" }).entries).toHaveLength(2);
    expect(historyView({ projectId: h.projectId, checkKey: h.checkKey }, { limit: 30, platform: "ios" }).entries).toHaveLength(1);
  });

  test("resolves a run's check to its key; a live run with no history yet still answers", () => {
    const h = history([{}], ["pass", "fail"]);
    const byCheck = historyView({ runId: h.runs[1]!.id, checkId: "c" }, { limit: 30 });
    expect(byCheck.checkKey).toBe(h.checkKey);
    expect(byCheck.entries).toHaveLength(2);

    const live = makeRun({ testKey: uniqueTest(), at: 20, status: "running", verdict: null, checks: [["x", "running"]] });
    const liveHistory = historyView({ runId: live.id, checkId: "x" }, { limit: 30 });
    expect(liveHistory).toMatchObject({ entries: [], title: "Check x", flaky: null, passRate: null });
  });

  test("unknown key, run or check is a 404", () => {
    const h = history([{}], ["pass"]);
    expect(() => historyView({ projectId: h.projectId, checkKey: "t:nope" }, { limit: 30 })).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => historyView({ runId: "nope", checkId: "c" }, { limit: 30 })).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => historyView({ runId: h.runs[0]!.id, checkId: "zzz" }, { limit: 30 })).toThrow(expect.objectContaining({ status: 404 }));
  });

  test("pass/blocked churn on the same code is flagged unstable, not flaky", () => {
    const h = history([{}], ["pass", "blocked", "pass", "blocked"]);
    expect(historyView({ projectId: h.projectId, checkKey: h.checkKey }, { limit: 30 })).toMatchObject({ unstable: true, flaky: null, passRate: 1 });
  });
});
