import { Check, Loader2 } from "lucide-react";

import { LeaseRing } from "@/components/lease-ring";
import { formatDuration } from "@/lib/format";
import type { RunView } from "@/lib/api";
import { useNow } from "@/lib/hooks";
import { queueHoldCopy } from "@/lib/leases";
import { cn } from "@/lib/utils";

const PHASE_INDEX: Record<string, number> = { queued: 0, preflight: 1, running: 2, finishing: 3 };

/** `Running (C3 of 8)`: position of the check currently running (or the last resolved one) in the plan. */
function runningLabel(run: RunView): string {
  const total = run.checks.length;
  if (total === 0) return "Running";
  const runningIdx = run.checks.findIndex((c) => c.status === "running");
  const resolved = run.checks.filter((c) => c.status !== "pending" && c.status !== "running").length;
  const current = runningIdx >= 0 ? run.checks[runningIdx]?.id : undefined;
  return current ? `Running (${current} of ${total})` : `Running (${resolved} of ${total} done)`;
}

/** Queued → Booting/Preflight → Running (Cn of N) → Writing report → Done, with the reason for any wait. */
export function PhaseStepper({ run }: { run: RunView }) {
  const now = useNow(1000);
  const current = PHASE_INDEX[run.status] ?? 0;
  const phases: { label: string }[] = [
    { label: "Queued" },
    { label: run.bootedByRun ? "Booting device" : "Preflight" },
    { label: runningLabel(run) },
    { label: "Writing report" },
    { label: "Done" },
  ];
  const waitNote =
    run.status === "queued"
      ? (run.queueReason ?? (run.queuePosition !== null ? `Position #${run.queuePosition} in the queue` : "Waiting for a free device"))
      : run.status === "preflight"
        ? run.bootedByRun
          ? "Booting a device for this run…"
          : "Preparing the device and starting the agent…"
        : run.startedAt
          ? `Running for ${formatDuration(run.startedAt, null, now)}`
          : null;

  return (
    <div className="rounded-lg border bg-card px-4 py-3" aria-label="Run phase">
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-sm">
        {phases.map((phase, i) => {
          const done = i < current;
          const active = i === current;
          return (
            <li key={phase.label} className="flex items-center gap-2">
              <span
                className={cn(
                  "flex size-5 items-center justify-center rounded-full border text-[10px] font-medium",
                  done && "border-emerald-500 bg-emerald-500 text-white",
                  active && "border-blue-500 text-blue-600 dark:text-blue-400",
                  !done && !active && "text-muted-foreground",
                )}
              >
                {done ? <Check className="size-3" /> : active ? <Loader2 className="size-3 animate-spin" /> : i + 1}
              </span>
              <span className={cn(active ? "font-medium" : "text-muted-foreground")}>{phase.label}</span>
              {i < phases.length - 1 ? <span aria-hidden className="h-px w-5 bg-border" /> : null}
            </li>
          );
        })}
      </ol>
      {run.status === "queued" && run.queueHold ? (
        <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
          <LeaseRing size={12} lease={{ renewedAt: run.createdAt, expiresAt: run.queueHold.expiresAt }} />
          <span className="line-clamp-2 min-w-0 break-words">{queueHoldCopy(run.queueHold, run.deviceRequest).note}</span>
          <a href="#/devices" className="text-foreground underline-offset-4 hover:underline">
            Open Devices
          </a>
        </p>
      ) : waitNote ? (
        <p className="mt-1.5 text-xs text-muted-foreground">{waitNote}</p>
      ) : null}
    </div>
  );
}
