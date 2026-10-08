import { describe, expect, test } from "bun:test";
import { HttpError } from "../src/config";
import { isBootingTarget, manualBootCount, bootTarget } from "../src/devices/pool";

// The config in test/preload.ts allows AVD_A and AVD_B with maxBooted 1; the emulator and adb binaries do not exist,
// so a started boot fails fast after its reservation was taken.
describe("manual boot reservation", () => {
  test("is taken synchronously: a second request in the same tick sees the first", async () => {
    const first = bootTarget("android", "AVD_A");
    expect(isBootingTarget("AVD_A")).toBe(true);
    expect(manualBootCount("android")).toBe(1);

    const same = bootTarget("android", "AVD_A");
    const other = bootTarget("android", "AVD_B");
    const [a, b] = await Promise.allSettled([same, other]);
    expect(a.status === "rejected" && a.reason).toBeInstanceOf(HttpError);
    expect(a.status === "rejected" && (a.reason as HttpError).message).toMatch(/already booting/);
    // maxBooted is 1 and the first boot already holds the slot.
    expect(b.status === "rejected" && (b.reason as HttpError).message).toMatch(/emulator limit reached/);

    await first.catch(() => {});
    expect(isBootingTarget("AVD_A")).toBe(false);
    expect(manualBootCount("android")).toBe(0);
  });

  test("a target that is not configured is rejected", async () => {
    await expect(bootTarget("android", "Nope")).rejects.toMatchObject({ status: 400 });
  });
});
