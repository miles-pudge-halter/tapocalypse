import { config } from "../config";

/** Share-upload credentials Tapocalypse itself reads (`resolveShareCredentials`); an agent has no use for them. */
const S3_CREDENTIALS: Record<string, true> = { S3_ACCESS_KEY_ID: true, S3_SECRET_ACCESS_KEY: true, S3_SESSION_TOKEN: true };
/** What Bun's S3 client falls back to; only secret while `share.s3` is configured, otherwise they belong to the user's own tooling. */
const AWS_CREDENTIALS: Record<string, true> = { AWS_ACCESS_KEY_ID: true, AWS_SECRET_ACCESS_KEY: true, AWS_SESSION_TOKEN: true };

export interface HarnessEnvOptions {
  /** Whether `share.s3` is configured, i.e. whether the `AWS_*` credentials are the report bucket's; defaults to the loaded config. */
  s3Configured?: boolean;
}

/**
 * The environment every harness process (and so everything the agent runs and prints) inherits: ours, without secrets the
 * agent must not see. `TAPOCALYPSE_HUB_TOKEN` / `_HEADERS` authenticate uploads from this machine, and `S3_*` (plus `AWS_*`
 * when `share.s3` is configured) are the report bucket's keys: an agent that runs `env` must not see them.
 */
export function harnessEnv(env: Record<string, string | undefined> = process.env, opts: HarnessEnvOptions = {}): Record<string, string | undefined> {
  const s3Configured = opts.s3Configured ?? config.share?.s3 !== undefined;
  const out: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || name.startsWith("TAPOCALYPSE_HUB_") || Object.hasOwn(S3_CREDENTIALS, name)) continue;
    if (s3Configured && Object.hasOwn(AWS_CREDENTIALS, name)) continue;
    out[name] = value;
  }
  return out;
}
