import type { Check, CheckStatus } from "@/lib/api";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export const SEGMENT_COLOR: Record<CheckStatus, string> = {
  pass: "bg-emerald-500",
  fail: "bg-red-500",
  blocked: "bg-rose-900 dark:bg-rose-700",
  skipped: "bg-stone-400 dark:bg-stone-600",
  pending: "bg-muted-foreground/25",
  // A faint bolt channel inside the segment (the colour-independent "in progress" cue, also under reduced motion) with a
  // white-gold head looping along it.
  running: "bg-blue-500 strike-bar",
};

function segmentLabel(check: Check): string {
  return `${check.id} · ${check.status} · ${check.title}`;
}

export function SegmentedProgress({
  checks,
  size = "md",
  className,
}: {
  checks: Check[];
  size?: "sm" | "md";
  className?: string;
}) {
  const height = size === "sm" ? "h-1.5" : "h-2.5";
  if (checks.length === 0) {
    return <div role="img" aria-label="No checks yet" className={cn("w-full min-w-12 rounded-full border border-dashed", height, className)} />;
  }
  const done = checks.filter((c) => c.status !== "pending" && c.status !== "running").length;
  return (
    <div
      role="img"
      aria-label={`${done} of ${checks.length} checks resolved`}
      className={cn("flex w-full min-w-12 items-stretch gap-px overflow-hidden rounded-full", height, className)}
    >
      {checks.map((check) => {
        const segment = (
          <span
            key={check.id}
            className={cn("min-w-0.5 flex-1", SEGMENT_COLOR[check.status])}
            title={size === "sm" ? segmentLabel(check) : undefined}
          />
        );
        // Dense lists render hundreds of these: small bars use the native title, medium bars get a real tooltip.
        if (size === "sm") return segment;
        return (
          <Tooltip key={check.id}>
            <TooltipTrigger asChild>{segment}</TooltipTrigger>
            <TooltipContent>{segmentLabel(check)}</TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

/** "5 pass · 2 fail · 1 blocked · 3 remaining" — zero counts are omitted. */
export function CheckCounts({ checks, className }: { checks: Check[]; className?: string }) {
  if (checks.length === 0) return <span className={cn("text-muted-foreground", className)}>No checks yet</span>;
  const count = (status: CheckStatus) => checks.filter((c) => c.status === status).length;
  const remaining = count("pending") + count("running");
  const parts: { label: string; tone: string }[] = [];
  if (count("pass")) parts.push({ label: `${count("pass")} pass`, tone: "text-emerald-700 dark:text-emerald-400" });
  if (count("fail")) parts.push({ label: `${count("fail")} fail`, tone: "text-red-700 dark:text-red-400" });
  if (count("blocked")) parts.push({ label: `${count("blocked")} blocked`, tone: "text-rose-800 dark:text-rose-400" });
  if (count("skipped")) parts.push({ label: `${count("skipped")} skipped`, tone: "" });
  if (remaining) parts.push({ label: `${remaining} remaining`, tone: "" });
  return (
    <span className={cn("tabular-nums text-muted-foreground", className)}>
      {parts.map((p, i) => (
        <span key={p.label}>
          {i > 0 && " · "}
          <span className={p.tone}>{p.label}</span>
        </span>
      ))}
    </span>
  );
}
