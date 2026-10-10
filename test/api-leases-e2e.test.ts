import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The real scheduler decides grants, and the in-process one is stopped by other test files, so this file runs a second
// instance (own port, config, data dir and a fake adb with one emulator) and talks to it over HTTP like an agent would.
const SERIAL = "emulator-5591";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "tapocalypse-leases-e2e-"));
let server: Bun.Subprocess | null = null;
let base = "";

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = probe.port!;
  await probe.stop(true);
  return port;
}

beforeAll(async () => {
  const adb = path.join(root, "adb");
  fs.writeFileSync(
    adb,
    [
      "#!/bin/sh",
      'case "$*" in',
      `  "devices -l") printf 'List of devices attached\\n${SERIAL} device product:sdk model:sdk_test transport_id:1\\n\\n';;`,
      '  *"emu avd name"*) printf "E2E_AVD\\nOK\\n";;',
      '  *"wm size"*) printf "Physical size: 1080x2400\\n";;',
      '  *getprop*) printf "14\\nemulator,nosdcard\\n\\n";;',
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = Bun.spawn(["bun", path.join(import.meta.dir, "..", "src", "server.ts")], {
    env: {
      ...process.env,
      NODE_ENV: "production",
      TAPOCALYPSE_PORT: String(port),
      TAPOCALYPSE_CONFIG: path.join(root, "config.json"),
      TAPOCALYPSE_DATA_DIR: path.join(root, "data"),
      ADB_BIN: adb,
      XCRUN_BIN: path.join(root, "no-xcrun"),
      EMULATOR_BIN: path.join(root, "no-emulator"),
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    if ((await fetch(`${base}/api/leases`).catch(() => null))?.ok) return;
    await Bun.sleep(100);
  }
  throw new Error("lease test server did not start");
});

afterAll(async () => {
  server?.kill("SIGTERM");
  await server?.exited;
  fs.rmSync(root, { recursive: true, force: true });
});

const post = (pathname: string, body: unknown, signal?: AbortSignal) =>
  fetch(`${base}${pathname}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });

async function rpc(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ isError: boolean; text: string }> {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    signal,
  });
  const text = await res.text();
  const raw = text.startsWith("event:") ? text.split("\n").find((l) => l.startsWith("data: "))!.slice("data: ".length) : text;
  const result = (JSON.parse(raw) as { result: { isError?: boolean; content: { text: string }[] } }).result;
  return { isError: result.isError === true, text: result.content[0]!.text };
}

interface Grant {
  serial: string;
  platform: string;
  name: string;
  mobileDeviceId: string;
  leaseId: string;
  expiresAt: string;
  ttlMinutes: number;
}
interface Waiting {
  timedOut: true;
  ticket: string;
  position: number;
  state: string;
  heldBy: { kind: string; holder: string } | null;
}

describe("device leases against a running scheduler", () => {
  // Tests share one device and run in any order: start each one with nothing held (a previous test's lease or claim window).
  beforeEach(async () => {
    const held = (await (await fetch(`${base}/api/leases`)).json()) as { serial: string; ref: string }[];
    for (const l of held) await post(`/api/devices/${l.serial}/release`, { ref: l.ref });
    for (let i = 0; i < 20; i++) {
      const left = (await (await fetch(`${base}/api/leases`)).json()) as unknown[];
      if (left.length === 0) return;
      await Bun.sleep(50);
    }
  });

  test("acquire grants the device and the list shows it without the secret; a busy device answers timedOut with its holder", async () => {
    const res = await post("/api/leases", { serial: SERIAL, holder: "first agent", reason: "e2e", ttlMinutes: 20 });
    expect(res.status).toBe(200);
    const lease = (await res.json()) as Grant;
    expect(lease).toMatchObject({ serial: SERIAL, platform: "android", mobileDeviceId: "E2E_AVD", ttlMinutes: 20 });

    const listed = await (await fetch(`${base}/api/leases`)).text();
    expect(listed).not.toContain(lease.leaseId);
    expect(JSON.parse(listed)).toMatchObject([{ serial: SERIAL, holder: "first agent", reason: "e2e" }]);

    const busy = (await (await post("/api/leases", { serial: SERIAL, holder: "second agent" })).json()) as Waiting;
    expect(busy).toMatchObject({ timedOut: true, state: "waiting", heldBy: { kind: "agent", holder: "first agent" } });

    // The ticket keeps the second agent's place: once the holder releases, resuming with it gets the device.
    expect(await (await post("/api/leases/release", { leaseId: lease.leaseId })).json()).toEqual({ released: true, serial: SERIAL });
    const served = (await (await post("/api/leases", { serial: SERIAL, holder: "second agent", ticket: busy.ticket })).json()) as Grant;
    expect(served).toMatchObject({ serial: SERIAL });
    expect(served.leaseId).not.toBe(lease.leaseId);
    await post("/api/leases/release", { leaseId: served.leaseId });
  });

  test("a waiting call is served the moment the holder releases, and keeps its place by ticket", async () => {
    const first = (await (await post("/api/leases", { serial: SERIAL, holder: "first agent" })).json()) as Grant;
    const waiter = post("/api/leases", { serial: SERIAL, holder: "second agent", waitSeconds: 20 });
    await Bun.sleep(300);
    await post("/api/leases/release", { leaseId: first.leaseId });
    const second = (await (await waiter).json()) as Grant;
    expect(second).toMatchObject({ serial: SERIAL });
    expect(second.leaseId).not.toBe(first.leaseId);

    // The first lease is spent: renewing it is a 404, the second one renews.
    expect((await post("/api/leases/renew", { leaseId: first.leaseId })).status).toBe(404);
    expect((await post("/api/leases/renew", { leaseId: second.leaseId })).status).toBe(200);
    await post("/api/leases/release", { leaseId: second.leaseId });
  });

  test("a caller that gave up before the grant does not leave the device leased to nobody", async () => {
    const first = (await (await post("/api/leases", { serial: SERIAL, holder: "first agent" })).json()) as Grant;
    const abort = new AbortController();
    const waiter = post("/api/leases", { serial: SERIAL, holder: "impatient agent", waitSeconds: 60 }, abort.signal).catch(() => null);
    await Bun.sleep(300);
    abort.abort();
    await waiter;
    await Bun.sleep(200);
    await post("/api/leases/release", { leaseId: first.leaseId });
    await Bun.sleep(300);
    // The grant waits in a 60 s claim window (a claim-pending lease), not as a full lease with a 30 minute TTL.
    const views = (await (await fetch(`${base}/api/leases`)).json()) as { holder: string; claimPending: boolean }[];
    expect(views.find((v) => v.holder === "impatient agent")?.claimPending).toBe(true);
  });

  test("a caller that gave up before the grant over MCP does not leave the device leased to nobody either", async () => {
    const first = (await (await post("/api/leases", { serial: SERIAL, holder: "first agent" })).json()) as Grant;
    const abort = new AbortController();
    const waiter = rpc("device_acquire", { serial: SERIAL, holder: "impatient mcp agent", waitSeconds: 60 }, abort.signal).catch(() => null);
    await Bun.sleep(300);
    abort.abort();
    await waiter;
    await Bun.sleep(200);
    await post("/api/leases/release", { leaseId: first.leaseId });
    await Bun.sleep(300);
    const views = (await (await fetch(`${base}/api/leases`)).json()) as { holder: string; claimPending: boolean }[];
    expect(views.find((v) => v.holder === "impatient mcp agent")?.claimPending).toBe(true);
  });

  test("the MCP tools run the same lifecycle", async () => {
    const acquired = await rpc("device_acquire", { platform: "android", holder: "mcp agent" });
    expect(acquired.isError).toBe(false);
    const lease = JSON.parse(acquired.text) as Grant;
    expect(lease).toMatchObject({ serial: SERIAL, mobileDeviceId: "E2E_AVD" });

    const listed = await rpc("qa_list_devices", {});
    expect(listed.text).not.toContain(lease.leaseId);
    expect((JSON.parse(listed.text) as { serial: string; lease: { holder: string } | null }[]).find((d) => d.serial === SERIAL)?.lease?.holder).toBe("mcp agent");

    expect(JSON.parse((await rpc("device_release", { leaseId: lease.leaseId })).text)).toEqual({ released: true, serial: SERIAL });
    const spent = await rpc("device_renew", { leaseId: lease.leaseId });
    expect(spent.isError).toBe(true);
    expect(spent.text).toStartWith("lease_not_found: ");
  });
});
