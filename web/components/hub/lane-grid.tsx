import { Grid3x3, Search, Snowflake } from "lucide-react";
import { useRef, useState } from "react";

import { EmptyState } from "@/components/empty-state";
import { RegressionCount } from "@/components/regression/transition";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { VerdictStrip } from "@/components/verdict-strip";
import { compareHash, type LaneCell, type OverviewShow, type Platform, type ProjectOverview, runHash } from "@/lib/api";
import { formatRelative, PLATFORM_ICON, PLATFORM_LABEL } from "@/lib/format";
import { useNow, useShortcut } from "@/lib/hooks";
import { briefAttribution, filterLanes, type LaneRow, type LaneSort, PLATFORM_ORDER, sortLanes } from "@/lib/hub";
import { readStorage, writeStorage } from "@/lib/storage";
import { cn } from "@/lib/utils";
import { VerdictCell } from "@/components/hub/verdict-cell";

const SORT_KEY = "tapocalypse-lanes-sort";
const PAGE = 25;
const BRANCH_MAX = 24;

const ellipsize = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function readSort(): LaneSort {
  const stored = readStorage(SORT_KEY);
  return stored === "recent" || stored === "title" ? stored : "problems";
}

function LaneCellView({ cell, now, lane, platform, projectId }: { cell: LaneCell; now: number; lane: LaneRow; platform: Platform; projectId: string }) {
  const { latest } = cell;
  const where = latest.branch ?? latest.versionName;
  const by = briefAttribution(latest.machine, latest.uploader);
  const when = formatRelative(latest.endedAt ?? latest.createdAt, now);
  const line = [where ? ellipsize(where, BRANCH_MAX) : null, when, by?.text].filter(Boolean).join(" · ");
  return (
    <div className="relative space-y-1">
      <div className="flex items-center gap-1.5">
        <a
          href={runHash(latest.id)}
          aria-label={`${lane.title} on ${PLATFORM_LABEL[platform]}: ${latest.verdict ?? "no verdict"}`}
          className="rounded-md outline-none after:absolute after:inset-0 focus-visible:ring-2 focus-visible:ring-ring"
        >
          <VerdictCell verdict={latest.verdict} size="sm" />
        </a>
        {cell.newlyFailing > 0 && (
          <RegressionCount
            count={cell.newlyFailing}
            href={compareHash(latest.id, "auto", { show: "newly_failing" })}
            tooltip={`${cell.newlyFailing} newly failing vs its baseline`}
          />
        )}
        {cell.flaky > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="relative z-10 inline-flex items-center gap-0.5 text-[11px] text-fuchsia-700 dark:text-fuchsia-400">
                <Snowflake className="size-3" aria-hidden />
                {cell.flaky}
              </span>
            </TooltipTrigger>
            <TooltipContent>{cell.flaky} flaky checks</TooltipContent>
          </Tooltip>
        )}
        <span className="ml-auto">
          <VerdictStrip items={cell.history} size="sm" max={10} />
        </span>
      </div>
      <div className="truncate text-xs text-muted-foreground" title={[where, when, by?.title].filter(Boolean).join(" · ")}>
        {line}
      </div>
      {cell.newerWithoutVerdict > 0 && (
        <a href={`#/runs?project=${encodeURIComponent(projectId)}`} className="relative z-10 block text-xs text-muted-foreground hover:underline">
          +{cell.newerWithoutVerdict} newer {cell.newerWithoutVerdict === 1 ? "run" : "runs"} without a verdict
        </a>
      )}
    </div>
  );
}

const NOT_TESTED = <span className="text-xs text-muted-foreground">not tested</span>;

function checks(lane: LaneRow): string {
  return `${lane.suiteId ? "suite · " : ""}${lane.checks} checks`;
}

/** Latest result per test and platform: filterable, sortable, with a history strip per cell. */
export function LaneGrid({
  lanes,
  projectId,
  show,
  onShowChange,
  id,
}: {
  lanes: ProjectOverview["lanes"] | null;
  projectId: string;
  show: OverviewShow | null;
  onShowChange(show: OverviewShow | null): void;
  id?: string;
}) {
  const now = useNow(30_000);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<LaneSort>(readSort);
  const [all, setAll] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useShortcut("/", () => input.current?.focus());

  if (lanes === null) {
    return (
      <Card className="gap-0 p-0" id={id}>
        <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-8 w-56" />
        </div>
        <div className="space-y-2 p-3" aria-label="Loading results">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </div>
      </Card>
    );
  }
  if (lanes.length === 0) {
    return <EmptyState icon={Grid3x3} title="No tests yet" description="Tests appear after the first finished run with checks." />;
  }

  const platforms = PLATFORM_ORDER.filter((p) => lanes.some((l) => l.platforms[p]));
  const rows = sortLanes(filterLanes(lanes, { show, q }), sort);
  const shown = all ? rows : rows.slice(0, PAGE);
  const clear = () => {
    setQ("");
    onShowChange(null);
  };
  return (
    <Card className="gap-0 overflow-hidden p-0" id={id}>
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <h2 className="text-sm font-medium">
          Latest results <span className="font-normal text-muted-foreground">· {lanes.length} tests</span>
        </h2>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter tests…" aria-label="Filter tests" className="h-8 w-56 pl-7" />
        </div>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={show ?? "all"}
          onValueChange={(v) => v && onShowChange(v === "all" ? null : (v as OverviewShow))}
          aria-label="Show"
        >
          <ToggleGroupItem value="all">All</ToggleGroupItem>
          <ToggleGroupItem value="failing">Failing</ToggleGroupItem>
          <ToggleGroupItem value="newly_failing">Newly failing</ToggleGroupItem>
          <ToggleGroupItem value="flaky">Flaky</ToggleGroupItem>
        </ToggleGroup>
        <Select
          value={sort}
          onValueChange={(v) => {
            setSort(v as LaneSort);
            writeStorage(SORT_KEY, v);
          }}
        >
          <SelectTrigger className="h-8 w-40" aria-label="Sort">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="problems">Problems first</SelectItem>
            <SelectItem value="recent">Recently tested</SelectItem>
            <SelectItem value="title">A–Z</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {rows.length === 0 ? (
        <div className="flex items-center justify-center gap-2 px-3 py-6 text-sm text-muted-foreground">
          No tests match.
          <Button variant="link" size="xs" onClick={clear}>
            Clear filters
          </Button>
        </div>
      ) : (
        <>
          <div className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-56">Test</TableHead>
                  {platforms.map((p) => {
                    const Icon = PLATFORM_ICON[p];
                    return (
                      <TableHead key={p} className="w-[13.5rem] xl:w-64">
                        <span className="inline-flex items-center gap-1.5">
                          <Icon className="size-3.5" aria-hidden />
                          {PLATFORM_LABEL[p]}
                        </span>
                      </TableHead>
                    );
                  })}
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.map((lane) => (
                  <TableRow key={lane.testKey} className="align-top">
                    <TableCell className="whitespace-normal">
                      <div className="line-clamp-2 font-medium" title={lane.title}>
                        {lane.title}
                      </div>
                      <div className="text-xs text-muted-foreground">{checks(lane)}</div>
                    </TableCell>
                    {platforms.map((p) => {
                      const cell = lane.platforms[p];
                      return (
                        <TableCell key={p} className="whitespace-normal">
                          {cell ? <LaneCellView cell={cell} now={now} lane={lane} platform={p} projectId={projectId} /> : NOT_TESTED}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <ul className="divide-y md:hidden">
            {shown.map((lane) => (
              <li key={lane.testKey} className="space-y-2 px-3 py-3">
                <div>
                  <div className="line-clamp-2 text-sm font-medium">{lane.title}</div>
                  <div className="text-xs text-muted-foreground">{checks(lane)}</div>
                </div>
                {platforms.map((p) => {
                  const cell = lane.platforms[p];
                  const Icon = PLATFORM_ICON[p];
                  return (
                    <div key={p} className={cn("flex items-start gap-2", !cell && "items-center")}>
                      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-label={PLATFORM_LABEL[p]} />
                      <div className="min-w-0 flex-1">{cell ? <LaneCellView cell={cell} now={now} lane={lane} platform={p} projectId={projectId} /> : NOT_TESTED}</div>
                    </div>
                  );
                })}
              </li>
            ))}
          </ul>
          {rows.length > shown.length && (
            <Button variant="ghost" size="sm" className="w-full rounded-none border-t" onClick={() => setAll(true)}>
              Show all {rows.length} tests
            </Button>
          )}
        </>
      )}
    </Card>
  );
}
