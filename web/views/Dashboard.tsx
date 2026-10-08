import { AlertCircle, CheckCircle2, ChevronsUpDown, Clock, FolderOpen, Inbox, Loader2, Play, Plus, RotateCcw, Search, Smartphone } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { CheckStatusIcon } from "@/components/check-status-icon";
import { SourceChips } from "@/components/source-chips";
import { DeviceFrame } from "@/components/device-frame";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { VerdictBadge } from "@/components/verdict-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Card, CardContent } from "@/components/ui/card";
import { SetupChecklist } from "@/components/setup-checklist";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { api, isActive, type Backend, type Device, type Platform, type ProjectStatus, type RunView, type StartRunSource } from "@/lib/api";
import { formatDuration, formatTime } from "@/lib/format";
import { navigate, useDevices, useDoctor, useNow, useProjects, useRuns } from "@/lib/hooks";
import { cn } from "@/lib/utils";

const HISTORY_LIMIT = 50;
const PASS_RATE_WINDOW = 20;
const ALL_PROJECTS = "all";

/** Initial values of the New run form. `device` is a Select value: `any:<platform>` or `dev:<serial>`. */
interface Draft {
  projectId: string;
  device: string;
  platform: Platform;
  backend: Backend;
  packageId: string;
  title: string;
  brief: string;
  /** Source working directory; empty means the project repo root. */
  sourcePath: string;
  /** PR number as typed; empty means auto-detect. */
  prNumber: string;
}

interface SheetState {
  open: boolean;
  draft: Draft | null;
  /** Bumped on every open so the form remounts with fresh initial values. */
  nonce: number;
}

/** Re-run copies the working directory, and the PR number only when the requester gave it explicitly. */
function draftFromRun(run: RunView): Draft {
  const { serial, platform } = run.deviceRequest;
  return {
    projectId: run.projectId,
    device: serial ? `dev:${serial}` : `any:${platform}`,
    platform,
    backend: run.backend,
    packageId: run.packageId,
    title: run.title,
    brief: run.brief,
    sourcePath: run.source?.path ?? "",
    prNumber: run.source?.prStatus === "provided" && run.source.pr ? String(run.source.pr.number) : "",
  };
}

/** Matches title, branch, PR number (`609` or `#609`), ticket, or commit prefix. */
function matchesSearch(run: RunView, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const { source } = run;
  return (
    run.title.toLowerCase().includes(q) ||
    Boolean(source?.branch?.toLowerCase().includes(q)) ||
    (source?.pr?.number !== undefined && String(source.pr.number) === q.replace(/^#/, "")) ||
    Boolean(source?.tickets?.some((t) => t.toLowerCase().includes(q))) ||
    Boolean(source?.commit?.toLowerCase().startsWith(q))
  );
}

export function Dashboard({ rerunId }: { rerunId?: string }) {
  const { projects, loading: projectsLoading, error: projectsError } = useProjects();
  const ready = useMemo(() => projects.filter((p) => p.status === "ok"), [projects]);
  const newRunHint = projectsLoading
    ? "Loading projects…"
    : projects.length === 0
      ? "Add a project first"
      : ready.length === 0
        ? "No project is ready — fix a project on the Projects page"
        : null;
  const { devices } = useDevices();
  const { report: doctorReport, blocked: doctorBlocked } = useDoctor();
  const { runs, loading: runsLoading, error: runsError } = useRuns();
  const [filter, setFilter] = useState(ALL_PROJECTS);
  const [showAll, setShowAll] = useState(false);
  const [query, setQuery] = useState("");
  const [sheet, setSheet] = useState<SheetState>({ open: false, draft: null, nonce: 0 });
  const handledRerun = useRef<string | null>(null);

  const projectName = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects]);

  useEffect(() => {
    if (!rerunId || handledRerun.current === rerunId) return;
    handledRerun.current = rerunId;
    api
      .run(rerunId)
      .then((run) => setSheet((s) => ({ open: true, draft: draftFromRun(run), nonce: s.nonce + 1 })))
      .catch((err: unknown) => toast.error(err instanceof Error ? err.message : String(err)))
      .finally(() => navigate("#/"));
  }, [rerunId]);

  const visible = useMemo(
    () => runs.filter((r) => filter === ALL_PROJECTS || r.projectId === filter),
    [runs, filter],
  );
  const active = useMemo(
    () => visible.filter((r) => isActive(r.status)).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [visible],
  );
  const history = useMemo(
    () =>
      visible
        .filter((r) => !isActive(r.status) && matchesSearch(r, query))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [visible, query],
  );

  const stats = useMemo(() => {
    const running = visible.filter((r) => r.status === "running" || r.status === "preflight" || r.status === "finishing");
    const queued = visible.filter((r) => r.status === "queued");
    const free = devices.filter((d) => d.state === "ready" && !d.busyRunId).length;
    const judged = visible
      .filter((r) => r.verdict !== null)
      .sort((a, b) => (b.endedAt ?? b.createdAt).localeCompare(a.endedAt ?? a.createdAt))
      .slice(0, PASS_RATE_WINDOW);
    const passed = judged.filter((r) => r.verdict === "PASS").length;
    return { running: running.length, queued: queued.length, free, passed, judged: judged.length };
  }, [visible, devices]);

  function openNewRun() {
    const project = ready.find((p) => p.id === filter) ?? ready[0];
    if (!project) return;
    setSheet((s) => ({
      open: true,
      nonce: s.nonce + 1,
      draft: {
        projectId: project.id,
        device: `any:${project.defaultPlatform}`,
        platform: project.defaultPlatform,
        backend: "mobile-mcp",
        packageId: project.defaultPackage,
        title: "",
        brief: "",
        sourcePath: "",
        prNumber: "",
      },
    }));
  }

  const shown = showAll ? history : history.slice(0, HISTORY_LIMIT);

  const needsSetup = doctorBlocked || (!projectsLoading && !projectsError && projects.length === 0);
  const artemisAvailable = doctorReport?.backends.includes("artemis") ?? false;

  if (!projectsLoading && !projectsError && projects.length === 0) {
    return (
      <div>
        <PageHeader
          title="Runs"
          description="Parallel, agent-driven QA runs across your devices."
          actions={<NewRunButton onClick={openNewRun} hint={newRunHint} />}
        />
        {needsSetup && (
          <div className="mb-6">
            <SetupChecklist dismissible />
          </div>
        )}
        <EmptyState
          icon={FolderOpen}
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

  return (
    <div className="space-y-8">
      <PageHeader
        title="Runs"
        description="Parallel, agent-driven QA runs across your devices."
        actions={
          <div className="flex items-center gap-2">
            <Select value={filter} onValueChange={setFilter}>
              <SelectTrigger className="w-44" aria-label="Filter by project">
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
            <NewRunButton onClick={openNewRun} hint={newRunHint} />
          </div>
        }
      />

      {projectsError && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Could not load projects</AlertTitle>
          <AlertDescription>{projectsError}</AlertDescription>
        </Alert>
      )}

      {needsSetup && <SetupChecklist dismissible />}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard icon={Play} label="Running" value={String(stats.running)} loading={runsLoading && runs.length === 0} />
        <StatCard icon={Clock} label="Queued" value={String(stats.queued)} loading={runsLoading && runs.length === 0} />
        <StatCard icon={Smartphone} label="Devices free" value={String(stats.free)} loading={false} />
        <StatCard
          icon={CheckCircle2}
          label={`Pass rate · last ${PASS_RATE_WINDOW}`}
          value={stats.judged ? `${Math.round((stats.passed / stats.judged) * 100)}%` : "—"}
          hint={stats.judged ? `${stats.passed} of ${stats.judged} PASS` : "no finished runs"}
          loading={runsLoading && runs.length === 0}
        />
      </div>

      {runsError && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Could not load runs</AlertTitle>
          <AlertDescription>{runsError}</AlertDescription>
        </Alert>
      )}

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">Active</h2>
        {runsLoading && runs.length === 0 ? (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <Skeleton className="h-44 w-full" />
            <Skeleton className="h-44 w-full" />
          </div>
        ) : active.length === 0 ? (
          <EmptyState icon={Play} title="No active runs" description="Start a new run to see it here live." />
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {active.map((run) => (
              <ActiveCard key={run.id} run={run} projectName={projectName.get(run.projectId) ?? run.projectId} />
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold tracking-tight">History</h2>
          <div className="relative w-full sm:w-72">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              className="pl-8"
              placeholder="Search title, branch, PR, ticket, commit"
              aria-label="Search history"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoComplete="off"
            />
          </div>
        </div>
        {runsLoading && runs.length === 0 ? (
          <Card>
            <CardContent className="space-y-2">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </CardContent>
          </Card>
        ) : visible.every((r) => isActive(r.status)) ? (
          <EmptyState icon={Inbox} title="No finished runs yet" description="Completed runs and their verdicts appear here." />
        ) : history.length === 0 ? (
          <EmptyState icon={Search} title="No matching runs" description="No finished run matches your search." />
        ) : (
          <Card className="py-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Title</TableHead>
                  <TableHead>Project</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Requester</TableHead>
                  <TableHead>Device</TableHead>
                  <TableHead>Backend</TableHead>
                  <TableHead>Result</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead className="text-right">Duration</TableHead>
                  <TableHead className="w-24" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.map((run) => (
                  <TableRow key={run.id}>
                    <TableCell className="max-w-64 truncate font-medium">
                      <a href={`#/runs/${encodeURIComponent(run.id)}`} className="hover:underline">
                        {run.title}
                      </a>
                    </TableCell>
                    <TableCell>{projectName.get(run.projectId) ?? run.projectId}</TableCell>
                    <TableCell className="max-w-72">
                      <SourceChips source={run.source} build={run.build} compact />
                    </TableCell>
                    <TableCell className="text-muted-foreground">{run.requestedBy}</TableCell>
                    <TableCell className="font-mono text-xs">{run.deviceSerial ?? "—"}</TableCell>
                    <TableCell className="text-muted-foreground">{run.backend}</TableCell>
                    <TableCell>
                      {run.verdict ? <VerdictBadge verdict={run.verdict} /> : <StatusBadge status={run.status} />}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatTime(run.startedAt ?? run.createdAt)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {run.endedAt ? formatDuration(run.startedAt, run.endedAt, Date.parse(run.endedAt)) : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setSheet((s) => ({ open: true, draft: draftFromRun(run), nonce: s.nonce + 1 }))}
                      >
                        <RotateCcw />
                        Re-run
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {history.length > HISTORY_LIMIT && (
              <div className="flex justify-center border-t p-3">
                <Button variant="ghost" size="sm" onClick={() => setShowAll((v) => !v)}>
                  {showAll ? `Show newest ${HISTORY_LIMIT}` : `Show all (${history.length})`}
                </Button>
              </div>
            )}
          </Card>
        )}
      </section>

      <Sheet open={sheet.open} onOpenChange={(open) => setSheet((s) => ({ ...s, open }))}>
        <SheetContent side="right" className="w-full gap-0 overflow-y-auto sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>New run</SheetTitle>
            <SheetDescription>Pick a project and device, then describe what the QA agent should verify.</SheetDescription>
          </SheetHeader>
          {sheet.draft && (
            <NewRunForm key={sheet.nonce} projects={ready} devices={devices} initial={sheet.draft} artemisAvailable={artemisAvailable} />
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

/** `hint` is why the button is unavailable; null enables it. */
function NewRunButton({ onClick, hint }: { onClick(): void; hint: string | null }) {
  if (hint === null) {
    return (
      <Button onClick={onClick}>
        <Plus />
        New run
      </Button>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="inline-flex rounded-md">
          <Button disabled className="pointer-events-none">
            <Plus />
            New run
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  hint,
  loading,
}: {
  icon: typeof Play;
  label: string;
  value: string;
  hint?: string;
  loading: boolean;
}) {
  return (
    <Card className="gap-2 py-4">
      <CardContent className="space-y-1 px-4">
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>{label}</span>
          <Icon className="size-4" />
        </div>
        {loading ? (
          <Skeleton className="h-8 w-16" />
        ) : (
          <div className="text-2xl font-semibold tabular-nums">{value}</div>
        )}
        {hint && <div className="text-xs text-muted-foreground tabular-nums">{hint}</div>}
      </CardContent>
    </Card>
  );
}

function ActiveCard({ run, projectName }: { run: RunView; projectName: string }) {
  const now = useNow();
  const total = run.checks.length;
  const done = run.checks.filter((c) => c.status !== "pending" && c.status !== "running").length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const failing = run.checks.some((c) => c.status === "fail" || c.status === "blocked");
  const where = run.deviceSerial ? (
    <span className="font-mono text-xs">{run.deviceSerial}</span>
  ) : run.status === "queued" ? (
    <span>queue #{run.queuePosition ?? "?"}</span>
  ) : (
    <span>assigning device…</span>
  );

  return (
    <Card className="py-4">
      <CardContent className="flex gap-4 px-4">
        <div className="min-w-0 flex-1 space-y-3">
          <div className="space-y-1.5">
            <StatusBadge status={run.status} />
            <a
              href={`#/runs/${encodeURIComponent(run.id)}`}
              className="block truncate font-medium leading-tight hover:underline"
              title={run.title}
            >
              {run.title}
            </a>
            <div className="truncate text-xs text-muted-foreground">
              {projectName} · {run.backend} · by {run.requestedBy}
            </div>
            <div className="text-xs text-muted-foreground">{where}</div>
            <SourceChips source={run.source} build={run.build} compact />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <Progress value={pct} className={cn("h-1.5", failing && "[&>*]:bg-red-500")} />
              <span className="text-xs tabular-nums text-muted-foreground">
                {done}/{total}
              </span>
            </div>
            {total > 0 && (
              <div className="flex flex-wrap gap-1">
                {run.checks.map((c) => (
                  <span key={c.id} title={`${c.id}: ${c.title}`}>
                    <CheckStatusIcon status={c.status} className="size-3.5" />
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="text-xs tabular-nums text-muted-foreground">
            {run.startedAt
              ? `elapsed ${formatDuration(run.startedAt, null, now)}`
              : `waiting ${formatDuration(run.createdAt, null, now)}`}
          </div>
        </div>
        {run.deviceSerial && <DeviceFrame serial={run.deviceSerial} live size="sm" />}
      </CardContent>
    </Card>
  );
}

function platformOf(value: string, devices: Device[], fallback: Platform): Platform {
  if (value.startsWith("any:")) return value.slice(4) === "ios" ? "ios" : "android";
  const serial = value.slice(4);
  return devices.find((d) => d.serial === serial)?.platform ?? fallback;
}

function DeviceTag({ children }: { children: string }) {
  return (
    <span className="rounded border bg-muted px-1 py-px text-[10px] font-normal leading-none text-muted-foreground">
      {children}
    </span>
  );
}

function NewRunForm({
  projects,
  devices,
  initial,
  artemisAvailable,
}: {
  projects: ProjectStatus[];
  devices: Device[];
  initial: Draft;
  artemisAvailable: boolean;
}) {
  const [projectId, setProjectId] = useState(initial.projectId);
  const [device, setDevice] = useState(initial.device);
  const [backend, setBackend] = useState<Backend>(initial.backend);
  const [packageId, setPackageId] = useState(initial.packageId);
  const [title, setTitle] = useState(initial.title);
  const [brief, setBrief] = useState(initial.brief);
  const [sourcePath, setSourcePath] = useState(initial.sourcePath);
  const [prNumber, setPrNumber] = useState(initial.prNumber);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const platform = platformOf(device, devices, initial.platform);
  const artemisDisabled = platform === "ios";
  const effectiveBackend: Backend = artemisAvailable && !artemisDisabled ? backend : "mobile-mcp";

  function changeProject(id: string) {
    setProjectId(id);
    const project = projects.find((p) => p.id === id);
    if (!project) return;
    setPackageId(project.defaultPackage);
    if (device.startsWith("any:")) setDevice(`any:${project.defaultPlatform}`);
    setSourcePath("");
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const prText = prNumber.trim().replace(/^#/, "");
    if (prText && !/^[1-9]\d*$/.test(prText)) {
      setError("PR number must be a positive integer");
      return;
    }
    setSubmitting(true);
    try {
      const project = projects.find((p) => p.id === projectId);
      const serial = device.startsWith("dev:") ? device.slice(4) : undefined;
      const path = sourcePath.trim();
      const source: StartRunSource = {};
      if (path) source.path = path;
      if (prText) source.prNumber = Number(prText);
      const run = await api.startRun({
        projectId,
        title: title.trim(),
        brief: brief.trim(),
        device: serial ? { platform, serial } : { platform },
        backend: effectiveBackend,
        packageId: packageId.trim() || project?.defaultPackage || "",
        ...(Object.keys(source).length > 0 ? { source } : {}),
      });
      toast.success(`Run queued: ${run.title}`);
      navigate(`#/runs/${encodeURIComponent(run.id)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-5 p-4 pt-0">
      {error && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Could not start run</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="space-y-2">
        <Label htmlFor="nr-project">Project</Label>
        <Select value={projectId} onValueChange={changeProject}>
          <SelectTrigger id="nr-project" className="w-full">
            <SelectValue placeholder="Select a project" />
          </SelectTrigger>
          <SelectContent>
            {projects.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label htmlFor="nr-device">Device</Label>
        <Select value={device} onValueChange={setDevice}>
          <SelectTrigger id="nr-device" className="w-full">
            <SelectValue placeholder="Select a device" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectLabel>Any available</SelectLabel>
              <SelectItem value="any:android">Any android</SelectItem>
              <SelectItem value="any:ios">Any ios</SelectItem>
            </SelectGroup>
            {devices.length > 0 && <SelectSeparator />}
            {devices.length > 0 && (
              <SelectGroup>
                <SelectLabel>Connected devices</SelectLabel>
                {devices.map((d) => (
                  <SelectItem key={d.serial} value={`dev:${d.serial}`} disabled={d.state === "booting"}>
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="font-mono text-xs">{d.serial}</span>
                      {d.state === "booting" ? (
                        <DeviceTag>booting…</DeviceTag>
                      ) : (
                        <>
                          <span className="text-muted-foreground">
                            · {d.model || d.kind} · {d.screen || "?"}
                          </span>
                          {d.busyRunId && <DeviceTag>busy</DeviceTag>}
                          {artemisAvailable && d.artemisOwner && <DeviceTag>Artemis task</DeviceTag>}
                          {artemisAvailable && d.artemisHelper && <DeviceTag>helper on</DeviceTag>}
                          {d.bootedByTapocalypse && <DeviceTag>booted by tapocalypse</DeviceTag>}
                        </>
                      )}
                    </span>
                  </SelectItem>
                ))}
              </SelectGroup>
            )}
          </SelectContent>
        </Select>
      </div>

      {artemisAvailable && (
        <div className="space-y-2">
          <Label>Backend</Label>
          <TooltipProvider>
            <RadioGroup
              value={effectiveBackend}
              onValueChange={(v) => setBackend(v === "artemis" ? "artemis" : "mobile-mcp")}
              className="grid grid-cols-2 gap-3"
            >
              <BackendOption value="mobile-mcp" title="mobile-mcp" description="Android and iOS" />
              <BackendOption
                value="artemis"
                title="artemis"
                description="Android only"
                disabled={artemisDisabled}
                disabledReason="Artemis is Android-only"
              />
            </RadioGroup>
          </TooltipProvider>
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="nr-package">Package</Label>
        <Input
          id="nr-package"
          className="font-mono"
          value={packageId}
          onChange={(e) => setPackageId(e.target.value)}
          autoComplete="off"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="nr-title">Title</Label>
        <Input
          id="nr-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          autoComplete="off"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="nr-brief">Brief</Label>
        <Textarea id="nr-brief" rows={12} value={brief} onChange={(e) => setBrief(e.target.value)} required />
      </div>

      <Collapsible defaultOpen={Boolean(initial.sourcePath || initial.prNumber)} className="space-y-3">
        <CollapsibleTrigger asChild>
          <Button type="button" variant="ghost" size="sm" className="-ml-2">
            <ChevronsUpDown />
            Source (optional)
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="nr-source-path">Working directory</Label>
            <Input
              id="nr-source-path"
              className="font-mono"
              placeholder="project repo root"
              value={sourcePath}
              onChange={(e) => setSourcePath(e.target.value)}
              autoComplete="off"
            />
            <p className="text-xs text-muted-foreground">
              Absolute path of a git worktree of the project, to record its branch, commit and PR.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="nr-source-pr">PR number</Label>
            <Input
              id="nr-source-pr"
              className="font-mono"
              inputMode="numeric"
              placeholder="auto-detect from branch"
              value={prNumber}
              onChange={(e) => setPrNumber(e.target.value)}
              autoComplete="off"
            />
          </div>
        </CollapsibleContent>
      </Collapsible>

      <Button type="submit" disabled={submitting || !projectId}>
        {submitting ? <Loader2 className="animate-spin" /> : <Play />}
        {submitting ? "Starting…" : "Start run"}
      </Button>
    </form>
  );
}

function BackendOption({
  value,
  title,
  description,
  disabled,
  disabledReason,
}: {
  value: Backend;
  title: string;
  description: string;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const id = `nr-backend-${value}`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div>
          <Label
            htmlFor={id}
            className={cn(
              "flex items-start gap-3 rounded-lg border p-3 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-accent",
              disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
            )}
          >
            <RadioGroupItem id={id} value={value} disabled={disabled} className="mt-0.5" />
            <span className="space-y-0.5">
              <span className="block text-sm font-medium">{title}</span>
              <span className="block text-xs font-normal text-muted-foreground">{description}</span>
            </span>
          </Label>
        </div>
      </TooltipTrigger>
      {disabled && disabledReason && <TooltipContent>{disabledReason}</TooltipContent>}
    </Tooltip>
  );
}
