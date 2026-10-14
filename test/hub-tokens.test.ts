import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { hubDir, setHubMode } from "../src/hub/mode";
import { createToken, listTokens, revokeToken, verifyToken } from "../src/hub/tokens";

const tag = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const tokensFile = () => path.join(hubDir(), "tokens.json");

afterAll(() => {
  // Leave the shared data dir tidy: drop only the records this file created.
  const records = JSON.parse(fs.readFileSync(tokensFile(), "utf8")) as { name: string }[];
  fs.writeFileSync(tokensFile(), JSON.stringify(records.filter((r) => !r.name.startsWith(tag))));
  setHubMode(null);
});

describe("upload tokens", () => {
  test("a created token verifies to its machine name and is never stored in clear", () => {
    const { token } = createToken(`${tag}-alice`);
    expect(token).toMatch(/^tpu_[A-Za-z0-9_-]{43}$/);
    // Read before verifying: a verify rewrites the file and would hide a plaintext copy written at creation.
    expect(fs.readFileSync(tokensFile(), "utf8")).not.toContain(token);
    expect(verifyToken(token)).toMatchObject({ name: `${tag}-alice`, admin: false });
    expect(fs.readFileSync(tokensFile(), "utf8")).not.toContain(token);
  });

  test("the tokens file is owner-only", () => {
    createToken(`${tag}-perm`);
    expect(fs.statSync(tokensFile()).mode & 0o777).toBe(0o600);
  });

  test("unknown, malformed and revoked tokens are refused", () => {
    const { token } = createToken(`${tag}-bob`);
    expect(verifyToken(`${token}x`)).toBeNull();
    expect(verifyToken("")).toBeNull();
    expect(verifyToken("tpu_short")).toBeNull();
    expect(revokeToken(`${tag}-bob`)).toBe(true);
    expect(verifyToken(token)).toBeNull();
    expect(revokeToken(`${tag}-bob`)).toBe(false);
  });

  test("admin tokens are flagged and listings never expose the digest", () => {
    const { token } = createToken(`${tag}-root`, { admin: true });
    expect(verifyToken(token)?.admin).toBe(true);
    const listed = listTokens().find((t) => t.name === `${tag}-root`);
    expect(listed).toMatchObject({ admin: true, revokedAt: null });
    expect(JSON.stringify(listed)).not.toContain("digest");
  });

  test("an active name cannot be reused, a revoked one can", () => {
    createToken(`${tag}-dup`);
    expect(() => createToken(`${tag}-dup`)).toThrow(/already exists/);
    revokeToken(`${tag}-dup`);
    expect(() => createToken(`${tag}-dup`)).not.toThrow();
  });

  test("a token created by another process (CLI) is picked up without a restart", () => {
    const { token } = createToken(`${tag}-seed`);
    expect(verifyToken(token)).not.toBeNull();
    const records = JSON.parse(fs.readFileSync(tokensFile(), "utf8")) as { name: string; revokedAt: string | null }[];
    for (const r of records) if (r.name === `${tag}-seed`) r.revokedAt = new Date().toISOString();
    fs.writeFileSync(tokensFile(), JSON.stringify(records));
    expect(verifyToken(token)).toBeNull();
  });

  test("names are restricted to a safe alphabet", () => {
    expect(() => createToken("bad name")).toThrow();
    expect(() => createToken("")).toThrow();
  });

  test("verifying records the last use", () => {
    const { token } = createToken(`${tag}-used`);
    expect(listTokens().find((t) => t.name === `${tag}-used`)?.lastUsedAt).toBeNull();
    verifyToken(token);
    expect(listTokens().find((t) => t.name === `${tag}-used`)?.lastUsedAt).not.toBeNull();
  });
});

describe("token usage", () => {
  test("recording a use never rewrites tokens.json, so a concurrent revocation cannot be undone by the hub", () => {
    const { token } = createToken(`${tag}-keep`);
    const before = fs.readFileSync(tokensFile(), "utf8");
    expect(verifyToken(token)).not.toBeNull();
    expect(fs.readFileSync(tokensFile(), "utf8")).toBe(before);
    expect(listTokens().find((t) => t.name === `${tag}-keep`)?.lastUsedAt).not.toBeNull();
    revokeToken(`${tag}-keep`);
    expect(verifyToken(token)).toBeNull();
    expect(listTokens().find((t) => t.name === `${tag}-keep`)?.revokedAt).not.toBeNull();
  });
});
