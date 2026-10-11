import { AlertCircle, GitCompareArrows, ListChecks, MousePointerClick, XCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { EmptyState } from "@/components/empty-state";
import { BaselinePicker } from "@/components/regression/baseline-picker";
import { CompareHeader, type PickerSlot } from "@/components/regression/compare-header";
import { LinkMode } from "@/components/regression/link-mode";
import { useLinkActions } from "@/components/regression/match-badge";
import { PairDetail } from "@/components/regression/pair-detail";
import { PairTable } from "@/components/regression/pair-table";
import { TRANSITION } from "@/components/regression/transition";
import { useFillHeight, useMinWidth } from "@/components/run/use-workbench";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { compareHash, runHash, type ComparePair, type RunView, type Transition } from "@/lib/api";
import { useCheckHistorySheet, useComparison, useNow, useProjects, useRunSummary, useShortcut } from "@/lib/hooks";
import { collapsedGroups, groupPairs, GROUP_ORDER } from "@/lib/regression";
import { cn } from "@/lib/utils";

const WIDE_BREAKPOINT_PX = 1280;
const MIN_PANES_HEIGHT_PX = 520;
const PANE = "min-h-0 overflow-y-auto rounded-lg border bg-card";

function CompareSkeleton() {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading comparison">
      <Skeleton className="h-4 w-64" />
      <Skeleton className="h-7 w-48" />
      <div className="grid gap-3 md:grid-cols-2">
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-28 w-full" />
      </div>
      <Skeleton className="h-8 w-2/3" />
      <div className="space-y-2 xl:grid xl:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] xl:gap-3 xl:space-y-0">
        <div className="space-y-2">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
        <Skeleton className="hidden h-[520px] w-full xl:block" />
      </div>
    </div>
  );
}

/** Runs / {project} / {run} / Compare, for the states where there is no comparison header to carry it. `run` is null when the run itself is unknown. */
function ContextHeader({ run, projectName, runHref }: { run: RunView | null; projectName: string | null; runHref: string }) {
  return (
    <header className="mb-3 space-y-3">
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <a href="#/" className="hover:text-foreground hover:underline">
          Runs
        </a>
        {run && projectName ? (
          <>
            <span aria-hidden>/</span>
            <span className="truncate">{projectName}</span>
            <span aria-hidden>/</span>
            <a href={runHref} className="truncate hover:text-foreground hover:underline">
              {run.title}
            </a>
          </>
        ) : null}
        <span aria-hidden>/</span>
        <span>Compare</span>
      </nav>
      <h1 className="text-xl font-semibold tracking-tight">Compare runs</h1>
    </header>
  );
}

/** The comparison of one run with a baseline: pair table on the left, evidence of the selected pair on the right. */
export function Compare({ id, baselineId, show, pair: pairParam }: { id: string; baselineId: string; show?: Transition; pair?: string }) {
  const auto = baselineId === "auto";
  const state = useComparison(id, auto ? null : baselineId);
  const { comparison, reason, reasonText, loading, error, refresh } = state;
  const { projects } = useProjects();
  const context = useRunSummary(id, !comparison && !loading);
  const now = useNow(60_000);
  const wide = useMinWidth(WIDE_BREAKPOINT_PX);
  const fillRef = useRef<HTMLDivElement>(null);
  const height = useFillHeight(fillRef, MIN_PANES_HEIGHT_PX);
  const actions = useLinkActions(comparison, refresh);
  const { openHistory } = useCheckHistorySheet();
  const [pickerSlot, setPickerSlot] = useState<PickerSlot | null>(null);
  const [override, setOverride] = useState<Record<string, boolean>>({});
  const [noAutoSelect, setNoAutoSelect] = useState(false);

  const groups = useMemo(() => groupPairs(comparison?.pairs ?? []), [comparison]);
  const shown = useMemo(() => (show ? groups.filter((g) => g.transition === show) : groups), [groups, show]);
  const rows = useMemo(() => shown.flatMap((g) => g.pairs), [shown]);
  const selectedKey = rows.find((p) => p.key === pairParam)?.key ?? (wide && !noAutoSelect && !pairParam ? (rows[0]?.key ?? null) : null);
  const selected = rows.find((p) => p.key === selectedKey) ?? null;
  const collapsed = useMemo(() => collapsedGroups(groups, { show, selectedKey, override }), [groups, show, selectedKey, override]);
  const manual = !auto;
  /** The run page keeps the baseline this page was opened with, so the pick carries over. */
  const runLink = runHash(id, undefined, auto ? undefined : baselineId);

  const go = useCallback(
    (next: { baseline?: string; show?: Transition; pair?: string }) => {
      // replace, not push: hopping between rows and baselines must not fill the history.
      window.location.replace(compareHash(id, next.baseline ?? baselineId, { show: next.show, pair: next.pair }));
    },
    [id, baselineId],
  );

  const select = useCallback(
    (key: string | null) => {
      setNoAutoSelect(key === null);
      const row = rows.find((p) => p.key === key);
      if (row) setOverride((o) => ({ ...o, [row.transition]: false }));
      go({ show, pair: key ?? undefined });
    },
    [rows, go, show],
  );

  // Keep the selected row in view when the keyboard moves it.
  useEffect(() => {
    if (selectedKey) document.getElementById(`pair-${selectedKey}`)?.scrollIntoView({ block: "nearest" });
  }, [selectedKey]);

  function openPairHistory(pair: ComparePair | null) {
    if (!comparison || !pair?.checkKey) return;
    const side = pair.current ?? pair.baseline;
    openHistory({
      projectId: comparison.current.projectId,
      checkKey: pair.checkKey,
      runId: comparison.current.id,
      checkId: pair.current?.checkId,
      title: side?.title ?? "",
    });
  }

  function step(delta: 1 | -1) {
    if (rows.length === 0) return;
    const at = selectedKey ? rows.findIndex((p) => p.key === selectedKey) : -1;
    const next = Math.min(rows.length - 1, Math.max(0, at < 0 ? (delta === 1 ? 0 : rows.length - 1) : at + delta));
    select(rows[next]?.key ?? null);
  }
  useShortcut("j", () => step(1), [rows, selectedKey]);
  useShortcut("k", () => step(-1), [rows, selectedKey]);
  useShortcut("escape", () => select(null), [select]);
  useShortcut("h", () => openPairHistory(selected), [comparison, selected]);

  const picker = (trigger: ReactNode, slot: PickerSlot): ReactNode => (
    <BaselinePicker
      runId={id}
      selectedId={comparison?.baselineRun.id ?? null}
      manual={manual}
      baseBranch={comparison?.current.source?.pr?.baseBranch ?? "main"}
      open={pickerSlot === slot}
      onOpenChange={(open) => setPickerSlot(open ? slot : null)}
      onPick={(picked) => go({ baseline: picked ?? "auto", show, pair: undefined })}
      shortcut={slot === "change"}
    >
      {trigger}
    </BaselinePicker>
  );

  if (!comparison && loading) return <CompareSkeleton />;
  /** A baseline that failed to produce a comparison is not carried back to the run page. */
  const plainRunLink = runHash(id);
  const contextRun = context.run;
  const contextProject = contextRun ? (projects.find((p) => p.id === contextRun.projectId)?.name ?? contextRun.projectId) : null;
  /** A run that does not exist has nothing to go "back" to. */
  const back = context.error ? (
    <a href="#/" className="underline underline-offset-2">
      Back to runs
    </a>
  ) : (
    <a href={plainRunLink} className="underline underline-offset-2">
      Back to the run
    </a>
  );
  if (!comparison && error) {
    return (
      <>
        <ContextHeader run={contextRun} projectName={contextProject} runHref={plainRunLink} />
        <Alert variant="destructive">
          <XCircle />
          <AlertTitle>Could not load the comparison</AlertTitle>
          <AlertDescription>
            <span>{error}. </span>
            {back}
          </AlertDescription>
        </Alert>
      </>
    );
  }
  if (!comparison) {
    const pick = picker(
      <Button variant="outline" size="sm">
        Pick another run
      </Button>,
      "change",
    );
    return (
      <>
        <ContextHeader run={contextRun} projectName={contextProject} runHref={plainRunLink} />
        {reason === "same_run" ? (
          <Alert>
            <AlertCircle />
            <AlertTitle>A run cannot be compared with itself.</AlertTitle>
            <AlertDescription className="space-y-2">
              {pick}
              <p>{back}</p>
            </AlertDescription>
          </Alert>
        ) : reason === "different_project" ? (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle>These runs belong to different projects</AlertTitle>
            <AlertDescription className="space-y-2">
              <p>Checks are only matched within one project. Pick a baseline from {contextProject ?? "the same project as this run"}.</p>
              {pick}
              <p>{back}</p>
            </AlertDescription>
          </Alert>
        ) : reason === "no_checks" ? (
          <EmptyState icon={ListChecks} title="Nothing to compare" description={reasonText ?? "One of these runs has no checks."} action={back} />
        ) : (
          <EmptyState
            icon={GitCompareArrows}
            title="No earlier run to compare with"
            description={reasonText ?? "No earlier run of this test to compare with yet."}
            action={
              <div className="flex flex-col items-center gap-2">
                {pick}
                <span className="text-sm">{back}</span>
              </div>
            }
          />
        )}
      </>
    );
  }

  const projectName = projects.find((p) => p.id === comparison.current.projectId)?.name ?? comparison.current.projectId;
  const matched = comparison.pairs.some((p) => p.baseline && p.current);
  const detail = (p: ComparePair) => (
    <PairDetail pair={p} comparison={comparison} actions={actions} now={now} onOpenHistory={() => openPairHistory(p)} />
  );

  const filter = (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      value={show ?? "all"}
      onValueChange={(v) => {
        // A filter click is an explicit "show me this": drop earlier manual collapses.
        setOverride({});
        go({ show: GROUP_ORDER.find((t) => t === v), pair: undefined });
      }}
      aria-label="Filter by transition"
      className="max-w-full overflow-x-auto"
    >
      <ToggleGroupItem value="all" className="h-8 px-2.5 text-xs">
        All {comparison.pairs.length}
      </ToggleGroupItem>
      {groups.map((g) => {
        const Icon = TRANSITION[g.transition].icon;
        return (
          <ToggleGroupItem key={g.transition} value={g.transition} className="h-8 gap-1 px-2.5 text-xs">
            <Icon className="size-3.5" aria-hidden />
            {TRANSITION[g.transition].label} {g.pairs.length}
          </ToggleGroupItem>
        );
      })}
    </ToggleGroup>
  );

  const table = (
    <PairTable
      groups={shown}
      selectedKey={selectedKey}
      collapsed={collapsed}
      onToggle={(t, open) => setOverride((o) => ({ ...o, [t]: !open }))}
      onSelect={(key) => select(key === selectedKey && !wide ? null : key)}
      actions={actions}
      detail={(p) => (wide ? null : <div className="border-t bg-muted/20">{detail(p)}</div>)}
    />
  );

  return (
    <div className="space-y-4">
      <CompareHeader comparison={comparison} runHref={runLink} projectName={projectName} now={now} picker={picker} />

      {comparison.pairs.length === 0 ? (
        <EmptyState icon={ListChecks} title="Nothing to compare" description={`${comparison.current.title} has no checks.`} />
      ) : !matched ? (
        <LinkMode comparison={comparison} actions={actions} />
      ) : (
        <>
          {filter}
          {shown.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No checks in this group.{" "}
              <a href={compareHash(id, baselineId)} className="underline underline-offset-2">
                Show all
              </a>
            </p>
          ) : wide ? (
            <div ref={fillRef} style={{ height }} className="grid grid-cols-[minmax(0,5fr)_minmax(0,6fr)] grid-rows-[minmax(0,1fr)] gap-3">
              <div className={PANE}>{table}</div>
              <div className={cn(PANE)}>
                {selected ? (
                  detail(selected)
                ) : (
                  <div className="p-4">
                    <EmptyState icon={MousePointerClick} title="Select a check" description="Pick a row to see both screenshots and notes." />
                  </div>
                )}
              </div>
            </div>
          ) : (
            <Card className="gap-0 overflow-hidden p-0">{table}</Card>
          )}
        </>
      )}
    </div>
  );
}
