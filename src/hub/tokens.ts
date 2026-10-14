import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { HttpError } from "../config";
import { readJsonCached, writeJsonAtomic } from "./files";
import { hubDir } from "./mode";

const TokenRecord = z.object({
  name: z.string(),
  /** SHA-256 hex of the token: the tokens carry 256 bits of entropy, so a plain digest needs no KDF. */
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable().default(null),
  revokedAt: z.string().nullable().default(null),
  admin: z.boolean().default(false),
});
type TokenRecord = z.infer<typeof TokenRecord>;

export type TokenInfo = Omit<TokenRecord, "digest">;

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TOKEN_RE = /^tpu_[A-Za-z0-9_-]{43}$/;
/** `lastUsedAt` is persisted at most this often, so a busy uploader does not rewrite the file on every request. */
const LAST_USED_WRITE_MS = 60_000;

const tokensFile = () => path.join(hubDir(), "tokens.json");
/**
 * Last use per token digest. Kept apart from `tokens.json` because the hub writes it while the admin CLI edits the token list:
 * a read-modify-write of one file by both could undo a revocation.
 */
const usageFile = () => path.join(hubDir(), "token-usage.json");
const usage = (): Record<string, string> => readJsonCached(usageFile(), z.record(z.string(), z.string()), {});

function load(): TokenRecord[] {
  return readJsonCached(tokensFile(), z.array(TokenRecord), []);
}

function save(records: TokenRecord[]): void {
  writeJsonAtomic(tokensFile(), records);
}

const digestOf = (token: string): string => createHash("sha256").update(token).digest("hex");

/** Creates an upload token. The plaintext is returned once and never stored. */
export function createToken(name: string, opts: { admin?: boolean } = {}): { token: string; info: TokenInfo } {
  if (!NAME_RE.test(name)) throw new HttpError(400, "token name must be 1-64 characters: letters, digits, dot, dash or underscore");
  const records = [...load()];
  if (records.some((r) => r.name === name && r.revokedAt === null)) throw new HttpError(409, `a token named ${name} already exists`);
  const token = `tpu_${randomBytes(32).toString("base64url")}`;
  const record: TokenRecord = { name, digest: digestOf(token), createdAt: new Date().toISOString(), lastUsedAt: null, revokedAt: null, admin: opts.admin === true };
  records.push(record);
  save(records);
  const { digest: _digest, ...info } = record;
  return { token, info };
}

/** The active token's record, or null. Every record is compared (no early exit) with `timingSafeEqual`. */
export function verifyToken(token: string): TokenInfo | null {
  if (!TOKEN_RE.test(token)) return null;
  const wanted = Buffer.from(digestOf(token), "hex");
  let found: TokenRecord | null = null;
  for (const record of load()) {
    if (timingSafeEqual(wanted, Buffer.from(record.digest, "hex")) && record.revokedAt === null) found = record;
  }
  if (!found) return null;
  const now = Date.now();
  const seen = usage()[found.digest];
  let lastUsedAt = seen ?? found.lastUsedAt;
  if (lastUsedAt === null || now - Date.parse(lastUsedAt) >= LAST_USED_WRITE_MS) {
    lastUsedAt = new Date(now).toISOString();
    writeJsonAtomic(usageFile(), { ...usage(), [found.digest]: lastUsedAt });
  }
  found = { ...found, lastUsedAt };
  const { digest: _digest, ...info } = found;
  return info;
}

export function listTokens(): TokenInfo[] {
  const used = usage();
  return load().map(({ digest, ...info }) => ({ ...info, lastUsedAt: used[digest] ?? info.lastUsedAt }));
}

/** Revokes the active token with this name; false when there is none. */
export function revokeToken(name: string): boolean {
  const records = load();
  if (!records.some((r) => r.name === name && r.revokedAt === null)) return false;
  save(records.map((r) => (r.name === name && r.revokedAt === null ? { ...r, revokedAt: new Date().toISOString() } : r)));
  return true;
}

/** Deletes a token record outright (the admin CLI's short-lived helper tokens must not linger in the machine list). */
export function removeToken(name: string): void {
  const records = load();
  if (records.some((r) => r.name === name)) save(records.filter((r) => r.name !== name));
}
