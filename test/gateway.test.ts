import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { leaseKey, LeaseStore } from "../src/devices/leases";
import { MOBILE_MCP_VERSION } from "../src/harness/types";
import {
  DROPPED_TOOLS,
  GATED_PREFIX_DESCRIPTION,
  Gateway,
  type GatewayClient,
  type GatewayDeps,
  gateSchema,
  mobileMcpSpawn,
  rewriteArgs,
  spawnMobileMcp,
  stopOnLeaseEnd,
  type ToolDef,
  type ToolResult,
} from "../src/devices/gateway";

const tap: ToolDef = {
  name: "mobile_click_on_screen_at_coordinates",
  description: "Click on the screen",
  inputSchema: {
    type: "object",
    properties: { device: { type: "string", description: "id" }, x: { type: "number" }, y: { type: "number" } },
    required: ["device", "x", "y"],
  },
};

const batch: ToolDef = {
  name: "mobile_batch_commands",
  description: "Run steps",
  inputSchema: {
    type: "object",
    properties: {
      device: { type: "string" },
      steps: { type: "array", items: { type: "object", properties: { name: { type: "string" }, arguments: { type: "object" } } } },
    },
    required: ["device", "steps"],
  },
};

describe("schema transforms", () => {
  test("gateSchema swaps the device argument for a required leaseId and prefixes the description", () => {
    const gated = gateSchema(tap);
    expect(gated.inputSchema.properties).not.toHaveProperty("device");
    expect(gated.inputSchema.properties).toHaveProperty("leaseId");
    expect(gated.inputSchema.required).toEqual(["leaseId", "x", "y"]);
    expect(gated.description).toBe(`${GATED_PREFIX_DESCRIPTION}Click on the screen`);
    expect(gated.name).toBe(tap.name);
    // the child's own definition is left untouched
    expect(tap.inputSchema.properties).toHaveProperty("device");
  });

  test("gateSchema keeps the batch step schema as the child defined it", () => {
    const gated = gateSchema(batch);
    expect(gated.inputSchema.properties?.steps).toEqual(batch.inputSchema.properties?.steps);
    expect(gated.inputSchema.required).toEqual(["leaseId", "steps"]);
  });

  test("the remote-cloud and device-listing tools are dropped", () => {
    expect([...DROPPED_TOOLS].sort()).toEqual([
      "mobile_allocate_remote_device",
      "mobile_list_available_devices",
      "mobile_list_remote_devices",
      "mobile_login_to_cloud_provider",
      "mobile_release_remote_device",
    ]);
  });
});

describe("rewriteArgs", () => {
  test("pins device, ignores a caller-supplied device and strips leaseId", () => {
    const out = rewriteArgs(tap, { leaseId: "secret", device: "other", x: 1, y: 2 }, "Pixel_8");
    expect(out).toEqual({ device: "Pixel_8", x: 1, y: 2 });
  });

  test("a batch overwrites the device inside every step, including steps that carry their own", () => {
    const out = rewriteArgs(
      batch,
      {
        leaseId: "secret",
        stopOnError: false,
        steps: [
          { name: "mobile_click_on_screen_at_coordinates", arguments: { x: 1, y: 2 } },
          { name: "mobile_type_keys", arguments: { device: "someone-elses", text: "hi" } },
          { name: "mobile_press_button" },
        ],
      },
      "Pixel_8",
    );
    expect(out).toEqual({
      device: "Pixel_8",
      stopOnError: false,
      steps: [
        { name: "mobile_click_on_screen_at_coordinates", arguments: { x: 1, y: 2, device: "Pixel_8" } },
        { name: "mobile_type_keys", arguments: { device: "Pixel_8", text: "hi" } },
        { name: "mobile_press_button", arguments: { device: "Pixel_8" } },
      ],
    });
  });
});

// ---- Gateway pool -----------------------------------------------------------------------------------------------------

const DEVICE_TOOLS: ToolDef[] = [tap, batch, { name: "mobile_list_available_devices", description: "all", inputSchema: { type: "object", properties: {} } }];

class FakeClient implements GatewayClient {
  readonly calls: Array<{ name: string; args: Record<string, unknown>; timeoutMs: number }> = [];
  closed = 0;
  /** Set to make `callTool` wait for a call to `release()`/`crash()`. */
  hang: PromiseWithResolvers<ToolResult> | null = null;
  private exit = Promise.withResolvers<void>();
  readonly exited = this.exit.promise;
  constructor(
    readonly cwd: string,
    readonly version: string | null = "1.0.9",
    readonly tools: ToolDef[] = DEVICE_TOOLS,
  ) {}
  async listTools(): Promise<ToolDef[]> {
    return this.tools;
  }
  async callTool(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<ToolResult> {
    this.calls.push({ name, args, timeoutMs });
    if (this.hang) return this.hang.promise;
    return { content: [{ type: "text", text: `ok ${JSON.stringify(args)}` }] };
  }
  async close(): Promise<void> {
    this.closed++;
    this.exit.resolve();
  }
  crash(): void {
    this.exit.resolve();
    this.hang?.reject(new Error("connection closed"));
  }
}

function setup(over: Partial<GatewayDeps> = {}) {
  const spawned: FakeClient[] = [];
  const gw = new Gateway({
    spawnClient: async (cwd) => {
      const c = new FakeClient(cwd);
      spawned.push(c);
      return c;
    },
    ...over,
  });
  return { gw, spawned };
}

const text = (r: ToolResult) => String((r.content[0] as { text?: unknown }).text);

describe("Gateway.call", () => {
  test("spawns one child per key lazily, even for concurrent first calls, and reuses it", async () => {
    const { gw, spawned } = setup();
    expect(spawned).toHaveLength(0);
    await Promise.all([
      gw.call("keyA", "Pixel_8", undefined, "mobile_click_on_screen_at_coordinates", { leaseId: "s", x: 1, y: 2 }),
      gw.call("keyA", "Pixel_8", undefined, "mobile_click_on_screen_at_coordinates", { leaseId: "s", x: 3, y: 4 }),
    ]);
    await gw.call("keyA", "Pixel_8", undefined, "mobile_click_on_screen_at_coordinates", { x: 5, y: 6 });
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.calls).toHaveLength(3);
    await gw.call("keyB", "iPhone", undefined, "mobile_click_on_screen_at_coordinates", { x: 1, y: 1 });
    expect(spawned).toHaveLength(2);
    await gw.stopAll();
  });

  test("the child gets the pinned device (never the caller's) and the default 300 s timeout; the result comes back verbatim", async () => {
    const { gw, spawned } = setup();
    const result = await gw.call("k", "Pixel_8", undefined, "mobile_click_on_screen_at_coordinates", { leaseId: "s", device: "other", x: 1, y: 2 });
    expect(spawned[0]!.calls[0]).toEqual({ name: "mobile_click_on_screen_at_coordinates", args: { device: "Pixel_8", x: 1, y: 2 }, timeoutMs: 300_000 });
    expect(result).toEqual({ content: [{ type: "text", text: 'ok {"device":"Pixel_8","x":1,"y":2}' }] });
    await gw.stopAll();
  });

  test("a child result flagged isError is returned as is, and the child stays", async () => {
    const { gw, spawned } = setup();
    await gw.call("k", "d", undefined, "mobile_click_on_screen_at_coordinates", {});
    spawned[0]!.callTool = async () => ({ content: [{ type: "text", text: "nope" }], isError: true });
    const r = await gw.call("k", "d", undefined, "mobile_click_on_screen_at_coordinates", {});
    expect(r).toEqual({ content: [{ type: "text", text: "nope" }], isError: true });
    await gw.call("k", "d", undefined, "mobile_click_on_screen_at_coordinates", {});
    expect(spawned).toHaveLength(1);
    await gw.stopAll();
  });

  test("a child that crashes mid-call is dropped: the call returns an error and the next call respawns", async () => {
    const { gw, spawned } = setup();
    await gw.call("k", "d", undefined, "mobile_click_on_screen_at_coordinates", {});
    spawned[0]!.hang = Promise.withResolvers<ToolResult>();
    const inflight = gw.call("k", "d", undefined, "mobile_click_on_screen_at_coordinates", {});
    await Bun.sleep(5);
    spawned[0]!.crash();
    const failed = await inflight;
    expect(failed.isError).toBe(true);
    expect(text(failed)).toContain("mobile-mcp");
    const next = await gw.call("k", "d", undefined, "mobile_click_on_screen_at_coordinates", {});
    expect(next.isError).toBeUndefined();
    expect(spawned).toHaveLength(2);
    await gw.stopAll();
  });

  test("a child that died while idle is respawned by the next call without an error", async () => {
    const { gw, spawned } = setup();
    await gw.call("k", "d", undefined, "mobile_click_on_screen_at_coordinates", {});
    spawned[0]!.crash();
    await Bun.sleep(5);
    const r = await gw.call("k", "d", undefined, "mobile_click_on_screen_at_coordinates", {});
    expect(r.isError).toBeUndefined();
    expect(spawned).toHaveLength(2);
    await gw.stopAll();
  });

  test("a call that outlives the timeout returns an error and the hung child is closed so the next call starts clean", async () => {
    const { gw, spawned } = setup({ callTimeoutMs: 30 });
    await gw.call("k", "d", undefined, "mobile_click_on_screen_at_coordinates", {});
    spawned[0]!.hang = Promise.withResolvers<ToolResult>();
    const r = await gw.call("k", "d", undefined, "mobile_click_on_screen_at_coordinates", {});
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("timed out");
    expect(spawned[0]!.closed).toBe(1);
    await gw.call("k", "d", undefined, "mobile_click_on_screen_at_coordinates", {});
    expect(spawned).toHaveLength(2);
    await gw.stopAll();
  });

  test("a failing spawn is an error result, and the next call tries again", async () => {
    let attempts = 0;
    const gw = new Gateway({
      spawnClient: async (cwd) => {
        if (++attempts === 1) throw new Error("npx: command not found");
        return new FakeClient(cwd);
      },
    });
    const first = await gw.call("k", "d", undefined, "mobile_click_on_screen_at_coordinates", {});
    expect(first.isError).toBe(true);
    expect(text(first)).toContain("npx: command not found");
    expect((await gw.call("k", "d", undefined, "mobile_click_on_screen_at_coordinates", {})).isError).toBeUndefined();
    await gw.stopAll();
  });

  test("the child runs in the lease's directory when it is an existing absolute dir, else in the temp dir", async () => {
    const { gw, spawned } = setup();
    const dir = mkdtempSync(path.join(tmpdir(), "tpc-gw-cwd-"));
    try {
      await gw.call("a", "d", dir, "mobile_click_on_screen_at_coordinates", {});
      await gw.call("b", "d", "relative/dir", "mobile_click_on_screen_at_coordinates", {});
      await gw.call("c", "d", path.join(dir, "missing"), "mobile_click_on_screen_at_coordinates", {});
      await gw.call("d", "d", undefined, "mobile_click_on_screen_at_coordinates", {});
      expect(spawned.map((c) => c.cwd)).toEqual([dir, tmpdir(), tmpdir(), tmpdir()]);
    } finally {
      await gw.stopAll();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("tools the gateway drops and batches that run a dropped tool never reach the child", async () => {
    const { gw, spawned } = setup();
    const listed = await gw.call("k", "d", undefined, "mobile_list_available_devices", {});
    const sneaky = await gw.call("k", "d", undefined, "mobile_batch_commands", { steps: [{ name: "mobile_allocate_remote_device", arguments: {} }] });
    for (const r of [listed, sneaky]) expect(r.isError).toBe(true);
    expect(spawned.flatMap((c) => c.calls)).toEqual([]);
    await gw.stopAll();
  });
});

describe("Gateway.call and the lease lifetime", () => {
  test("a lease that ends while a call is in flight says so, and nothing about restarting", async () => {
    const { gw, spawned } = setup();
    await gw.call("k", "d", undefined, tap.name, {});
    spawned[0]!.hang = Promise.withResolvers<ToolResult>();
    const inflight = gw.call("k", "d", undefined, tap.name, {});
    await Bun.sleep(5);
    await gw.stop("k");
    const r = await inflight;
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("lease ended");
    expect(text(r)).not.toContain("next call");
  });

  test("a lease that ends while the child is still starting gets the same answer and the child is not used", async () => {
    const gate = Promise.withResolvers<void>();
    const made: FakeClient[] = [];
    const gw = new Gateway({
      spawnClient: async (cwd) => {
        await gate.promise;
        const c = new FakeClient(cwd);
        made.push(c);
        return c;
      },
    });
    const call = gw.call("k", "d", undefined, tap.name, {});
    await Bun.sleep(5);
    const stopping = gw.stop("k");
    gate.resolve();
    await stopping;
    const r = await call;
    expect(text(r)).toContain("lease ended");
    expect(made[0]!.calls).toHaveLength(0);
  });

  test("onChildUp runs after a slow start and before the call is sent", async () => {
    const gate = Promise.withResolvers<void>();
    const order: string[] = [];
    const gw = new Gateway({
      spawnClient: async (cwd) => {
        await gate.promise;
        order.push("up");
        const c = new FakeClient(cwd);
        c.callTool = async () => {
          order.push("call");
          return { content: [] };
        };
        return c;
      },
    });
    const call = gw.call("k", "d", undefined, tap.name, {}, () => order.push("touched"));
    await Bun.sleep(5);
    expect(order).toEqual([]);
    gate.resolve();
    await call;
    expect(order).toEqual(["up", "touched", "call"]);
    await gw.stopAll();
  });

  test("the call timeout covers starting the child: a child that never comes up times out, and is closed if it appears later", async () => {
    const gate = Promise.withResolvers<void>();
    const made: FakeClient[] = [];
    const gw = new Gateway({
      callTimeoutMs: 30,
      spawnClient: async (cwd) => {
        await gate.promise;
        const c = new FakeClient(cwd);
        made.push(c);
        return c;
      },
    });
    const r = await gw.call("k", "d", undefined, tap.name, {});
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("timed out");
    gate.resolve();
    await Bun.sleep(5);
    expect(made[0]!.closed).toBe(1);
    expect(made[0]!.calls).toHaveLength(0);
  });

  test("the root and the home directory are not accepted as a lease directory: the child gets the temp dir", async () => {
    const { gw, spawned } = setup();
    await gw.call("a", "d", "/", tap.name, {});
    await gw.call("b", "d", homedir(), tap.name, {});
    await gw.call("c", "d", `${homedir()}/`, tap.name, {});
    expect(spawned.map((c) => c.cwd)).toEqual([tmpdir(), tmpdir(), tmpdir()]);
    await gw.stopAll();
  });
});

describe("Gateway.stop", () => {
  test("closes only that key's child, is idempotent, and the key can be used again", async () => {
    const { gw, spawned } = setup();
    await gw.call("a", "d", undefined, "mobile_click_on_screen_at_coordinates", {});
    await gw.call("b", "d", undefined, "mobile_click_on_screen_at_coordinates", {});
    await gw.stop("a");
    await gw.stop("a");
    await gw.stop("never-started");
    expect(spawned.map((c) => c.closed)).toEqual([1, 0]);
    await gw.call("a", "d", undefined, "mobile_click_on_screen_at_coordinates", {});
    expect(spawned).toHaveLength(3);
    await gw.stopAll();
    expect(spawned.map((c) => c.closed)).toEqual([1, 1, 1]);
  });

  test("stopping a key whose child is still starting closes it once it is up", async () => {
    const gate = Promise.withResolvers<void>();
    const made: FakeClient[] = [];
    const gw = new Gateway({
      spawnClient: async (cwd) => {
        await gate.promise;
        const c = new FakeClient(cwd);
        made.push(c);
        return c;
      },
    });
    const call = gw.call("k", "d", undefined, "mobile_click_on_screen_at_coordinates", {});
    await Bun.sleep(5);
    const stopping = gw.stop("k");
    gate.resolve();
    await stopping;
    await call;
    expect(made[0]!.closed).toBe(1);
  });
});

describe("Gateway.stopAll", () => {
  test("a call that arrives while stopAll is closing the children spawns nothing and is an error", async () => {
    const slow = Promise.withResolvers<void>();
    const { gw, spawned } = setup();
    await gw.call("a", "d", undefined, tap.name, {});
    spawned[0]!.close = async () => {
      spawned[0]!.closed++;
      await slow.promise;
    };
    const stopping = gw.stopAll();
    const late = await gw.call("b", "d", undefined, tap.name, {});
    expect(late.isError).toBe(true);
    expect(text(late)).toContain("shutting down");
    expect(spawned).toHaveLength(1);
    slow.resolve();
    await stopping;
    expect((await gw.call("a", "d", undefined, tap.name, {})).isError).toBe(true);
    expect(spawned).toHaveLength(1);
  });

  test("a probe child that is hung or still starting when stopAll runs is closed right away, not after the probe timeout", async () => {
    class Hung extends FakeClient {
      override async listTools(): Promise<ToolDef[]> {
        return Promise.withResolvers<ToolDef[]>().promise;
      }
    }
    const gate = Promise.withResolvers<void>();
    const made: FakeClient[] = [];
    const gw = new Gateway({
      spawnClient: async (cwd) => {
        await gate.promise;
        const c = new Hung(cwd);
        made.push(c);
        return c;
      },
    });
    void gw.tools();
    await Bun.sleep(5);
    const stopping = gw.stopAll();
    gate.resolve();
    await stopping;
    expect(made).toHaveLength(1);
    expect(made[0]!.closed).toBeGreaterThan(0);
  });

  test("stopAll gives up on a probe child whose start never settles, so shutdown cannot hang", async () => {
    // The child's MCP handshake can stall (a wedged npx, a machine under load); shutdown must still finish promptly.
    const gw = new Gateway({ stopGraceMs: 50, spawnClient: () => Promise.withResolvers<GatewayClient>().promise });
    void gw.tools();
    await Bun.sleep(5);
    const started = Date.now();
    await gw.stopAll();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("stopAll gives up on a device child whose close never settles", async () => {
    class Stuck extends FakeClient {
      override async close(): Promise<void> {
        this.closed++;
        return Promise.withResolvers<void>().promise;
      }
    }
    const gw = new Gateway({ stopGraceMs: 50, cacheFile: null, spawnClient: async (cwd) => new Stuck(cwd) });
    await gw.call("lease-1", "emulator-5554", tmpdir(), "mobile_take_screenshot", {});
    const started = Date.now();
    await gw.stopAll();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("once stopAll ran, a gateway with no tool list answers an empty one without probing", async () => {
    const { gw, spawned } = setupCache(null);
    await gw.stopAll();
    expect(await gw.tools()).toEqual([]);
    expect(spawned).toHaveLength(0);
  });
});

// ---- Tool cache ---------------------------------------------------------------------------------------------------------

const scratch = mkdtempSync(path.join(tmpdir(), "tpc-gw-cache-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const cacheFile = () => path.join(mkdtempSync(path.join(scratch, "c-")), "gateway-tools.json");

function setupCache(file: string | null, over: Partial<GatewayDeps> = {}, clientTools: ToolDef[] = DEVICE_TOOLS, version: string | null = "1.0.9") {
  const spawned: FakeClient[] = [];
  const gw = new Gateway({
    cacheFile: file,
    spawnClient: async (cwd) => {
      const c = new FakeClient(cwd, version, clientTools);
      spawned.push(c);
      return c;
    },
    ...over,
  });
  return { gw, spawned };
}

describe("Gateway.tools", () => {
  test("a cold start probes one throwaway child in the temp dir, lists the tools minus the dropped ones and stops it", async () => {
    const file = cacheFile();
    const { gw, spawned } = setupCache(file);
    expect(gw.status()).toEqual({ tools: 0, mobileMcpVersion: null });
    const [a, b] = await Promise.all([gw.tools(), gw.tools()]);
    expect(a.map((t) => t.name)).toEqual([tap.name, batch.name]);
    expect(b).toEqual(a);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.cwd).toBe(tmpdir());
    expect(spawned[0]!.closed).toBe(1);
    // the raw child schema is kept: the caller decides whether to gate or pin it
    expect(a[0]!.inputSchema.properties).toHaveProperty("device");
    expect(gw.status()).toEqual({ tools: 2, mobileMcpVersion: "1.0.9" });
  });

  test("a later process reads the file and starts nothing", async () => {
    const file = cacheFile();
    await setupCache(file).gw.tools();
    const second = setupCache(file);
    expect(second.gw.status()).toEqual({ tools: 2, mobileMcpVersion: "1.0.9" });
    expect((await second.gw.tools()).map((t) => t.name)).toEqual([tap.name, batch.name]);
    expect(second.spawned).toHaveLength(0);
  });

  test("an unreadable or invalid cache file counts as a miss", async () => {
    const file = cacheFile();
    writeFileSync(file, JSON.stringify({ version: 1, mobileMcpVersion: 5, tools: "no" }));
    const { gw, spawned } = setupCache(file);
    expect(gw.status().tools).toBe(0);
    expect(await gw.tools()).toHaveLength(2);
    expect(spawned).toHaveLength(1);
  });

  test("a probe that does not answer in time gives an empty list, stops the child and is not cached", async () => {
    class Silent extends FakeClient {
      override async listTools(): Promise<ToolDef[]> {
        return Promise.withResolvers<ToolDef[]>().promise;
      }
    }
    const made: FakeClient[] = [];
    const gw = new Gateway({
      probeTimeoutMs: 30,
      probeRetryMs: 0,
      spawnClient: async (cwd) => {
        const c = made.length === 0 ? new Silent(cwd) : new FakeClient(cwd);
        made.push(c);
        return c;
      },
    });
    const started = Date.now();
    expect(await gw.tools()).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(made[0]!.closed).toBeGreaterThan(0);
    expect(await gw.tools()).toHaveLength(2);
    expect(made).toHaveLength(2);
  });

  test("a tool's title and annotations survive the probe, the cache file and a later process", async () => {
    const hinted: ToolDef = {
      ...tap,
      title: "Tap",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    };
    const file = cacheFile();
    await setupCache(file, {}, [hinted]).gw.tools();
    const [served] = await setupCache(file).gw.tools();
    expect(served).toMatchObject({ title: "Tap", annotations: hinted.annotations });
  });

  test("a failed probe is remembered: tools() answers an empty list at once until the retry window has passed", async () => {
    let attempts = 0;
    const gw = new Gateway({
      probeRetryMs: 60,
      spawnClient: async (cwd) => {
        if (++attempts === 1) throw new Error("no npx");
        return new FakeClient(cwd);
      },
    });
    expect(await gw.tools()).toEqual([]);
    expect(await gw.tools()).toEqual([]);
    expect(attempts).toBe(1);
    await Bun.sleep(80);
    expect(await gw.tools()).toHaveLength(2);
    expect(attempts).toBe(2);
  });

  test("a probe that times out is remembered the same way", async () => {
    let attempts = 0;
    const gw = new Gateway({
      probeTimeoutMs: 20,
      probeRetryMs: 10_000,
      spawnClient: async (cwd) => {
        attempts++;
        return new (class extends FakeClient {
          override async listTools(): Promise<ToolDef[]> {
            return Promise.withResolvers<ToolDef[]>().promise;
          }
        })(cwd);
      },
    });
    expect(await gw.tools()).toEqual([]);
    const started = Date.now();
    expect(await gw.tools()).toEqual([]);
    expect(Date.now() - started).toBeLessThan(15);
    expect(attempts).toBe(1);
  });

  test("a probe that fails to start gives an empty list instead of throwing", async () => {
    const gw = new Gateway({
      spawnClient: async () => {
        throw new Error("no npx");
      },
    });
    expect(await gw.tools()).toEqual([]);
  });

  test("probeError says why a failed or timed-out probe left no tools, and clears once tools are known", async () => {
    let attempts = 0;
    const gw = new Gateway({
      probeTimeoutMs: 20,
      probeRetryMs: 0,
      spawnClient: async (cwd) => {
        attempts++;
        if (attempts === 1) throw new Error("no npx");
        if (attempts === 2) {
          return new (class extends FakeClient {
            override async listTools(): Promise<ToolDef[]> {
              return Promise.withResolvers<ToolDef[]>().promise;
            }
          })(cwd);
        }
        return new FakeClient(cwd);
      },
    });
    expect(gw.probeError()).toBeNull();
    expect(await gw.tools()).toEqual([]);
    expect(gw.probeError()).toContain("no npx");
    expect(await gw.tools()).toEqual([]);
    expect(gw.probeError()).toContain("in time");
    expect(await gw.tools()).toHaveLength(2);
    expect(gw.probeError()).toBeNull();
  });

  test("a child started for a call with another mobile-mcp version replaces the cached tool list", async () => {
    const file = cacheFile();
    writeFileSync(file, JSON.stringify({ version: 1, mobileMcpVersion: "1.0.8", tools: [tap] }));
    const newer: ToolDef = { name: "mobile_shake", inputSchema: { type: "object", properties: { device: { type: "string" } }, required: ["device"] } };
    const { gw, spawned } = setupCache(file, {}, [tap, newer], "1.0.9");
    expect((await gw.tools()).map((t) => t.name)).toEqual([tap.name]);
    await gw.call("k", "d", undefined, tap.name, {});
    await gw.stopAll();
    expect(spawned).toHaveLength(1);
    expect((await gw.tools()).map((t) => t.name)).toEqual([tap.name, "mobile_shake"]);
    expect(gw.status()).toEqual({ tools: 2, mobileMcpVersion: "1.0.9" });
    const onDisk = JSON.parse(readFileSync(file, "utf8")) as { mobileMcpVersion: string; tools: ToolDef[] };
    expect(onDisk.mobileMcpVersion).toBe("1.0.9");
    expect(onDisk.tools.map((t) => t.name)).toEqual([tap.name, "mobile_shake"]);
  });

  test("a child with the cached version leaves the cache alone", async () => {
    const file = cacheFile();
    writeFileSync(file, JSON.stringify({ version: 1, mobileMcpVersion: "1.0.9", tools: [tap] }));
    const { gw } = setupCache(file, {}, [tap, batch], "1.0.9");
    await gw.call("k", "d", undefined, tap.name, {});
    await gw.stopAll();
    expect((await gw.tools()).map((t) => t.name)).toEqual([tap.name]);
  });

  test("a cache or child listing only ever serves mobile_* tools that are not dropped: a Tapocalypse name or a cloud tool is filtered, the rest is kept", async () => {
    const file = cacheFile();
    const cloud: ToolDef = { name: "mobile_allocate_remote_device", inputSchema: { type: "object", properties: {} } };
    const foreign: ToolDef = { name: "qa_doctor", inputSchema: { type: "object", properties: {} } };
    writeFileSync(file, JSON.stringify({ version: 1, mobileMcpVersion: "1.0.9", tools: [foreign, tap, cloud] }));
    const cached = setupCache(file);
    expect((await cached.gw.tools()).map((t) => t.name)).toEqual([tap.name]);
    expect(cached.gw.status().tools).toBe(1);
    expect(cached.spawned).toHaveLength(0);

    const probed = setupCache(cacheFile(), {}, [foreign, tap, cloud, batch]);
    expect((await probed.gw.tools()).map((t) => t.name)).toEqual([tap.name, batch.name]);
  });
});

describe("stopOnLeaseEnd", () => {
  test("a lease that is released, revoked or expires stops exactly its own child", async () => {
    const { gw, spawned } = setup();
    const store = new LeaseStore({ now: () => Date.parse("2026-01-01T12:00:00.000Z") });
    stopOnLeaseEnd(store.ends, gw);
    const keep = store.grantAgent({ serial: "emulator-5554", platform: "android", avdName: "A", holder: "a", ttlMinutes: 60 });
    const gone = store.grantAgent({ serial: "emulator-5556", platform: "android", avdName: "B", holder: "b", ttlMinutes: 60 });
    for (const lease of [keep, gone]) await gw.call(leaseKey(lease.leaseId), lease.mobileDeviceId, undefined, tap.name, { x: 1, y: 1 });
    expect(spawned).toHaveLength(2);

    store.release(gone.leaseId);
    await Bun.sleep(5);
    expect(spawned.map((c) => c.closed)).toEqual([0, 1]);
    store.revoke("emulator-5554", keep.ref);
    await Bun.sleep(5);
    expect(spawned.map((c) => c.closed)).toEqual([1, 1]);
  });
});

// ---- The real stdio client against a stand-in mobile-mcp --------------------------------------------------------------

describe("spawnMobileMcp (MOBILE_MCP_BIN stand-in)", () => {
  const FAKE = path.resolve(import.meta.dir, "support/fake-mobile-mcp.ts");
  const withFake = async (fn: () => Promise<void>) => {
    const before = process.env.MOBILE_MCP_BIN;
    process.env.MOBILE_MCP_BIN = `${process.execPath} ${FAKE}`;
    try {
      await fn();
    } finally {
      if (before === undefined) delete process.env.MOBILE_MCP_BIN;
      else process.env.MOBILE_MCP_BIN = before;
    }
  };

  test("a real child lists its tools with its version, runs a pinned call, and ends when stopped", async () => {
    await withFake(async () => {
      const file = cacheFile();
      const gw = new Gateway({ spawnClient: spawnMobileMcp, cacheFile: file });
      const tools = await gw.tools();
      expect(tools.map((t) => t.name)).toContain("mobile_take_screenshot");
      expect(tools.map((t) => t.name)).not.toContain("mobile_list_available_devices");
      expect(gw.status().mobileMcpVersion).toBe("9.9.9-fake");

      const shot = await gw.call("k", "Pixel_8", undefined, "mobile_take_screenshot", { leaseId: "s", device: "other" });
      expect(shot).toMatchObject({ content: [{ type: "text", text: "shot:Pixel_8" }] });
      const bad = await gw.call("k", "Pixel_8", undefined, "mobile_click_on_screen_at_coordinates", { x: "left" });
      expect(bad.isError).toBe(true);
      await gw.stop("k");
      const again = await gw.call("k", "Pixel_9", undefined, "mobile_take_screenshot", {});
      expect(text(again)).toBe("shot:Pixel_9");
      await gw.stopAll();
    });
  }, 30_000);

  test("a command that cannot start is an error result", async () => {
    const before = process.env.MOBILE_MCP_BIN;
    process.env.MOBILE_MCP_BIN = "/definitely/not/a/binary";
    try {
      const gw = new Gateway({ spawnClient: spawnMobileMcp });
      const r = await gw.call("k", "d", undefined, "mobile_take_screenshot", {});
      expect(r.isError).toBe(true);
    } finally {
      if (before === undefined) delete process.env.MOBILE_MCP_BIN;
      else process.env.MOBILE_MCP_BIN = before;
    }
  }, 30_000);
});

describe("mobile-mcp child launch", () => {
  const MOBILE_MCP_BIN = process.env.MOBILE_MCP_BIN;
  const withoutBin = <T>(fn: () => T): T => {
    delete process.env.MOBILE_MCP_BIN;
    try {
      return fn();
    } finally {
      if (MOBILE_MCP_BIN !== undefined) process.env.MOBILE_MCP_BIN = MOBILE_MCP_BIN;
    }
  };

  test("the npx spec pins an exact mobile-mcp version, never a moving tag", () => {
    expect(MOBILE_MCP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    const spec = withoutBin(() => mobileMcpSpawn("/work", { PATH: "/bin" }));
    expect(spec.command).toBe("npx");
    expect(spec.args).toEqual(["-y", `@mobilenext/mobile-mcp@${MOBILE_MCP_VERSION}`]);
    expect(spec.cwd).toBe("/work");
  });

  test("MOBILE_MCP_BIN still replaces the whole command", () => {
    process.env.MOBILE_MCP_BIN = "/opt/mcp/bin --flag";
    try {
      expect(mobileMcpSpawn("/work", { PATH: "/bin" })).toMatchObject({ command: "/opt/mcp/bin", args: ["--flag"] });
    } finally {
      if (MOBILE_MCP_BIN === undefined) delete process.env.MOBILE_MCP_BIN;
      else process.env.MOBILE_MCP_BIN = MOBILE_MCP_BIN;
    }
  });

  test("the child's environment has the hub token, proxy headers and S3 keys stripped, and keeps what adb/npx need", () => {
    const env = {
      PATH: "/bin",
      ANDROID_HOME: "/sdk",
      TAPOCALYPSE_HUB_TOKEN: "tpu_x",
      TAPOCALYPSE_HUB_HEADERS: "{}",
      S3_ACCESS_KEY_ID: "id",
      S3_SECRET_ACCESS_KEY: "secret",
      S3_SESSION_TOKEN: "tok",
      GONE: undefined,
    };
    expect(mobileMcpSpawn("/work", env).env).toEqual({ PATH: "/bin", ANDROID_HOME: "/sdk" });
  });

  test("a real child does not inherit the server's secrets", async () => {
    const FAKE = path.resolve(import.meta.dir, "support/fake-mobile-mcp.ts");
    const saved = { bin: process.env.MOBILE_MCP_BIN, token: process.env.TAPOCALYPSE_HUB_TOKEN, s3: process.env.S3_SECRET_ACCESS_KEY };
    process.env.MOBILE_MCP_BIN = `${process.execPath} ${FAKE} --dump-env`;
    process.env.TAPOCALYPSE_HUB_TOKEN = "tpu_secret";
    process.env.S3_SECRET_ACCESS_KEY = "s3-secret";
    try {
      const gw = new Gateway({ spawnClient: spawnMobileMcp });
      const dumped = await gw.call("k", "Pixel_8", undefined, "mobile_dump_env", {});
      const names: string[] = JSON.parse(text(dumped));
      expect(names).toContain("PATH");
      expect(names).not.toContain("TAPOCALYPSE_HUB_TOKEN");
      expect(names).not.toContain("S3_SECRET_ACCESS_KEY");
      await gw.stopAll();
    } finally {
      for (const [name, value] of [["MOBILE_MCP_BIN", saved.bin], ["TAPOCALYPSE_HUB_TOKEN", saved.token], ["S3_SECRET_ACCESS_KEY", saved.s3]] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }, 30_000);
});
