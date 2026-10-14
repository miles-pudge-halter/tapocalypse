import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { z } from "zod";
import { HttpError } from "../config";

/** Atomic (tmp + rename) JSON write; the file is owner-only because the hub's tokens and registry live in it. */
export function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  cached.delete(file);
}

/**
 * Parses a JSON file once with zod. A missing file reads as `fallback` (the writer creates it). A file that exists but does not
 * parse or has the wrong shape is never read as empty: the next write would erase every token or project in it. A copy is kept as
 * `<file>.corrupt` and the call fails (500) until someone repairs or removes the file.
 */
export function readJsonFile<T extends z.ZodType>(file: string, schema: T, fallback: z.infer<T>): z.infer<T> {
  if (!existsSync(file)) return fallback;
  try {
    const parsed = schema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (parsed.success) return parsed.data;
  } catch {
    // unparseable: handled below
  }
  const copy = `${file}.corrupt`;
  if (!existsSync(copy)) copyFileSync(file, copy);
  throw new HttpError(500, `${path.basename(file)} is corrupt; a copy is in ${path.basename(copy)}. Repair or remove it.`, "hub_state_corrupt");
}

const cached = new Map<string, { stamp: string; value: unknown }>();

/**
 * `readJsonFile` that re-reads only when the file changed. The admin CLI is another process editing the same files, so the
 * cache is keyed by the file's identity (mtime, size, inode) instead of being trusted blindly.
 */
export function readJsonCached<T extends z.ZodType>(file: string, schema: T, fallback: z.infer<T>): z.infer<T> {
  let stamp = "missing";
  try {
    const st = statSync(file);
    stamp = `${st.mtimeMs}:${st.size}:${st.ino}`;
  } catch {
    // no file yet
  }
  const hit = cached.get(file);
  if (hit?.stamp === stamp) return hit.value as z.infer<T>;
  const value = readJsonFile(file, schema, fallback);
  cached.set(file, { stamp, value });
  return value;
}
