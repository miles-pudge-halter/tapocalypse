import { ArrowDown, Info, Snowflake, Tag } from "lucide-react";
import { useEffect } from "react";

import { Lockup } from "@/components/brand";
import { EmptyState } from "@/components/empty-state";
import { PassRateTrend } from "@/components/hub/pass-rate-trend";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { overviewHash, type ProjectView } from "@/lib/api";
import { formatRelative } from "@/lib/format";
import { useHubMachines, useNow, useOverview, useProjects, useProjectScope, useRefs } from "@/lib/hooks";
import { briefAttribution, latestRelease } from "@/lib/hub";
import { cn } from "@/lib/utils";
import { ReleaseStatusChip } from "@/views/Releases";

function ProjectCard({ project }: { project: ProjectView }) {
  const { overview, loading, error } = useOverview(project.id, null);
  const { refs } = useRefs(project.id);
  const now = useNow(30_000);
  const release = latestRelease(refs);
  const link = (
    <a href={overviewHash(project.id)} className="absolute inset-0 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`Open ${project.name}`} />
  );
  if (loading && !overview) return <Skeleton className="h-44" aria-label={`Loading ${project.name}`} />;
  if (!overview) {
    return (
      <Card className="relative gap-2 py-4">
        {link}
        <div className="px-4">
          <p className="truncate font-semibold">{project.name}</p>
          <p className="text-xs text-destructive">Could not load: {error}</p>
        </div>
      </Card>
    );
  }
  const { passRate, counts } = overview;
  const by = overview.project.lastUploadBy ? briefAttribution(overview.project.lastUploadBy.machine, overview.project.lastUploadBy.uploader) : null;
  const zero = (n: number, hot: string) => (n > 0 ? hot : "text-muted-foreground");
  return (
    <Card className="relative gap-3 py-4 hover:bg-muted/40">
      {link}
      <div className="space-y-1 px-4">
        <p className="truncate font-semibold">{project.name}</p>
        {overview.project.hubKey && (
          <p className="truncate font-mono text-xs text-muted-foreground" title={overview.project.hubKey}>
            {overview.project.hubKey}
          </p>
        )}
        {release && (
          <p className="flex items-center gap-1.5 text-sm">
            <Tag className="size-3.5 text-muted-foreground" aria-hidden />
            <span className={cn("truncate", release.ref.kind === "branch" && "font-mono text-xs")}>{release.ref.name}</span>
            <ReleaseStatusChip lanes={release.lanes} />
          </p>
        )}
      </div>
      <div className="flex items-center gap-3 px-4">
        <div className="shrink-0">
          <span className="text-2xl font-semibold tabular-nums">{passRate.decided === 0 || passRate.current === null ? "—" : `${Math.round(passRate.current * 100)}%`}</span>
          <span className="ml-1 text-xs text-muted-foreground">pass · 30 d</span>
        </div>
        <div className="min-w-0 flex-1">
          <PassRateTrend trend={overview.trend} days={overview.days} size="sm" />
        </div>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 px-4 text-xs">
        <span className={cn("inline-flex items-center gap-1", zero(counts.newlyFailing, "text-red-700 dark:text-red-400"))}>
          <ArrowDown className="size-3" aria-hidden />
          {counts.newlyFailing} newly failing
        </span>
        <span className={cn("inline-flex items-center gap-1", zero(counts.flaky, "text-fuchsia-700 dark:text-fuchsia-400"))}>
          <Snowflake className="size-3" aria-hidden />
          {counts.flaky} flaky
        </span>
        <span className={zero(counts.failingNow, "text-red-700 dark:text-red-400")}>{counts.failingNow} failing now</span>
      </div>
      <p className="truncate px-4 text-xs text-muted-foreground">
        {overview.project.lastUploadAt ? `Last upload ${formatRelative(overview.project.lastUploadAt, now)}${by ? ` ${by.text}` : ""}` : "No uploads yet"}
      </p>
    </Card>
  );
}

/** The team hub's landing page: straight to the project when there is one (or one is scoped), else a card per project. */
export function HubHome() {
  const { projects, loading, error } = useProjects();
  const { projectId: scope } = useProjectScope();
  const { machines } = useHubMachines();
  const target = projects.find((p) => p.id === scope) ?? (projects.length === 1 ? projects[0] : undefined);

  useEffect(() => {
    if (!loading && target) window.location.replace(overviewHash(target.id));
  }, [loading, target]);

  if (loading || target) {
    return (
      <div className="space-y-4" aria-label="Loading projects">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-44" />
          ))}
        </div>
      </div>
    );
  }
  if (error && projects.length === 0) {
    return <EmptyState icon={Info} title="Could not load the projects" description={error} />;
  }
  if (projects.length === 0) {
    return (
      <EmptyState
        media={<Lockup size="lg" />}
        title="No projects shared yet"
        description="Runs show up here once a teammate connects their Tapocalypse to this hub and turns on “Share with team hub” for a project. Each finished run then uploads on its own."
        action={
          <div className="flex flex-col items-center gap-3">
            <ol className="max-w-sm list-decimal space-y-1 pl-5 text-left text-sm text-muted-foreground">
              <li>Your hub admin creates an upload token for each machine.</li>
              <li>Each teammate pastes the hub address and token in Setup → Connect to a team hub.</li>
              <li>They tick “Share with team hub” in a project's settings.</li>
            </ol>
            <Button asChild variant="outline">
              <a href="#/about">
                <Info />
                How to connect a machine
              </a>
            </Button>
          </div>
        }
      />
    );
  }
  return (
    <div>
      <PageHeader
        title="Team hub"
        description={`QA results uploaded from ${machines.length} ${machines.length === 1 ? "machine" : "machines"} across ${projects.length} projects.`}
      />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {projects.map((p) => (
          <ProjectCard key={p.id} project={p} />
        ))}
      </div>
    </div>
  );
}
