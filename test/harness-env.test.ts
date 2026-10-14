import { describe, expect, test } from "bun:test";
import { harnessEnv } from "../src/harness/env";

describe("harnessEnv", () => {
  test("keeps the environment an agent needs and drops every TAPOCALYPSE_HUB_* variable (the upload token, proxy headers, hub settings)", () => {
    const env = harnessEnv({
      PATH: "/usr/bin",
      ANDROID_HOME: "/sdk",
      TAPOCALYPSE_PORT: "4310",
      TAPOCALYPSE_HUB_TOKEN: "tpu_secret",
      TAPOCALYPSE_HUB_HEADERS: '{"X":"y"}',
      TAPOCALYPSE_HUB_HOSTS: "qa.example.com",
      MISSING: undefined,
    });
    expect(env).toEqual({ PATH: "/usr/bin", ANDROID_HOME: "/sdk", TAPOCALYPSE_PORT: "4310" });
  });

  test("the input is not modified", () => {
    const input = { TAPOCALYPSE_HUB_TOKEN: "t", PATH: "/bin" };
    harnessEnv(input);
    expect(input).toEqual({ TAPOCALYPSE_HUB_TOKEN: "t", PATH: "/bin" });
  });
});
