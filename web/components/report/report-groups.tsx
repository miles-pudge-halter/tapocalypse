import { Play } from "lucide-react";
import { useMemo } from "react";
import { Card } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { VerdictBadge } from "@/components/verdict-badge";
import type { ReportEntry } from "@/lib/api";
import { formatRelative, formatTime } from "@/lib/format";

export type VerdictFilter = "all" | "pass" | "fail" | "issues" | "other";

export function matchesVerdict(report: ReportEntry, filter: VerdictFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "pass":
      return report.verdict === "PASS";
    case "fail":
      return report.verdict === "FAIL";
    case "issues":
      return report.verdict === "PASS WITH ISSUES";
    case "other":
      return report.verdict !== "PASS" && report.verdict !== "FAIL" && report.verdict !== "PASS WITH ISSUES";
  }
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function dayLabel(date: Date, now: number): string {
  const today = new Date(now);
  if (dayKey(date) === dayKey(today)) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (dayKey(date) === dayKey(yesterday)) return "Yesterday";
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: date.getFullYear() === today.getFullYear() ? undefined : "numeric",
  });
}

interface DayGroup {
  key: string;
  label: string;
  reports: ReportEntry[];
}

/** Groups newest-first reports by local calendar day, preserving order. */
function groupByDay(reports: ReportEntry[], now: number): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const report of reports) {
    const date = new Date(report.mtime);
    const key = dayKey(date);
    const last = groups.at(-1);
    if (last?.key === key) last.reports.push(report);
    else groups.push({ key, label: dayLabel(date, now), reports: [report] });
  }
  return groups;
}

function ReportRow({ report, projectId, now }: { report: ReportEntry; projectId: string; now: number }) {
  return (
    <li className="relative flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/50">
      <div className="min-w-0 flex-1">
        <a
          href={`#/p/${encodeURIComponent(projectId)}/reports/${encodeURIComponent(report.name)}`}
          className="block truncate font-medium after:absolute after:inset-0 hover:underline"
        >
          {report.title || report.name}
        </a>
        <div className="truncate font-mono text-xs text-muted-foreground">{report.name}</div>
      </div>
      {report.runId ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <a
              href={`#/runs/${encodeURIComponent(report.runId)}`}
              className="relative z-10 inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-xs text-muted-foreground hover:bg-background hover:text-foreground"
            >
              <Play className="size-3" />
              Run
            </a>
          </TooltipTrigger>
          <TooltipContent>Open the run that produced this report</TooltipContent>
        </Tooltip>
      ) : null}
      <div className="flex w-36 shrink-0 justify-end">
        <VerdictBadge verdict={report.verdict} />
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="w-20 shrink-0 text-right text-sm tabular-nums text-muted-foreground">
            {formatRelative(report.mtime, now)}
          </span>
        </TooltipTrigger>
        <TooltipContent>{formatTime(report.mtime)}</TooltipContent>
      </Tooltip>
    </li>
  );
}

/** Reports under day headings; every row links to its report and, when known, to its run. */
export function ReportGroups({ reports, projectId, now }: { reports: ReportEntry[]; projectId: string; now: number }) {
  const groups = useMemo(() => groupByDay(reports, now), [reports, now]);
  return (
    <div className="space-y-5">
      {groups.map((group) => (
        <section key={group.key} className="space-y-2">
          <h2 className="px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {group.label}
            <span className="ml-2 font-normal normal-case tabular-nums">{group.reports.length}</span>
          </h2>
          <Card className="gap-0 overflow-hidden py-0">
            <ul className="divide-y">
              {group.reports.map((report) => (
                <ReportRow key={report.name} report={report} projectId={projectId} now={now} />
              ))}
            </ul>
          </Card>
        </section>
      ))}
    </div>
  );
}
