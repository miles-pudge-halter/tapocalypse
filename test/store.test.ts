import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { appendEvent, appendStderr, createRun, deleteRun, getRun, listRuns, type NewRun, readActivity, runDir, saveRun } from "../src/runs/store";

const OLD_RUN = {
  id: "20260101-000000-abcd-old",
  projectId: "test-proj",
  title: "old",
  brief: "b",
  requestedBy: "web",
  deviceRequest: { platform: "android" },
  deviceSerial: "emulator-5554",
  bootedByRun: false,
  backend: "mobile-mcp",
  packageId: "com.x",
  status: "done",
  verdict: "PASS",
  summary: "ok",
  reportPath: null,
  checks: [{ id: "C1", title: "t", status: "pass", updatedAt: "2026-01-01T00:00:00.000Z" }],
  error: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  startedAt: "2026-01-01T00:00:01.000Z",
  endedAt: "2026-01-01T00:01:00.000Z",
  stats: { cost: 1 },
  transcriptHtml: false,
};

const newRun = (title: string): NewRun => {
  const { id: _id, createdAt: _c, ...rest } = OLD_RUN;
  return { ...rest, title, status: "queued", verdict: null, summary: null, deviceSerial: null, startedAt: null, endedAt: null, stats: null, source: null, build: null } as NewRun;
};

describe("store", () => {
  test("an old run.json without the newer fields loads with defaults and keeps its data", () => {
    fs.mkdirSync(runDir(OLD_RUN.id), { recursive: true });
    fs.writeFileSync(path.join(runDir(OLD_RUN.id), "run.json"), JSON.stringify(OLD_RUN));
    const run = getRun(OLD_RUN.id)!;
    expect(run).toMatchObject({
      verdict: "PASS",
      stats: { cost: 1 },
      source: null,
      build: null,
      batchId: null,
      suiteId: null,
      suiteChecks: null,
      model: null,
      thinking: null,
      errorKind: null,
      verdictSource: null,
      usage: { cost: 1, tokensIn: 0, toolCalls: 0, model: null },
      deviceName: null,
      attempt: 1,
      retryOf: null,
      retriedBy: null,
      rerunOf: null,
      install: null,
    });
    expect(run.checks).toEqual(OLD_RUN.checks as typeof run.checks);
  });

  test("createRun fills defaults, listRuns serves it newest-first and deleteRun forgets it", () => {
    const a = createRun(newRun("store a"));
    expect(a.attempt).toBe(1);
    expect(a.suiteChecks).toBeNull();
    a.createdAt = "2020-01-01T00:00:00.000Z";
    saveRun(a);
    const b = createRun(newRun("store b"));
    const ids = listRuns({ projectId: "test-proj" }).map((r) => r.id);
    expect(ids.indexOf(b.id)).toBeLessThan(ids.indexOf(a.id));
    expect(listRuns({ projectId: "nope" })).toEqual([]);

    a.status = "done";
    saveRun(a);
    expect(listRuns().find((r) => r.id === a.id)?.status).toBe("done");

    deleteRun(a.id);
    expect(listRuns().some((r) => r.id === a.id)).toBe(false);
    expect(fs.existsSync(runDir(a.id))).toBe(false);
    expect(getRun(a.id)).toBeNull();
  });

  test("listRuns snapshots are not aliased to the caller's live object", () => {
    const r = createRun(newRun("alias"));
    r.status = "running";
    expect(listRuns().find((x) => x.id === r.id)?.status).toBe("queued");
    saveRun(r);
    expect(listRuns().find((x) => x.id === r.id)?.status).toBe("running");
    deleteRun(r.id);
  });

  test("appendEvent returns consecutive 0-based seq, also after the in-memory counter is gone", () => {
    const r = createRun(newRun("seq"));
    expect([appendEvent(r.id, { type: "a" }), appendEvent(r.id, { type: "b" }), appendEvent(r.id, { type: "c" })]).toEqual([0, 1, 2]);
    deleteRun(r.id);
  });

  test("writes from a runner that outlives deleteRun are dropped instead of throwing or resurrecting the run", () => {
    const r = createRun(newRun("deleted underneath"));
    deleteRun(r.id);
    r.status = "error";
    expect(() => saveRun(r)).not.toThrow();
    expect(() => appendEvent(r.id, { type: "late" })).not.toThrow();
    expect(() => appendStderr(r.id, "late")).not.toThrow();
    expect(fs.existsSync(runDir(r.id))).toBe(false);
    expect(getRun(r.id)).toBeNull();
    expect(listRuns().some((x) => x.id === r.id)).toBe(false);
  });
});

describe("readActivity", () => {
  function runWithSays(n: number): string {
    const r = createRun(newRun(`activity ${n}`));
    for (let i = 0; i < n; i++) {
      // Interleave a frame that yields no activity: seq must still be the line index.
      appendEvent(r.id, { type: "turn_start" });
      appendEvent(r.id, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `say ${i}` }] } });
    }
    return r.id;
  }

  test("returns the newest page oldest-first with seq = line index, then pages backwards", () => {
    const id = runWithSays(10);
    const first = readActivity(id, { limit: 4 });
    expect(first.items.map((a) => a.text)).toEqual(["say 6", "say 7", "say 8", "say 9"]);
    expect(first.items.map((a) => a.seq)).toEqual([13, 15, 17, 19]);
    expect(first.hasMore).toBe(true);

    const second = readActivity(id, { before: first.items[0]!.seq, limit: 4 });
    expect(second.items.map((a) => a.text)).toEqual(["say 2", "say 3", "say 4", "say 5"]);
    expect(second.hasMore).toBe(true);

    const last = readActivity(id, { before: second.items[0]!.seq, limit: 4 });
    expect(last.items.map((a) => a.text)).toEqual(["say 0", "say 1"]);
    expect(last.hasMore).toBe(false);
  });

  test("an exact fit has no more; a missing log is empty", () => {
    const id = runWithSays(3);
    expect(readActivity(id, { limit: 3 })).toMatchObject({ hasMore: false });
    expect(readActivity(id, { limit: 3 }).items).toHaveLength(3);
    expect(readActivity("does-not-exist", { limit: 5 })).toEqual({ items: [], hasMore: false });
  });

  test("tool_end items resolve tool name and duration from a start outside the page", () => {
    const r = createRun(newRun("tool pair"));
    fs.writeFileSync(
      path.join(runDir(r.id), "events.jsonl"),
      [
        { type: "tool_execution_start", toolCallId: "t", toolName: "bash", args: { command: "ls" }, _ts: "2026-01-01T00:00:00.000Z" },
        { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "x" }] }, _ts: "2026-01-01T00:00:01.000Z" },
        { type: "tool_execution_end", toolCallId: "t", toolName: "bash", isError: false, _ts: "2026-01-01T00:00:03.000Z" },
      ]
        .map((f) => JSON.stringify(f))
        .join("\n") + "\n",
    );
    const page = readActivity(r.id, { limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ kind: "tool_end", seq: 2, tool: "bash", ok: true, durationMs: 3000 });
  });
});
