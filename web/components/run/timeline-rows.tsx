import { memo, useState } from "react";
import {
  Bot,
  CircleX,
  Code2,
  FileText,
  Flag,
  Info,
  ListChecks,
  Loader2,
  Smartphone,
  Terminal,
  TriangleAlert,
  User,
  Wrench,
  type LucideIcon,
} from "lucide-react";

import { CheckStatusIcon } from "@/components/check-status-icon";
import { Badge } from "@/components/ui/badge";
import type { Check } from "@/lib/api";
import { formatDurationMs } from "@/lib/format";
import { cn } from "@/lib/utils";
import { checkDurationMs } from "./evidence";
import { formatArgs, formatToolDuration, type ToolFamily } from "./humanise";
import { formatOffset, type TimelineRow, type TimelineSection, type ToolRow } from "./timeline-model";

const FAMILY_ICON: Record<ToolFamily, LucideIcon> = {
  device: Smartphone,
  shell: Terminal,
  code: Code2,
  file: FileText,
  check: ListChecks,
  other: Wrench,
};

const FAMILY_TONE: Record<ToolFamily, string> = {
  device: "text-blue-600 dark:text-blue-400",
  shell: "text-zinc-600 dark:text-zinc-400",
  code: "text-violet-600 dark:text-violet-400",
  file: "text-teal-600 dark:text-teal-400",
  check: "text-emerald-600 dark:text-emerald-400",
  other: "text-muted-foreground",
};

export type TimeMode = "relative" | "absolute";

function timeLabel(ts: string, mode: TimeMode, startTs: string): string {
  if (mode === "relative") return formatOffset(ts, startTs);
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour12: false });
}

function Time({ ts, mode, startTs }: { ts: string; mode: TimeMode; startTs: string }) {
  return (
    <time dateTime={ts} className="w-14 shrink-0 pt-0.5 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
      {timeLabel(ts, mode, startTs)}
    </time>
  );
}

function ToolLine({ row, mode, startTs, live }: { row: ToolRow; mode: TimeMode; startTs: string; live: boolean }) {
  const [open, setOpen] = useState(false);
  const Icon = FAMILY_ICON[row.human.family];
  const failed = row.end?.ok === false;
  const pending = row.end === null && row.start !== null && live;
  const args = formatArgs(row.args);
  const result = row.end?.text?.trim() ?? "";

  return (
    <div className={cn("rounded-md", failed && "bg-red-500/5")}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-start gap-2 rounded-md px-2 py-1 text-left outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Time ts={row.ts} mode={mode} startTs={startTs} />
        <Icon className={cn("mt-0.5 size-3.5 shrink-0", failed ? "text-red-500" : FAMILY_TONE[row.human.family])} />
        <span className={cn("min-w-0 flex-1 break-words text-sm", failed && "text-red-700 dark:text-red-300")}>{row.human.label}</span>
        {pending ? (
          <Loader2 className="mt-0.5 size-3 shrink-0 animate-spin text-muted-foreground" aria-label="running" />
        ) : row.end ? (
          <span className="mt-0.5 flex shrink-0 items-center gap-1.5 text-xs tabular-nums text-muted-foreground">
            {row.end.durationMs !== undefined ? formatToolDuration(row.end.durationMs) : null}
            {failed ? <span className="font-medium text-red-500" aria-label="failed">✗</span> : <span className="text-emerald-500" aria-label="ok">✓</span>}
          </span>
        ) : null}
      </button>
      {failed && result && !open ? (
        <p className="truncate pb-1 pl-[5.25rem] pr-3 text-xs text-red-600/90 dark:text-red-400/90">{result.split("\n")[0]}</p>
      ) : null}
      {open ? (
        <div className="space-y-2 pb-2 pl-[5.25rem] pr-2">
          <div className="font-mono text-[11px] text-muted-foreground">{row.tool}</div>
          {args ? (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-2 font-mono text-xs">{args}</pre>
          ) : null}
          {result ? (
            <div className="space-y-1">
              <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{failed ? "Error" : "Result"}</div>
              <pre
                className={cn(
                  "max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border p-2 font-mono text-xs",
                  failed ? "border-red-500/30 bg-red-500/5" : "bg-muted/40",
                )}
              >
                {result}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const NOTE_STYLE: Record<string, { icon: LucideIcon; row: string; label: string }> = {
  warn: { icon: TriangleAlert, row: "bg-amber-500/10 text-amber-800 dark:text-amber-200", label: "warning" },
  error: { icon: CircleX, row: "bg-red-500/10 text-red-800 dark:text-red-200", label: "error" },
  info: { icon: Info, row: "text-muted-foreground", label: "info" },
  user: { icon: User, row: "bg-violet-500/10 text-violet-900 dark:text-violet-100", label: "you" },
};

function TimelineRowViewImpl({
  row,
  mode,
  startTs,
  live,
  onSelectCheck,
}: {
  row: TimelineRow;
  mode: TimeMode;
  startTs: string;
  live: boolean;
  onSelectCheck: (id: string) => void;
}) {
  switch (row.type) {
    case "tool":
      return <ToolLine row={row} mode={mode} startTs={startTs} live={live} />;
    case "say":
      return (
        <div className="flex items-start gap-2 px-2 py-1">
          <Time ts={row.ts} mode={mode} startTs={startTs} />
          <Bot className="mt-2 size-3.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 max-w-[92%] whitespace-pre-wrap break-words rounded-lg rounded-tl-sm bg-muted px-3 py-1.5 text-sm leading-relaxed">
            {row.a.text}
          </div>
        </div>
      );
    case "note": {
      const style = NOTE_STYLE[row.a.kind] ?? NOTE_STYLE.info;
      if (!style) return null;
      const Icon = style.icon;
      return (
        <div className={cn("mx-1 flex items-start gap-2 rounded-md px-1 py-1", style.row)}>
          <Time ts={row.ts} mode={mode} startTs={startTs} />
          <Icon className="mt-0.5 size-3.5 shrink-0" aria-label={style.label} />
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm">{row.a.text}</span>
        </div>
      );
    }
    case "milestone": {
      const { checkId, checkStatus } = row.a;
      const content = (
        <>
          <Time ts={row.ts} mode={mode} startTs={startTs} />
          {checkStatus ? <CheckStatusIcon status={checkStatus} className="mt-0.5 size-3.5" /> : <Flag className="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />}
          <span className="min-w-0 flex-1 break-words text-sm font-medium">{row.a.text}</span>
          {checkId ? (
            <Badge variant="outline" className="shrink-0 font-mono">
              {checkId}
            </Badge>
          ) : null}
        </>
      );
      return checkId ? (
        <button
          type="button"
          onClick={() => onSelectCheck(checkId)}
          className="flex w-full items-start gap-2 rounded-md px-2 py-1 text-left outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring"
        >
          {content}
        </button>
      ) : (
        <div className="flex items-start gap-2 px-2 py-1">{content}</div>
      );
    }
  }
}

export const TimelineRowView = memo(TimelineRowViewImpl);

/** Sticky header of one section: the check it belongs to, its status and how long it took. */
export function SectionHeader({
  section,
  check,
  now,
  selected,
  wrapUp,
  onSelect,
}: {
  section: TimelineSection;
  check: Check | undefined;
  now: number;
  selected: boolean;
  wrapUp: boolean;
  onSelect: (id: string) => void;
}) {
  const duration = check ? checkDurationMs(check, now) : null;
  const base = "sticky top-0 z-10 flex w-full items-center gap-2 border-b bg-background/95 px-3 py-1.5 text-left backdrop-blur";
  if (section.kind !== "check" || !section.checkId) {
    return (
      <div className={cn(base, "text-xs font-medium uppercase tracking-wide text-muted-foreground")}>
        {section.kind === "setup" ? "Setup" : wrapUp ? "Report & wrap-up" : "Between checks"}
      </div>
    );
  }
  const checkId = section.checkId;
  return (
    <button
      type="button"
      onClick={() => onSelect(checkId)}
      className={cn(base, "outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring", selected && "bg-accent")}
    >
      <CheckStatusIcon status={check?.status ?? "running"} />
      <span className="font-mono text-xs text-muted-foreground">{checkId}</span>
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{check?.title ?? checkId}</span>
      {duration !== null ? <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{formatDurationMs(duration)}</span> : null}
    </button>
  );
}
