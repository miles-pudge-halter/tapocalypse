import { AlertCircle, Link2, Loader2 } from "lucide-react";
import { useEffect, useRef } from "react";
import { toast } from "sonner";

import { ChangesCard } from "@/components/hub/changes-card";
import { Freshness } from "@/components/hub/freshness";
import { KpiSkeleton, KpiTiles } from "@/components/hub/kpi-tiles";
import { LaneGrid } from "@/components/hub/lane-grid";
import { TrendCard } from "@/components/hub/pass-rate-trend";
import { RefPicker } from "@/components/hub/ref-picker";
import { briefAttribution } from "@/lib/hub";
import { RunRow } from "@/components/run-row";
import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { type OverviewShow, overviewHash, parseRef } from "@/lib/api";
import { formatRelative } from "@/lib/format";
import { runsHash, useNow, useOverview, useProjects } from "@/lib/hooks";
import { firstSyncInProgress, refRunFilters } from "@/lib/hub";
import { isHub } from "@/lib/mode";
import { cn } from "@/lib/utils";

/** A page's trail: `Overview / Acme App`. */
export function Breadcrumb({ items }: { items: { label: string; href?: string }[] }) {
  return (
    <nav aria-label="Breadcrumb" className="mb-2 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      {items.map((item, i) => (
        <span key={item.label} className="flex min-w-0 items-center gap-1.5">
          {i > 0 && <span aria-hidden>/</span>}
          {item.href ? (
            <a href={item.href} className="hover:text-foreground hover:underline">
              {item.label}
            </a>
          ) : (
            <span className="truncate">{item.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}

function copyViewLink() {
  navigator.clipboard.writeText(location.href).then(
    () => toast.success("Link copied", { description: "Anyone who can sign in to the hub can open it." }),
    () => toast.error("Could not copy to the clipboard"),
  );
}

function LoadingState() {
  return (
    <div className="space-y-4" aria-label="Loading the overview">
      <div className="space-y-2">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <KpiSkeleton />
      <div className="grid gap-3 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Skeleton className="h-56" />
        <Skeleton className="h-56" />
      </div>
      <LaneGrid lanes={null} projectId="" show={null} onShowChange={() => {}} />
      <Skeleton className="h-40" />
    </div>
  );
}

/** The stakeholder landing page of a project: pass rate, what is failing, what changed since the last release, latest result per test. */
export function Overview({ projectId, refValue, show }: { projectId: string; refValue: string | null; show?: OverviewShow }) {
  const ref = parseRef(refValue);
  const hub = isHub();
  const { overview, loading, error, missing, fetchedAt, refresh } = useOverview(projectId, ref);
  const { projects } = useProjects();
  const now = useNow(30_000);
  const grid = useRef<HTMLDivElement>(null);
  const firstShow = useRef(show);

  // Following a KPI tile (Failing now, Newly failing) should land on the results it filters.
  useEffect(() => {
    if (show && show !== firstShow.current) grid.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    firstShow.current = show;
  }, [show]);

  if (loading && !overview) return <LoadingState />;
  if (missing === "ref" && ref) {
    return (
      <Alert>
        <AlertCircle />
        <AlertTitle>No runs for {ref.name}</AlertTitle>
        <AlertDescription>
          <a className="underline underline-offset-2" href={overviewHash(projectId)}>
            Show all branches
          </a>
        </AlertDescription>
      </Alert>
    );
  }
  if (missing !== null) {
    return (
      <Alert variant="destructive">
        <AlertCircle />
        <AlertTitle>This project is not on the hub</AlertTitle>
        <AlertDescription>
          It may have been renamed or removed.{" "}
          <a className="underline underline-offset-2" href="#/projects">
            See all projects
          </a>
        </AlertDescription>
      </Alert>
    );
  }
  if (!overview) {
    return (
      <Alert variant="destructive">
        <AlertCircle />
        <AlertTitle>Could not load the overview</AlertTitle>
        <AlertDescription className="space-y-1">
          <p>{error}</p>
          <Button variant="link" size="xs" className="h-auto p-0" onClick={refresh}>
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const { project } = overview;
  const by = project.lastUploadBy ? briefAttribution(project.lastUploadBy.machine, project.lastUploadBy.uploader) : null;
  const firstSync = hub && firstSyncInProgress(project, now);
  const noRunsInRef = ref !== null && overview.recent.length === 0 && overview.trend.every((d) => d.runs === 0);
  const filters = { project: projectId, ...refRunFilters(ref) };
  const trailing = hub && projects.length >= 2 ? [{ label: "Overview", href: "#/" }] : [{ label: "Projects", href: "#/projects" }];
  const lastMachine = project.lastUploadBy?.machine;
  const arrived = overview.trend.reduce((sum, d) => sum + d.runs, 0);

  return (
    <div className="space-y-4">
      <div>
        <Breadcrumb items={[...trailing, { label: project.name }]} />
        <PageHeader
          title={project.name}
          description={
            <span className="block space-y-0.5">
              <span className="block">
                {project.hubKey && <span className="font-mono text-xs">{project.hubKey}</span>}
                {project.hubKey && project.defaultBranch ? " · " : ""}
                {project.defaultBranch ? `default branch ${project.defaultBranch}` : ""}
                {project.lastUploadAt ? `${project.hubKey || project.defaultBranch ? " · " : ""}last upload ${formatRelative(project.lastUploadAt, now)}${by ? ` ${by.text}` : ""}` : ""}
              </span>
              <Freshness fetchedAt={fetchedAt} />
            </span>
          }
          actions={
            <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
              <RefPicker
                projectId={projectId}
                value={ref}
                allowAll
                onChange={(next) => window.location.replace(overviewHash(projectId, { ref: next, show }))}
              />
              <Button variant="ghost" size="icon-sm" aria-label="Copy link to this view" onClick={copyViewLink}>
                <Link2 />
              </Button>
            </div>
          }
        />
      </div>

      {firstSync && (
        <Alert>
          <Loader2 className="animate-spin" />
          <AlertTitle>First upload in progress</AlertTitle>
          <AlertDescription>
            {arrived} runs from {lastMachine ?? "a teammate's machine"} have arrived so far. This page updates as more arrive.
          </AlertDescription>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Could not refresh the overview</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {noRunsInRef && ref && (
        <Alert>
          <AlertCircle />
          <AlertTitle>No runs for {ref.name}</AlertTitle>
          <AlertDescription>
            <a className="underline underline-offset-2" href={overviewHash(projectId)}>
              Show all branches
            </a>
          </AlertDescription>
        </Alert>
      )}

      <KpiTiles overview={overview} projectId={projectId} refValue={ref} />

      <div className="grid gap-3 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <TrendCard trend={overview.trend} days={overview.days} scope={ref?.name ?? null} />
        <ChangesCard data={overview.latestRelease} projectId={projectId} />
      </div>

      <div ref={grid} className="scroll-mt-16">
        <LaneGrid
          lanes={overview.lanes}
          projectId={projectId}
          show={show ?? null}
          onShowChange={(next) => window.location.replace(overviewHash(projectId, { ref, show: next }))}
        />
      </div>

      <Card className="@container gap-0 py-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <h2 className="text-sm font-medium">{hub ? "Recent uploads" : "Recent runs"}</h2>
          <Button asChild variant="link" size="xs">
            <a href={runsHash(filters)}>All runs</a>
          </Button>
        </div>
        {overview.recent.length === 0 ? (
          <p className={cn("px-3 py-4 text-sm text-muted-foreground")}>No runs in this scope yet.</p>
        ) : (
          <div className="divide-y">
            {overview.recent.map((run) => (
              <RunRow key={run.id} run={run} projectName={project.name} deviceName={null} now={now} onChanged={refresh} />
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
