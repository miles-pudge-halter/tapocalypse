import { LaptopMinimal, Loader2 } from "lucide-react";

import { DeviceFrame } from "@/components/device-frame";
import { LiveStatus } from "@/components/hub/live-status";
import { RunActions } from "@/components/run-row";
import { RunStatusIcon } from "@/components/run-status-icon";
import { CheckCounts, SegmentedProgress } from "@/components/segmented-progress";
import { Card } from "@/components/ui/card";
import { runHash, type Device, type RunView } from "@/lib/api";
import { formatDuration } from "@/lib/format";

/**
 * A queued or in-flight run on the Runs page. A laptop's run shows its device (frame, name) and elapsed time; a hub run
 * (`run.hub`) has no device of its own: it shows the machine it runs on, its check progress and whether that machine is still reporting.
 */
export function ActiveCard({
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
  const hub = run.hub;
  const current = run.checks.find((c) => c.status === "running");
  const queued = run.status === "queued";
  const reason =
    run.queueReason ??
    (run.deviceRequest.serial ? `waiting for ${run.deviceRequest.serial}` : `waiting for a free ${run.deviceRequest.platform} device`);

  return (
    <Card className="relative flex-row gap-3 p-3">
      {hub ? null : <DeviceFrame serial={run.deviceSerial} live device={device} platform={run.deviceRequest.platform} size="tile" />}
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
        {hub ? (
          <div className="flex min-w-0 items-center gap-1.5 truncate text-xs text-muted-foreground">
            <span className="truncate">{projectName}</span>
            <span aria-hidden>·</span>
            <LaptopMinimal className="size-3 shrink-0 opacity-70" aria-hidden />
            <span className="truncate">{hub.machine}</span>
          </div>
        ) : (
          <div className="truncate text-xs text-muted-foreground">
            {[projectName, deviceName ?? (queued ? null : "assigning device…"), run.requestedBy].filter(Boolean).join(" · ")}
          </div>
        )}
        {queued && !hub ? (
          <div className="text-xs">
            <span className="font-medium">Queue #{run.queuePosition ?? "?"}</span>
            <span className="text-muted-foreground"> · {reason}</span>
          </div>
        ) : queued ? (
          <div className="text-xs text-muted-foreground">Waiting for a device on {hub?.machine}</div>
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
          {hub ? (
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 text-xs tabular-nums">
              <CheckCounts checks={run.checks} />
              <LiveStatus hub={hub} now={now} compact />
            </div>
          ) : (
            <div className="text-xs tabular-nums text-muted-foreground">
              {run.startedAt ? `elapsed ${formatDuration(run.startedAt, null, now)}` : `waiting ${formatDuration(run.createdAt, null, now)}`}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
