import { describe, expect, test } from "bun:test";
import path from "node:path";
import { type Frame, LineParser } from "../src/omp/rpc";
import { frameToActivity } from "../src/runs/prompt";

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
  const activities = parseChunks(fixture, 37)
    .map((f) => frameToActivity(f, "mobile-mcp"))
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
});

describe("frameToActivity backend rules", () => {
  const start = (toolName: string): Frame => ({ type: "tool_execution_start", toolName, args: {} });

  test("mobile-mcp tools under the artemis backend are violations", () => {
    expect(frameToActivity(start("mcp__mobile_mcp_mobile_click"), "artemis")).toMatchObject({
      kind: "warn",
      text: "backend violation: mcp__mobile_mcp_mobile_click",
    });
  });

  test("artemis run_task is a violation under artemis, direct tools are fine", () => {
    expect(frameToActivity(start("mcp__artemis_mobile_run_task"), "artemis")?.kind).toBe("warn");
    expect(frameToActivity(start("mcp__artemis_mobile_click"), "artemis")?.kind).toBe("tool");
  });

  test("artemis tools under mobile-mcp are violations, mobile-mcp tools are fine", () => {
    expect(frameToActivity(start("mcp__artemis_mobile_click"), "mobile-mcp")).toMatchObject({
      kind: "warn",
      text: "backend violation: mcp__artemis_mobile_click",
    });
    expect(frameToActivity(start("mcp__mobile_mcp_mobile_click"), "mobile-mcp")?.kind).toBe("tool");
  });

  test("Tapocalypse's plugin-namespaced mobile-mcp tools follow the same rules as the user-config form", () => {
    const namespaced = "mcp__tpc_mobile_mcp_mobile_click_on_screen_at_coordinates";
    expect(frameToActivity(start(namespaced), "artemis")).toMatchObject({ kind: "warn", text: `backend violation: ${namespaced}` });
    expect(frameToActivity(start(namespaced), "mobile-mcp")?.kind).toBe("tool");
  });

  test("tapocalypse MCP tools are violations under both backends", () => {
    for (const backend of ["mobile-mcp", "artemis"] as const) {
      expect(frameToActivity(start("mcp__tapocalypse_qa_start_run"), backend)).toMatchObject({
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
    expect(frameToActivity(xd("write", "xd://mcp__mobile_mcp_mobile_click_on_screen_at_coordinates"), "artemis")).toMatchObject({
      kind: "warn",
      text: "backend violation: mcp__mobile_mcp_mobile_click_on_screen_at_coordinates",
    });
    expect(frameToActivity(xd("write", "xd://mcp__artemis_mobile_click"), "artemis")).toMatchObject({
      kind: "tool",
      text: 'mcp__artemis_mobile_click {"device":"emulator-5556"}',
    });
    // Reading a device's docs is not a call.
    expect(frameToActivity(xd("read", "xd://mcp__mobile_mcp_mobile_click_on_screen_at_coordinates"), "artemis")?.kind).toBe("tool");
  });
});
