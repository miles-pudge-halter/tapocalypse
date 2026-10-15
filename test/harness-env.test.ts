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

  test("S3_* credentials are always dropped: the share upload reads them, an agent never needs them", () => {
    const s3 = { S3_ACCESS_KEY_ID: "id", S3_SECRET_ACCESS_KEY: "secret", S3_SESSION_TOKEN: "tok" };
    for (const s3Configured of [true, false]) {
      expect(harnessEnv({ PATH: "/bin", ...s3 }, { s3Configured })).toEqual({ PATH: "/bin" });
    }
  });

  test("AWS credentials are dropped when share.s3 is configured (Bun's S3 client reads them), and kept otherwise (an app under test may need them)", () => {
    const aws = { AWS_ACCESS_KEY_ID: "id", AWS_SECRET_ACCESS_KEY: "secret", AWS_SESSION_TOKEN: "tok", AWS_REGION: "eu-west-1", AWS_PROFILE: "dev" };
    expect(harnessEnv({ PATH: "/bin", ...aws }, { s3Configured: true })).toEqual({ PATH: "/bin", AWS_REGION: "eu-west-1", AWS_PROFILE: "dev" });
    expect(harnessEnv({ PATH: "/bin", ...aws }, { s3Configured: false })).toEqual({ PATH: "/bin", ...aws });
  });

  test("without options it follows the loaded config (the test config has no share.s3)", () => {
    expect(harnessEnv({ AWS_ACCESS_KEY_ID: "id", S3_ACCESS_KEY_ID: "id" })).toEqual({ AWS_ACCESS_KEY_ID: "id" });
  });
});
