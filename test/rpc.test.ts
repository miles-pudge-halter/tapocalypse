import { describe, expect, test } from "bun:test";
import path from "node:path";
import { legacyProgressActivity } from "../src/harness/omp/activity";
import { harness } from "../src/harness/omp";
import { type Frame, LineParser } from "../src/harness/omp/rpc";
import type { ReplayContext } from "../src/harness/types";
import type { Activity, Backend } from "../src/runs/types";

type ToolStarts = ReplayContext["starts"];

/** One frame through the omp adapter's replay mapping; pass the same `starts` across a session. */
function frameToActivity(frame: unknown, backend: Backend, seq: number, starts: ToolStarts = new Map()): Activity | null {
  return harness.toActivity(frame, { backend, seq, starts });
}

function parseChunks(data: Uint8Array, size: number): Frame[] {
  const frames: Frame[] = [];
  const parser = new LineParser((f) => frames.push(f));
  for (let i = 0; i < data.length; i += size) parser.push(data.subarray(i, i + size));
  return frames;
}

const fixture = await Bun.file(path.join(import.meta.dir, "fixtures", "rpc-session.jsonl")).bytes();

describe("LineParser", () => {
  test("replays the captured session identically regardless of chunk size", () => {
    const whole = parseChunks(fixture, fixture.length);
    const chunked = parseChunks(fixture, 37);
    expect(chunked).toEqual(whole);
    expect(whole.some((f) => f.type === "_raw")).toBe(false);
    expect(whole[0].type).toBe("ready");
    expect(whole.at(-1)?.type).toBe("session_settled");
  });

  test("a line split across two pushes yields exactly one frame", () => {
    const frames: Frame[] = [];
    const parser = new LineParser((f) => frames.push(f));
    parser.push('{"type":"re');
    expect(frames).toHaveLength(0);
    parser.push('ady","n":1}\n');
    expect(frames).toEqual([{ type: "ready", n: 1 }]);
  });

  test("a non-JSON line becomes a _raw frame and parsing continues", () => {
    const frames: Frame[] = [];
    const parser = new LineParser((f) => frames.push(f));
    parser.push('not json\n{"type":"ok"}\n');
    expect(frames).toEqual([{ type: "_raw", line: "not json" }, { type: "ok" }]);
  });

  test("multi-byte characters split across chunks survive", () => {
    const bytes = new TextEncoder().encode('{"type":"say","text":"héllo ✅"}\n');
    const frames = parseChunks(bytes, 1);
    expect(frames).toEqual([{ type: "say", text: "héllo ✅" }]);
  });
});

describe("frameToActivity on the captured session", () => {
  const frames = parseChunks(fixture, 37);
  const starts: ToolStarts = new Map();
  const activities = frames
    .map((f, seq) => frameToActivity(f, "mobile-mcp", seq, starts))
    .filter((a) => a !== null);

  test("tool calls name each tool", () => {
    const tools = activities.filter((a) => a.kind === "tool").map((a) => a.text);
    expect(tools.some((t) => t.startsWith("bash "))).toBe(true);
    expect(tools.some((t) => t.startsWith("qa_ping "))).toBe(true);
    expect(tools.find((t) => t.startsWith("qa_ping "))).toContain("pong");
  });

  test("assistant text becomes a say line; user and tool-result messages do not", () => {
    const says = activities.filter((a) => a.kind === "say");
    expect(says.map((a) => a.text)).toEqual(["done"]);
  });

  test("no backend violation warnings for the benign session", () => {
    expect(activities.filter((a) => a.kind === "warn")).toEqual([]);
  });

  test("seq is the frame's line index", () => {
    const bashStart = frames.findIndex((f) => f.type === "tool_execution_start" && f.toolName === "bash");
    expect(activities.find((a) => a.kind === "tool" && a.tool === "bash")?.seq).toBe(bashStart);
  });

  test("tool_end pairs with its start by callId and carries ok", () => {
    const start = activities.find((a) => a.kind === "tool" && a.tool === "qa_ping");
    const end = activities.find((a) => a.kind === "tool_end" && a.tool === "qa_ping");
    expect(start?.callId).toBeTruthy();
    expect(end?.callId).toBe(start?.callId);
    expect(end?.ok).toBe(true);
    expect(start?.args).toEqual({ msg: "pong" });
  });
});

describe("frameToActivity backend rules", () => {
  const start = (toolName: string): Frame => ({ type: "tool_execution_start", toolName, args: {} });

  test("mobile-mcp tools under the artemis backend are violations", () => {
    expect(frameToActivity(start("mcp__mobile_mcp_mobile_click"), "artemis", 0)).toMatchObject({
      kind: "warn",
      text: "backend violation: mcp__mobile_mcp_mobile_click",
    });
  });

  test("artemis run_task is a violation under artemis, direct tools are fine", () => {
    expect(frameToActivity(start("mcp__artemis_mobile_run_task"), "artemis", 0)?.kind).toBe("warn");
    expect(frameToActivity(start("mcp__artemis_mobile_click"), "artemis", 0)?.kind).toBe("tool");
  });

  test("artemis tools under mobile-mcp are violations, mobile-mcp tools are fine", () => {
    expect(frameToActivity(start("mcp__artemis_mobile_click"), "mobile-mcp", 0)).toMatchObject({
      kind: "warn",
      text: "backend violation: mcp__artemis_mobile_click",
    });
    expect(frameToActivity(start("mcp__mobile_mcp_mobile_click"), "mobile-mcp", 0)?.kind).toBe("tool");
  });

  test("Tapocalypse's plugin-namespaced mobile-mcp tools follow the same rules as the user-config form, under the canonical name", () => {
    const namespaced = "mcp__tpc_mobile_mcp_mobile_click_on_screen_at_coordinates";
    const canonical = "mcp__mobile_mcp_mobile_click_on_screen_at_coordinates";
    expect(frameToActivity(start(namespaced), "artemis", 0)).toMatchObject({ kind: "warn", text: `backend violation: ${canonical}` });
    expect(frameToActivity(start(namespaced), "mobile-mcp", 0)).toMatchObject({ kind: "tool", tool: canonical });
  });

  test("a user-configured server under another name still canonicalizes to its device server", () => {
    expect(frameToActivity(start("mcp__my_phone_mobile_mcp_mobile_click"), "mobile-mcp", 0)).toMatchObject({ tool: "mcp__mobile_mcp_mobile_click" });
  });

  test("tapocalypse MCP tools are violations under both backends", () => {
    for (const backend of ["mobile-mcp", "artemis"] as const) {
      expect(frameToActivity(start("mcp__tapocalypse_qa_start_run"), backend, 0)).toMatchObject({
        kind: "warn",
        text: "backend violation: mcp__tapocalypse_qa_start_run",
      });
    }
  });

  test("MCP calls made through omp's xd:// write are attributed to the MCP tool", () => {
    const xd = (toolName: string, path: string): Frame => ({
      type: "tool_execution_start",
      toolName,
      args: { path, content: '{"device":"emulator-5556"}' },
    });
    expect(frameToActivity(xd("write", "xd://mcp__mobile_mcp_mobile_click_on_screen_at_coordinates"), "artemis", 0)).toMatchObject({
      kind: "warn",
      text: "backend violation: mcp__mobile_mcp_mobile_click_on_screen_at_coordinates",
    });
    expect(frameToActivity(xd("write", "xd://mcp__artemis_mobile_click"), "artemis", 0)).toMatchObject({
      kind: "tool",
      text: 'mcp__artemis_mobile_click {"device":"emulator-5556"}',
    });
    // Reading a device's docs is not a call.
    expect(frameToActivity(xd("read", "xd://mcp__mobile_mcp_mobile_click_on_screen_at_coordinates"), "artemis", 0)?.kind).toBe("tool");
  });
});

describe("frameToActivity enrichment", () => {
  const frame = (f: Record<string, unknown>): Frame => ({ type: "x", ...f }) as Frame;

  test("progress tool calls add no feed line of their own (the progress recorder writes the check lines)", () => {
    const starts: ToolStarts = new Map();
    for (const [name, args] of [
      ["qa_plan", { checks: [{ id: "C1", title: "a" }] }],
      ["qa_check", { id: "C1", status: "pass" }],
      ["qa_finish", { verdict: "PASS", summary: "s", reportPath: "r" }],
    ] as const) {
      expect(frameToActivity(frame({ type: "tool_execution_start", toolCallId: name, toolName: name, args }), "mobile-mcp", 0, starts)).toBeNull();
      expect(frameToActivity(frame({ type: "tool_execution_end", toolCallId: name, toolName: name, isError: false }), "mobile-mcp", 1, starts)).toBeNull();
    }
  });

  test("runs recorded before progress calls were logged server-side still show their check lines", () => {
    const at = (toolName: string, args: Record<string, unknown>) => legacyProgressActivity(frame({ type: "tool_execution_start", toolName, args }), 3);
    expect(at("qa_plan", { checks: [{ id: "C1", title: "a" }, { id: "C2", title: "b" }] })).toMatchObject({ kind: "check", text: "Test plan: 2 checks", seq: 3 });
    expect(at("qa_check", { id: "C2", status: "fail", note: "no title" })).toMatchObject({ kind: "check", checkId: "C2", checkStatus: "fail", text: "C2: fail — no title" });
    expect(at("qa_finish", { verdict: "PASS", summary: "s", reportPath: "r" })).toMatchObject({ kind: "check", text: "Finished: PASS" });
    expect(at("qa_check", { id: "C2", status: "bogus" })).toBeNull();
    expect(at("bash", { command: "ls" })).toBeNull();
  });

  test("a rejected host-tool call stays visible as a failed tool_end", () => {
    const starts: ToolStarts = new Map();
    frameToActivity(
      frame({ type: "tool_execution_start", toolCallId: "c", toolName: "qa_check", args: { id: "C2", status: "pass", screenshot: "/etc/passwd" } }),
      "mobile-mcp",
      0,
      starts,
    );
    const end = frameToActivity(
      frame({ type: "tool_execution_end", toolCallId: "c", toolName: "qa_check", isError: true, result: { content: [{ type: "text", text: "screenshot path must be inside the repo" }] } }),
      "mobile-mcp",
      1,
      starts,
    );
    expect(end).toMatchObject({ kind: "tool_end", tool: "qa_check", ok: false });
    expect(end?.text).toContain("must be inside the repo");
  });

  test("an xd:// write resolves to the MCP tool on both start and end, with parsed args and duration", () => {
    const starts: ToolStarts = new Map();
    const start = frameToActivity(
      frame({
        type: "tool_execution_start",
        toolCallId: "t1",
        toolName: "write",
        args: { path: "xd://mcp__tpc_mobile_mcp_mobile_click", content: '{"x":1}' },
        _ts: "2026-01-01T00:00:00.000Z",
      }),
      "mobile-mcp",
      0,
      starts,
    );
    expect(start).toMatchObject({ kind: "tool", tool: "mcp__mobile_mcp_mobile_click", args: { x: 1 } });
    const end = frameToActivity(
      frame({ type: "tool_execution_end", toolCallId: "t1", toolName: "write", isError: true, result: { content: [{ type: "text", text: "boom" }] }, _ts: "2026-01-01T00:00:02.500Z" }),
      "mobile-mcp",
      1,
      starts,
    );
    expect(end).toMatchObject({ kind: "tool_end", tool: "mcp__mobile_mcp_mobile_click", ok: false, durationMs: 2500 });
    expect(end?.text).toContain("boom");
  });

  test("args over 2 KB are truncated to a string", () => {
    const big = frameToActivity(frame({ type: "tool_execution_start", toolCallId: "b", toolName: "bash", args: { command: "x".repeat(5000) } }), "mobile-mcp", 0);
    expect(typeof big?.args).toBe("string");
    expect((big?.args as string).length).toBeLessThanOrEqual(2049);
    expect(big?.text.length).toBeLessThanOrEqual(220);
  });
});
