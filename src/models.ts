import { readFileSync } from "node:fs";
import { config, OMP_BIN } from "./config";
import { exec } from "./devices/devices";
import { listProjects } from "./projects/registry";
import { parsePersona } from "./runs/prompt";
import { listRuns } from "./runs/store";

const CACHE_MS = 10 * 60_000;
/** A failed `omp models` is not retried for a minute, so a broken install does not stall every request. */
const FAILURE_BACKOFF_MS = 60_000;
/** The list request waits this long for `omp models`; a slower call keeps running and fills the cache for the next one. */
const WAIT_MS = 3_000;
const OMP_TIMEOUT_MS = 20_000;
const RECENT_RUNS = 200;

let cache: { at: number; ttl: number; models: string[] } | null = null;
let inflight: Promise<string[]> | null = null;

/** Parses the table `omp models` prints: `provider (n)` header lines followed by `│ model │ …` rows. */
export function parseOmpModels(output: string): string[] {
  const models: string[] = [];
  let provider: string | null = null;
  for (const line of output.split("\n")) {
    const header = /^(\S+) \(\d+\)\s*$/.exec(line);
    if (header) {
      provider = header[1]!;
      continue;
    }
    const row = /^│\s*([^│\s]+)\s*│/.exec(line);
    if (row && provider && row[1] !== "model") models.push(`${provider}/${row[1]}`);
  }
  return models;
}

function refreshOmpModels(): Promise<string[]> {
  inflight ??= exec([OMP_BIN, "models"], { timeoutMs: OMP_TIMEOUT_MS })
    .then((r) => {
      const models = r.code === 0 ? parseOmpModels(r.text) : [];
      cache = { at: Date.now(), ttl: models.length > 0 ? CACHE_MS : FAILURE_BACKOFF_MS, models };
      return models;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

async function ompModels(): Promise<string[]> {
  if (cache && Date.now() - cache.at < cache.ttl) return cache.models;
  return Promise.race([refreshOmpModels(), Bun.sleep(WAIT_MS).then(() => cache?.models ?? [])]);
}

function personaModels(): string[] {
  return listProjects().flatMap((p) => {
    if (!p.personaFile) return [];
    try {
      const { model } = parsePersona(readFileSync(`${p.repoPath}/${p.personaFile}`, "utf8"));
      return model ? [model] : [];
    } catch {
      return [];
    }
  });
}

/** Distinct model ids for the New run picker: recently used, configured, persona models, then everything omp offers. */
export async function listModels(): Promise<string[]> {
  const recent = listRuns()
    .slice(0, RECENT_RUNS)
    .flatMap((r) => (r.model ? [r.model] : []));
  const configured = config.agent?.model ? [config.agent.model] : [];
  const omp = await ompModels();
  return [...new Set([...recent, ...configured, ...personaModels(), ...omp])];
}
