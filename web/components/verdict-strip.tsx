import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { type RunStatus, runHash, type Verdict } from "@/lib/api";
import { formatTime } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Dot colour for a run: its verdict when it has one, else its status. */
export function verdictDotClass({ verdict, status }: { verdict: Verdict | null; status: RunStatus }): string {
  switch (verdict) {
    case "PASS":
      return "bg-emerald-500";
    case "FAIL":
      return "bg-red-500";
    case "PASS WITH ISSUES":
      return "bg-orange-400";
    case "BLOCKED":
      return "bg-rose-800 dark:bg-rose-700";
    case "PARTIAL":
      return "border-2 border-orange-400 bg-transparent";
    case null:
      break;
  }
  if (status === "queued" || status === "preflight" || status === "running" || status === "finishing") return "animate-pulse bg-blue-500";
  if (status === "error") return "border-2 border-red-500/60 bg-transparent";
  return "bg-stone-400 dark:bg-stone-600";
}

export interface StripItem {
  id: string;
  title?: string;
  verdict: Verdict | null;
  status: RunStatus;
  createdAt?: string;
}

/** Oldest → newest dots, each linking to its run. `md` dots are 12 px, `sm` 8 px. Items beyond `max` (the oldest) are dropped. */
export function VerdictStrip({ items, max, size = "md" }: { items: StripItem[]; max?: number; size?: "sm" | "md" }) {
  const shown = max !== undefined ? items.slice(-max) : items;
  return (
    <div className={cn("flex items-center", size === "sm" ? "gap-0.5" : "gap-1")} role="list" aria-label="Most recent runs">
      {shown.map((item) => {
        const outcome = item.verdict ?? item.status;
        const label = item.title ?? (item.createdAt ? formatTime(item.createdAt) : item.id);
        return (
          <Tooltip key={item.id}>
            <TooltipTrigger asChild>
              <a
                role="listitem"
                href={runHash(item.id)}
                aria-label={`${label}: ${outcome}`}
                className={cn(
                  "relative z-10 rounded-full outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring",
                  size === "sm" ? "size-2" : "size-3",
                  verdictDotClass(item),
                )}
              />
            </TooltipTrigger>
            <TooltipContent>
              {label} · {outcome}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
