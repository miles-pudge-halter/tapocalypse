import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

test("the index built from the store lists runs in the same order as incremental inserts, ties included", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tpc-index-"));
  try {
    const child = Bun.spawn(["bun", path.join(import.meta.dir, "support/regression-build-order.ts")], {
      env: { ...process.env, TAPOCALYPSE_CONFIG: path.join(dir, "c.json"), TAPOCALYPSE_DATA_DIR: path.join(dir, "data") },
      stdout: "pipe", stderr: "pipe",
    });
    const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(await child.exited, err).toBe(0);
    const { built, incremental } = JSON.parse(out.trim().split("\n").at(-1) ?? "") as { built: { tests: string[]; checks: string[] }; incremental: typeof built };
    expect(built.tests).toHaveLength(8);
    expect(built).toEqual(incremental);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
