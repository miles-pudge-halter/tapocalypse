import { ArrowDown, Percent, Snowflake, TrendingDown, TrendingUp, XCircle, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { flakyHash, overviewHash, type ProjectOverview, type Ref } from "@/lib/api";
import { runsHash } from "@/lib/hooks";
import { passRateDelta, refRunFilters } from "@/lib/hub";
import { cn } from "@/lib/utils";

function Tile({ label, icon: Icon, href, value, valueClass, children }: { label: string; icon: LucideIcon; href: string; value: ReactNode; valueClass?: string; children: ReactNode }) {
  return (
    <Card className="relative gap-1 p-4 hover:bg-muted/40 focus-within:ring-2 focus-within:ring-ring">
      <a href={href} className="absolute inset-0 rounded-xl outline-none" aria-label={label} />
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Icon className="size-3.5" aria-hidden />
        {label}
      </div>
      <div className={cn("text-2xl font-semibold tabular-nums", valueClass)}>{value}</div>
      <div className="text-xs text-muted-foreground">{children}</div>
    </Card>
  );
}

/** The change against the window before, followed by its separator; nothing when there is no earlier window to compare with. */
function Delta({ rate, days }: { rate: ProjectOverview["passRate"]; days: number }) {
  const delta = passRateDelta(rate);
  if (delta.kind === "none") return null;
  if (delta.kind === "same") return <span>same as the {days} days before · </span>;
  const up = delta.kind === "up";
  const Icon = up ? TrendingUp : TrendingDown;
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={cn("relative z-10 inline-flex items-center gap-0.5", up ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400")}>
            <Icon className="size-3" aria-hidden />
            {up ? "↑" : "↓"} {delta.points} pts
          </span>
        </TooltipTrigger>
        <TooltipContent>Previous {days} days: {Math.round((rate.previous ?? 0) * 100)}%</TooltipContent>
      </Tooltip>
      {" · "}
    </>
  );
}

export function KpiTiles({ overview, projectId, refValue }: { overview: ProjectOverview; projectId: string; refValue: Ref | null }) {
  const { passRate, counts } = overview;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Tile
        label="Pass rate"
        icon={Percent}
        href={runsHash({ project: projectId, verdict: ["PASS", "PASS WITH ISSUES", "FAIL"], ...refRunFilters(refValue) })}
        value={passRate.decided === 0 || passRate.current === null ? "—" : `${Math.round(passRate.current * 100)}%`}
      >
        <Delta rate={passRate} days={overview.days} />{passRate.pass} of {passRate.decided} runs passed
      </Tile>
      <Tile
        label="Newly failing"
        icon={ArrowDown}
        href={overviewHash(projectId, { ref: refValue, show: "newly_failing" })}
        value={counts.newlyFailing}
        valueClass={counts.newlyFailing > 0 ? "text-red-700 dark:text-red-400" : undefined}
      >
        {counts.newlyFailing > 0 ? `in ${counts.newlyFailingTests} tests` : "Nothing that passed before fails now"}
      </Tile>
      <Tile
        label="Flaky checks"
        icon={Snowflake}
        href={flakyHash(projectId)}
        value={counts.flaky}
        valueClass={counts.flaky > 0 ? "text-fuchsia-700 dark:text-fuchsia-400" : undefined}
      >
        {counts.suspects > 0 ? `+${counts.suspects} suspects` : counts.flaky > 0 ? "no suspects" : "No flaky checks"}
      </Tile>
      <Tile
        label="Failing now"
        icon={XCircle}
        href={overviewHash(projectId, { ref: refValue, show: "failing" })}
        value={`${counts.failingNow} tests`}
        valueClass={counts.failingNow > 0 ? "text-red-700 dark:text-red-400" : undefined}
      >
        {counts.blockedNow > 0 ? `${counts.blockedNow} could not be tested` : "on their latest run"}
      </Tile>
    </div>
  );
}

export function KpiSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Loading">
      {[0, 1, 2, 3].map((i) => (
        <Skeleton key={i} className="h-24" />
      ))}
    </div>
  );
}
