import { AlertCircle, LaptopMinimal } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { runHash, type HubAttribution, type RunView } from "@/lib/api";
import { formatRelative } from "@/lib/format";
import { useActiveRuns, useNow } from "@/lib/hooks";
import { LIVE_PENDING_COPY, checkProgress, isLiveRun, liveState } from "@/lib/live";
import { cn } from "@/lib/utils";

/**
 * Where a run still in progress on a laptop stands: a green "Live from <machine> · updated 12s ago", or, once the laptop has been
 * silent for more than 3 minutes, an amber "No update from <machine> for 4 min". `compact` (cards, lists that name the machine
 * elsewhere) drops the machine. Renders nothing for a run that is not live.
 */
export function LiveStatus({ hub, now, compact = false, className }: { hub: HubAttribution | null | undefined; now: number; compact?: boolean; className?: string }) {
  const state = liveState(hub, now);
  if (!state) return null;
  if (state.kind === "stale") {
    return (
      <span className={cn("inline-flex min-w-0 items-center gap-1.5 text-amber-700 dark:text-amber-400", className)}>
        <span aria-hidden className="size-2 shrink-0 rounded-full bg-amber-500" />
        <span className="truncate font-medium">{compact ? `No update for ${state.minutes} min` : `No update from ${state.machine} for ${state.minutes} min`}</span>
      </span>
    );
  }
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
      <span aria-hidden className="size-2 shrink-0 animate-pulse rounded-full bg-emerald-500" />
      <span className="truncate">
        <span className="font-medium text-emerald-700 dark:text-emerald-400">{compact ? "Live" : `Live from ${state.machine}`}</span>
        <span className="text-muted-foreground">{` · updated ${formatRelative(state.lastSeenAt, now)}`}</span>
      </span>
    </span>
  );
}

/** What the device and activity panes of a live run say instead of their usual empty states. */
export function LivePendingState({ machine }: { machine: string }) {
  return <EmptyState icon={LaptopMinimal} title={`Running on ${machine}`} description={LIVE_PENDING_COPY} />;
}

/** Compact list of the runs in progress on teammates' laptops; absent when there are none. `projectNames` adds the project to each line. */
export function RunningNow({
  runs,
  loading,
  error,
  now,
  projectNames,
}: {
  runs: RunView[];
  loading: boolean;
  error: string | null;
  now: number;
  projectNames?: ReadonlyMap<string, string>;
}) {
  const live = runs.filter(isLiveRun).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (live.length === 0) {
    if (loading) return <Skeleton className="h-20 w-full" aria-label="Loading running runs" />;
    if (error) {
      return (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Could not load running runs</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      );
    }
    return null;
  }
  return (
    <Card className="@container gap-0 py-0" aria-label="Running now">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <span aria-hidden className="size-2 animate-pulse rounded-full bg-emerald-500" />
        <h2 className="text-sm font-medium">Running now · {live.length}</h2>
      </div>
      <ul className="divide-y">
        {live.map((run) => {
          const { done, total, failing } = checkProgress(run.checks);
          const project = projectNames?.get(run.projectId);
          return (
            <li key={run.id} className="relative flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-sm hover:bg-muted/50 focus-within:bg-muted/50">
              <a
                href={runHash(run.id)}
                title={run.title}
                className="min-w-40 flex-1 truncate font-medium after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring hover:underline"
              >
                {run.title}
              </a>
              {project ? <span className="max-w-40 truncate text-xs text-muted-foreground">{project}</span> : null}
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <LaptopMinimal className="size-3 shrink-0 opacity-70" aria-hidden />
                {run.hub?.machine}
              </span>
              <span className="text-xs tabular-nums">{`${done}/${total} checks`}</span>
              {failing > 0 ? <span className="text-xs font-medium tabular-nums text-red-700 dark:text-red-400">{`${failing} failing`}</span> : null}
              <LiveStatus hub={run.hub} now={now} compact className="text-xs" />
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/** `RunningNow` fed by the app-wide active-runs store, limited to one project when `projectId` is given. */
export function RunningNowSection({ projectId, projectNames }: { projectId?: string; projectNames?: ReadonlyMap<string, string> }) {
  const { runs, loading, error } = useActiveRuns();
  const now = useNow(10_000);
  return <RunningNow runs={projectId ? runs.filter((r) => r.projectId === projectId) : runs} loading={loading} error={error} now={now} projectNames={projectNames} />;
}
