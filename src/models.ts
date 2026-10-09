import { readFileSync } from "node:fs";
import { config } from "./config";
import { exec } from "./devices/devices";
import { getHarness, harnessBin } from "./harness";
import type { HarnessId } from "./harness/types";
import { listProjects } from "./projects/registry";
import { parsePersona } from "./runs/prompt";
import { listRuns } from "./runs/store";

const CACHE_MS = 10 * 60_000;
/** A failed model listing is not retried for a minute, so a broken install does not stall every request. */
const FAILURE_BACKOFF_MS = 60_000;
/** The list request waits this long for the harness CLI; a slower call keeps running and fills the cache for the next one. */
const WAIT_MS = 3_000;
const LIST_TIMEOUT_MS = 20_000;
const RECENT_RUNS = 200;

const caches = new Map<HarnessId, { at: number; ttl: number; models: string[] }>();
const inflight = new Map<HarnessId, Promise<string[]>>();

function refreshHarnessModels(id: HarnessId): Promise<string[]> {
  let pending = inflight.get(id);
  if (!pending) {
    pending = getHarness(id)
      .listModels({ bin: harnessBin(id), run: (cmd) => exec(cmd, { timeoutMs: LIST_TIMEOUT_MS }) })
      .catch(() => [])
      .then((models) => {
        caches.set(id, { at: Date.now(), ttl: models.length > 0 ? CACHE_MS : FAILURE_BACKOFF_MS, models });
        return models;
      })
      .finally(() => {
        inflight.delete(id);
      });
    inflight.set(id, pending);
  }
  return pending;
}

async function harnessModels(id: HarnessId): Promise<string[]> {
  const cache = caches.get(id);
  if (cache && Date.now() - cache.at < cache.ttl) return cache.models;
  return Promise.race([refreshHarnessModels(id), Bun.sleep(WAIT_MS).then(() => caches.get(id)?.models ?? [])]);
}

/** Models named by project personas that target `harness` (a persona without `harness:` counts as omp). */
function personaModels(harness: HarnessId): string[] {
  return listProjects().flatMap((p) => {
    if (!p.personaFile) return [];
    try {
      const persona = parsePersona(readFileSync(`${p.repoPath}/${p.personaFile}`, "utf8"));
      return persona.model && (persona.harness ?? "omp") === harness ? [persona.model] : [];
    } catch {
      return [];
    }
  });
}

function configuredModels(harness: HarnessId): string[] {
  const own = config.agent?.harnesses?.[harness]?.model;
  const legacy = harness === "omp" ? config.agent?.model : undefined;
  return [own, legacy].filter((m): m is string => !!m);
}

/** Distinct model ids for the New run picker: recently used, configured, persona models, then everything the harness offers. */
export async function listModels(harness: HarnessId): Promise<string[]> {
  const recent = listRuns()
    .slice(0, RECENT_RUNS)
    .flatMap((r) => (r.harness === harness && r.model ? [r.model] : []));
  const offered = await harnessModels(harness);
  return [...new Set([...recent, ...configuredModels(harness), ...personaModels(harness), ...offered])];
}
