import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  type Activity,
  api,
  type Device,
  type DoctorReport,
  type ProjectStatus,
  type ReportDoc,
  type ReportEntry,
  type RunView,
} from "./api";

export type Route =
  | { name: "dashboard"; rerunId?: string }
  | { name: "run"; id: string }
  | { name: "projects"; openNew: boolean }
  | { name: "reports"; projectId: string }
  | { name: "report"; projectId: string; reportName: string };

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function parseHash(hash: string): Route {
  const [pathPart = "", query = ""] = hash.replace(/^#/, "").split("?");
  const parts = pathPart.split("/").filter(Boolean);
  try {
    const seg = parts.map(decodeURIComponent);
    if (seg[0] === "runs" && seg[1]) return { name: "run", id: seg[1] };
    if (seg[0] === "projects") return { name: "projects", openNew: new URLSearchParams(query).get("new") === "1" };
    if (seg[0] === "p" && seg[1] && seg[2] === "reports") {
      return seg[3] ? { name: "report", projectId: seg[1], reportName: seg[3] } : { name: "reports", projectId: seg[1] };
    }
  } catch {
    // malformed escape sequence: fall through to the dashboard
  }
  return { name: "dashboard", rerunId: new URLSearchParams(query).get("rerun") ?? undefined };
}

function subscribeHash(listener: () => void): () => void {
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash);
  return useMemo(() => parseHash(hash), [hash]);
}

export function navigate(hash: string): void {
  window.location.hash = hash.startsWith("#") ? hash : `#${hash}`;
}

interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

/** Fetches on mount and whenever `key` changes; stale responses from a previous key are dropped. */
function useAsync<T>(fetcher: () => Promise<T>, key: string, intervalMs?: number): AsyncState<T> & { refresh(): void } {
  const [state, setState] = useState<AsyncState<T>>({ data: null, loading: true, error: null });
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetcher().then(
        (data) => !cancelled && setState({ data, loading: false, error: null }),
        (e: unknown) => !cancelled && setState((s) => ({ data: s.data, loading: false, error: errorMessage(e) })),
      );
    setState((s) => ({ data: s.data, loading: true, error: null }));
    void load();
    const timer = intervalMs ? setInterval(load, intervalMs) : undefined;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [key, tick, intervalMs]);

  // Switching key must not show the previous key's data.
  useEffect(() => {
    setState({ data: null, loading: true, error: null });
  }, [key]);

  return { ...state, refresh };
}

// --- useProjects: fetched once, then replaced by every `projects` event on the shared EventSource ---

interface ProjectsState {
  projects: ProjectStatus[];
  loading: boolean;
  error: string | null;
}

const projectsListeners = new Set<() => void>();
let projectsState: ProjectsState = { projects: [], loading: true, error: null };

function setProjectsState(next: Partial<ProjectsState>): void {
  projectsState = { ...projectsState, ...next };
  for (const l of projectsListeners) l();
}

function refreshProjects(): void {
  api.projects().then(
    (projects) => setProjectsState({ projects, loading: false, error: null }),
    (e: unknown) => setProjectsState({ loading: false, error: errorMessage(e) }),
  );
}

function onProjectsEvent(e: Event): void {
  try {
    const data: unknown = JSON.parse((e as MessageEvent<string>).data);
    if (Array.isArray(data)) {
      setProjectsState({ projects: data as ProjectStatus[], loading: false, error: null });
      return;
    }
  } catch {
    // malformed payload: fall back to a fetch
  }
  refreshProjects();
}

let stopProjectsFeed: (() => void) | null = null;

function startProjectsFeed(): () => void {
  refreshProjects();
  const { source, release } = acquireEventSource();
  source.addEventListener("projects", onProjectsEvent);
  // After a reconnect events may have been missed.
  source.addEventListener("open", refreshProjects);
  return () => {
    source.removeEventListener("projects", onProjectsEvent);
    source.removeEventListener("open", refreshProjects);
    release();
  };
}

function subscribeProjects(listener: () => void): () => void {
  projectsListeners.add(listener);
  if (projectsListeners.size === 1) stopProjectsFeed = startProjectsFeed();
  return () => {
    projectsListeners.delete(listener);
    if (projectsListeners.size === 0) {
      stopProjectsFeed?.();
      stopProjectsFeed = null;
    }
  };
}

export function useProjects(): { projects: ProjectStatus[]; loading: boolean; error: string | null; refresh(): void } {
  const state = useSyncExternalStore(subscribeProjects, () => projectsState);
  return { ...state, refresh: refreshProjects };
}

export function useDevices(intervalMs = 10_000): {
  devices: Device[];
  loading: boolean;
  error: string | null;
  refresh(): void;
} {
  const { data, loading, error, refresh } = useAsync(api.devices, "devices", intervalMs);
  return { devices: data ?? [], loading, error, refresh };
}

// --- useDoctor: one shared report so a Re-check anywhere updates the top bar dot too ---

interface DoctorState {
  report: DoctorReport | null;
  loading: boolean;
  error: string | null;
}

const doctorListeners = new Set<() => void>();
let doctorState: DoctorState = { report: null, loading: true, error: null };

function setDoctorState(next: Partial<DoctorState>): void {
  doctorState = { ...doctorState, ...next };
  for (const l of doctorListeners) l();
}

function loadDoctor(fresh: boolean): void {
  setDoctorState({ loading: true });
  api.doctor(fresh).then(
    (report) => setDoctorState({ report, loading: false, error: null }),
    (e: unknown) => setDoctorState({ loading: false, error: errorMessage(e) }),
  );
}

function subscribeDoctor(listener: () => void): () => void {
  doctorListeners.add(listener);
  if (doctorListeners.size === 1 && !doctorState.report) loadDoctor(false);
  return () => void doctorListeners.delete(listener);
}

const recheckDoctor = () => loadDoctor(true);

/** Setup diagnostics shared by every consumer; `recheck` bypasses the server's 10 s cache. */
export function useDoctor(): DoctorState & { recheck(): void; blocked: boolean } {
  const state = useSyncExternalStore(subscribeDoctor, () => doctorState);
  const blocked = !!state.report?.checks.some((c) => c.required && c.status === "error");
  return { ...state, recheck: recheckDoctor, blocked };
}

export function useReports(projectId: string): { reports: ReportEntry[]; loading: boolean; error: string | null } {
  const { data, loading, error } = useAsync(() => api.reports(projectId), `reports:${projectId}`);
  return { reports: data ?? [], loading, error };
}

export function useReport(
  projectId: string,
  name: string,
): { report: ReportDoc | null; loading: boolean; error: string | null } {
  const { data, loading, error } = useAsync(() => api.report(projectId, name), `report:${projectId}:${name}`);
  return { report: data, loading, error };
}

// --- useRuns: one global EventSource shared by every consumer (ref counted) ---

interface RunsState {
  runs: RunView[];
  loading: boolean;
  error: string | null;
}

const REFETCH_DEBOUNCE_MS = 300;
const runsListeners = new Set<() => void>();
let runsState: RunsState = { runs: [], loading: true, error: null };
let runsDebounce: ReturnType<typeof setTimeout> | undefined;

function setRunsState(next: Partial<RunsState>): void {
  runsState = { ...runsState, ...next };
  for (const l of runsListeners) l();
}

function refreshRuns(): void {
  api.runs().then(
    (runs) => setRunsState({ runs, loading: false, error: null }),
    (e: unknown) => setRunsState({ loading: false, error: errorMessage(e) }),
  );
}

function scheduleRunsRefresh(): void {
  clearTimeout(runsDebounce);
  runsDebounce = setTimeout(refreshRuns, REFETCH_DEBOUNCE_MS);
}

/** One `/api/events` connection shared by every global store; closed when the last store unsubscribes. */
let eventSource: EventSource | null = null;
let eventSourceUsers = 0;

function acquireEventSource(): { source: EventSource; release(): void } {
  eventSource ??= new EventSource("/api/events");
  const source = eventSource;
  eventSourceUsers++;
  return {
    source,
    release() {
      if (--eventSourceUsers === 0) {
        source.close();
        eventSource = null;
      }
    },
  };
}

let stopRunsFeed: (() => void) | null = null;

function startRunsFeed(): () => void {
  refreshRuns();
  const { source, release } = acquireEventSource();
  source.addEventListener("run", scheduleRunsRefresh);
  // After a reconnect events may have been missed.
  source.addEventListener("open", scheduleRunsRefresh);
  return () => {
    source.removeEventListener("run", scheduleRunsRefresh);
    source.removeEventListener("open", scheduleRunsRefresh);
    release();
    clearTimeout(runsDebounce);
  };
}

function subscribeRuns(listener: () => void): () => void {
  runsListeners.add(listener);
  if (runsListeners.size === 1) stopRunsFeed = startRunsFeed();
  return () => {
    runsListeners.delete(listener);
    if (runsListeners.size === 0) {
      stopRunsFeed?.();
      stopRunsFeed = null;
    }
  };
}

export function useRuns(): { runs: RunView[]; loading: boolean; error: string | null; refresh(): void } {
  const state = useSyncExternalStore(subscribeRuns, () => runsState);
  return { ...state, refresh: refreshRuns };
}

// --- useRunEvents ---

const ACTIVITY_CAP = 1000;

export function useRunEvents(id: string): {
  run: RunView | null;
  activity: Activity[];
  error: string | null;
  connected: boolean;
} {
  const [run, setRun] = useState<RunView | null>(null);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    setRun(null);
    setActivity([]);
    setError(null);
    setConnected(false);
    const source = new EventSource(`/api/runs/${encodeURIComponent(id)}/events`);
    const parse = <T>(e: Event): T => JSON.parse((e as MessageEvent<string>).data) as T;
    source.addEventListener("open", () => {
      setConnected(true);
      setError(null);
    });
    source.addEventListener("snapshot", (e) => {
      const snap = parse<{ run: RunView; activity: Activity[] }>(e);
      setRun(snap.run);
      setActivity(snap.activity.slice(-ACTIVITY_CAP));
    });
    source.addEventListener("run", (e) => setRun(parse<RunView>(e)));
    source.addEventListener("activity", (e) => {
      const a = parse<Activity>(e);
      setActivity((prev) => [...prev, a].slice(-ACTIVITY_CAP));
    });
    source.addEventListener("error", () => {
      setConnected(false);
      // readyState CLOSED means the browser gave up (e.g. 404 for an unknown run); CONNECTING means it is retrying.
      if (source.readyState === EventSource.CLOSED) setError("Connection to run stream lost");
    });
    return () => source.close();
  }, [id]);

  return { run, activity, error, connected };
}

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
