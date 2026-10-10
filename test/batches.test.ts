import { describe, expect, test } from "bun:test";
import { batchView } from "../src/app";
import { getBatchMeta, summarizeBatch, worstVerdict } from "../src/batches";
import type { Run, Verdict } from "../src/runs/types";
import { emulator, setup, settle } from "./support/scheduler-env";

const base = { projectId: "test-proj", brief: "Check the thing." };

describe("verdict rollup", () => {
  test("worst verdict wins: FAIL > BLOCKED > PARTIAL > PASS WITH ISSUES > PASS", () => {
    const order: Verdict[] = ["FAIL", "BLOCKED", "PARTIAL", "PASS WITH ISSUES", "PASS"];
    for (let i = 0; i < order.length; i++) {
      expect(worstVerdict([...order.slice(i)].reverse())).toBe(order[i]!);
    }
  });

  test("is null when any run has no verdict or there are no runs", () => {
    expect(worstVerdict(["PASS", null])).toBeNull();
    expect(worstVerdict([])).toBeNull();
  });

  test("a run replaced by an infra retry is judged by its successor, but its cost still counts", async () => {
    const env = setup({ devices: [emulator("emulator-5556")] });
    const first = await env.scheduler.enqueueRun({ ...base, title: "a" });
    const next = env.scheduler.retry(first);
    first.status = "error";
    first.usage = { cost: 0.5, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, toolCalls: 0, model: null };
    next.status = "done";
    next.verdict = "PASS";
    next.startedAt = "2026-01-01T00:00:00.000Z";
    next.endedAt = "2026-01-01T00:05:00.000Z";
    next.usage = { cost: 0.25, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, toolCalls: 0, model: null };
    expect(summarizeBatch([first, next])).toEqual({
      status: "done",
      verdict: "PASS",
      cost: 0.75,
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:05:00.000Z",
    });
  });

  test("a batch with any active run is active and has no end time or verdict", async () => {
    const env = setup();
    const r1 = await env.scheduler.enqueueRun({ ...base, title: "x" });
    const r2 = await env.scheduler.enqueueRun({ ...base, title: "y" });
    r1.status = "done";
    r1.verdict = "FAIL";
    r1.endedAt = "2026-01-01T00:05:00.000Z";
    expect(summarizeBatch([r1, r2])).toMatchObject({ status: "active", verdict: null, endedAt: null, cost: null });
  });
});

describe("batch fan-out", () => {
  test("one run per device, sharing a batch id, with device-suffixed titles", async () => {
    const env = setup({ devices: [emulator("emulator-5556"), emulator("emulator-5558", { name: "Pixel 8" })] });
    const { batchId, runs } = await env.scheduler.enqueueBatch({
      ...base,
      title: "Smoke",
      devices: [{ platform: "android" }, { platform: "android" }, { serial: "emulator-5558", platform: "android" }],
      requestedBy: "tester",
    });
    expect(batchId).toMatch(/^b-\d{8}-\d{6}-[0-9a-f]{4}$/);
    // An explicit device lane is named after the device, not its serial.
    expect(runs.map((r) => r.title)).toEqual(["Smoke · android #1", "Smoke · android #2", "Smoke · Pixel 8"]);
    expect(new Set(runs.map((r) => r.batchId))).toEqual(new Set([batchId]));
    expect(runs.every((r) => r.requestedBy === "tester" && r.status === "queued")).toBe(true);
    expect(getBatchMeta(batchId)).toMatchObject({ id: batchId, projectId: "test-proj", title: "Smoke" });

    await settle(env.scheduler);
    // The explicit-serial run and the first platform-only run compete for the two emulators; the third waits its turn.
    expect(env.started).toHaveLength(2);
    expect(env.scheduler.queue).toHaveLength(1);
  });

  test("batchView lists the runs oldest-first and rolls their verdicts up", async () => {
    const env = setup();
    const { batchId, runs } = await env.scheduler.enqueueBatch({ ...base, title: "Rollup", devices: [{ platform: "android" }, { platform: "ios" }] });
    expect(batchView(batchId)).toMatchObject({ id: batchId, title: "Rollup", status: "active", verdict: null });

    runs[0]!.status = "done";
    runs[0]!.verdict = "PASS";
    runs[0]!.endedAt = "2026-01-01T00:01:00.000Z";
    env.scheduler.update(runs[0]!);
    runs[1]!.status = "done";
    runs[1]!.verdict = "BLOCKED";
    runs[1]!.endedAt = "2026-01-01T00:02:00.000Z";
    env.scheduler.update(runs[1]!);

    const view = batchView(batchId)!;
    expect(view.runs.map((r) => r.id)).toEqual(runs.map((r) => r.id));
    expect(view).toMatchObject({ status: "done", verdict: "BLOCKED", endedAt: "2026-01-01T00:02:00.000Z" });
    expect(batchView("b-20200101-000000-0000")).toBeNull();
  });

  test("a batch without a title uses the brief's first line", async () => {
    const env = setup();
    const { runs } = await env.scheduler.enqueueBatch({ projectId: "test-proj", brief: "Open settings\nthen scroll", devices: [{ platform: "android" }] });
    expect(runs[0]!.title).toBe("Open settings · android #1");
  });

  test("1 to 8 devices are required", async () => {
    const env = setup();
    const none = await env.scheduler.enqueueBatch({ ...base, title: "t", devices: [] }).catch((e: unknown) => e);
    expect(none).toMatchObject({ status: 400, message: "devices: between 1 and 8 devices are required" });
    const nine = await env.scheduler
      .enqueueBatch({ ...base, title: "t", devices: Array.from({ length: 9 }, () => ({ platform: "android" })) })
      .catch((e: unknown) => e);
    expect(nine).toMatchObject({ status: 400 });
    expect(env.scheduler.queue).toEqual([]);
  });

  test("one invalid device rejects the whole batch and queues nothing", async () => {
    const env = setup({ devices: [emulator("emulator-5556")] });
    const err = await env.scheduler
      .enqueueBatch({ ...base, title: "t", devices: [{ platform: "android" }, { serial: "emulator-9999", platform: "android" }] })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 400, message: "devices.1: device emulator-9999 not connected" });
    expect(env.scheduler.queue).toEqual([]);
  });
});

describe("rerun", () => {
  async function finished(env: ReturnType<typeof setup>, extra: Partial<Run> = {}): Promise<Run> {
    const run = await env.scheduler.enqueueRun({ ...base, title: "Checkout", brief: "Buy things." });
    Object.assign(run, {
      status: "done",
      verdict: "FAIL",
      checks: [
        { id: "C1", title: "Add to cart", status: "pass", updatedAt: "t" },
        { id: "C2", title: "Pay", status: "fail", note: "card\ndeclined", updatedAt: "t" },
        { id: "C3", title: "Receipt", status: "skipped", updatedAt: "t" },
        { id: "C4", title: "Email", status: "blocked", updatedAt: "t" },
      ],
      suiteId: "s1",
      suiteChecks: [
        { id: "C1", title: "Add to cart" },
        { id: "C2", title: "Pay" },
        { id: "C4", title: "Email" },
      ],
      ...extra,
    });
    env.scheduler.update(run);
    return run;
  }

  test("only=failed quotes the checks that did not pass or skip and narrows the suite checks", async () => {
    const env = setup();
    const run = await finished(env);
    const next = await env.scheduler.rerun(run.id, { only: "failed", requestedBy: "mcp" });
    expect(next.brief).toBe(
      `Buy things.\n\nRe-run ONLY these checks from run ${run.id} (previous status + note):\n- C2 Pay (fail: card declined)\n- C4 Email (blocked)`,
    );
    expect(next).toMatchObject({
      title: "Checkout (re-run)",
      rerunOf: run.id,
      suiteId: "s1",
      suiteChecks: [
        { id: "C2", title: "Pay" },
        { id: "C4", title: "Email" },
      ],
      packageId: run.packageId,
      requestedBy: "mcp",
      status: "queued",
      batchId: null,
    });
  });

  test("only=all repeats the brief and every suite check; titles do not stack suffixes", async () => {
    const env = setup();
    const run = await finished(env);
    const first = await env.scheduler.rerun(run.id, { only: "all" });
    expect(first.brief).toBe("Buy things.");
    expect(first.suiteChecks).toHaveLength(3);
    first.status = "done";
    env.scheduler.update(first);
    expect((await env.scheduler.rerun(first.id, { only: "all" })).title).toBe("Checkout (re-run)");
  });

  test("400 when nothing failed, 409 while the run is active, 404 for unknown runs", async () => {
    const env = setup();
    const passed = await finished(env, {
      checks: [{ id: "C1", title: "ok", status: "pass", updatedAt: "t" }],
      verdict: "PASS",
    });
    expect(await env.scheduler.rerun(passed.id, { only: "failed" }).catch((e: unknown) => e)).toMatchObject({ status: 400 });
    const active = await env.scheduler.enqueueRun({ ...base, title: "still going" });
    expect(await env.scheduler.rerun(active.id, { only: "all" }).catch((e: unknown) => e)).toMatchObject({ status: 409 });
    expect(await env.scheduler.rerun("nope", { only: "all" }).catch((e: unknown) => e)).toMatchObject({ status: 404 });
  });

  test("the re-run goes through the normal queue and can target another device", async () => {
    const env = setup();
    const run = await finished(env);
    env.devices.push(emulator("emulator-5556"));
    const next = await env.scheduler.rerun(run.id, { only: "all", device: { serial: "emulator-5556", platform: "android" } });
    await settle(env.scheduler);
    expect(next.deviceRequest).toEqual({ serial: "emulator-5556", platform: "android" });
    expect(env.started.filter(([id]) => id === next.id)).toEqual([[next.id, { serial: "emulator-5556" }]]);
  });

  test("a re-run never exceeds the title and brief limits it is validated against", async () => {
    const env = setup();
    const run = await finished(env, {
      title: "T".repeat(200),
      brief: "B".repeat(19_990),
      checks: Array.from({ length: 200 }, (_, i) => ({ id: `C${i}`, title: "check", status: "fail", note: "n".repeat(400), updatedAt: "t" })),
      suiteChecks: null,
    });
    const next = await env.scheduler.rerun(run.id, { only: "failed" });
    expect(next.title).toHaveLength(200);
    expect(next.title.endsWith(" (re-run)")).toBe(true);
    expect(next.brief.length).toBeLessThanOrEqual(20_000);
    expect(next.brief).toContain("Re-run ONLY these checks");
    expect(next.brief).toMatch(/- … and \d+ more$/);
  });
});
