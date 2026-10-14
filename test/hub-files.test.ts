import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { readJsonCached, readJsonFile, writeJsonAtomic } from "../src/hub/files";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tpc-hub-files-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const Entries = z.array(z.object({ id: z.string() }));

describe("hub state files", () => {
  test("a missing file reads as the fallback", () => {
    expect(readJsonFile(path.join(dir, "none.json"), Entries, [])).toEqual([]);
  });

  test("a file that no longer parses is refused, not read as empty: the writer would otherwise erase the registry", () => {
    const file = path.join(dir, "registry.json");
    writeJsonAtomic(file, [{ id: "app" }]);
    fs.writeFileSync(file, '[{"id":"app"');
    expect(() => readJsonCached(file, Entries, [])).toThrow(/corrupt/);
    expect(fs.readFileSync(file, "utf8")).toBe('[{"id":"app"');
    expect(fs.readFileSync(`${file}.corrupt`, "utf8")).toBe('[{"id":"app"');
    expect(() => readJsonCached(file, Entries, [])).toThrow(/corrupt/);
  });

  test("a file of the wrong shape is refused the same way", () => {
    const file = path.join(dir, "shape.json");
    fs.writeFileSync(file, JSON.stringify({ id: "not-an-array" }));
    expect(() => readJsonFile(file, Entries, [])).toThrow(/corrupt/);
  });
});
