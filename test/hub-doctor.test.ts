import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildHubReport, type HubDoctorEnv } from "../src/doctor";
import type { HubMachine } from "../src/hub/status";

const NOW = Date.parse("2026-06-30T12:00:00Z");
const GB = 1024 ** 3;

function env(over: Partial<HubDoctorEnv> = {}): HubDoctorEnv {
  return {
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "hub-doctor-")),
    hosts: ["qa.example.com"],
    identityHeader: null,
    retention: { days: 365 },
    runCount: () => 120,
    activeTokens: () => 2,
    machines: () => [],
    freeBytes: () => 50 * GB,
    now: () => NOW,
    ...over,
  };
}

const machine = (over: Partial<HubMachine>): HubMachine => ({ name: "m", uploader: null, lastUploadAt: null, runs30d: 0, clockSkewMs: null, revoked: false, ...over });
const byId = async (e: HubDoctorEnv) => Object.fromEntries((await buildHubReport(e)).checks.map((c) => [c.id, c]));

describe("hub doctor", () => {
  test("a healthy hub passes every check", async () => {
    const checks = (await buildHubReport(env())).checks;
    expect(checks.filter((c) => c.status === "error" || c.status === "warn")).toEqual([]);
    expect(checks.map((c) => c.id)).toEqual(expect.arrayContaining(["data-dir", "disk", "store", "tokens", "hosts", "uploads"]));
  });

  test("an unwritable data dir is a blocking error", async () => {
    const checks = await byId(env({ dataDir: path.join(os.tmpdir(), `hub-doctor-missing-${Date.now()}`, "nested") }));
    expect(checks["data-dir"]).toMatchObject({ status: "error", required: true });
  });

  test("low disk warns, very low disk blocks, an unknown size is skipped", async () => {
    expect((await byId(env({ freeBytes: () => 500 * 1024 ** 2 }))).disk?.status).toBe("warn");
    expect((await byId(env({ freeBytes: () => 20 * 1024 ** 2 }))).disk).toMatchObject({ status: "error", required: true });
    expect((await byId(env({ freeBytes: () => null }))).disk?.status).toBe("skip");
  });

  test("the store tripwire warns from 8,000 runs and says what to do", async () => {
    expect((await byId(env({ runCount: () => 7999 }))).store?.status).toBe("ok");
    const warned = (await byId(env({ runCount: () => 8000 }))).store;
    expect(warned?.status).toBe("warn");
    expect(warned?.fix).toMatch(/retention|SQLite/i);
  });

  test("no active token and no configured host are warnings with a fix", async () => {
    const checks = await byId(env({ activeTokens: () => 0, hosts: [] }));
    expect(checks.tokens).toMatchObject({ status: "warn" });
    expect(checks.tokens?.fix).toContain("hub token create");
    expect(checks.hosts).toMatchObject({ status: "warn" });
    expect(checks.hosts?.fix).toContain("TAPOCALYPSE_HUB_HOSTS");
  });

  test("the last upload of every machine is listed, and a skewed clock is a warning", async () => {
    const machines = [
      machine({ name: "ann-mbp", lastUploadAt: new Date(NOW - 2 * 3600_000).toISOString() }),
      machine({ name: "bob-mini", lastUploadAt: new Date(NOW - 3 * 86_400_000).toISOString(), clockSkewMs: 3_600_000 }),
      machine({ name: "new-box" }),
    ];
    const uploads = (await byId(env({ machines: () => machines }))).uploads!;
    expect(uploads.status).toBe("warn");
    expect(uploads.detail).toContain("ann-mbp 2h ago");
    expect(uploads.detail).toContain("bob-mini 3d ago");
    expect(uploads.detail).toContain("new-box never");
    expect(uploads.detail).toContain("bob-mini");
    expect(uploads.fix).toMatch(/clock/i);
  });
});
