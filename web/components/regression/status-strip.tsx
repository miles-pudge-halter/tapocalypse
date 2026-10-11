import { SEGMENT_COLOR } from "@/components/segmented-progress";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { CheckStatus } from "@/lib/api";
import { cn } from "@/lib/utils";

/** `null` = no decisive result (the run ended before resolving the check). */
export type StripStatus = CheckStatus | null;

/** A row of coloured squares, oldest on the left; the history sheet, compare detail and flaky table share it. */
export function StatusStrip({
  statuses,
  size,
  current,
  labels,
  sameCodeFlip,
  onSelect,
  className,
}: {
  /** Oldest → newest. */
  statuses: readonly StripStatus[];
  size: "sm" | "md";
  /** Index of the square that stands for the run being viewed. */
  current?: number;
  /** Tooltip / title per square, same order. */
  labels?: readonly string[];
  /** Squares that flipped pass↔fail on the same code get a fuchsia dot (md only). */
  sameCodeFlip?: readonly boolean[];
  onSelect?(index: number): void;
  className?: string;
}) {
  const md = size === "md";
  const words = statuses.map((s) => s ?? "not reached").join(", ");
  return (
    <div
      role={onSelect ? "group" : "img"}
      aria-label={`Last ${statuses.length} results, oldest first: ${words}`}
      className={cn("flex items-center", md ? "gap-0.5" : "gap-px", className)}
    >
      {statuses.map((status, i) => {
        const label = labels?.[i] ?? status ?? "not reached";
        const square = (
          <span
            className={cn(
              "relative block shrink-0",
              md ? "h-5 w-3 rounded-[3px]" : "h-3 w-2 rounded-[2px]",
              status ? SEGMENT_COLOR[status] : "border border-dashed border-muted-foreground/40",
              current === i && "ring-2 ring-ring ring-offset-1 ring-offset-background",
            )}
            title={md ? undefined : label}
          >
            {md && sameCodeFlip?.[i] ? (
              <span aria-hidden className="absolute -bottom-1.5 left-1/2 size-1 -translate-x-1/2 rounded-full bg-fuchsia-500" />
            ) : null}
          </span>
        );
        if (!md) return <span key={i}>{square}</span>;
        return (
          <Tooltip key={i}>
            <TooltipTrigger asChild>
              {onSelect ? (
                <button type="button" aria-label={label} onClick={() => onSelect(i)} className="rounded-[3px] outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  {square}
                </button>
              ) : (
                <span>{square}</span>
              )}
            </TooltipTrigger>
            <TooltipContent>{label}</TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
