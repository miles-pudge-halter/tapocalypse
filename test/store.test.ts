import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { appendEvent, appendStderr, createRun, deleteRun, getRun, listRuns, type NewRun, readActivity, runDir, saveRun, subscribeRuns } from "../src/runs/store";

const OLD_RUN = {
  id: "20260101-000000-abcd-old",
  projectId: "test-proj",
  title: "old",
  brief: "b",
  requestedBy: "web",
  deviceRequest: { platform: "android" },
  deviceSerial: "emulator-5554",
  bootedByRun: false,
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

const newRun = (title: string, over: Partial<NewRun> = {}): NewRun => {
  const { id: _id, createdAt: _c, ...rest } = OLD_RUN;
  return { ...rest, title, status: "queued", verdict: null, summary: null, deviceSerial: null, startedAt: null, endedAt: null, stats: null, source: null, build: null, ...over } as NewRun;
};

const writeEvents = (id: string, frames: object[]): void =>
  fs.writeFileSync(path.join(runDir(id), "events.jsonl"), frames.map((f) => JSON.stringify(f)).join("\n") + "\n");

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
      harness: "omp",
      model: null,
      thinking: null,
      effort: null,
      errorKind: null,
      verdictSource: null,
      usage: { cost: 1, tokensIn: 0, toolCalls: 0, model: null },
      deviceName: null,
      attempt: 1,
      retryOf: null,
      retriedBy: null,
      rerunOf: null,
      install: null,
      storage: "repo",
      testKey: null,
      checkHints: null,
      reuseChecks: true,
    });
    expect(run.checks).toEqual(OLD_RUN.checks as typeof run.checks);
  });

  test("subscribers hear every save (with the stored snapshot) and delete, until they unsubscribe", () => {
    const heard: string[] = [];
    const off = subscribeRuns((change) => heard.push("saved" in change ? `saved:${change.saved.id}:${change.saved.status}` : `deleted:${change.deleted}`));
    const r = createRun(newRun("subscribed"));
    r.status = "running";
    saveRun(r);
    deleteRun(r.id);
    off();
    const after = createRun(newRun("after unsubscribe"));
    deleteRun(after.id);
    expect(heard).toEqual([`saved:${r.id}:queued`, `saved:${r.id}:running`, `deleted:${r.id}`]);
  });

  test("a persisted artemis run loads without its dropped backend key, and saving does not bring it back", () => {
    const legacy = { ...OLD_RUN, id: "20260101-000000-abcd-artemis", backend: "artemis" };
    fs.mkdirSync(runDir(legacy.id), { recursive: true });
    fs.writeFileSync(path.join(runDir(legacy.id), "run.json"), JSON.stringify(legacy));
    const run = getRun(legacy.id)!;
    expect(run.title).toBe("old");
    expect("backend" in run).toBe(false);
    saveRun(run);
    expect("backend" in (JSON.parse(fs.readFileSync(path.join(runDir(legacy.id), "run.json"), "utf8")) as object)).toBe(false);
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

  test("a hub copy pages its stored activity.jsonl by the original seq, ignoring any events.jsonl", () => {
    const r = createRun(newRun("hub activity"));
    const items = [3, 7, 8, 20, 41].map((seq) => ({ ts: "2026-01-01T00:00:00.000Z", seq, kind: "say", text: `item ${seq}` }));
    fs.writeFileSync(path.join(runDir(r.id), "activity.jsonl"), items.map((i) => JSON.stringify(i)).join("\n") + "\n");
    writeEvents(r.id, [{ type: "_activity", kind: "info", text: "raw frame that must not be read" }]);

    const newest = readActivity(r.id, { limit: 2 });
    expect(newest.items.map((a) => a.seq)).toEqual([20, 41]);
    expect(newest.hasMore).toBe(true);
    const older = readActivity(r.id, { before: 20, limit: 5 });
    expect(older.items.map((a) => a.text)).toEqual(["item 3", "item 7", "item 8"]);
    expect(older.hasMore).toBe(false);
  });
});

describe("readActivity per harness", () => {
  test("tapocalypse's own feed lines keep their check id and status", () => {
    const r = createRun(newRun("activity lines"));
    writeEvents(r.id, [
      { type: "_activity", kind: "check", text: "C1: pass — ok", checkId: "C1", checkStatus: "pass", _ts: "2026-01-01T00:00:00.000Z" },
      { type: "_activity", kind: "info", text: "booted" },
    ]);
    const { items } = readActivity(r.id, { limit: 10 });
    expect(items[0]).toMatchObject({ kind: "check", text: "C1: pass — ok", checkId: "C1", checkStatus: "pass", seq: 0 });
    expect(items[1]).toMatchObject({ kind: "info", text: "booted" });
    expect(items[1]!.checkId).toBeUndefined();
    deleteRun(r.id);
  });

  test("frames are replayed by the run's own harness adapter", () => {
    const frames = [
      { type: "assistant", message: { content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } }] }, _ts: "2026-01-01T00:00:00.000Z" },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "boom", is_error: true }] }, _ts: "2026-01-01T00:00:02.000Z" },
    ];
    const claude = createRun(newRun("claude replay", { harness: "claude" }));
    writeEvents(claude.id, frames);
    const items = readActivity(claude.id, { limit: 10 }).items;
    expect(items.map((a) => a.kind)).toEqual(["tool", "tool_end"]);
    expect(items[1]).toMatchObject({ tool: "bash", ok: false, durationMs: 2000 });

    const omp = createRun(newRun("omp ignores claude frames"));
    writeEvents(omp.id, frames);
    expect(readActivity(omp.id, { limit: 10 }).items).toEqual([]);
    deleteRun(claude.id);
    deleteRun(omp.id);
  });

  test("a call start in an earlier page resolves later pages, and new lines extend the same run's scan", () => {
    const r = createRun(newRun("incremental"));
    const start = { type: "tool_execution_start", toolCallId: "t", toolName: "bash", args: { command: "ls" }, _ts: "2026-01-01T00:00:00.000Z" };
    writeEvents(r.id, [start]);
    expect(readActivity(r.id, { limit: 5 }).items).toHaveLength(1);
    appendEvent(r.id, { type: "tool_execution_end", toolCallId: "t", toolName: "bash", isError: false });
    const items = readActivity(r.id, { limit: 5 }).items;
    expect(items.at(-1)).toMatchObject({ kind: "tool_end", tool: "bash", ok: true });
    deleteRun(r.id);
  });

  test("omp runs recorded before server-side check lines keep theirs; newer ones are not shown twice", () => {
    const hostCall = { type: "tool_execution_start", toolCallId: "p", toolName: "qa_check", args: { id: "C1", status: "pass" } };
    const old = createRun(newRun("legacy checks"));
    writeEvents(old.id, [hostCall]);
    expect(readActivity(old.id, { limit: 5 }).items).toMatchObject([{ kind: "check", checkId: "C1", checkStatus: "pass" }]);

    const current = createRun(newRun("server-side checks"));
    writeEvents(current.id, [hostCall, { type: "_activity", kind: "check", text: "C1: pass", checkId: "C1", checkStatus: "pass" }]);
    const items = readActivity(current.id, { limit: 5 }).items;
    expect(items).toHaveLength(1);
    expect(items[0]!.seq).toBe(1);
    deleteRun(old.id);
    deleteRun(current.id);
  });

  test("an unknown harness id in run.json falls back to omp instead of breaking replay and start", () => {
    const id = "20260101-000003-abcd-badharness";
    fs.mkdirSync(runDir(id), { recursive: true });
    fs.writeFileSync(path.join(runDir(id), "run.json"), JSON.stringify({ ...OLD_RUN, id, harness: "gemini" }));
    expect(getRun(id)?.harness).toBe("omp");
    deleteRun(id);
  });

  test("a Codex run keeps its tool rows after a reload: the scan pass and the page pass map the same frame", async () => {
    const fixture = await Bun.file(path.join(import.meta.dir, "fixtures", "codex-exec.jsonl")).text();
    const frames = fixture
      .split("\n")
      .filter(Boolean)
      .map((l, i) => ({ ...JSON.parse(l), _ts: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() }));
    const r = createRun(newRun("codex replay", { harness: "codex" }));
    writeEvents(r.id, frames);
    const { items } = readActivity(r.id, { limit: 100 });
    expect(items.filter((a) => a.kind === "tool").map((a) => a.tool)).toEqual([
      "mcp__mobile_mcp_mobile_list_elements_on_screen",
      "bash",
      "bash",
      "edit",
      "search",
    ]);
    expect(items.find((a) => a.kind === "tool_end" && a.callId === "item_3")?.durationMs).toBe(1000);
    deleteRun(r.id);
  });

  test("raw omp stats become usage only for omp runs", () => {
    const withStats = (id: string, harness: string) => {
      fs.mkdirSync(runDir(id), { recursive: true });
      fs.writeFileSync(path.join(runDir(id), "run.json"), JSON.stringify({ ...OLD_RUN, id, harness }));
      return getRun(id)!;
    };
    expect(withStats("20260101-000001-abcd-statsomp", "omp").usage).toMatchObject({ cost: 1 });
    expect(withStats("20260101-000002-abcd-statsclaude", "claude").usage).toBeNull();
    deleteRun("20260101-000001-abcd-statsomp");
    deleteRun("20260101-000002-abcd-statsclaude");
  });

  describe("replay of mobile-mcp calls", () => {
    const ts = "2026-01-01T00:00:00.000Z";
    const codexCall = { type: "item.started", item: { id: "i1", type: "mcp_tool_call", server: "mobile_mcp", tool: "mobile_list_apps", arguments: {}, status: "in_progress" }, _ts: ts };
    const claudeCall = { type: "assistant", message: { content: [{ type: "tool_use", id: "c1", name: "mcp__mobile_mcp__mobile_list_apps", input: {} }] }, _ts: ts };
    const ompCall = { type: "tool_execution_start", toolCallId: "o1", toolName: "write", args: { path: "xd://mcp__mobile_mcp_mobile_list_apps", content: "{}" }, _ts: ts };
    const FRAMES = { codex: codexCall, claude: claudeCall, omp: ompCall };

    test("a run from before the gateway (no `gated` in run.json) replays them as plain tool rows", () => {
      for (const [harness, frame] of Object.entries(FRAMES)) {
        const id = `20260101-000010-abcd-pre2b-${harness}`;
        fs.mkdirSync(runDir(id), { recursive: true });
        fs.writeFileSync(path.join(runDir(id), "run.json"), JSON.stringify({ ...OLD_RUN, id, harness }));
        fs.writeFileSync(path.join(runDir(id), "events.jsonl"), `${JSON.stringify(frame)}\n`);
        expect(getRun(id)?.gated).toBe(false);
        expect(readActivity(id, { limit: 5 }).items).toMatchObject([{ kind: "tool", tool: "mcp__mobile_mcp_mobile_list_apps" }]);
        deleteRun(id);
      }
    });

    test("a gated run replays an agent's own mobile-mcp as a backend violation", () => {
      for (const [harness, frame] of Object.entries(FRAMES)) {
        const r = createRun(newRun(`gated ${harness}`, { harness: harness as NewRun["harness"], gated: true }));
        writeEvents(r.id, [frame]);
        expect(readActivity(r.id, { limit: 5 }).items).toMatchObject([{ kind: "warn" }]);
        deleteRun(r.id);
      }
    });
  });
});
