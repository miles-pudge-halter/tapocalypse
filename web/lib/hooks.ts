import { type DependencyList, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import {
  ACTIVE_STATUSES,
  type Activity,
  api,
  ApiError,
  type BatchView,
  type Device,
  type DoctorReport,
  type McpStatus,
  type ShareStatus,
  type Platform,
  type PoolView,
  type ReportDoc,
  type ReportEntry,
  type RunStats,
  type RunStatus,
  type RunView,
  type Suite,
  type Template,
  type Verdict,
  type LeaseEvent,
  type LeaseView,
  type HarnessInfo,
  type HarnessId,
  type BaselineCandidate,
  type CheckHistory,
  type CompareResponse,
  type FlakyResponse,
  type HubInfo,
  type HubMachine,
  type HubStatus,
  type HubSync,
  type ProjectOverview,
  type ProjectView,
  type RefSummary,
  type ReleaseView,
  type Transition,
  OVERVIEW_SHOWS,
  refParam,
  type OverviewShow,
  type Ref,
} from "./api";
import { createLeaseCache, parseWatched } from "./leases";
import { isHub } from "./mode";
import { HARNESS_LABEL } from "./format";
import { missingKind } from "./hub";
import { GROUP_ORDER } from "./regression";
import { readStorage, writeStorage } from "./storage";

// --- routing ---

export type RunGroup = "day" | "batch" | "none";

/** Every field optional; absent = no constraint. Mirrored in the hash as `#/runs?status=a,b&verdict=..&project=..&q=..&group=..`. */
export interface RunFilters {
  status?: RunStatus[];
  verdict?: Verdict[];
  project?: string;
  q?: string;
  group?: RunGroup;
  /** Only finished runs with newly failing checks versus their baseline (`regressed=1`). */
  regressed?: boolean;
  /** Limits the list to one branch / app version (links from the overview and release pages). */
  branch?: string;
  version?: string;
  /** Hub only: upload machine names. */
  machine?: string[];
}

export type Route =
  | { name: "home" }
  | { name: "runs"; filters: RunFilters }
  | { name: "run"; id: string; check?: string; baseline?: string }
  | { name: "compare"; id: string; baselineId: string; show?: Transition; pair?: string }
  | { name: "batch"; id: string }
  | { name: "devices" }
  | { name: "setup"; section?: string }
  | { name: "projects"; openNew: boolean }
  | { name: "reports"; projectId: string }
  | { name: "flaky"; projectId: string }
  | { name: "report"; projectId: string; reportName: string }
  | { name: "overview"; projectId: string; ref: string | null; show?: OverviewShow }
  | { name: "releases"; projectId: string }
  | { name: "release"; projectId: string; ref: Ref; against: string | null; group: "device" | "platform" }
  | { name: "about" };

const RUN_STATUSES: readonly RunStatus[] = [
  "queued",
  "preflight",
  "running",
  "finishing",
  "done",
  "error",
  "cancelled",
  "interrupted",
];
const VERDICTS: readonly Verdict[] = ["PASS", "FAIL", "PASS WITH ISSUES", "BLOCKED", "PARTIAL"];
const GROUPS: readonly RunGroup[] = ["day", "batch", "none"];

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function csv<T extends string>(raw: string | null, allowed: readonly T[]): T[] | undefined {
  if (!raw) return undefined;
  const out = raw.split(",").filter((v): v is T => (allowed as readonly string[]).includes(v));
  return out.length > 0 ? out : undefined;
}

function parseFilters(params: URLSearchParams): RunFilters {
  const filters: RunFilters = {};
  const status = csv(params.get("status"), RUN_STATUSES);
  if (status) filters.status = status;
  const verdict = csv(params.get("verdict"), VERDICTS);
  if (verdict) filters.verdict = verdict;
  const project = params.get("project");
  if (project) filters.project = project;
  const q = params.get("q");
  if (q) filters.q = q;
  const group = params.get("group");
  if (group && (GROUPS as readonly string[]).includes(group)) filters.group = group as RunGroup;
  if (params.get("regressed") === "1") filters.regressed = true;
  const branch = params.get("branch");
  if (branch) filters.branch = branch;
  const version = params.get("version");
  if (version) filters.version = version;
  const machine = params.get("machine")?.split(",").filter(Boolean);
  if (machine?.length) filters.machine = machine;
  return filters;
}

/** Hash for the Runs page carrying `filters`. */
export function runsHash(filters: RunFilters): string {
  const q = new URLSearchParams();
  if (filters.status?.length) q.set("status", filters.status.join(","));
  if (filters.verdict?.length) q.set("verdict", filters.verdict.join(","));
  if (filters.project) q.set("project", filters.project);
  if (filters.q) q.set("q", filters.q);
  if (filters.group) q.set("group", filters.group);
  if (filters.regressed) q.set("regressed", "1");
  if (filters.branch) q.set("branch", filters.branch);
  if (filters.version) q.set("version", filters.version);
  if (filters.machine?.length) q.set("machine", filters.machine.join(","));
  const qs = q.toString();
  return qs ? `#/runs?${qs}` : "#/runs";
}

export function parseHash(hash: string): Route {
  const [pathPart = "", query = ""] = hash.replace(/^#/, "").split("?");
  const params = new URLSearchParams(query);
  const parts = pathPart.split("/").filter(Boolean);
  try {
    const seg = parts.map(decodeURIComponent);
    if (seg[0] === "runs" && seg[1] && seg[2] === "compare" && seg[3]) {
      const show = params.get("show");
      return {
        name: "compare",
        id: seg[1],
        baselineId: seg[3],
        show: show && (GROUP_ORDER as readonly string[]).includes(show) ? (show as Transition) : undefined,
        pair: params.get("pair") ?? undefined,
      };
    }
    if (seg[0] === "runs" && seg[1]) {
      return { name: "run", id: seg[1], check: params.get("check") ?? undefined, baseline: params.get("baseline") ?? undefined };
    }
    if ((seg[0] === "batches" || seg[0] === "batch") && seg[1]) return { name: "batch", id: seg[1] };
    if (seg[0] === "devices") return { name: "devices" };
    if (seg[0] === "about") return { name: "about" };
    if (seg[0] === "setup") return { name: "setup", section: params.get("section") ?? undefined };
    if (seg[0] === "projects") return { name: "projects", openNew: params.get("new") === "1" };
    if (seg[0] === "p" && seg[1] && seg[2] === "flaky") return { name: "flaky", projectId: seg[1] };
    if (seg[0] === "p" && seg[1] && seg[2] === "releases") {
      const kind = seg[3];
      if ((kind === "version" || kind === "branch") && seg[4]) {
        // A branch typed with raw slashes arrives as several segments: rejoin them.
        const name = seg.slice(4).join("/");
        return {
          name: "release",
          projectId: seg[1],
          ref: { kind, name },
          against: params.get("against"),
          group: params.get("group") === "platform" ? "platform" : "device",
        };
      }
      return { name: "releases", projectId: seg[1] };
    }
    if (seg[0] === "p" && seg[1] && seg[2] === "overview") {
      const show = params.get("show");
      return {
        name: "overview",
        projectId: seg[1],
        ref: params.get("ref") && params.get("ref") !== "all" ? params.get("ref") : null,
        show: show && (OVERVIEW_SHOWS as readonly string[]).includes(show) ? (show as OverviewShow) : undefined,
      };
    }
    if (seg[0] === "p" && seg[1] && seg[2] === "reports") {
      return seg[3] ? { name: "report", projectId: seg[1], reportName: seg[3] } : { name: "reports", projectId: seg[1] };
    }
  } catch {
    // malformed escape sequence: fall through to the runs page
  }
  // `#/` alone is the home page; a query (the old Runs-page links) or an unknown path still means the list.
  if (parts.length === 0 && query === "") return { name: "home" };
  return { name: "runs", filters: parseFilters(params) };
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

/** Updates the Runs-page hash in place (no history entry per keystroke). */
export function setRunFilters(filters: RunFilters): void {
  window.location.replace(runsHash(filters));
}

// --- the shared global EventSource (`/api/events`), ref counted ---

let eventSource: EventSource | null = null;
let eventSourceUsers = 0;
let sourceConnected = false;
const connectionListeners = new Set<() => void>();

function setConnected(next: boolean): void {
  if (sourceConnected === next) return;
  sourceConnected = next;
  for (const l of connectionListeners) l();
}

function onSourceOpen(): void {
  setConnected(true);
}
function onSourceError(): void {
  setConnected(false);
}

/** Subscribes to a named event (or the synthetic "open", fired on every (re)connect) on the shared stream. */
export function listenEvent(name: string, handler: (e: Event) => void): () => void {
  if (!eventSource) {
    eventSource = new EventSource("/api/events");
    eventSource.addEventListener("open", onSourceOpen);
    eventSource.addEventListener("error", onSourceError);
  }
  const source = eventSource;
  eventSourceUsers++;
  source.addEventListener(name, handler);
  return () => {
    source.removeEventListener(name, handler);
    if (--eventSourceUsers === 0) {
      source.removeEventListener("open", onSourceOpen);
      source.removeEventListener("error", onSourceError);
      source.close();
      eventSource = null;
      setConnected(false);
    }
  };
}

function parseRunEvent(e: Event): RunView | null {
  try {
    const data: unknown = JSON.parse((e as MessageEvent<string>).data);
    if (data && typeof data === "object" && "id" in data && "status" in data) return data as RunView;
  } catch {
    // malformed payload
  }
  return null;
}

const LEASE_CHANGES: readonly string[] = ["acquired", "renewed", "released", "expired", "revoked", "gone"];

/** Narrows a global `lease` event's payload; null for anything that is not one. */
export function parseLeaseEvent(e: Event): LeaseEvent | null {
  try {
    const data: unknown = JSON.parse((e as MessageEvent<string>).data);
    if (data && typeof data === "object" && "serial" in data && "change" in data && typeof data.serial === "string" && LEASE_CHANGES.includes(String(data.change))) {
      return data as LeaseEvent;
    }
  } catch {
    // malformed payload
  }
  return null;
}

const leaseCache = createLeaseCache();
const resolvedLeases = new WeakMap<Event, LeaseView | null>();

/**
 * Subscribes to global `lease` events with the lease the event is about. The server sends `lease: null` on every ending
 * event, so that is the last lease this tab knew for the serial (null if it never saw one). All listeners of one event
 * get the same answer.
 */
export function listenLeaseEvent(handler: (event: LeaseEvent, lease: LeaseView | null) => void): () => void {
  return listenEvent("lease", (e) => {
    const event = parseLeaseEvent(e);
    if (!event) return;
    if (!resolvedLeases.has(e)) resolvedLeases.set(e, leaseCache.resolve(event));
    handler(event, resolvedLeases.get(e) ?? null);
  });
}

/** Calls `cb` (debounced) after every global `lease` event and once after each reconnect (events may have been missed). */
function useLeasesChanged(cb: () => void, delayMs = 300): void {
  const ref = useRef(cb);
  ref.current = cb;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fire = () => {
      clearTimeout(timer);
      timer = setTimeout(() => ref.current(), delayMs);
    };
    const offLease = listenEvent("lease", fire);
    const offOpen = listenEvent("open", fire);
    return () => {
      clearTimeout(timer);
      offLease();
      offOpen();
    };
  }, [delayMs]);
}

/** True while the global event stream is open ("Live"); false while (re)connecting. */
export function useLiveConnection(): boolean {
  return useSyncExternalStore(
    (listener) => {
      connectionListeners.add(listener);
      return () => void connectionListeners.delete(listener);
    },
    () => sourceConnected,
  );
}

/**
 * Calls `cb` (debounced) with the run payload of every global `run` event, and once after each reconnect.
 * `onHubProjects`: on the hub also once per burst of `projects` frames (the hub announces an expired or removed live run that way, with no `run` frame).
 */
function useRunsChanged(cb: (run: RunView | null) => void, delayMs = 400, onHubProjects = false): void {
  const ref = useRef(cb);
  ref.current = cb;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fire = (run: RunView | null) => {
      clearTimeout(timer);
      timer = setTimeout(() => ref.current(run), delayMs);
    };
    const offRun = listenEvent("run", (e) => fire(parseRunEvent(e)));
    const offOpen = listenEvent("open", () => fire(null));
    const offProjects = onHubProjects ? listenEvent("projects", () => isHub() && fire(null)) : null;
    return () => {
      clearTimeout(timer);
      offRun();
      offOpen();
      offProjects?.();
    };
  }, [delayMs, onHubProjects]);
}

// --- generic fetch hook ---

interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  /** HTTP status of the failed request, when it was an API error. */
  errorStatus: number | null;
  errorCode: string | null;
  /** When the data last arrived (ms since the epoch); drives "Updated 3m ago" labels. */
  fetchedAt: number | null;
}

/**
 * Fetches on mount and whenever `key` changes; stale responses from a previous key are dropped.
 * While `enabled` is false nothing is fetched and the state is an empty, settled one (hub mode skips routes the hub blocks).
 */
function useAsync<T>(fetcher: () => Promise<T>, key: string, intervalMs?: number, enabled = true): AsyncState<T> & { refresh(): void } {
  const [state, setState] = useState<AsyncState<T>>({ data: null, loading: enabled, error: null, errorStatus: null, errorCode: null, fetchedAt: null });
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const load = () =>
      fetcher().then(
        (data) => !cancelled && setState({ data, loading: false, error: null, errorStatus: null, errorCode: null, fetchedAt: Date.now() }),
        (e: unknown) => !cancelled && setState((s) => ({ ...s, loading: false, error: errorMessage(e), errorStatus: e instanceof ApiError ? e.status : null, errorCode: e instanceof ApiError ? e.code : null })),
      );
    setState((s) => ({ ...s, loading: true, error: null, errorStatus: null, errorCode: null }));
    void load();
    const timer = intervalMs ? setInterval(load, intervalMs) : undefined;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [key, tick, intervalMs, enabled]);

  // Switching key must not show the previous key's data.
  useEffect(() => {
    setState({ data: null, loading: enabled, error: null, errorStatus: null, errorCode: null, fetchedAt: null });
  }, [key, enabled]);

  return { ...state, refresh };
}

// --- useProjects: fetched once, then replaced by every `projects` event on the shared EventSource ---

interface ProjectsState {
  projects: ProjectView[];
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
      setProjectsState({ projects: data as ProjectView[], loading: false, error: null });
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
  const offProjects = listenEvent("projects", onProjectsEvent);
  // After a reconnect events may have been missed.
  const offOpen = listenEvent("open", refreshProjects);
  return () => {
    offProjects();
    offOpen();
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

export function useProjects(): { projects: ProjectView[]; loading: boolean; error: string | null; refresh(): void } {
  const state = useSyncExternalStore(subscribeProjects, () => projectsState);
  return { ...state, refresh: refreshProjects };
}

// --- project scope (sidebar project switcher) ---

const SCOPE_KEY = "tapocalypse-project";
const scopeListeners = new Set<() => void>();
let scopeProjectId: string | null = readStorage(SCOPE_KEY);

function setScopeProjectId(id: string | null): void {
  if (scopeProjectId === id) return;
  scopeProjectId = id;
  writeStorage(SCOPE_KEY, id);
  for (const l of scopeListeners) l();
}

/** The project picked in the sidebar switcher (null = all projects); persisted in localStorage. Views default their project filter to it. */
export function useProjectScope(): { projectId: string | null; setProjectId(id: string | null): void } {
  const projectId = useSyncExternalStore(
    (listener) => {
      scopeListeners.add(listener);
      return () => void scopeListeners.delete(listener);
    },
    () => scopeProjectId,
  );
  return { projectId, setProjectId: setScopeProjectId };
}

// --- devices, doctor, reports ---

/** Every device, polled and refreshed within a second of any lease change. */
export function useDevices(intervalMs = 10_000): {
  devices: Device[];
  loading: boolean;
  error: string | null;
  refresh(): void;
} {
  const { data, loading, error, refresh } = useAsync(api.devices, "devices", intervalMs, !isHub());
  useLeasesChanged(refresh);
  useEffect(() => {
    if (data) leaseCache.seed(data.flatMap((d) => (d.lease ? [d.lease] : [])));
  }, [data]);
  return { devices: data ?? [], loading, error, refresh };
}

export function usePool(intervalMs = 5_000): { pool: PoolView | null; loading: boolean; error: string | null; refresh(): void } {
  const { data, loading, error, refresh } = useAsync(api.pool, "pool", intervalMs, !isHub());
  useRunsChanged(refresh, 600);
  useLeasesChanged(refresh);
  return { pool: data, loading, error, refresh };
}

/** Agent and run leases (public view, no secrets), refreshed by `lease` events. */
export function useLeases(intervalMs = 15_000): { leases: LeaseView[]; loading: boolean; error: string | null; refresh(): void } {
  const { data, loading, error, refresh } = useAsync(api.leases, "leases", intervalMs, !isHub());
  useLeasesChanged(refresh);
  useEffect(() => {
    if (data) leaseCache.seed(data);
  }, [data]);
  return { leases: data ?? [], loading: loading && data === null, error, refresh };
}

// --- useDoctor: one shared report so a Re-check anywhere updates the sidebar dot too ---

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
  if (isHub()) {
    // The hub has no devices or harnesses to check, and its doctor route is not served to viewers.
    if (doctorState.loading) doctorState = { report: null, loading: false, error: null };
  } else if (doctorListeners.size === 1 && !doctorState.report) loadDoctor(false);
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

// --- runs ---

const PAGE_SIZE = 100;

export interface RunQuery extends RunFilters {
  batch?: string;
  pr?: number;
  ticket?: string;
  commit?: string;
  limit?: number;
}

interface RunsState {
  runs: RunView[];
  hasMore: boolean;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
}

function runQueryKey(f: RunQuery): string {
  return JSON.stringify([f.status, f.verdict, f.project, f.q, f.batch, f.branch, f.pr, f.ticket, f.commit, f.limit, f.regressed, f.version, f.machine]);
}

function mergeRun(existing: RunView, incoming: RunView): RunView {
  return { ...existing, ...incoming };
}

/**
 * Server-filtered run list. Live `run` events upsert rows already in the list immediately and trigger a
 * debounced refetch (which also pulls in newly created matching runs and drops rows that stopped matching).
 */
export function useRuns(filters: RunQuery = {}): {
  runs: RunView[];
  hasMore: boolean;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  loadMore(): Promise<void>;
  refresh(): void;
} {
  const key = runQueryKey(filters);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const [state, setState] = useState<RunsState>({ runs: [], hasMore: false, loading: true, loadingMore: false, error: null });
  const stateRef = useRef(state);
  stateRef.current = state;
  const generation = useRef(0);

  const fetchList = useCallback((fresh = false) => {
    const gen = generation.current;
    const f = filtersRef.current;
    const limit = fresh ? (f.limit ?? PAGE_SIZE) : Math.max(f.limit ?? PAGE_SIZE, stateRef.current.runs.length);
    return api.runs({ ...f, limit }).then(
      ({ runs, hasMore }) => {
        if (gen === generation.current) setState((s) => ({ ...s, runs, hasMore, loading: false, error: null }));
      },
      (e: unknown) => {
        if (gen === generation.current) setState((s) => ({ ...s, loading: false, error: errorMessage(e) }));
      },
    );
  }, []);

  useEffect(() => {
    generation.current++;
    setState({ runs: [], hasMore: false, loading: true, loadingMore: false, error: null });
    void fetchList(true);
  }, [key, fetchList]);

  useRunsChanged((run) => {
    if (run) {
      setState((s) =>
        s.runs.some((r) => r.id === run.id) ? { ...s, runs: s.runs.map((r) => (r.id === run.id ? mergeRun(r, run) : r)) } : s,
      );
    }
    void fetchList();
  }, 400, true);

  // A laptop's upload state changes without a run event: patch the row in place.
  useEffect(
    () =>
      listenHubSync((runId, sync) =>
        setState((s) => (s.runs.some((r) => r.id === runId) ? { ...s, runs: s.runs.map((r) => (r.id === runId ? { ...r, hubSync: sync } : r)) } : s)),
      ),
    [],
  );

  const loadMore = useCallback(async () => {
    const { runs, hasMore, loadingMore } = stateRef.current;
    const last = runs[runs.length - 1];
    if (!hasMore || loadingMore || !last) return;
    const gen = generation.current;
    setState((s) => ({ ...s, loadingMore: true }));
    try {
      const page = await api.runs({ ...filtersRef.current, limit: filtersRef.current.limit ?? PAGE_SIZE, before: last.createdAt });
      if (gen !== generation.current) return;
      setState((s) => {
        const seen = new Set(s.runs.map((r) => r.id));
        return { ...s, runs: [...s.runs, ...page.runs.filter((r) => !seen.has(r.id))], hasMore: page.hasMore, loadingMore: false };
      });
    } catch (e) {
      if (gen === generation.current) setState((s) => ({ ...s, loadingMore: false, error: errorMessage(e) }));
    }
  }, []);

  return { ...state, loadMore, refresh: () => void fetchList() };
}

// --- active runs: one app-wide store (sidebar badge, notifications seed) ---

interface ActiveRunsState {
  runs: RunView[];
  loading: boolean;
  /** The last list request failed (the runs shown are the ones from before); cleared by the next success or run event. */
  error: string | null;
}

const activeListeners = new Set<() => void>();
let activeState: ActiveRunsState = { runs: [], loading: true, error: null };
let activeDebounce: ReturnType<typeof setTimeout> | undefined;

function setActiveState(next: ActiveRunsState): void {
  activeState = next;
  for (const l of activeListeners) l();
}

function refreshActiveRuns(): void {
  api.runs({ status: ACTIVE_STATUSES, limit: PAGE_SIZE }).then(
    ({ runs }) => setActiveState({ runs, loading: false, error: null }),
    (e: unknown) => setActiveState({ runs: activeState.runs, loading: false, error: errorMessage(e) }),
  );
}

function onActiveRunEvent(e: Event): void {
  const run = parseRunEvent(e);
  if (run) {
    const active = ACTIVE_STATUSES.includes(run.status);
    const others = activeState.runs.filter((r) => r.id !== run.id);
    setActiveState({ runs: active ? [...others, run] : others, loading: false, error: null });
  }
  clearTimeout(activeDebounce);
  activeDebounce = setTimeout(refreshActiveRuns, 800);
}

let stopActiveFeed: (() => void) | null = null;

function startActiveFeed(): () => void {
  refreshActiveRuns();
  const offRun = listenEvent("run", onActiveRunEvent);
  const offOpen = listenEvent("open", refreshActiveRuns);
  // The hub announces a live run that expired or was removed with a `projects` frame and no `run` frame.
  const offProjects = listenEvent("projects", () => {
    if (!isHub()) return;
    clearTimeout(activeDebounce);
    activeDebounce = setTimeout(refreshActiveRuns, 800);
  });
  return () => {
    clearTimeout(activeDebounce);
    offRun();
    offOpen();
    offProjects();
  };
}

function subscribeActive(listener: () => void): () => void {
  activeListeners.add(listener);
  if (activeListeners.size === 1) stopActiveFeed = startActiveFeed();
  return () => {
    activeListeners.delete(listener);
    if (activeListeners.size === 0) {
      stopActiveFeed?.();
      stopActiveFeed = null;
    }
  };
}

/** Queued + in-flight runs across all projects, live. */
export function useActiveRuns(): ActiveRunsState {
  return useSyncExternalStore(subscribeActive, () => activeState);
}

// --- aggregated reads ---

export function useBatch(id: string): { batch: BatchView | null; loading: boolean; error: string | null; refresh(): void } {
  const { data, loading, error, refresh } = useAsync(() => api.batch(id), `batch:${id}`);
  useRunsChanged((run) => {
    if (!run || run.batchId === id) refresh();
  });
  return { batch: data, loading, error, refresh };
}

export function useStats(
  project?: string | null,
  days = 7,
): { stats: RunStats | null; loading: boolean; error: string | null; refresh(): void } {
  const { data, loading, error, refresh } = useAsync(() => api.stats(project, days), `stats:${project ?? ""}:${days}`);
  useRunsChanged((run) => {
    if (!run || !ACTIVE_STATUSES.includes(run.status)) refresh();
  }, 1500);
  return { stats: data, loading, error, refresh };
}

export function useModels(harness?: HarnessId): { models: string[]; loading: boolean; error: string | null } {
  const { data, loading, error } = useAsync(() => api.models(harness), `models:${harness ?? ""}`, undefined, !isHub());
  return { models: data ?? [], loading, error };
}

/** Supported agent CLIs with install state and capabilities (`default` = the harness a run gets when none is chosen). */
export function useHarnesses(): {
  harnesses: HarnessInfo[];
  defaultId: HarnessId | null;
  loading: boolean;
  error: string | null;
} {
  const { data, loading, error } = useAsync(api.harnesses, "harnesses", undefined, !isHub());
  return { harnesses: data?.harnesses ?? [], defaultId: data?.default ?? null, loading, error };
}

/** One harness by id (a run's `harness`): `label` is undefined while the list loads, then falls back to the raw id. */
export function useHarness(id: HarnessId): { info: HarnessInfo | null; label: string | undefined; loading: boolean } {
  const { harnesses, loading } = useHarnesses();
  const info = harnesses.find((h) => h.id === id) ?? null;
  if (isHub()) return { info: null, label: HARNESS_LABEL[id] ?? id, loading: false };
  return { info, label: info?.label ?? (loading ? undefined : id), loading };
}

export function useTemplates(): { templates: Template[]; loading: boolean; error: string | null } {
  const { data, loading, error } = useAsync(api.templates, "templates", undefined, !isHub());
  return { templates: data ?? [], loading, error };
}

export function useSuites(projectId: string): { suites: Suite[]; loading: boolean; error: string | null; refresh(): void } {
  const { data, loading, error, refresh } = useAsync(
    () => (projectId ? api.suites(projectId) : Promise.resolve<Suite[]>([])),
    `suites:${projectId}`,
    undefined,
    !isHub(),
  );
  return { suites: data ?? [], loading, error, refresh };
}

export function useMcpStatus(intervalMs = 5_000): { status: McpStatus | null; loading: boolean; error: string | null } {
  const { data, loading, error } = useAsync(api.mcpStatus, "mcp-status", intervalMs, !isHub());
  return { status: data, loading, error };
}

/** Whether report links can be uploaded (`share.s3` configured on the server); the download needs no setup. */
export function useShareStatus(): { status: ShareStatus | null; loading: boolean; error: string | null; refresh(): void } {
  const { data, loading, error, refresh } = useAsync(api.shareStatus, "share-status", undefined, !isHub());
  return { status: data, loading, error, refresh };
}

// --- team hub ---

/** Like `useRunsChanged`, but only for events about `projectId` (and reconnects, which may have missed some). */
function useProjectRunsChanged(projectId: string, cb: () => void, delayMs = 2000): void {
  useRunsChanged((run) => {
    // A run still in progress on a laptop is in none of the hub's aggregates: only its finished upload changes them.
    if (run?.hub?.live) return;
    if (!run || run.projectId === projectId) cb();
  }, delayMs);
}

/** A project's overview for one ref (null = all branches); refetches 2 s (debounced) after a run of the project changes. */
export function useOverview(
  projectId: string,
  ref: Ref | null,
): { overview: ProjectOverview | null; loading: boolean; error: string | null; fetchedAt: number | null; missing: "ref" | "project" | null; refresh(): void } {
  const { projects } = useProjects();
  const { data, loading, error, errorStatus, errorCode, fetchedAt, refresh } = useAsync(() => api.overview(projectId, ref), `overview:${projectId}:${refParam(ref)}`);
  useProjectRunsChanged(projectId, refresh);
  return { overview: data, loading, error, fetchedAt, missing: missingKind({ status: errorStatus, code: errorCode }, projects.some((p) => p.id === projectId)), refresh };
}

/** Versions and branches that have runs in a project, newest first. */
export function useRefs(projectId: string): { refs: RefSummary[]; loading: boolean; error: string | null; fetchedAt: number | null; refresh(): void } {
  const { data, loading, error, fetchedAt, refresh } = useAsync(() => api.refs(projectId), `refs:${projectId}`);
  useProjectRunsChanged(projectId, refresh);
  return { refs: data ?? [], loading: loading && data === null, error, fetchedAt, refresh };
}

/** One release across every machine (`against` = a ref param to compare with, null = automatic). */
export function useRelease(
  projectId: string,
  ref: Ref,
  against: string | null,
): { release: ReleaseView | null; loading: boolean; error: string | null; fetchedAt: number | null; missing: "ref" | "project" | null; refresh(): void } {
  const { projects } = useProjects();
  const { data, loading, error, errorStatus, errorCode, fetchedAt, refresh } = useAsync(() => api.release(projectId, ref, against), `release:${projectId}:${refParam(ref)}:${against ?? "auto"}`);
  useProjectRunsChanged(projectId, refresh);
  return { release: data, loading, error, fetchedAt, missing: missingKind({ status: errorStatus, code: errorCode }, projects.some((p) => p.id === projectId)), refresh };
}

/** Machines that upload to this hub; refetched after uploads and every minute. Hub only (no fetch on a laptop). */
export function useHubMachines(): { machines: HubMachine[]; loading: boolean; error: string | null; fetchedAt: number | null } {
  const { data, loading, error, fetchedAt, refresh } = useAsync(api.hubMachines, "hub-machines", 60_000, isHub());
  useRunsChanged((run) => {
    if (!run?.hub?.live) refresh();
  }, 2000);
  return { machines: data ?? [], loading: loading && data === null, error, fetchedAt };
}

/** Hub totals and settings for the About page. Hub only. */
export function useHubInfo(): { info: HubInfo | null; loading: boolean; error: string | null } {
  const { data, loading, error } = useAsync(api.hubInfo, "hub-info", undefined, isHub());
  return { info: data, loading, error };
}

type HubEvent = { kind: "status"; status: HubStatus } | { kind: "sync"; runId: string; sync: HubSync | null };

/** Narrows a laptop's `hub` event: the whole status, or one run's upload state. */
function parseHubEvent(e: Event): HubEvent | null {
  try {
    const data: unknown = JSON.parse((e as MessageEvent<string>).data);
    if (!data || typeof data !== "object") return null;
    if ("status" in data && data.status && typeof data.status === "object") return { kind: "status", status: data.status as HubStatus };
    if ("runId" in data && typeof data.runId === "string" && "sync" in data) return { kind: "sync", runId: data.runId, sync: (data.sync as HubSync | null) ?? null };
  } catch {
    // malformed payload
  }
  return null;
}

/** Calls `handler` with the new upload state of a run whenever the laptop's sync worker reports one. */
function listenHubSync(handler: (runId: string, sync: HubSync | null) => void): () => void {
  return listenEvent("hub", (e) => {
    const event = parseHubEvent(e);
    if (event?.kind === "sync") handler(event.runId, event.sync);
  });
}

interface HubStatusState {
  status: HubStatus | null;
  loading: boolean;
  error: string | null;
}

const hubStatusListeners = new Set<() => void>();
let hubStatusState: HubStatusState = { status: null, loading: true, error: null };

function setHubStatusState(next: Partial<HubStatusState>): void {
  hubStatusState = { ...hubStatusState, ...next };
  for (const l of hubStatusListeners) l();
}

function refreshHubStatus(): void {
  api.hubStatus().then(
    (status) => setHubStatusState({ status, loading: false, error: null }),
    (e: unknown) => setHubStatusState({ loading: false, error: errorMessage(e) }),
  );
}

let stopHubStatusFeed: (() => void) | null = null;

function startHubStatusFeed(): () => void {
  refreshHubStatus();
  const offHub = listenEvent("hub", (e) => {
    const event = parseHubEvent(e);
    if (event?.kind === "status") setHubStatusState({ status: event.status, loading: false, error: null });
  });
  const offOpen = listenEvent("open", refreshHubStatus);
  return () => {
    offHub();
    offOpen();
  };
}

function subscribeHubStatus(listener: () => void): () => void {
  hubStatusListeners.add(listener);
  if (hubStatusListeners.size === 1 && !isHub()) stopHubStatusFeed = startHubStatusFeed();
  return () => {
    hubStatusListeners.delete(listener);
    if (hubStatusListeners.size === 0) {
      stopHubStatusFeed?.();
      stopHubStatusFeed = null;
    }
  };
}

/** The laptop's hub connection and upload queue, live through `hub` events. Never fetches on a hub. */
export function useHubStatus(): HubStatusState & { refresh(): void; set(status: HubStatus): void } {
  const state = useSyncExternalStore(subscribeHubStatus, () => (isHub() ? HUB_STATUS_OFF : hubStatusState));
  return { ...state, refresh: refreshHubStatus, set: (status) => setHubStatusState({ status, loading: false, error: null }) };
}

const HUB_STATUS_OFF: HubStatusState = { status: null, loading: false, error: null };

// --- New run sheet store ---

export interface NewRunPrefill {
  projectId?: string;
  title?: string;
  brief?: string;
  device?: { platform: Platform; serial?: string };
  devices?: { platform: Platform; serial?: string }[];
  packageId?: string;
  model?: string;
  harness?: HarnessId;
  effort?: string;
  suiteId?: string;
  sourcePath?: string;
  /** A finished run whose checks the sheet offers to reuse (the "previous checks will be reused" hint). */
  reuseChecksFrom?: string;
}

interface NewRunState {
  open: boolean;
  prefill: NewRunPrefill | null;
}

const newRunListeners = new Set<() => void>();
let newRunState: NewRunState = { open: false, prefill: null };

function setNewRunState(next: NewRunState): void {
  newRunState = next;
  for (const l of newRunListeners) l();
}

function openNewRun(prefill?: NewRunPrefill): void {
  setNewRunState({ open: true, prefill: prefill ?? null });
}

function closeNewRun(): void {
  // Keep the prefill until the sheet's exit animation is done; the next open replaces it.
  setNewRunState({ open: false, prefill: newRunState.prefill });
}

/** Global store behind the "New run" sheet; any view can open it (optionally prefilled). */
export function useNewRun(): { open: boolean; prefill: NewRunPrefill | null; openNewRun(prefill?: NewRunPrefill): void; close(): void } {
  const state = useSyncExternalStore(
    (listener) => {
      newRunListeners.add(listener);
      return () => void newRunListeners.delete(listener);
    },
    () => newRunState,
    () => newRunState,
  );
  return { ...state, openNewRun, close: closeNewRun };
}

// --- regression intelligence ---

export interface ComparisonState {
  comparison: CompareResponse["comparison"];
  reason: CompareResponse["reason"];
  reasonText: string | null;
  loading: boolean;
  error: string | null;
  refresh(): void;
}

/**
 * Comparison of run `runId` with `baselineId` (null = the server's automatic pick). Refetches 1.5 s (debounced) after
 * every `run` event of either run, so an active run's counts follow it live.
 */
export function useComparison(runId: string, baselineId: string | null): ComparisonState {
  const { data, loading, error, refresh } = useAsync(() => api.compare(runId, baselineId ?? "auto"), `compare:${runId}:${baselineId ?? "auto"}`);
  useRunsChanged((run) => {
    if (!run || run.id === runId || run.id === baselineId) refresh();
  }, 1500);
  return { comparison: data?.comparison ?? null, reason: data?.reason ?? null, reasonText: data?.reasonText ?? null, loading, error, refresh };
}

/** One run for context around a comparison that could not load; fetches only while `enabled`. */
export function useRunSummary(runId: string, enabled: boolean): { run: RunView | null; loading: boolean; error: string | null } {
  const { data, loading, error } = useAsync(() => (enabled ? api.run(runId) : Promise.resolve<RunView | null>(null)), `run-summary:${runId}:${enabled}`);
  return { run: data, loading: enabled && loading, error };
}

/** Runs that could serve as the baseline of `runId`; fetches only while `enabled` (the picker is open). */
export function useBaselineCandidates(
  runId: string,
  q: string,
  enabled: boolean,
): { candidates: BaselineCandidate[]; loading: boolean; error: string | null } {
  const { data, loading, error } = useAsync(
    () => (enabled ? api.baselineCandidates(runId, q).then((r) => r.candidates) : Promise.resolve<BaselineCandidate[]>([])),
    `baseline-candidates:${runId}:${enabled ? q : "closed"}`,
  );
  return { candidates: data ?? [], loading: enabled && loading, error };
}

/** What the check-history sheet is about: a stored key, or (key unknown) one check of one run. */
export interface CheckHistoryTarget {
  projectId: string;
  checkKey: string | null;
  /** The run the sheet was opened from, with its check: highlights that entry and enables "Compare with this run". */
  runId?: string;
  checkId?: string;
  title: string;
}

const HISTORY_PAGE = 30;

interface HistoryState {
  history: CheckHistory | null;
  loading: boolean;
  loadingMore: boolean;
  /** The first page failed; `history` still holds the previous page set when only a filter changed. */
  error: string | null;
  /** Loading an older page failed; the pages already shown stay. */
  moreError: string | null;
  /** The server has no history for this check (404). */
  notFound: boolean;
}

/** Pages of one check's history; `filters` change refetches from the newest entry. */
export function useCheckHistory(
  target: CheckHistoryTarget | null,
  filters: { branch?: string; platform?: Platform },
): HistoryState & { loadMore(): Promise<void>; refresh(): void } {
  const [state, setState] = useState<HistoryState>({ history: null, loading: true, loadingMore: false, error: null, moreError: null, notFound: false });
  const [tick, setTick] = useState(0);
  const generation = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;
  const targetRef = useRef(target);
  targetRef.current = target;
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const targetKey = JSON.stringify([target?.projectId, target?.checkKey, target?.runId, target?.checkId]);
  const lastTargetKey = useRef(targetKey);
  const key = JSON.stringify([targetKey, filters.branch, filters.platform, tick]);

  const fetchPage = useCallback((before?: string): Promise<CheckHistory> | null => {
    const t = targetRef.current;
    if (!t) return null;
    const query = { limit: HISTORY_PAGE, before, branch: filtersRef.current.branch, platform: filtersRef.current.platform };
    if (t.checkKey) return api.projectCheckHistory(t.projectId, t.checkKey, query);
    if (t.runId && t.checkId) return api.runCheckHistory(t.runId, t.checkId, query);
    return null;
  }, []);

  useEffect(() => {
    const gen = ++generation.current;
    // A filter change keeps the shown entries until the new page arrives; another check never shows this one's.
    const sameTarget = lastTargetKey.current === targetKey;
    lastTargetKey.current = targetKey;
    const first = fetchPage();
    if (!first) {
      setState({ history: null, loading: false, loadingMore: false, error: null, moreError: null, notFound: false });
      return;
    }
    setState((s) => ({ history: sameTarget ? s.history : null, loading: true, loadingMore: false, error: null, moreError: null, notFound: false }));
    first.then(
      (history) => gen === generation.current && setState({ history, loading: false, loadingMore: false, error: null, moreError: null, notFound: false }),
      (e: unknown) =>
        gen === generation.current &&
        setState((s) => ({
          history: sameTarget ? s.history : null,
          loading: false,
          loadingMore: false,
          error: errorMessage(e),
          moreError: null,
          notFound: e instanceof ApiError && e.status === 404,
        })),
    );
  }, [key, fetchPage]);

  const loadMore = useCallback(async () => {
    const { history, loadingMore } = stateRef.current;
    const last = history?.entries.at(-1);
    if (!history || !history.hasMore || loadingMore || !last) return;
    const gen = generation.current;
    setState((s) => ({ ...s, loadingMore: true, moreError: null }));
    try {
      const page = await fetchPage(last.createdAt);
      if (!page || gen !== generation.current) return;
      setState((s) => {
        if (!s.history) return s;
        const seen = new Set(s.history.entries.map((e) => `${e.runId}:${e.checkId}`));
        const more = page.entries.filter((e) => !seen.has(`${e.runId}:${e.checkId}`));
        return { ...s, loadingMore: false, history: { ...s.history, entries: [...s.history.entries, ...more], hasMore: page.hasMore } };
      });
    } catch (e) {
      if (gen === generation.current) setState((s) => ({ ...s, loadingMore: false, moreError: errorMessage(e) }));
    }
  }, [fetchPage]);

  return { ...state, loadMore, refresh: () => setTick((t) => t + 1) };
}

/** Flaky and suspect checks of a project (optionally one platform). */
export function useFlakyChecks(
  projectId: string,
  platform: Platform | null,
): { data: FlakyResponse | null; loading: boolean; error: string | null; refresh(): void } {
  const { data, loading, error, refresh } = useAsync(() => api.flakyChecks(projectId, platform ?? undefined), `flaky:${projectId}:${platform ?? "all"}`);
  return { data, loading, error, refresh };
}

// --- check history sheet store ---

interface HistorySheetState {
  open: boolean;
  target: CheckHistoryTarget | null;
}

const historySheetListeners = new Set<() => void>();
let historySheetState: HistorySheetState = { open: false, target: null };

function setHistorySheetState(next: HistorySheetState): void {
  historySheetState = next;
  for (const l of historySheetListeners) l();
}

function openHistory(target: CheckHistoryTarget): void {
  setHistorySheetState({ open: true, target });
}

function closeHistory(): void {
  // Keep the target until the exit animation is done; the next open replaces it.
  setHistorySheetState({ open: false, target: historySheetState.target });
}

/** Global store behind the check-history sheet; any view can open it. */
export function useCheckHistorySheet(): { open: boolean; target: CheckHistoryTarget | null; openHistory(target: CheckHistoryTarget): void; close(): void } {
  const state = useSyncExternalStore(
    (listener) => {
      historySheetListeners.add(listener);
      return () => void historySheetListeners.delete(listener);
    },
    () => historySheetState,
  );
  return { ...state, openHistory, close: closeHistory };
}

// --- a release this tab confirmed, so its own `revoked` event does not toast a second time ---

let ownRelease: { serial: string; ref: string } | null = null;

/** Remembers (before the request goes out; the event can beat the response) the lease this tab is releasing. */
export function noteOwnRelease(serial: string, ref: string): void {
  ownRelease = { serial, ref };
}

export function lastOwnRelease(): { serial: string; ref: string } | null {
  return ownRelease;
}

// --- devices watched for "notify me when free" ---

const WATCH_KEY = "tapocalypse-watched-devices";
const watchListeners = new Set<() => void>();
let watchedState: ReadonlySet<string> = new Set(parseWatched(readStorage(WATCH_KEY)));

function setWatched(next: ReadonlySet<string>): void {
  watchedState = next;
  writeStorage(WATCH_KEY, next.size > 0 ? JSON.stringify([...next]) : null);
  for (const l of watchListeners) l();
}

function toggleWatched(serial: string): void {
  const next = new Set(watchedState);
  if (!next.delete(serial)) next.add(serial);
  setWatched(next);
}

function unwatchDevice(serial: string): void {
  if (!watchedState.has(serial)) return;
  const next = new Set(watchedState);
  next.delete(serial);
  setWatched(next);
}

/** The Devices-page bell: serials the user wants a toast for when they become free; persisted, unknown serials kept. */
export function useWatchedDevices(): { watched: ReadonlySet<string>; toggle(serial: string): void; unwatch(serial: string): void } {
  const watched = useSyncExternalStore(
    (listener) => {
      watchListeners.add(listener);
      return () => void watchListeners.delete(listener);
    },
    () => watchedState,
  );
  return { watched, toggle: toggleWatched, unwatch: unwatchDevice };
}

/** Current watch list for non-React callers (the notifications component's event handler). */
export function isWatched(serial: string): boolean {
  return watchedState.has(serial);
}

// --- notifications preference ---

type NotificationPermissionState = NotificationPermission | "unsupported";

const NOTIFY_KEY = "tapocalypse-notify";
const notifyListeners = new Set<() => void>();

function readPermission(): NotificationPermissionState {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

interface NotifyState {
  permission: NotificationPermissionState;
  enabled: boolean;
}

function computeNotify(): NotifyState {
  const permission = readPermission();
  return { permission, enabled: permission === "granted" && readStorage(NOTIFY_KEY) === "1" };
}

let notifyState = computeNotify();

function refreshNotify(): void {
  const next = computeNotify();
  if (next.permission === notifyState.permission && next.enabled === notifyState.enabled) return;
  notifyState = next;
  for (const l of notifyListeners) l();
}

async function setNotificationsEnabled(enabled: boolean): Promise<void> {
  if (!enabled) {
    writeStorage(NOTIFY_KEY, null);
    refreshNotify();
    return;
  }
  if (typeof Notification === "undefined") {
    toast.error("This browser does not support desktop notifications");
    return;
  }
  let permission = Notification.permission;
  if (permission === "default") permission = await Notification.requestPermission();
  if (permission !== "granted") {
    toast.error("Notifications are blocked — allow them for this site in your browser settings");
    refreshNotify();
    return;
  }
  writeStorage(NOTIFY_KEY, "1");
  refreshNotify();
}

/** Browser-notification preference; `enabled` is only true while permission is granted. */
export function useNotifications(): { permission: NotificationPermissionState; enabled: boolean; setEnabled(enabled: boolean): Promise<void> } {
  const state = useSyncExternalStore(
    (listener) => {
      notifyListeners.add(listener);
      return () => void notifyListeners.delete(listener);
    },
    () => notifyState,
  );
  return { ...state, setEnabled: setNotificationsEnabled };
}

// --- keyboard shortcuts ---

interface ShortcutEntry {
  keys: string;
  handler: () => void;
}

const shortcuts = new Set<ShortcutEntry>();
const SEQUENCE_TIMEOUT_MS = 1000;
let pendingKey: string | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | undefined;
let shortcutListenerAttached = false;

/** Text-entry fields, where plain-key shortcuts must not fire. */
function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

const OVERLAY_ROLES = '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]';
const OPEN_OVERLAYS = ["dialog", "alertdialog", "menu", "listbox"].map((r) => `[role="${r}"][data-state="open"]`).join(",");

/**
 * True when a plain-key shortcut must stay inert: the key was already handled (Radix preventDefaults Escape),
 * the user is typing, or a dialog / alert dialog / menu / listbox owns the keyboard.
 */
export function keyboardClaimed(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || isEditable(e.target)) return true;
  if (e.target instanceof Element && e.target.closest(OVERLAY_ROLES)) return true;
  return document.querySelector(OPEN_OVERLAYS) !== null;
}

function onShortcutKeydown(e: KeyboardEvent): void {
  if (e.key === "Shift" || e.key === "Control" || e.key === "Meta" || e.key === "Alt") return;
  const mod = e.metaKey || e.ctrlKey;
  if (!mod && e.altKey) return;
  // Plain-key shortcuts must not fire while typing or while a dialog owns the keyboard.
  if (!mod && keyboardClaimed(e)) return;
  const base = e.key.toLowerCase();
  const token = mod ? `mod+${base}` : base;
  if (pendingKey) {
    const combo = `${pendingKey} ${token}`;
    pendingKey = null;
    clearTimeout(pendingTimer);
    for (const s of shortcuts) {
      if (s.keys === combo) {
        e.preventDefault();
        s.handler();
        return;
      }
    }
  }
  const starts = [...shortcuts].some((s) => s.keys.startsWith(`${token} `));
  if (starts) {
    pendingKey = token;
    clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => {
      pendingKey = null;
    }, SEQUENCE_TIMEOUT_MS);
    return;
  }
  for (const s of shortcuts) {
    if (s.keys === token) {
      e.preventDefault();
      s.handler();
      return;
    }
  }
}

/**
 * Registers a global shortcut. `keys`: a single key ("n", "?", "/"), `mod+<key>` (⌘ on macOS, Ctrl elsewhere)
 * or a two-key sequence ("g r"). Plain keys are ignored while typing in a field or while a dialog is open.
 */
export function useShortcut(keys: string, handler: () => void, deps: DependencyList = []): void {
  useEffect(() => {
    const entry: ShortcutEntry = { keys, handler };
    shortcuts.add(entry);
    if (!shortcutListenerAttached) {
      window.addEventListener("keydown", onShortcutKeydown);
      shortcutListenerAttached = true;
    }
    return () => {
      shortcuts.delete(entry);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys, ...deps]);
}

// --- useRunEvents ---

const ACTIVITY_CAP = 5000;
const EARLIER_PAGE = 200;
/** The newest activity a run's `snapshot` frame carries (src/api.ts `SNAPSHOT_ACTIVITY`). */
const SNAPSHOT_ACTIVITY = 200;

export function useRunEvents(id: string): {
  run: RunView | null;
  activity: Activity[];
  hasMoreActivity: boolean;
  loadEarlier(): Promise<void>;
  error: string | null;
  connected: boolean;
} {
  const [run, setRun] = useState<RunView | null>(null);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [hasMoreActivity, setHasMoreActivity] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const activityRef = useRef<Activity[]>([]);
  const loadingEarlier = useRef(false);
  const idRef = useRef(id);
  idRef.current = id;
  const liveRef = useRef(false);

  const commit = useCallback((next: Activity[]) => {
    activityRef.current = next;
    setActivity(next);
  }, []);

  useEffect(() => {
    setRun(null);
    commit([]);
    setHasMoreActivity(false);
    setError(null);
    setConnected(false);
    const source = new EventSource(`/api/runs/${encodeURIComponent(id)}/events`);
    const parse = <T>(e: Event): T => JSON.parse((e as MessageEvent<string>).data) as T;
    source.addEventListener("open", () => {
      setConnected(true);
      setError(null);
    });
    source.addEventListener("snapshot", (e) => {
      const snap = parse<{ run: RunView; activity: Activity[]; hasMoreActivity?: boolean }>(e);
      liveRef.current = Boolean(snap.run.hub?.live);
      setRun(snap.run);
      commit(snap.activity);
      setHasMoreActivity(snap.hasMoreActivity ?? false);
    });
    source.addEventListener("run", (e) => {
      const next = parse<RunView>(e);
      const wasLive = liveRef.current;
      liveRef.current = Boolean(next.hub?.live);
      setRun(next);
      // The finished upload replaces the live copy and brings its activity, which no `activity` frame carries: load it.
      if (wasLive && !liveRef.current) {
        void api.activity(next.id, null, SNAPSHOT_ACTIVITY).then(
          (page) => {
            if (idRef.current !== next.id) return;
            commit(page.items);
            setHasMoreActivity(page.hasMore);
          },
          (err: unknown) => toast.error(`Could not load the run's activity: ${errorMessage(err)}`),
        );
      }
    });
    source.addEventListener("activity", (e) => {
      const a = parse<Activity>(e);
      const prev = activityRef.current;
      const last = prev[prev.length - 1];
      // A reconnect re-sends a snapshot; ignore events already covered by it.
      if (last && a.seq <= last.seq) return;
      commit([...prev, a].slice(-ACTIVITY_CAP));
    });
    source.addEventListener("error", () => {
      setConnected(false);
      // readyState CLOSED means the browser gave up (e.g. 404 for an unknown run); CONNECTING means it is retrying.
      if (source.readyState === EventSource.CLOSED) setError("Connection to run stream lost");
    });
    const offSync = listenHubSync((runId, sync) => {
      if (runId === idRef.current) setRun((r) => (r ? { ...r, hubSync: sync } : r));
    });
    return () => {
      source.close();
      offSync();
    };
  }, [id, commit]);

  const loadEarlier = useCallback(async () => {
    const first = activityRef.current[0];
    if (!first || loadingEarlier.current) return;
    loadingEarlier.current = true;
    const requested = idRef.current;
    try {
      const page = await api.activity(requested, first.seq, EARLIER_PAGE);
      if (requested !== idRef.current) return;
      commit([...page.items, ...activityRef.current]);
      setHasMoreActivity(page.hasMore);
    } catch (e) {
      toast.error(`Could not load earlier activity: ${errorMessage(e)}`);
    } finally {
      loadingEarlier.current = false;
    }
  }, [commit]);

  return { run, activity, hasMoreActivity, loadEarlier, error, connected };
}

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
