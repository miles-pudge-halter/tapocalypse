import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ProjectOverview } from "@/lib/api";
import { TREND_COLUMN, type TrendKind, trendBars, trendTooltip } from "@/lib/hub";
import { cn } from "@/lib/utils";

type Trend = ProjectOverview["trend"];

const FILL: Record<TrendKind, string> = {
  pass: "fill-emerald-500",
  issues: "fill-orange-400",
  fail: "fill-red-500",
  other: "fill-stone-400 dark:fill-stone-600",
};

const LEGEND: { kind: TrendKind; word: string; swatch: string }[] = [
  { kind: "pass", word: "pass", swatch: "bg-emerald-500" },
  { kind: "issues", word: "with issues", swatch: "bg-orange-400" },
  { kind: "fail", word: "fail", swatch: "bg-red-500" },
  { kind: "other", word: "other", swatch: "bg-stone-400 dark:bg-stone-600" },
];

const dayLabel = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const axisLabel = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", timeZone: "UTC" });
const parseDay = (date: string) => new Date(`${date}T00:00:00Z`);

/** Stacked bars of results per day: hand-written SVG in status colours (no chart dependency). `sm` is the 32 px sparkline of a project card. */
export function PassRateTrend({ trend, days, size = "md" }: { trend: Trend; days: number; size?: "md" | "sm" }) {
  const bars = trendBars(trend);
  const totals = trend.reduce((t, d) => ({ runs: t.runs + d.runs, pass: t.pass + d.pass, fail: t.fail + d.fail }), { runs: 0, pass: 0, fail: 0 });
  const label = `Runs per day over the last ${days} days: ${totals.runs} runs, ${totals.pass} passed, ${totals.fail} failed.`;
  const small = size === "sm";
  const chart = (
    <div className="relative">
      <svg
        role="img"
        aria-label={label}
        viewBox={`0 0 ${Math.max(1, trend.length) * TREND_COLUMN} 100`}
        preserveAspectRatio="none"
        className={cn("w-full", small ? "h-8" : "h-40")}
      >
        {bars.map((bar, i) => {
          const day = trend[i];
          if (!day) return null;
          return (
            <g key={day.date}>
              {bar.empty ? <rect x={bar.x} y={98.5} width={7} height={1.5} className="fill-border" /> : null}
              {bar.segments.map((s) => (
                <rect key={s.kind} x={bar.x} y={s.y} width={7} height={s.height} className={FILL[s.kind]} />
              ))}
              {small ? null : (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <rect x={i * TREND_COLUMN} y={0} width={TREND_COLUMN} height={100} fill="transparent" />
                  </TooltipTrigger>
                  <TooltipContent>{trendTooltip(dayLabel.format(parseDay(day.date)), day)}</TooltipContent>
                </Tooltip>
              )}
            </g>
          );
        })}
      </svg>
      {!small && totals.runs === 0 && (
        <p className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">No runs in the last {days} days</p>
      )}
    </div>
  );
  if (small) return chart;
  const first = trend[0];
  const middle = trend[Math.floor(trend.length / 2)];
  return (
    <>
      {chart}
      <div className="mt-1 flex justify-between text-[10px] tabular-nums text-muted-foreground" aria-hidden>
        <span>{first ? axisLabel.format(parseDay(first.date)) : ""}</span>
        <span className="hidden sm:inline">{middle ? axisLabel.format(parseDay(middle.date)) : ""}</span>
        <span>Today</span>
      </div>
      <div className="mt-2 flex flex-wrap gap-3 text-xs text-muted-foreground">
        {LEGEND.map((l) => (
          <span key={l.kind} className="inline-flex items-center gap-1.5">
            <span className={cn("size-2 rounded-sm", l.swatch)} />
            {l.word}
          </span>
        ))}
      </div>
      <table className="sr-only">
        <caption>{label}</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            <th scope="col">Runs</th>
            <th scope="col">Pass</th>
            <th scope="col">With issues</th>
            <th scope="col">Fail</th>
            <th scope="col">Other</th>
          </tr>
        </thead>
        <tbody>
          {trend.map((d) => (
            <tr key={d.date}>
              <th scope="row">{dayLabel.format(parseDay(d.date))}</th>
              <td>{d.runs}</td>
              <td>{d.pass}</td>
              <td>{d.issues}</td>
              <td>{d.fail}</td>
              <td>{d.other}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

export function TrendCard({ trend, days, scope }: { trend: Trend | null; days: number; scope: string | null }) {
  return (
    <Card className="gap-3 py-4">
      <CardHeader className="px-4">
        <CardTitle className="text-sm font-medium">
          Results per day <span className="font-normal text-muted-foreground">· {days} days{scope ? ` · ${scope}` : ""}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4">{trend ? <PassRateTrend trend={trend} days={days} /> : <Skeleton className="h-40" />}</CardContent>
    </Card>
  );
}
