import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import type { RunView } from "@/lib/api";
import { formatCost, formatDuration, formatDurationMs, formatTokens } from "@/lib/format";
import { cn } from "@/lib/utils";

function shortModel(model: string): string {
  return model.split("/").pop() ?? model;
}

/**
 * Compact one-line spend summary: cost · tokens in/out/cache · tool calls · duration · model.
 * `now` drives the live duration of an unfinished run; the server-computed `durationMs` is only
 * trusted once the run has ended, because for an active run it is a snapshot from serialization time.
 */
export function UsageStrip({
  run,
  now,
  harnessLabel,
  className,
}: {
  run: RunView;
  now: number;
  /** Display name of the run's agent CLI; shown as a badge before the model. */
  harnessLabel?: string;
  className?: string;
}) {
  const u = run.usage;
  const duration =
    run.endedAt && run.durationMs !== null ? formatDurationMs(run.durationMs) : formatDuration(run.startedAt, run.endedAt, now);
  const model = u?.model ?? run.model;
  const parts: { key: string; node: ReactNode; title: string }[] = [];
  if (u) {
    parts.push({ key: "cost", node: formatCost(u.cost), title: "Estimated cost" });
    parts.push({
      key: "tokens",
      node: `${formatTokens(u.tokensIn)} in / ${formatTokens(u.tokensOut)} out / ${formatTokens(u.cacheRead + u.cacheWrite)} cache`,
      title: "Input / output / cache tokens",
    });
    parts.push({ key: "tools", node: `${u.toolCalls} tool calls`, title: "Tool calls" });
  }
  if (run.startedAt) parts.push({ key: "duration", node: duration, title: "Duration" });
  if (harnessLabel) {
    parts.push({
      key: "harness",
      node: (
        <Badge variant="outline" className="px-1.5 py-0 text-[11px] font-normal">
          {harnessLabel}
        </Badge>
      ),
      title: "Agent runtime",
    });
  }
  if (model) parts.push({ key: "model", node: shortModel(model), title: model });
  return (
    <div className={cn("flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs tabular-nums text-muted-foreground", className)}>
      {parts.map((p, i) => (
        <span key={p.key} title={p.title} className="inline-flex items-center gap-2">
          {i > 0 && <span aria-hidden className="text-muted-foreground/40">·</span>}
          {p.node}
        </span>
      ))}
    </div>
  );
}
