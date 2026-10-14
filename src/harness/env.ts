/**
 * The environment every harness process (and so everything the agent runs and prints) inherits: ours, without the team hub's
 * secrets. `TAPOCALYPSE_HUB_TOKEN` / `_HEADERS` authenticate uploads from this machine; an agent that runs `env` must not see them.
 */
export function harnessEnv(env: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !name.startsWith("TAPOCALYPSE_HUB_")) out[name] = value;
  }
  return out;
}
