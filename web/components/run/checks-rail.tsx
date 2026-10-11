import { useEffect, useMemo, useRef, useState } from "react";
import { History, ListChecks, Loader2, Plus } from "lucide-react";

import { CheckStatusIcon } from "@/components/check-status-icon";
import { EmptyState } from "@/components/empty-state";
import { CheckCounts, SegmentedProgress } from "@/components/segmented-progress";
import { MatchBadge, type LinkActions } from "@/components/regression/match-badge";
import { LostCoverage, TRANSITION, TransitionChip } from "@/components/regression/transition";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { isActive, type Check, type ComparePair, type RunComparison, type RunView } from "@/lib/api";
import { formatDurationMs, formatRelative } from "@/lib/format";
import { useNow } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { checkDurationMs, screenshotOfCheck, type GalleryItem } from "./evidence";
import { Thumb } from "./thumb";

type RailFilter = "all" | "fail" | "pass" | "blocked";

const FILTERS: { value: RailFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "fail", label: "Failed" },
  { value: "pass", label: "Passed" },
  { value: "blocked", label: "Blocked" },
];

function isRailFilter(value: string): value is RailFilter {
  return FILTERS.some((f) => f.value === value);
}

const STATUS_BORDER: Record<Check["status"], string> = {
  fail: "border-l-red-500",
  blocked: "border-l-rose-800 dark:border-l-rose-500",
  running: "border-l-blue-500",
  pass: "border-l-transparent",
  skipped: "border-l-transparent",
  pending: "border-l-transparent",
};

const BRANCH_MAX = 24;

function branchText(branch: string | null): string {
  if (!branch) return "";
  return ` on ${branch.length > BRANCH_MAX ? `${branch.slice(0, BRANCH_MAX - 1)}…` : branch}`;
}

/** The one transition line under a check's title: what it was in the baseline run, in the words of the design spec. */
function PairLine({ pair, comparison, matched, now, actions }: { pair: ComparePair; comparison: RunComparison; matched: boolean; now: number; actions: LinkActions }) {
  const was = pair.baseline?.status;
  const on = branchText(comparison.baseline.branch);
  const when = formatRelative(comparison.baselineRun.createdAt, now);
  const base = "mt-1 flex min-w-0 flex-wrap items-center gap-1 text-xs";
  const badge = <MatchBadge pair={pair} actions={actions} />;
  const title = comparison.baseline.branch ?? undefined;
  if (pair.transition === "newly_failing" || pair.transition === "fixed") {
    return (
      <span className={base} title={title}>
        <TransitionChip transition={pair.transition} className="min-w-0 max-w-full">
          <span className="truncate">{`was ${was}${on} · ${when}`}</span>
        </TransitionChip>
        {badge}
      </span>
    );
  }
  if (pair.transition === "flaky" || (pair.flaky && pair.transition === "unchanged")) {
    return (
      <span className={base} title={title}>
        <Tooltip>
          <TooltipTrigger asChild>
            <TransitionChip transition="flaky" className="min-w-0 max-w-full">
              <span className="truncate">{`flaky · was ${was}${on}`}</span>
            </TransitionChip>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">Flipped between pass and fail on the same code and device.</TooltipContent>
        </Tooltip>
        {badge}
      </span>
    );
  }
  if (pair.transition === "changed") {
    const Icon = TRANSITION.changed.icon;
    return (
      <span className={cn(base, "text-muted-foreground")} title={title}>
        <Icon className="size-3 shrink-0" aria-hidden />
        <span className="truncate">{`was ${was}${on}, now ${pair.current?.status}`}</span>
        {pair.lostCoverage ? <LostCoverage pair={pair} /> : null}
        {badge}
      </span>
    );
  }
  if (pair.transition === "still_failing") {
    return (
      <span className={cn(base, "text-muted-foreground")} title={title}>
        <TRANSITION.still_failing.icon className="size-3 shrink-0 text-red-500" aria-hidden />
        <span className="truncate">{`also ${was}${on} · ${when}`}</span>
        {badge}
      </span>
    );
  }
  if (pair.transition === "new" && matched) {
    return (
      <span className={cn(base, "text-muted-foreground")}>
        <Plus className="size-3 shrink-0" aria-hidden />
        new: not in the baseline run
      </span>
    );
  }
  return badge ? <span className={base}>{badge}</span> : null;
}

/** Left rail: progress, status filter tabs and one selectable row per check. */
export function ChecksRail({
  run,
  gallery,
  selected,
  onSelect,
  onOpenImage,
  comparison,
  linkActions,
  onOpenHistory,
}: {
  run: RunView;
  gallery: GalleryItem[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  onOpenImage: (item: GalleryItem) => void;
  comparison: RunComparison | null;
  linkActions: LinkActions;
  onOpenHistory: (checkId: string) => void;
}) {
  const active = isActive(run.status);
  const now = useNow(active ? 1000 : 60_000);
  const [filter, setFilter] = useState<RailFilter>("all");
  const selectedRef = useRef<HTMLLIElement | null>(null);
  const checks = run.checks;
  const resolved = checks.filter((c) => c.status !== "pending" && c.status !== "running").length;
  const pairByCheckId = useMemo(() => new Map((comparison?.pairs ?? []).filter((p) => p.current).map((p) => [p.current?.checkId ?? "", p])), [comparison]);
  const matched = useMemo(() => (comparison?.pairs ?? []).some((p) => p.baseline && p.current), [comparison]);
  const visible = useMemo(() => (filter === "all" ? checks : checks.filter((c) => c.status === filter)), [checks, filter]);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="space-y-2 border-b p-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">Checks</h2>
          <span className="text-xs tabular-nums text-muted-foreground">
            {resolved}/{checks.length}
          </span>
        </div>
        {checks.length > 0 ? (
          <>
            <SegmentedProgress checks={checks} />
            <CheckCounts checks={checks} className="text-xs text-muted-foreground" />
            <Tabs value={filter} onValueChange={(v) => isRailFilter(v) && setFilter(v)}>
              <TabsList className="w-full">
                {FILTERS.map((f) => (
                  <TabsTrigger key={f.value} value={f.value} className="px-1.5 text-xs">
                    {f.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {checks.length === 0 ? (
          <div className="p-3">
            <EmptyState
              icon={active ? Loader2 : ListChecks}
              title={active ? "No checks declared yet" : "No test plan"}
              description={
                active
                  ? "Waiting for the agent to declare its test plan (qa_plan)…"
                  : "The agent never declared a test plan."
              }
            />
          </div>
        ) : visible.length === 0 ? (
          <p className="p-4 text-center text-sm text-muted-foreground">No checks match this filter.</p>
        ) : (
          <ul className="divide-y">
            {visible.map((c) => {
              const shot = screenshotOfCheck(run, c, gallery);
              const duration = checkDurationMs(c, run.endedAt ? Date.parse(run.endedAt) : now);
              const isSelected = selected === c.id;
              const pair = pairByCheckId.get(c.id);
              return (
                <li
                  key={c.id}
                  ref={isSelected ? selectedRef : undefined}
                  className={cn("group relative border-l-2 px-3 py-2.5", STATUS_BORDER[c.status], isSelected && "bg-accent")}
                >
                  <button
                    type="button"
                    onClick={() => onSelect(isSelected ? null : c.id)}
                    aria-pressed={isSelected}
                    className="flex w-full min-w-0 items-start gap-2 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <CheckStatusIcon status={c.status} className="mt-0.5" />
                    <span className="min-w-0 flex-1 space-y-0.5">
                      <span className="flex items-baseline gap-2">
                        <span className="font-mono text-xs text-muted-foreground">{c.id}</span>
                        {duration !== null ? (
                          <span className="ml-auto mr-6 text-xs tabular-nums text-muted-foreground">{formatDurationMs(duration)}</span>
                        ) : null}
                      </span>
                      <span className="line-clamp-2 block break-words text-sm">{c.title}</span>
                      {c.note ? (
                        <span className={cn("block break-words text-xs text-muted-foreground", !isSelected && "line-clamp-2")}>
                          {c.note}
                        </span>
                      ) : null}
                    </span>
                  </button>
                  {pair && comparison ? (
                    <div className="pl-6">
                      <PairLine pair={pair} comparison={comparison} matched={matched} now={now} actions={linkActions} />
                    </div>
                  ) : null}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`History of ${c.id}`}
                        onClick={() => onOpenHistory(c.id)}
                        className={cn(
                          "absolute right-2 top-2 opacity-0 focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100",
                          isSelected && "opacity-100",
                        )}
                      >
                        <History />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Check history (h)</TooltipContent>
                  </Tooltip>
                  {shot ? (
                    <div className="mt-2 pl-6">
                      <Thumb url={shot.url} label={`${c.id} — ${c.title}`} onOpen={() => onOpenImage(shot)} />
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
