import { describe, expect, test } from "bun:test";
import { formatArgs, formatToolDuration, humaniseTool, parseArgs } from "../web/components/run/humanise";

const MCP = "mcp__mobile_mcp_mobile_";

describe("humaniseTool: device tools", () => {
  test("tap by ref and by coordinates, args as object or JSON string", () => {
    expect(humaniseTool(`${MCP}click_on_screen_at_coordinates`, { device: "e", ref: "@e23" })).toEqual({
      family: "device",
      label: "Tap @e23",
    });
    expect(humaniseTool(`${MCP}double_tap_on_screen`, '{"device":"e","x":720,"y":800}').label).toBe("Double-tap (720, 800)");
    expect(humaniseTool(`${MCP}long_press_on_screen_at_coordinates`, '{"x":720.4,"y":1000}').label).toBe(
      "Long-press (720, 1000)",
    );
  });

  test("plugin-prefixed mobile-mcp names resolve the same action", () => {
    const tool = "mcp__tapocalypse_plugin_mobile_mcp_mobile_take_screenshot";
    expect(humaniseTool(tool, {}).label).toBe("Take screenshot");
  });

  test("swipe, type, press, launch, save screenshot", () => {
    expect(humaniseTool(`${MCP}swipe_on_screen`, { direction: "up", x: 100, y: 900 }).label).toBe("Swipe up from (100, 900)");
    expect(humaniseTool(`${MCP}type_keys`, { text: "hello", submit: true }).label).toBe('Type "hello" ⏎');
    expect(humaniseTool(`${MCP}press_button`, { button: "HOME" }).label).toBe("Press HOME");
    expect(humaniseTool(`${MCP}launch_app`, { packageName: "com.example.shop.dev" }).label).toBe(
      "Launch app com.example.shop.dev",
    );
    expect(
      humaniseTool(`${MCP}save_screenshot`, { saveTo: "qa/screenshots/run/03-map.png" }).label,
    ).toBe("Save screenshot → 03-map.png");
    expect(humaniseTool(`${MCP}list_elements_on_screen`, { device: "x" }).label).toBe("List screen elements");
  });

  test("a batch lists its steps", () => {
    const label = humaniseTool(`${MCP}batch_commands`, {
      commands: [
        { tool: "mobile_click_on_screen_at_coordinates", args: { ref: "@e9" } },
        { tool: "mobile_list_elements_on_screen", args: {} },
      ],
    }).label;
    expect(label).toBe("Batch of 2: tap @e9 → list screen elements");
  });

  test("Artemis element-index click and key press", () => {
    expect(humaniseTool("mcp__artemis_mobile_click", { target: 21, device_serial: "emulator-5556" }).label).toBe(
      "Tap element #21",
    );
    expect(humaniseTool("mcp__artemis_mobile_press_key", { key: "BACK" }).label).toBe("Press BACK");
  });
});

describe("humaniseTool: other families", () => {
  test("bash strips the ADB variable preamble and clips long commands", () => {
    const cmd = "ADB=$(command -v adb || echo ~/Library/Android/sdk/platform-tools/adb); $ADB -s emulator-5556 shell wm size";
    expect(humaniseTool("bash", { command: cmd })).toEqual({
      family: "shell",
      label: "$ adb -s emulator-5556 shell wm size",
    });
    const wrapped = "A=~/Library/Android/sdk/platform-tools/adb; perl -e 'alarm 10; exec @ARGV' $A -s emulator-5556 shell uptime";
    expect(humaniseTool("bash", { command: wrapped }).label).toBe("$ adb -s emulator-5556 shell uptime");
    const long = humaniseTool("bash", { command: `echo ${"x".repeat(400)}` });
    expect(long.label.length).toBeLessThanOrEqual(160);
    expect(long.label.endsWith("…")).toBe(true);
  });

  test("eval prefers its title, otherwise the first code line", () => {
    expect(humaniseTool("eval", { language: "py", title: "QA helpers setup", code: "import os" }).label).toBe(
      "Run Python: QA helpers setup",
    );
    expect(humaniseTool("eval", { language: "js", code: "\n\nconst x = 1;" })).toEqual({
      family: "code",
      label: "Run JavaScript: const x = 1;",
    });
  });

  test("file tools: read, xd docs, write, hashline edit, grep", () => {
    expect(humaniseTool("read", { path: "qa/a.png" }).label).toBe("Read qa/a.png");
    expect(humaniseTool("read", { path: "xd://mcp__mobile_mcp_mobile_take_screenshot" }).label).toBe(
      "Read docs: mcp__mobile_mcp_mobile_take_screenshot",
    );
    expect(humaniseTool("write", { path: "qa/QA-REPORT.md", content: "x" }).label).toBe("Write qa/QA-REPORT.md");
    expect(humaniseTool("edit", { input: "[qa/report.md#AA6C]\nPUT 1:\n+x" }).label).toBe("Edit qa/report.md");
    expect(humaniseTool("grep", { pattern: "junction", path: "lib" }).label).toBe('Search "junction" in lib');
  });

  test("the canonical web search of claude/codex reads as a web search, with or without a query", () => {
    expect(humaniseTool("search", { query: "x" }).label).toBe('Web search "x"');
    expect(humaniseTool("search", {}).label).toBe("Web search");
  });

  test("an unresolved xd:// write is described as the MCP call it is", () => {
    const wrapped = { path: `xd://${MCP}click_on_screen_at_coordinates`, content: '{"device":"d","ref":"@e1"}' };
    expect(humaniseTool("write", wrapped)).toEqual({ family: "device", label: "Tap @e1" });
  });

  test("qa host tools read as milestones", () => {
    expect(humaniseTool("qa_plan", { checks: [{ id: "C1", title: "t" }, { id: "C2", title: "u" }] })).toEqual({
      family: "check",
      label: "Declare test plan (2 checks)",
    });
    expect(humaniseTool("qa_check", { id: "C2", status: "fail" }).label).toBe("Report C2 → fail");
    expect(humaniseTool("qa_finish", { verdict: "PASS WITH ISSUES" }).label).toBe("Finish run: PASS WITH ISSUES");
  });

  test("unknown tools keep a readable name", () => {
    expect(humaniseTool("mcp__atlassian_getjiraissue", {})).toEqual({ family: "other", label: "atlassian · getjiraissue" });
    expect(humaniseTool("wait", {}).label).toBe("Wait");
  });
});

describe("parseArgs", () => {
  test("recovers fields from a payload truncated mid-JSON", () => {
    const truncated = '{"device":"emulator-5556","x":720,"y":800,"extra":"this string never clo';
    expect(parseArgs(truncated)).toEqual({ device: "emulator-5556", x: 720, y: 800 });
    expect(humaniseTool(`${MCP}click_on_screen_at_coordinates`, truncated).label).toBe("Tap (720, 800)");
  });

  test("non-JSON strings and non-objects yield no args", () => {
    expect(parseArgs("just text")).toEqual({});
    expect(parseArgs(null)).toEqual({});
    expect(parseArgs([1, 2])).toEqual({});
    expect(humaniseTool("bash", "oops").label).toBe("Run shell command");
  });
});

describe("formatArgs", () => {
  test("pretty-prints objects and JSON strings, leaves truncated JSON verbatim", () => {
    expect(formatArgs({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(formatArgs('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(formatArgs('{"a":1,"b":"unfinis')).toBe('{"a":1,"b":"unfinis');
    expect(formatArgs(undefined)).toBe("");
  });
});

describe("formatToolDuration", () => {
  test("sub-second in ms, then seconds, then minutes", () => {
    expect(formatToolDuration(310)).toBe("310ms");
    expect(formatToolDuration(2400)).toBe("2.4s");
    expect(formatToolDuration(42_000)).toBe("42s");
    expect(formatToolDuration(65_000)).toBe("1m 05s");
  });
});
