import { AlertCircle, ChevronRight, GitBranch, Link2, RotateCcw, Tag } from "lucide-react";
import { toast } from "sonner";

import { BlockersCard } from "@/components/hub/blockers-card";
import { ChangeCounts, ChangesCard } from "@/components/hub/changes-card";
import { Freshness } from "@/components/hub/freshness";
import { LaneBar } from "@/components/hub/lane-bar";
import { RefPicker } from "@/components/hub/ref-picker";
import { ReleaseChanges } from "@/components/hub/release-changes";
import { ReleaseMatrix } from "@/components/hub/release-matrix";
import { ReleaseSummary } from "@/components/hub/release-summary";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { ProjectPicker } from "@/components/reports-nav";
import { RegressionCount } from "@/components/regression/transition";
import { RunRow } from "@/components/run-row";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { type Ref, type RefSummary, type ReleaseView, refParam, releaseHash, releasesHash, overviewHash } from "@/lib/api";
import { formatRelative } from "@/lib/format";
import { navigate, runsHash, useNow, useProjects, useRefs, useRelease, useRuns } from "@/lib/hooks";
import { groupRefs, refRunFilters, releaseStatus, releaseStatusText, testedBy } from "@/lib/hub";
import { Breadcrumb } from "@/views/Overview";
import { cn } from "@/lib/utils";

const rangeFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });

/** "Oct 2 – 9", "Oct 2 – Nov 3" or a single day, in the reader's locale. */
function spanText(firstAt: string, lastAt: string): string {
  return rangeFormat.formatRange(new Date(firstAt), new Date(lastAt));
}

/** "N blockers" (red), "N with issues" (orange), "N incomplete" (amber), "no results" (grey) or "all passing" (green) for a release. */
export function ReleaseStatusChip({ lanes }: { lanes: RefSummary["lanes"] }) {
  const status = releaseStatus(lanes);
  const style = {
    blockers: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
    issues: "border-orange-500/30 bg-orange-500/10 text-orange-800 dark:text-orange-300",
    partial: "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300",
    none: "border-border bg-muted text-muted-foreground",
    pass: "border-emerald-500/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300",
  }[status.kind];
  return <span className={cn("inline-flex h-5 shrink-0 items-center rounded-md border px-1.5 text-xs font-medium tabular-nums", style)}>{releaseStatusText(status)}</span>;
}

function RefIdentity({ summary }: { summary: RefSummary }) {
  const Icon = summary.ref.kind === "version" ? Tag : GitBranch;
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className={cn("truncate font-medium", summary.ref.kind === "branch" && "font-mono text-sm")} title={summary.ref.name}>
        {summary.ref.name}
      </span>
      <Badge variant="outline" className="h-4 px-1 text-[10px]">
        {summary.ref.kind}
      </Badge>
    </span>
  );
}

function VsPrevious({ summary, projectId }: { summary: RefSummary; projectId: string }) {
  if (summary.previous === null || summary.newlyFailing === null) return <span className="text-xs text-muted-foreground">first</span>;
  if (summary.newlyFailing === 0) return <span className="text-xs text-muted-foreground">↓ 0</span>;
  return (
    <RegressionCount
      count={summary.newlyFailing}
      href={releaseHash(projectId, summary.ref)}
      tooltip={`${summary.newlyFailing} newly failing vs ${summary.previous.name}`}
    />
  );
}

function ReleaseRow({ summary, projectId }: { summary: RefSummary; projectId: string }) {
  const href = releaseHash(projectId, summary.ref);
  const span = `${spanText(summary.firstAt, summary.lastAt)} · ${summary.runs} runs · ${summary.machines.length} ${summary.machines.length === 1 ? "machine" : "machines"}`;
  return (
    <li>
      <a href={href} className="block px-3 py-3 outline-none hover:bg-muted/50 focus-visible:bg-muted/50">
        <div className="hidden items-center gap-4 md:grid md:grid-cols-[fit-content(26rem)_minmax(0,1fr)_8rem_auto_auto_1rem]">
          <RefIdentity summary={summary} />
          <span className="truncate text-xs text-muted-foreground">{span}</span>
          <LaneBar lanes={summary.lanes} />
          <ReleaseStatusChip lanes={summary.lanes} />
          <VsPrevious summary={summary} projectId={projectId} />
          <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
        </div>
        <div className="space-y-1.5 md:hidden">
          <div className="flex items-center justify-between gap-2">
            <RefIdentity summary={summary} />
            <ReleaseStatusChip lanes={summary.lanes} />
          </div>
          <p className="text-xs text-muted-foreground">{span}</p>
          <div className="flex items-center gap-3">
            <LaneBar lanes={summary.lanes} className="w-full" />
            <VsPrevious summary={summary} projectId={projectId} />
          </div>
        </div>
      </a>
    </li>
  );
}

/** Every release of a project (versions and release branches), newest first, with its health at a glance. */
export function ReleaseList({ projectId }: { projectId: string }) {
  const { projects } = useProjects();
  const { refs, loading, error, fetchedAt, refresh } = useRefs(projectId);
  const project = projects.find((p) => p.id === projectId);
  const releases = groupRefs(refs.filter((r) => r.release));
  const header = (
    <PageHeader
      title="Releases"
      description={
        <span className="block space-y-0.5">
          <span className="block">{project?.name ?? projectId}</span>
          <Freshness fetchedAt={fetchedAt} />
        </span>
      }
      actions={
        <ProjectPicker
          projects={projects.map((p) => ({ id: p.id, name: p.name }))}
          projectId={projectId}
          hrefFor={releasesHash}
        />
      }
    />
  );
  if (loading) {
    return (
      <div>
        {header}
        <div className="space-y-2" aria-label="Loading releases">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-14" />
          ))}
        </div>
      </div>
    );
  }
  if (error) {
    return (
      <div>
        {header}
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Could not load releases</AlertTitle>
          <AlertDescription className="space-y-1">
            <p>{error}</p>
            <Button variant="link" size="xs" className="h-auto p-0" onClick={refresh}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    );
  }
  if (releases.versions.length + releases.releaseBranches.length === 0) {
    return (
      <div>
        {header}
        <EmptyState
          icon={Tag}
          title="No releases yet"
          description="Runs show up here by app version, or by branch when the branch name starts with release/, releases/ or hotfix/."
          action={
            <Button asChild variant="outline">
              <a href={overviewHash(projectId)}>Open the overview</a>
            </Button>
          }
        />
      </div>
    );
  }
  return (
    <div>
      {header}
      <Card className="gap-0 overflow-hidden p-0">
        {[
          { title: "Versions", items: releases.versions },
          { title: "Release branches", items: releases.releaseBranches },
        ]
          .filter((g) => g.items.length > 0)
          .map((g) => (
            <section key={g.title}>
              <h2 className="bg-muted/40 px-3 py-1.5 text-xs font-medium">{g.title}</h2>
              <ul className="divide-y">
                {g.items.map((s) => (
                  <ReleaseRow key={`${s.ref.kind}:${s.ref.name}`} summary={s} projectId={projectId} />
                ))}
              </ul>
            </section>
          ))}
      </Card>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="space-y-4" aria-label="Loading the release">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-4 w-96 max-w-full" />
      <Skeleton className="h-20" />
      <div className="grid gap-3 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Skeleton className="h-48" />
        <Skeleton className="h-48" />
      </div>
      <Skeleton className="h-[320px]" />
    </div>
  );
}

/** One release across every machine: blockers first, a tests × devices matrix with rounds folded, changes against the release before. */
export function ReleaseDetail({
  projectId,
  refValue,
  against,
  group,
}: {
  projectId: string;
  refValue: Ref;
  against: string | null;
  group: "device" | "platform";
}) {
  const { release, loading, error, missing, fetchedAt, refresh } = useRelease(projectId, refValue, against);
  const now = useNow(30_000);
  const edit = (patch: { against?: string | null; group?: "device" | "platform" }) =>
    window.location.replace(
      releaseHash(projectId, refValue, {
        against: patch.against !== undefined ? patch.against : against,
        group: patch.group ?? group,
      }),
    );
  if (loading && !release) return <LoadingState />;
  if (!release && missing !== "ref") {
    return (
      <Alert variant="destructive">
        <AlertCircle />
        <AlertTitle>Could not load this release</AlertTitle>
        <AlertDescription className="space-y-1">
          <p>{error}</p>
          <Button variant="link" size="xs" className="h-auto p-0" onClick={refresh}>
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  if (!release || release.runs === 0) {
    return (
      <EmptyState
        icon={Tag}
        title={`No runs for ${refValue.name}`}
        description="Nothing uploaded so far is on this version or branch."
        action={
          <RefPicker
            projectId={projectId}
            value={refValue}
            allowAll={false}
            releasesOnly
            onChange={(next) => next && navigate(releaseHash(projectId, next))}
            trigger={<Button variant="outline">Pick another release</Button>}
          />
        }
      />
    );
  }
  const tested = testedBy(release.machines);
  const prev = release.previous;
  const toChanges = () => document.getElementById("changes")?.scrollIntoView({ behavior: "smooth", block: "start" });
  const toUntested = () =>
    (document.getElementById("changes-removed") ?? document.getElementById("changes"))?.scrollIntoView({ behavior: "smooth", block: "start" });
  const top = release.changes?.items.filter((i) => i.transition === "newly_failing").slice(0, 5) ?? [];
  return (
    <div className="space-y-4">
      <div>
        <Breadcrumb items={[{ label: "Releases", href: releasesHash(projectId) }, { label: release.project.name }]} />
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className={cn("truncate text-xl font-semibold tracking-tight", refValue.kind === "branch" && "font-mono")}>{refValue.name}</h1>
              <Badge variant="outline">{refValue.kind}</Badge>
            </div>
            <div className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
              <span>{spanText(release.span.firstAt, release.span.lastAt)}</span>
              <span aria-hidden>·</span>
              <span>{release.runs} runs</span>
              {tested.text && (
                <>
                  <span aria-hidden>·</span>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span>tested by {tested.text}</span>
                    </TooltipTrigger>
                    <TooltipContent>{tested.all}</TooltipContent>
                  </Tooltip>
                </>
              )}
              <span aria-hidden>·</span>
              {prev ? (
                <span className="inline-flex items-center gap-1">
                  compared with
                  <RefPicker
                    projectId={projectId}
                    value={prev}
                    allowAll={false}
                    releasesOnly
                    onChange={(next) => next && edit({ against: refParam(next) })}
                    extra={release.auto ? undefined : { label: "Automatic (previous release)", icon: RotateCcw, onSelect: () => edit({ against: null }) }}
                    align="start"
                    trigger={
                      <Button
                        variant="link"
                        size="xs"
                        className="h-auto p-0"
                        title={release.auto ? "Picked automatically: the release before this one" : undefined}
                      >
                        {prev.name}
                      </Button>
                    }
                  />
                </span>
              ) : (
                <span>not compared (first release)</span>
              )}
            </div>
            <Freshness fetchedAt={fetchedAt} />
          </div>
          <div className="flex items-center gap-2">
            <RefPicker
              projectId={projectId}
              value={refValue}
              allowAll={false}
              releasesOnly
              onChange={(next) => next && navigate(releaseHash(projectId, next))}
            />
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Copy link to this view"
              onClick={() =>
                navigator.clipboard.writeText(location.href).then(
                  () => toast.success("Link copied", { description: "Anyone who can sign in to the hub can open it." }),
                  () => toast.error("Could not copy to the clipboard"),
                )
              }
            >
              <Link2 />
            </Button>
          </div>
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Could not refresh this release</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <ReleaseSummary view={release} fetchedAt={fetchedAt} onShowUntested={toUntested} />

      <div className="grid gap-3 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        {release.blockers.length > 0 ? <BlockersCard view={release} /> : null}
        {prev && release.changes ? (
          <ChangesCard
            data={{ ref: refValue, previous: prev, counts: release.changes.counts, top }}
            projectId={projectId}
            onSeeAll={toChanges}
            className={release.blockers.length === 0 ? "xl:col-span-2" : undefined}
          />
        ) : (
          <ChangesCard data={{ ref: refValue, previous: null, counts: EMPTY_COUNTS, top: [] }} projectId={projectId} onSeeAll={toChanges} className={release.blockers.length === 0 ? "xl:col-span-2" : undefined} />
        )}
      </div>

      <ReleaseMatrix view={release} group={group} onGroupChange={(next) => edit({ group: next })} />

      <ReleaseChanges view={release} />

      <RunsInRelease view={release} refValue={refValue} projectId={projectId} now={now} />
    </div>
  );
}

const EMPTY_COUNTS = { newly_failing: 0, fixed: 0, flaky: 0, still_failing: 0, unchanged: 0, changed: 0, new: 0, removed: 0, pending: 0 };

function RunsInRelease({ view, refValue, projectId, now }: { view: ReleaseView; refValue: Ref; projectId: string; now: number }) {
  const { runs, loading, error, refresh } = useRuns({ project: projectId, ...refRunFilters(refValue), limit: 20 });
  return (
    <Card className="@container gap-0 py-0">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <h2 className="text-sm font-medium">Runs in this release ({view.runs})</h2>
        <Button asChild variant="link" size="xs">
          <a href={runsHash({ project: projectId, ...refRunFilters(refValue) })}>Open in Runs</a>
        </Button>
      </div>
      {loading ? (
        <div className="space-y-2 p-3" aria-label="Loading runs">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      ) : error ? (
        <p className="px-3 py-4 text-sm text-destructive">Could not load the runs: {error}</p>
      ) : (
        <div className="divide-y">
          {runs.map((run) => (
            <RunRow key={run.id} run={run} projectName={view.project.name} deviceName={null} now={now} onChanged={refresh} />
          ))}
        </div>
      )}
    </Card>
  );
}
