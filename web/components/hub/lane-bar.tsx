import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { RefSummary } from "@/lib/api";
import { cn } from "@/lib/utils";

const SEGMENTS = [
  { key: "pass", word: "pass", className: "bg-emerald-500" },
  { key: "issues", word: "with issues", className: "bg-orange-400" },
  { key: "fail", word: "fail", className: "bg-red-500" },
  { key: "blocked", word: "blocked", className: "bg-rose-800 dark:bg-rose-700" },
  { key: "other", word: "other", className: "bg-stone-400 dark:bg-stone-600" },
] as const;

/** Stacked horizontal bar of the latest result per test × device; the words are in the tooltip and the aria-label. */
export function LaneBar({ lanes, className }: { lanes: RefSummary["lanes"]; className?: string }) {
  const total = SEGMENTS.reduce((sum, s) => sum + lanes[s.key], 0);
  const text = SEGMENTS.filter((s) => lanes[s.key] > 0)
    .map((s) => `${lanes[s.key]} ${s.word}`)
    .join(" · ");
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          role="img"
          aria-label={text || "No results"}
          className={cn("flex h-2 w-32 overflow-hidden rounded-full bg-muted", className)}
        >
          {SEGMENTS.map((s) =>
            lanes[s.key] > 0 ? <div key={s.key} className={s.className} style={{ width: `${(lanes[s.key] / total) * 100}%` }} /> : null,
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent>{text || "No results"}</TooltipContent>
    </Tooltip>
  );
}
