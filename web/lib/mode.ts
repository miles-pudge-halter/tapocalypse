import { useEffect, useSyncExternalStore } from "react";
import type { Health } from "./api";

/**
 * Narrows a `GET /api/health` body. A server from before the hub existed has no `mode`: it is a laptop.
 * Anything that is not an object with `ok`, a known mode, a version and a run count (an HTML error page, a proxy login) is rejected.
 */
export function parseHealth(body: unknown): Health | null {
  if (!body || typeof body !== "object") return null;
  const { ok, mode, version, runs } = body as Record<string, unknown>;
  if (typeof ok !== "boolean" || typeof version !== "string" || typeof runs !== "number") return null;
  if (mode !== undefined && mode !== "local" && mode !== "hub") return null;
  return { ok, mode: mode ?? "local", version, runs };
}

export interface ModeState {
  mode: Health["mode"] | null;
  error: string | null;
}

/**
 * The one source of truth for the server's mode: `load` fetches `/api/health` once (concurrent calls share the request, a known mode is kept),
 * `retry` clears a failure and loads again. Every subscriber sees the same state, so a retry on the boot gate unsticks the app.
 */
export function createModeStore(fetchHealth: () => Promise<Health>) {
  let health: Health | null = null;
  let state: ModeState = { mode: null, error: null };
  let pending: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  const set = (next: ModeState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: (): ModeState => state,
    health: (): Health | null => health,
    isHub: (): boolean => health?.mode === "hub",
    load(): Promise<void> {
      if (health) return Promise.resolve();
      pending ??= fetchHealth()
        .then(
          (loaded) => {
            health = loaded;
            set({ mode: loaded.mode, error: null });
          },
          (e: unknown) => set({ mode: null, error: e instanceof Error ? e.message : String(e) }),
        )
        .finally(() => {
          pending = null;
        });
      return pending;
    },
    retry(): Promise<void> {
      if (state.error !== null) set({ mode: null, error: null });
      return this.load();
    },
  };
}

async function fetchHealth(): Promise<Health> {
  const res = await fetch("/api/health");
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const health = parseHealth(await res.json().catch(() => null));
  if (!health) throw new Error("The server did not answer like Tapocalypse.");
  return health;
}

const store = createModeStore(fetchHealth);

/** The mode the server runs in, fetched once before the shell renders; `mode` is null while loading or after an error. Shared by every caller. */
export function useAppMode(): ModeState & { retry(): void } {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  useEffect(() => {
    void store.load();
  }, []);
  return { ...state, retry: () => void store.retry() };
}

/** True on a team hub. Only call it below the boot gate (the mode is known there); before that it reads as a laptop. */
export function isHub(): boolean {
  return store.isHub();
}

/** The `/api/health` body, once known; for the version line. */
export function appHealth(): Health | null {
  return store.health();
}
