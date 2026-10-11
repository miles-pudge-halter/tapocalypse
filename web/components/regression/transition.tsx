import { ArrowDown, ArrowLeftRight, ArrowUp, Circle, EyeOff, Equal, Minus, Plus, Snowflake, XCircle, type LucideIcon } from "lucide-react";
import type { ComponentProps } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { CheckStatus, ComparePair, Transition } from "@/lib/api";
import { cn } from "@/lib/utils";

const NEUTRAL_CHIP = "border-border text-muted-foreground";

interface TransitionStyle {
  icon: LucideIcon;
  /** Group heading. */
  label: string;
  /** Short word for the strip and the filter. */
  short: string;
  chip: string;
  text: string;
  /** Left edge of a table row. */
  border: string;
}

/** One table for every transition's glyph, words and colours (regressions red + ArrowDown, fixed green + ArrowUp, flaky fuchsia + Snowflake). */
export const TRANSITION: Record<Transition, TransitionStyle> = {
  newly_failing: {
    icon: ArrowDown,
    label: "Newly failing",
    short: "newly failing",
    chip: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
    text: "text-red-700 dark:text-red-400",
    border: "border-l-red-500",
  },
  flaky: {
    icon: Snowflake,
    label: "Flaky",
    short: "flaky",
    chip: "border-fuchsia-500/30 bg-fuchsia-500/10 text-fuchsia-800 dark:text-fuchsia-300",
    text: "text-fuchsia-700 dark:text-fuchsia-400",
    border: "border-l-fuchsia-500",
  },
  fixed: {
    icon: ArrowUp,
    label: "Fixed",
    short: "fixed",
    chip: "border-emerald-500/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300",
    text: "text-emerald-700 dark:text-emerald-400",
    border: "border-l-emerald-500",
  },
  changed: {
    icon: ArrowLeftRight,
    label: "Status changed",
    short: "changed",
    chip: NEUTRAL_CHIP,
    text: "text-muted-foreground",
    border: "border-l-stone-400",
  },
  still_failing: {
    icon: XCircle,
    label: "Still failing",
    short: "still failing",
    chip: "border-red-500/30 text-red-700 dark:text-red-400",
    text: "text-red-700 dark:text-red-400",
    border: "border-l-red-500/40",
  },
  new: { icon: Plus, label: "New in this run", short: "new", chip: NEUTRAL_CHIP, text: "text-muted-foreground", border: "border-l-transparent" },
  removed: { icon: Minus, label: "Not in this run", short: "removed", chip: NEUTRAL_CHIP, text: "text-muted-foreground", border: "border-l-transparent" },
  unchanged: { icon: Equal, label: "Unchanged", short: "unchanged", chip: NEUTRAL_CHIP, text: "text-muted-foreground", border: "border-l-transparent" },
  pending: { icon: Circle, label: "Not reached yet", short: "pending", chip: NEUTRAL_CHIP, text: "text-muted-foreground", border: "border-l-transparent" },
};

export const FLAKY_TEXT = TRANSITION.flaky.text;
/** Outline-only fuchsia chip (a "suspect" check). */
export const SUSPECT_CHIP = "border-fuchsia-500/40 text-fuchsia-700 dark:text-fuchsia-400";

export function TransitionChip({
  transition,
  count,
  className,
  children,
  ...rest
}: { transition: Transition; count?: number } & ComponentProps<"span">) {
  const style = TRANSITION[transition];
  const Icon = style.icon;
  return (
    <span {...rest} className={cn("inline-flex items-center gap-1 rounded-md border px-1.5 text-xs font-medium leading-5 tabular-nums", style.chip, className)}>
      <Icon className="size-3 shrink-0" aria-hidden />
      {count !== undefined ? <span>{count}</span> : null}
      {children}
    </span>
  );
}

/** Compact runs-list indicator: `↓ 2`, red. The caller supplies the link and its tooltip. */
export function RegressionCount({ count, href, tooltip }: { count: number; href: string; tooltip: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <a
          href={href}
          aria-label={`${count} newly failing`}
          className={cn(
            "relative z-10 inline-flex shrink-0 items-center rounded border px-1 text-[10px] font-medium leading-4 tabular-nums hover:underline",
            TRANSITION.newly_failing.chip,
          )}
        >
          <ArrowDown className="size-3" aria-hidden />
          {count}
        </a>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs whitespace-pre-line break-words">{tooltip}</TooltipContent>
    </Tooltip>
  );
}

const NOW_WORD: Partial<Record<CheckStatus, string>> = { blocked: "blocked", skipped: "skipped", pending: "not reached", running: "not reached" };

/** Orange "lost coverage" marker: decisive in the baseline, not tested this time. */
export function LostCoverage({ pair, count }: { pair?: ComparePair; count?: number }) {
  const now = pair?.current ? (NOW_WORD[pair.current.status] ?? "not reached") : "not reached";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className="inline-flex h-4 shrink-0 items-center gap-1 rounded-md border border-dashed border-orange-500/40 px-1 text-[10px] font-medium text-orange-700 dark:text-orange-400"
        >
          <EyeOff className="size-3" aria-hidden />
          {count !== undefined ? `${count} lost coverage` : "lost coverage"}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        This check was decisive (pass or fail) in the baseline but is {now} now, so it was not really tested this time.
      </TooltipContent>
    </Tooltip>
  );
}
