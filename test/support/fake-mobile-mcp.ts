/**
 * A stdio MCP server standing in for mobile-mcp in gateway tests: `bun test/support/fake-mobile-mcp.ts`.
 * It exposes the shapes the gateway cares about (device-scoped tools with a required `device`, a batch tool whose steps
 * may carry their own `device`, and one tool the gateway drops) and echoes the `device` it was given, so a test can see
 * which device an agent's call was pinned to. It never touches a real device.
 */
import { appendFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

// Tests that must prove a child is gone read the pids a run of this script appended to this file.
if (process.env.FAKE_MOBILE_MCP_PIDFILE) appendFileSync(process.env.FAKE_MOBILE_MCP_PIDFILE, `${process.pid}\n`);

const device = z.string().describe("The device identifier to use");
const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

const server = new McpServer({ name: "fake-mobile-mcp", version: "9.9.9-fake" });

server.registerTool(
  "mobile_list_available_devices",
  { description: "List all available devices", inputSchema: z.object({}) },
  () => text("devices: fake-a, fake-b"),
);

server.registerTool(
  "mobile_take_screenshot",
  { description: "Take a screenshot of the mobile device", inputSchema: z.object({ device }) },
  (args) => text(`shot:${args.device}`),
);

server.registerTool(
  "mobile_click_on_screen_at_coordinates",
  { description: "Click on the screen at x,y", inputSchema: z.object({ device, x: z.number(), y: z.number() }) },
  (args) => text(`click:${args.device}@${args.x},${args.y}`),
);

server.registerTool(
  "mobile_batch_commands",
  {
    description: "Run multiple tools in sequence. The device argument is applied to every step unless a step provides its own.",
    inputSchema: z.object({
      device,
      steps: z.array(z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()) })).min(1),
    }),
  },
  (args) => {
    // Mirrors mobile-mcp: `{ device, ...step.arguments }`, so a step's own `device` wins.
    const seen = args.steps.map((step) => ({ name: step.name, device: String(step.arguments.device ?? args.device) }));
    return text(JSON.stringify({ device: args.device, steps: seen }));
  },
);

await server.connect(new StdioServerTransport());
