import { AlertCircle, ArrowLeft, Layers, Loader2, RotateCcw } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { DeviceFrame } from "@/components/device-frame";
import { DeviceName } from "@/components/device-name";
import { EmptyState } from "@/components/empty-state";
import { isFailedLane, rerunFailedLanes } from "@/components/run-row";
import { RunStatusIcon } from "@/components/run-status-icon";
import { CheckCounts, SegmentedProgress } from "@/components/segmented-progress";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { VerdictBadge } from "@/components/verdict-badge";
import { isActive, runHash, type Device, type RunView } from "@/lib/api";
import { formatCost, formatDuration } from "@/lib/format";
import { useBatch, useDevices, useNow, useProjects } from "@/lib/hooks";
import { cn } from "@/lib/utils";

export function Batch({ id }: { id: string }) {
  const { batch, loading, error, refresh } = useBatch(id);
  const { projects } = useProjects();
  const { devices } = useDevices();
  const now = useNow();
  const [rerunning, setRerunning] = useState(false);
  const deviceBySerial = useMemo(() => new Map(devices.map((d) => [d.serial, d])), [devices]);

  const back = (
    <Button asChild variant="ghost" size="sm" className="-ml-2 mb-2">
      <a href="#/">
        <ArrowLeft />
        Runs
      </a>
    </Button>
  );

  if (loading && !batch) {
    return (
      <div>
        {back}
        <Skeleton className="mb-2 h-8 w-80" />
        <Skeleton className="mb-6 h-5 w-96" />
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <Skeleton className="h-52 w-full" />
          <Skeleton className="h-52 w-full" />
        </div>
      </div>
    );
  }

  if (!batch) {
    return (
      <div>
        {back}
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Could not load batch</AlertTitle>
          <AlertDescription>{error ?? `Batch ${id} was not found.`}</AlertDescription>
        </Alert>
      </div>
    );
  }

  const projectName = projects.find((p) => p.id === batch.projectId)?.name ?? batch.projectId;
  const active = batch.status === "active";
  const failedLanes = batch.runs.filter(isFailedLane);
  const withoutVerdict = batch.runs.filter((r) => r.verdict === null).length;

  async function rerunFailed() {
    if (!batch) return;
    setRerunning(true);
    try {
      const count = await rerunFailedLanes(batch.runs);
      if (count === 0) toast.error("No lane could be re-run");
      else toast.success(`Re-running ${count} lane${count === 1 ? "" : "s"}`);
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setRerunning(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        {back}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="truncate text-2xl font-semibold tracking-tight">{batch.title}</h1>
              {batch.verdict && !active ? (
                <VerdictBadge verdict={batch.verdict} />
              ) : active ? (
                <StatusBadge status="running" />
              ) : (
                <Badge variant="outline" className="text-muted-foreground" title="Some lanes ended without a verdict (errored, cancelled or interrupted)">
                  incomplete · {withoutVerdict} of {batch.runs.length} without a verdict
                </Badge>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground tabular-nums">
              <span>{projectName}</span>
              <span>
                {batch.runs.length} lane{batch.runs.length === 1 ? "" : "s"}
              </span>
              <span>
                {batch.startedAt ? `${formatDuration(batch.startedAt, active ? null : batch.endedAt, now)} wall clock` : "not started"}
              </span>
              <span>{formatCost(batch.cost)}</span>
            </div>
          </div>
          <Button variant="outline" disabled={active || failedLanes.length === 0 || rerunning} onClick={() => void rerunFailed()}>
            {rerunning ? <Loader2 className="animate-spin" /> : <RotateCcw />}
            Re-run failed lanes
          </Button>
        </div>
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Could not refresh batch</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {batch.runs.length === 0 ? (
        <EmptyState icon={Layers} title="This batch has no runs" description="Its runs may have been deleted." />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
          {batch.runs.map((run) => (
            <Lane key={run.id} run={run} device={run.deviceSerial ? deviceBySerial.get(run.deviceSerial) : undefined} now={now} />
          ))}
        </div>
      )}
    </div>
  );
}

function Lane({ run, device, now }: { run: RunView; device: Device | undefined; now: number }) {
  const live = isActive(run.status);
  return (
    <Card className="relative flex-row gap-4 p-4">
      {live && <DeviceFrame serial={run.deviceSerial} live className="w-[120px]" />}
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex items-start gap-2">
          <RunStatusIcon status={run.status} verdict={run.verdict} className="mt-0.5 size-4 shrink-0" />
          <a
            href={runHash(run.id)}
            className="min-w-0 flex-1 text-sm font-medium after:absolute after:inset-0 hover:underline focus-visible:outline-none"
            title={run.title}
          >
            <span className="line-clamp-2">{run.title}</span>
          </a>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {device ? (
            <DeviceName device={run.deviceName ? { ...device, name: run.deviceName } : device} />
          ) : (
            <span>{run.deviceName ?? run.deviceSerial ?? `any ${run.deviceRequest.platform}`}</span>
          )}
          <span aria-hidden="true">·</span>
          <span>{run.backend}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {run.verdict ? <VerdictBadge verdict={run.verdict} /> : <StatusBadge status={run.status} />}
          {run.status === "queued" && (
            <span className="text-xs text-muted-foreground">
              Queue #{run.queuePosition ?? "?"}
              {run.queueReason ? ` · ${run.queueReason}` : ""}
            </span>
          )}
        </div>
        {run.summary && !live && <p className="line-clamp-3 text-xs text-muted-foreground">{run.summary}</p>}
        {run.error && !live && !run.summary && <p className="line-clamp-3 text-xs text-destructive">{run.error}</p>}
        <div className="mt-auto space-y-1.5">
          <SegmentedProgress checks={run.checks} size="md" />
          <div className={cn("flex items-center justify-between gap-2 text-xs text-muted-foreground tabular-nums")}>
            <CheckCounts checks={run.checks} />
            <span>{run.startedAt ? formatDuration(run.startedAt, run.endedAt, now) : "—"}</span>
          </div>
        </div>
      </div>
    </Card>
  );
}
