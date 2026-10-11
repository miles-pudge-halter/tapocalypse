import { AlertCircle, ArrowDown, ChevronDown, Inbox, Loader2, Plus, Search, SearchX, X } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Lockup } from "@/components/brand";
import { BatchRow, RunActions, RunRow } from "@/components/run-row";
import { RunStatusIcon } from "@/components/run-status-icon";
import { SegmentedProgress } from "@/components/segmented-progress";
import { VERDICT_DOT } from "@/components/verdict-badge";
import { SetupBanner } from "@/components/setup-checklist";
import { DeviceFrame } from "@/components/device-frame";
import { LeaseRing } from "@/components/lease-ring";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Toggle } from "@/components/ui/toggle";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { isActive, runHash, type Device, type RunStatus, type RunView, type Verdict } from "@/lib/api";
import { deviceDisplayName, formatCost, formatDuration } from "@/lib/format";
import { deviceCounts, heldSummary } from "@/lib/leases";
import {
  setRunFilters,
  useActiveRuns,
  useDevices,
  useNewRun,
  useNow,
  useProjects,
  useProjectScope,
  useRoute,
  useRuns,
  useShortcut,
  useStats,
  useTemplates,
  type RunFilters,
} from "@/lib/hooks";
import { cn } from "@/lib/utils";

const TERMINAL_STATUSES: RunStatus[] = ["done", "error", "cancelled", "interrupted"];
const ALL_STATUSES: RunStatus[] = ["queued", "preflight", "running", "finishing", ...TERMINAL_STATUSES];
const RUNNING_STATUSES: RunStatus[] = ["preflight", "running", "finishing"];
const ALL_VERDICTS: Verdict[] = ["PASS", "PASS WITH ISSUES", "FAIL", "BLOCKED", "PARTIAL"];
const ALL_PROJECTS = "all";
const SEARCH_DEBOUNCE_MS = 250;
const GROUPS = [
  { value: "day", label: "Day" },
  { value: "batch", label: "Batch" },
  { value: "none", label: "None" },
] as const;

const STATUS_DOT: Record<RunStatus, string> = {
  queued: "bg-slate-400",
  preflight: "bg-blue-500",
  running: "bg-blue-500",
  finishing: "bg-violet-500",
  done: "bg-emerald-500",
  error: "bg-red-500",
  cancelled: "bg-stone-500",
  interrupted: "bg-orange-400",
};

type Item = { kind: "run"; run: RunView } | { kind: "batch"; id: string; runs: RunView[] };

/**
 * Collapses runs sharing a batchId into one item at the position of the batch's newest run. Batches that still
 * have an active lane stay as individual runs: history only holds their finished lanes, so a rolled-up row would
 * count too few lanes and report a verdict that ignores the running one.
 */
function toItems(runs: RunView[], activeBatchIds: ReadonlySet<string>): Item[] {
  const items: Item[] = [];
  const batches = new Map<string, Extract<Item, { kind: "batch" }>>();
  for (const run of runs) {
    if (!run.batchId || activeBatchIds.has(run.batchId)) {
      items.push({ kind: "run", run });
      continue;
    }
    const existing = batches.get(run.batchId);
    if (existing) {
      existing.runs.push(run);
      continue;
    }
    const batch: Extract<Item, { kind: "batch" }> = { kind: "batch", id: run.batchId, runs: [run] };
    batches.set(run.batchId, batch);
    items.push(batch);
  }
  return items;
}

function itemRuns(item: Item): RunView[] {
  return item.kind === "run" ? [item.run] : item.runs;
}

function dayLabel(iso: string, now: number): string {
  const date = new Date(iso);
  const today = new Date(now);
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOfDay(today) - startOfDay(date)) / 86_400_000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return date.toLocaleDateString(undefined, {
    weekday: diffDays < 7 ? "long" : undefined,
    month: "short",
    day: "numeric",
    year: date.getFullYear() === today.getFullYear() ? undefined : "numeric",
  });
}

function groupByDay(items: Item[], now: number): { label: string; items: Item[] }[] {
  const groups: { label: string; items: Item[] }[] = [];
  for (const item of items) {
    const first = itemRuns(item)[0];
    if (!first) continue;
    const label = dayLabel(first.createdAt, now);
    const last = groups.at(-1);
    if (last?.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}

function describeFilters(filters: RunFilters, projectName: string | null): string {
  const parts: string[] = [];
  if (filters.status?.length) parts.push(`status: ${filters.status.join(", ")}`);
  if (filters.verdict?.length) parts.push(`verdict: ${filters.verdict.join(", ")}`);
  if (projectName) parts.push(`project: ${projectName}`);
  if (filters.q) parts.push(`search: “${filters.q}”`);
  if (filters.regressed) parts.push("with newly failing checks");
  return parts.join(" · ");
}

export function Dashboard() {
  const route = useRoute();
  const filters: RunFilters = useMemo(() => (route.name === "runs" ? route.filters : {}), [route]);
  const { projects, loading: projectsLoading, error: projectsError } = useProjects();
  const { projectId: scopeProject } = useProjectScope();
  const { devices } = useDevices();
  const { openNewRun } = useNewRun();
  const now = useNow();
  const searchRef = useRef<HTMLInputElement>(null);

  const ready = useMemo(() => projects.filter((p) => p.status === "ok"), [projects]);
  const project = filters.project ?? scopeProject ?? undefined;
  const projectName = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects]);
  const deviceNames = useMemo(() => new Map(devices.map((d) => [d.serial, deviceDisplayName(d)])), [devices]);
  const deviceBySerial = useMemo(() => new Map(devices.map((d) => [d.serial, d])), [devices]);

  const showsActive = filters.status?.some(isActive) ?? false;
  const historyFilters = useMemo<RunFilters>(
    () => ({
      project,
      status: filters.status?.length ? filters.status : TERMINAL_STATUSES,
      verdict: filters.verdict,
      q: filters.q,
      regressed: filters.regressed,
    }),
    [project, filters.status, filters.verdict, filters.q, filters.regressed],
  );
  const activeStore = useActiveRuns();
  const activeBatchIds = useMemo(() => new Set(activeStore.runs.flatMap((r) => (r.batchId ? [r.batchId] : []))), [activeStore.runs]);
  const activeRuns = useMemo(
    () => ({ ...activeStore, runs: project ? activeStore.runs.filter((r) => r.projectId === project) : activeStore.runs }),
    [activeStore, project],
  );
  const history = useRuns(historyFilters);
  const refreshAll = history.refresh;

  useShortcut("/", () => searchRef.current?.focus());

  const newRunHint = projectsLoading
    ? "Loading projects…"
    : projects.length === 0
      ? "Add a project first"
      : ready.length === 0
        ? "No project is ready — fix a project on the Projects page"
        : null;

  const newRunButton =
    newRunHint === null ? (
      <Button onClick={() => openNewRun({ projectId: project })}>
        <Plus />
        New run
      </Button>
    ) : (
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} className="inline-flex rounded-md">
            <Button disabled className="pointer-events-none">
              <Plus />
              New run
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>{newRunHint}</TooltipContent>
      </Tooltip>
    );

  const header = (
    <PageHeader title="Runs" description="Parallel, agent-driven QA runs across your devices." actions={newRunButton} />
  );

  if (!projectsLoading && !projectsError && projects.length === 0) {
    return (
      <div>
        <SetupBanner />
        {header}
        <EmptyState
          media={<Lockup size="lg" />}
          title="Add your first project"
          description="A project tells Tapocalypse where your app's repository lives. Point it at a folder and it detects the framework, package name and QA persona for you."
          action={
            <Button asChild>
              <a href="#/projects?new=1">
                <Plus />
                Add your first project
              </a>
            </Button>
          }
        />
      </div>
    );
  }

  const active = [...activeRuns.runs].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const filtered = Boolean(filters.status?.length || filters.verdict?.length || filters.q || filters.project);

  return (
    <div className="space-y-5">
      <SetupBanner />
      {header}

      {projectsError && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Could not load projects</AlertTitle>
          <AlertDescription>{projectsError}</AlertDescription>
        </Alert>
      )}

      <LiveStrip
        project={project}
        filters={filters}
        running={activeRuns.runs.filter((r) => RUNNING_STATUSES.includes(r.status)).length}
        queued={activeRuns.runs.filter((r) => r.status === "queued").length}
        devices={devices}
        loading={activeRuns.loading && activeRuns.runs.length === 0}
      />

      {!showsActive && active.length > 0 && (
        <section aria-label="Active runs" className="space-y-2">
          <h2 className="text-sm font-semibold text-muted-foreground">Active · {active.length}</h2>
          <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
            {active.map((run) => (
              <ActiveCard
                key={run.id}
                run={run}
                device={run.deviceSerial ? deviceBySerial.get(run.deviceSerial) : undefined}
                projectName={projectName.get(run.projectId) ?? run.projectId}
                deviceName={run.deviceName ?? (run.deviceSerial ? (deviceNames.get(run.deviceSerial) ?? run.deviceSerial) : null)}
                now={now}
                onChanged={refreshAll}
              />
            ))}
          </div>
        </section>
      )}
      {!showsActive && activeRuns.loading && activeRuns.runs.length === 0 && (
        <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
          <Skeleton className="h-36 w-full" />
          <Skeleton className="hidden h-36 w-full md:block" />
        </div>
      )}

      <FilterBar
        filters={filters}
        projectValue={project ?? ALL_PROJECTS}
        searchRef={searchRef}
        projects={projects.map((p) => ({ id: p.id, name: p.name }))}
      />

      <HistorySection
        runs={history.runs}
        loading={history.loading}
        error={history.error}
        hasMore={history.hasMore}
        loadingMore={history.loadingMore}
        loadMore={history.loadMore}
        group={filters.group ?? "day"}
        filtered={filtered}
        filterText={describeFilters(filters, filters.project ? (projectName.get(filters.project) ?? filters.project) : null)}
        hasActive={active.length > 0}
        projectName={projectName}
        activeBatchIds={activeBatchIds}
        deviceNames={deviceNames}
        now={now}
        onChanged={refreshAll}
        newRunProject={project}
        ready={ready.length > 0}
      />
    </div>
  );
}

function LiveStrip({
  project,
  filters,
  running,
  queued,
  devices,
  loading,
}: {
  project: string | undefined;
  filters: RunFilters;
  running: number;
  queued: number;
  devices: Device[];
  loading: boolean;
}) {
  const { stats, loading: statsLoading } = useStats(project, 7);
  const { usable, busy } = deviceCounts(devices);
  const held = heldSummary(devices);
  const judged = stats ? stats.pass + stats.fail + stats.issues : 0;

  const segment = "flex items-center gap-1.5 rounded-md px-2 py-1 text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
  const divider = <span aria-hidden="true" className="hidden h-4 w-px bg-border sm:block" />;

  return (
    <div className="flex flex-wrap items-center gap-x-1 gap-y-1 rounded-lg border bg-card px-2 py-1.5 tabular-nums">
      {loading ? (
        <Skeleton className="h-6 w-64" />
      ) : (
        <>
          <button
            type="button"
            className={segment}
            onClick={() => setRunFilters({ ...filters, status: RUNNING_STATUSES })}
            title="Show running runs"
          >
            <span className={cn("size-2 rounded-full", running > 0 ? "animate-pulse bg-blue-500" : "bg-muted-foreground/40")} />
            <strong className="font-semibold">{running}</strong> running
          </button>
          {divider}
          <button type="button" className={segment} onClick={() => setRunFilters({ ...filters, status: ["queued"] })} title="Show queued runs">
            <strong className="font-semibold">{queued}</strong> queued
          </button>
          {divider}
          <a href="#/devices" className={segment} title="Open Devices">
            <strong className="font-semibold">
              {busy}/{usable}
            </strong>{" "}
            devices busy
          </a>
          {held && (
            <>
              {divider}
              <a href="#/devices" className={segment} title={held.title}>
                <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-violet-500/40 bg-violet-50 px-2 py-0.5 text-xs font-medium text-violet-800 dark:bg-violet-950/40 dark:text-violet-300">
                  <LeaseRing size={12} lease={held.earliest} />
                  {held.label}
                </span>
              </a>
            </>
          )}
        </>
      )}
      {divider}
      {statsLoading && !stats ? (
        <Skeleton className="mx-2 h-5 w-40" />
      ) : (
        <>
          <button
            type="button"
            className={segment}
            onClick={() => setRunFilters({ ...filters, verdict: ["PASS"] })}
            title="Show passing runs"
          >
            Pass rate{" "}
            <strong className="font-semibold">{judged > 0 && stats ? `${Math.round((stats.pass / judged) * 100)}%` : "—"}</strong>
            {judged > 0 && stats && (
              <span className="text-muted-foreground">
                ({stats.pass}/{judged}) · 7d
              </span>
            )}
          </button>
          {divider}
          <span className={cn(segment, "cursor-default hover:bg-transparent")}>
            Spend <strong className="font-semibold">{formatCost(stats?.cost ?? null)}</strong>
            <span className="text-muted-foreground">· 7d</span>
          </span>
        </>
      )}
    </div>
  );
}

function ActiveCard({
  run,
  device,
  projectName,
  deviceName,
  now,
  onChanged,
}: {
  run: RunView;
  device: Device | undefined;
  projectName: string;
  deviceName: string | null;
  now: number;
  onChanged(): void;
}) {
  const current = run.checks.find((c) => c.status === "running");
  const queued = run.status === "queued";
  const reason =
    run.queueReason ??
    (run.deviceRequest.serial ? `waiting for ${run.deviceRequest.serial}` : `waiting for a free ${run.deviceRequest.platform} device`);

  return (
    <Card className="relative flex-row gap-3 p-3">
      <DeviceFrame serial={run.deviceSerial} live device={device} platform={run.deviceRequest.platform} size="tile" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex items-start gap-2">
          <RunStatusIcon status={run.status} verdict={run.verdict} className="mt-0.5 size-4 shrink-0" />
          <a
            href={runHash(run.id)}
            className="min-w-0 flex-1 truncate text-sm font-medium after:absolute after:inset-0 hover:underline focus-visible:outline-none"
            title={run.title}
          >
            {run.title}
          </a>
          <RunActions run={run} onChanged={onChanged} />
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {[projectName, deviceName ?? (queued ? null : "assigning device…"), run.requestedBy].filter(Boolean).join(" · ")}
        </div>
        {queued ? (
          <div className="text-xs">
            <span className="font-medium">Queue #{run.queuePosition ?? "?"}</span>
            <span className="text-muted-foreground"> · {reason}</span>
          </div>
        ) : current ? (
          <div className="flex min-w-0 items-center gap-1.5 text-xs">
            <Loader2 className="size-3 shrink-0 animate-spin text-blue-500" />
            <span className="truncate">
              <span className="font-mono">{current.id}</span> · {current.title}
            </span>
          </div>
        ) : (
          <div className="text-xs capitalize text-muted-foreground">{run.status}…</div>
        )}
        <div className="mt-auto space-y-1.5">
          <SegmentedProgress checks={run.checks} size="md" />
          <div className="text-xs tabular-nums text-muted-foreground">
            {run.startedAt
              ? `elapsed ${formatDuration(run.startedAt, null, now)}`
              : `waiting ${formatDuration(run.createdAt, null, now)}`}
          </div>
        </div>
      </div>
    </Card>
  );
}

function FilterBar({
  filters,
  projectValue,
  projects,
  searchRef,
}: {
  filters: RunFilters;
  projectValue: string;
  projects: { id: string; name: string }[];
  searchRef: RefObject<HTMLInputElement | null>;
}) {
  const { setProjectId } = useProjectScope();
  const [q, setQ] = useState(filters.q ?? "");
  const group = filters.group ?? "day";
  const filterCount = (filters.status?.length ?? 0) + (filters.verdict?.length ?? 0) + (filters.q ? 1 : 0) + (filters.project ? 1 : 0) + (filters.regressed ? 1 : 0);

  useEffect(() => setQ(filters.q ?? ""), [filters.q]);
  useEffect(() => {
    if (q.trim() === (filters.q ?? "")) return;
    const timer = setTimeout(() => setRunFilters({ ...filters, q: q.trim() || undefined }), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [q, filters]);

  function changeProject(value: string) {
    if (value === ALL_PROJECTS) {
      setProjectId(null);
      setRunFilters({ ...filters, project: undefined });
    } else {
      setRunFilters({ ...filters, project: value });
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative w-full sm:w-64">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={searchRef}
          type="search"
          className="h-8 pl-8"
          placeholder="Search title, branch, PR, ticket…  ( / )"
          aria-label="Search runs"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoComplete="off"
        />
      </div>
      <MultiFilter
        label="Status"
        options={ALL_STATUSES}
        selected={filters.status ?? []}
        dot={(s) => STATUS_DOT[s]}
        text={(s) => s.charAt(0).toUpperCase() + s.slice(1)}
        onChange={(status) => setRunFilters({ ...filters, status })}
        hint="None selected shows finished runs"
      />
      <MultiFilter
        label="Verdict"
        options={ALL_VERDICTS}
        selected={filters.verdict ?? []}
        dot={(v) => VERDICT_DOT[v]}
        text={(v) => v}
        onChange={(verdict) => setRunFilters({ ...filters, verdict })}
      />
      <Tooltip>
        <TooltipTrigger asChild>
          <Toggle
            variant="outline"
            size="sm"
            className="h-8 data-[state=on]:border-ring/60 data-[state=on]:bg-accent"
            pressed={filters.regressed === true}
            onPressedChange={(on) => setRunFilters({ ...filters, regressed: on ? true : undefined })}
          >
            <ArrowDown className="text-red-500" />
            Has regressions
          </Toggle>
        </TooltipTrigger>
        <TooltipContent>Finished runs with checks that passed in their baseline and fail now</TooltipContent>
      </Tooltip>
      <Select value={projectValue} onValueChange={changeProject}>
        <SelectTrigger size="sm" className="w-40" aria-label="Filter by project">
          <SelectValue placeholder="All projects" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_PROJECTS}>All projects</SelectItem>
          {projects.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div role="radiogroup" aria-label="Group by" className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
        <span className="mr-1">Group by</span>
        {GROUPS.map((g) => (
          <Button
            key={g.value}
            type="button"
            role="radio"
            aria-checked={group === g.value}
            variant={group === g.value ? "secondary" : "ghost"}
            size="sm"
            className="h-7 px-2"
            onClick={() => setRunFilters({ ...filters, group: g.value })}
          >
            {g.label}
          </Button>
        ))}
      </div>
      {filterCount > 0 && (
        <Button type="button" variant="ghost" size="sm" className="h-7" onClick={() => setRunFilters({ group: filters.group })}>
          <X />
          Clear ({filterCount})
        </Button>
      )}
    </div>
  );
}

function MultiFilter<T extends string>({
  label,
  options,
  selected,
  dot,
  text,
  onChange,
  hint,
}: {
  label: string;
  options: readonly T[];
  selected: T[];
  dot(option: T): string;
  text(option: T): string;
  onChange(next: T[]): void;
  hint?: string;
}) {
  function toggle(option: T, on: boolean) {
    onChange(on ? [...selected, option] : selected.filter((s) => s !== option));
  }
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className={cn("h-8", selected.length > 0 && "border-ring/60")}>
          {label}
          {selected.length > 0 && (
            <span className="rounded-full bg-primary px-1.5 text-[10px] font-semibold leading-4 text-primary-foreground">{selected.length}</span>
          )}
          <ChevronDown className="opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-1">
        {options.map((option) => (
          <label key={option} className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent">
            <Checkbox checked={selected.includes(option)} onCheckedChange={(v) => toggle(option, v === true)} />
            <span className={cn("size-2 shrink-0 rounded-full", dot(option))} />
            {text(option)}
          </label>
        ))}
        {hint && <p className="px-2 pb-1 pt-1.5 text-xs text-muted-foreground">{hint}</p>}
      </PopoverContent>
    </Popover>
  );
}

function VerdictStack({ runs }: { runs: RunView[] }) {
  const pass = runs.filter((r) => r.verdict === "PASS").length;
  const issues = runs.filter((r) => r.verdict === "PASS WITH ISSUES" || r.verdict === "PARTIAL").length;
  const fail = runs.filter((r) => r.verdict === "FAIL" || r.verdict === "BLOCKED").length;
  const other = runs.length - pass - issues - fail;
  return (
    <span className="flex items-center gap-2 tabular-nums">
      {pass > 0 && <span className="text-emerald-600 dark:text-emerald-400">{pass} ✓</span>}
      {issues > 0 && <span className="text-orange-700 dark:text-orange-400">{issues} ⚠</span>}
      {fail > 0 && <span className="text-red-600 dark:text-red-400">{fail} ✗</span>}
      {other > 0 && <span>{other} ⊘</span>}
    </span>
  );
}

function GroupHeader({ label, runs }: { label: string; runs: RunView[] }) {
  return (
    <div className="flex items-center gap-3 border-b bg-muted/40 px-3 py-1.5 text-xs font-medium text-muted-foreground">
      <span className="text-foreground">{label}</span>
      <span>
        {runs.length} run{runs.length === 1 ? "" : "s"}
      </span>
      <VerdictStack runs={runs} />
    </div>
  );
}

interface HistoryProps {
  runs: RunView[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  loadingMore: boolean;
  loadMore(): Promise<void>;
  group: "day" | "batch" | "none";
  filtered: boolean;
  filterText: string;
  hasActive: boolean;
  projectName: Map<string, string>;
  activeBatchIds: ReadonlySet<string>;
  deviceNames: Map<string, string>;
  now: number;
  onChanged(): void;
  newRunProject: string | undefined;
  ready: boolean;
}

function HistorySection(props: HistoryProps) {
  const { runs, loading, error, group, now } = props;
  const items = useMemo(() => toItems(runs, props.activeBatchIds), [runs, props.activeBatchIds]);
  const { openNewRun } = useNewRun();
  const { templates } = useTemplates();

  if (loading && runs.length === 0) {
    return (
      <Card className="@container gap-0 divide-y py-0">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="flex items-center gap-3 px-3 py-2">
            <Skeleton className="size-4 rounded-full" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-3 w-3/4" />
            </div>
            <Skeleton className="hidden h-3 w-28 @2xl:block" />
            <Skeleton className="h-3 w-12" />
          </div>
        ))}
      </Card>
    );
  }

  if (error && runs.length === 0) {
    return (
      <Alert variant="destructive">
        <AlertCircle />
        <AlertTitle>Could not load runs</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }

  if (runs.length === 0) {
    if (props.filtered) {
      return (
        <EmptyState
          icon={SearchX}
          title="No runs match your filters"
          description={props.filterText}
          action={
            <Button variant="outline" onClick={() => setRunFilters({ group })}>
              <X />
              Clear filters
            </Button>
          }
        />
      );
    }
    if (props.hasActive) {
      return <EmptyState icon={Inbox} title="No finished runs yet" description="Completed runs and their verdicts appear here." />;
    }
    const smoke = templates.find((t) => t.id === "smoke");
    const quickStart = (platform: "android" | "ios") => (
      <Button
        key={platform}
        variant="outline"
        size="sm"
        disabled={!props.ready}
        onClick={() =>
          openNewRun({
            projectId: props.newRunProject,
            device: { platform },
            ...(smoke ? { title: smoke.title, brief: smoke.brief } : {}),
          })
        }
      >
        Smoke test on Any {platform === "ios" ? "iOS" : "Android"}
      </Button>
    );
    return (
      <EmptyState
        icon={Inbox}
        title="No runs yet"
        description={
          <>
            Start one here, or let an agent start one through MCP (<code className="font-mono text-xs">qa_start_run</code>).
          </>
        }
        action={
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button disabled={!props.ready} onClick={() => openNewRun({ projectId: props.newRunProject })}>
              <Plus />
              New run
            </Button>
            {quickStart("android")}
            {quickStart("ios")}
          </div>
        }
      />
    );
  }

  const row = (item: Item, nested = false): ReactNode => {
    if (item.kind === "batch") {
      return (
        <BatchRow
          key={item.id}
          batchId={item.id}
          runs={item.runs}
          projectName={props.projectName.get(item.runs[0]?.projectId ?? "") ?? ""}
          now={now}
          onChanged={props.onChanged}
        />
      );
    }
    const run = item.run;
    return (
      <RunRow
        key={run.id}
        run={run}
        projectName={props.projectName.get(run.projectId) ?? run.projectId}
        deviceName={run.deviceSerial ? (props.deviceNames.get(run.deviceSerial) ?? null) : null}
        now={now}
        onChanged={props.onChanged}
        nested={nested}
      />
    );
  };

  let body: ReactNode;
  if (group === "day") {
    body = groupByDay(items, now).map((g) => (
      <Fragment key={g.label}>
        <GroupHeader label={g.label} runs={g.items.flatMap(itemRuns)} />
        <div className="divide-y border-b last:border-b-0">{g.items.map((item) => row(item))}</div>
      </Fragment>
    ));
  } else if (group === "batch") {
    const batches: Extract<Item, { kind: "batch" }>[] = [];
    const singles: Item[] = [];
    for (const item of items) {
      if (item.kind === "batch") batches.push(item);
      else singles.push(item);
    }
    body = (
      <>
        {batches.map((batch) => (
          <div key={batch.id} className="divide-y border-b">
            {row(batch)}
            {batch.runs.map((r) => row({ kind: "run", run: r }, true))}
          </div>
        ))}
        {singles.length > 0 && (
          <Fragment>
            <GroupHeader label="Single runs" runs={singles.flatMap(itemRuns)} />
            <div className="divide-y">{singles.map((item) => row(item))}</div>
          </Fragment>
        )}
      </>
    );
  } else {
    body = <div className="divide-y">{items.map((item) => row(item))}</div>;
  }

  return (
    <section className="space-y-3" aria-label="Run history">
      <Card className="@container gap-0 py-0">{body}</Card>
      {error && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Could not refresh runs</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {props.hasMore && (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" disabled={props.loadingMore} onClick={() => void props.loadMore()}>
            {props.loadingMore && <Loader2 className="animate-spin" />}
            Load more
          </Button>
        </div>
      )}
    </section>
  );
}
