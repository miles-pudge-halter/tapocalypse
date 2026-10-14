import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readHubConfig, removeHubCredentials, resolveHubCredentials, writeHubConfig, writeHubCredentials } from "../src/hub/credentials";

const dirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tpc-hubcred-"));
  dirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

describe("hub credentials file", () => {
  test("a missing file and no environment is not an error but 'no token'", () => {
    const res = resolveHubCredentials({ env: {}, configDir: tmp() });
    expect(res).toMatchObject({ ok: false, code: "missing" });
  });

  test("written files are mode 600 and read back", () => {
    const dir = tmp();
    const file = writeHubCredentials({ token: "tpu_abcdef123456", headers: { "X-Proxy-Key": "k1" } }, { configDir: dir });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const res = resolveHubCredentials({ env: {}, configDir: dir });
    expect(res).toMatchObject({ ok: true, token: "tpu_abcdef123456", tokenSource: "file", tokenHint: "3456", headers: { "X-Proxy-Key": "k1" }, headersSource: "file" });
  });

  test("a file readable by group or others is refused and never parsed", () => {
    const dir = tmp();
    const file = path.join(dir, "hub-credentials.json");
    fs.writeFileSync(file, JSON.stringify({ token: "tpu_secretsecret" }), { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    const res = resolveHubCredentials({ env: {}, configDir: dir });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("insecure");
    expect(res.problem).toContain("chmod 600");
    expect(res.problem).not.toContain("tpu_secretsecret");
  });

  test("a malformed file reports the expected shape without echoing its content", () => {
    const dir = tmp();
    const file = path.join(dir, "hub-credentials.json");
    fs.writeFileSync(file, JSON.stringify({ token: 42, extra: "tpu_leakme" }), { mode: 0o600 });
    const res = resolveHubCredentials({ env: {}, configDir: dir });
    expect(res).toMatchObject({ ok: false, code: "invalid" });
    if (!res.ok) expect(res.problem).not.toContain("tpu_leakme");
  });

  test("environment overrides the file: token and headers", () => {
    const dir = tmp();
    writeHubCredentials({ token: "tpu_fromfile0000", headers: { "X-A": "file", "X-B": "file" } }, { configDir: dir });
    const res = resolveHubCredentials({ env: { TAPOCALYPSE_HUB_TOKEN: "tpu_fromenv9999", TAPOCALYPSE_HUB_HEADERS: JSON.stringify({ "X-A": "env" }) }, configDir: dir });
    expect(res).toMatchObject({ ok: true, token: "tpu_fromenv9999", tokenSource: "env", headers: { "X-A": "env" }, headersSource: "env" });
  });

  test("environment token works with no file at all", () => {
    const res = resolveHubCredentials({ env: { TAPOCALYPSE_HUB_TOKEN: "tpu_envonly0001" }, configDir: tmp() });
    expect(res).toMatchObject({ ok: true, token: "tpu_envonly0001", tokenSource: "env", headers: {}, headersSource: null });
  });

  test("an insecure file does not block a token from the environment", () => {
    const dir = tmp();
    const file = path.join(dir, "hub-credentials.json");
    fs.writeFileSync(file, JSON.stringify({ token: "tpu_fromfile0000" }));
    fs.chmodSync(file, 0o644);
    const res = resolveHubCredentials({ env: { TAPOCALYPSE_HUB_TOKEN: "tpu_fromenv9999" }, configDir: dir });
    expect(res).toMatchObject({ ok: true, tokenSource: "env" });
  });

  test("configured headers from config are the lowest layer", () => {
    const dir = tmp();
    writeHubCredentials({ token: "tpu_fromfile0000", headers: { "X-A": "file" } }, { configDir: dir });
    const res = resolveHubCredentials({ env: {}, configDir: dir, configHeaders: { "X-A": "config", "X-C": "config" } });
    expect(res).toMatchObject({ ok: true, headers: { "X-A": "file", "X-C": "config" } });
  });

  test("removeHubCredentials deletes the file", () => {
    const dir = tmp();
    const file = writeHubCredentials({ token: "tpu_fromfile0000" }, { configDir: dir });
    removeHubCredentials({ configDir: dir });
    expect(fs.existsSync(file)).toBe(false);
    removeHubCredentials({ configDir: dir });
  });
});

describe("hub connection in the config file", () => {
  test("writeHubConfig keeps unrelated keys and share.s3; removing hub drops an empty share", () => {
    const dir = tmp();
    const file = path.join(dir, "c.json");
    fs.writeFileSync(file, JSON.stringify({ port: 1, projects: [] }));
    writeHubConfig(file, { url: "https://hub.example.com", screenshots: "original" });
    expect(readHubConfig(file)).toEqual({ url: "https://hub.example.com", screenshots: "original" });
    expect(JSON.parse(fs.readFileSync(file, "utf8")).port).toBe(1);
    writeHubConfig(file, null);
    expect(readHubConfig(file)).toBeNull();
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ port: 1, projects: [] });
  });

  test("an s3 block survives hub changes", () => {
    const dir = tmp();
    const file = path.join(dir, "c.json");
    fs.writeFileSync(file, JSON.stringify({ share: { s3: { bucket: "b" } } }));
    writeHubConfig(file, { url: "https://hub.example.com" });
    writeHubConfig(file, null);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ share: { s3: { bucket: "b" } } });
  });
});
