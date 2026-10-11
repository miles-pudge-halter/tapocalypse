import { AlertCircle, ArrowRight, ChevronDown, GitCommitHorizontal, GitCompareArrows, Unlink } from "lucide-react";
import type { ReactNode } from "react";

import { BaselinePicker } from "@/components/regression/baseline-picker";
import { LostCoverage, TRANSITION, TransitionChip } from "@/components/regression/transition";
import { RunStatusIcon } from "@/components/run-status-icon";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { VERDICT_DOT, VerdictBadge } from "@/components/verdict-badge";
import { compareHash, isActive, type RunComparison, type RunView, type Transition } from "@/lib/api";
import { formatRelative } from "@/lib/format";
import type { ComparisonState } from "@/lib/hooks";
import { cn } from "@/lib/utils";

const SHORT_SHA = 7;
const BRANCH_MAX = 24;
const OUTLINE_CHIP = "inline-flex h-5 items-center gap-1 rounded-md border px-1.5 text-xs text-muted-foreground";
const COUNT_ORDER: Transition[] = ["newly_failing", "fixed", "flaky", "changed", "new", "removed"];

function ellipsize(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function ChipWithTip({ tip, children, className }: { tip: ReactNode; children: ReactNode; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className={cn(OUTLINE_CHIP, className)}>
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{tip}</TooltipContent>
    </Tooltip>
  );
}

function BaselineChip({ comparison, now }: { comparison: RunComparison; now: number }) {
  const { baselineRun: base, baseline } = comparison;
  const extra = baseline.runIds.length - 1;
  const sha = (base.source?.commit ?? baseline.commit)?.slice(0, SHORT_SHA);
  const tip = baseline.auto ? `Picked automatically: ${baseline.reason}` : "Picked by you. Open to reset to automatic.";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 max-w-[30rem] gap-1 px-2 font-normal" aria-label={`Baseline: ${base.title}. Change baseline`}>
          {isActive(base.status) ? (
            <RunStatusIcon status={base.status} verdict={base.verdict} className="size-3.5" />
          ) : (
            <span className={cn("size-2 shrink-0 rounded-full", base.verdict ? VERDICT_DOT[base.verdict] : "bg-muted-foreground/40")} />
          )}
          <span className="min-w-0 truncate">{base.title}</span>
          {baseline.branch ? <span className="shrink-0 text-muted-foreground">· {ellipsize(baseline.branch, BRANCH_MAX)}</span> : null}
          {sha ? <span className="shrink-0 font-mono text-xs text-muted-foreground">· {sha}</span> : null}
          {base.deviceName ? <span className="hidden shrink-0 text-muted-foreground 2xl:inline">· {base.deviceName}</span> : null}
          <span className="shrink-0 text-muted-foreground">· {formatRelative(base.createdAt, now)}</span>
          {extra > 0 ? <span className="shrink-0 text-muted-foreground">· +{extra} runs</span> : null}
          <ChevronDown className="size-3.5 shrink-0 opacity-60" />
        </Button>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm space-y-1 break-words">
        <p>{tip}</p>
        {extra > 0 ? <p>Includes {extra} more runs at the same commit (re-runs and later rounds); each check uses the newest pass/fail result.</p> : null}
        {isActive(base.status) ? <p>Still running; counts will change.</p> : null}
      </TooltipContent>
    </Tooltip>
  );
}

function VerdictDelta({ run, comparison }: { run: RunView; comparison: RunComparison }) {
  const before = comparison.verdict.baseline;
  const after = comparison.verdict.current;
  const active = isActive(run.status);
  const same = !active && before !== null && before === after;
  return (
    <span className="inline-flex items-center gap-1.5">
      {before ? <VerdictBadge verdict={before} className="h-5 px-1.5 text-[10px]" /> : <span className="text-xs text-muted-foreground">no verdict</span>}
      {same ? (
        <span className="text-xs text-muted-foreground">unchanged</span>
      ) : (
        <>
          <ArrowRight className="size-3.5 text-muted-foreground" aria-hidden />
          {active || !after ? <StatusBadge status={run.status} className="h-5 px-1.5 text-[10px]" /> : <VerdictBadge verdict={after} className="h-5 px-1.5 text-[10px]" />}
        </>
      )}
    </span>
  );
}

function CountLink({ comparison, baselineParam, transition, label, tooltip }: { comparison: RunComparison; baselineParam: string; transition: Transition; label: ReactNode; tooltip?: string }) {
  const href = compareHash(comparison.current.id, baselineParam, { show: transition });
  const link = (
    <Button asChild variant="ghost" size="sm" className="h-7 px-1 text-xs">
      <a href={href}>{label}</a>
    </Button>
  );
  if (!tooltip) return link;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

function Counts({ comparison, baselineParam, active }: { comparison: RunComparison; baselineParam: string; active: boolean }) {
  const { counts } = comparison;
  const shown: Transition[] = COUNT_ORDER.filter((t) => t === "newly_failing" || counts[t] > 0);
  const unchanged = counts.unchanged + counts.still_failing;
  const items = unchanged > 0 ? [...shown, "unchanged" as const] : shown;
  return (
    <>
      {items.map((t, i) => {
        const style = TRANSITION[t];
        const Icon = style.icon;
        const n = t === "unchanged" ? unchanged : counts[t];
        const suffix = active && i === items.length - 1 ? " so far" : "";
        const text = `${n} ${style.short}${suffix}`;
        const label =
          t === "newly_failing" && n > 0 ? (
            <TransitionChip transition={t}>{text}</TransitionChip>
          ) : (
            <span className={cn("inline-flex items-center gap-1 tabular-nums", n === 0 ? "text-muted-foreground" : style.text)}>
              <Icon className="size-3" aria-hidden />
              {text}
            </span>
          );
        return (
          <CountLink
            key={t}
            comparison={comparison}
            baselineParam={baselineParam}
            transition={t}
            label={label}
            tooltip={t === "unchanged" ? `${counts.unchanged} still pass · ${counts.still_failing} still fail` : undefined}
          />
        );
      })}
    </>
  );
}

function MismatchChips({ comparison, baselineParam }: { comparison: RunComparison; baselineParam: string }) {
  const { baseline, baselineRun: base, current } = comparison;
  const lost = comparison.pairs.filter((p) => p.lostCoverage).length;
  const tip = (a: string | null, b: string | null) => `Baseline: ${a ?? "unknown"} · This run: ${b ?? "unknown"}`;
  return (
    <>
      {baseline.platformMismatch ? (
        <span className="inline-flex h-5 items-center rounded-md border border-orange-500/30 bg-orange-500/10 px-1.5 text-xs font-medium text-orange-800 dark:text-orange-300">different platform</span>
      ) : null}
      {baseline.deviceChanged ? <ChipWithTip tip={tip(base.deviceName, current.deviceName)}>device changed</ChipWithTip> : null}
      {baseline.harnessChanged ? <ChipWithTip tip={tip(base.harness, current.harness)}>agent changed</ChipWithTip> : null}
      {baseline.modelChanged ? <ChipWithTip tip={tip(base.model, current.model)}>model changed</ChipWithTip> : null}
      {baseline.sameCommit ? (
        <ChipWithTip tip="Both runs tested the same code, so any difference points to flakiness or the environment, not your change.">
          <GitCommitHorizontal className="size-3" aria-hidden />
          same commit
        </ChipWithTip>
      ) : null}
      {lost > 0 ? (
        <a href={compareHash(current.id, baselineParam, { show: "changed" })} className="inline-flex">
          <LostCoverage count={lost} />
        </a>
      ) : null}
    </>
  );
}

/** One-line "Compared to" summary of a run against its baseline, on the run page. */
export function CompareStrip({
  run,
  state,
  baselineParam,
  now,
  pickerOpen,
  onPickerOpenChange,
  onPick,
}: {
  run: RunView;
  state: ComparisonState;
  /** The `?baseline=` of the page: a manual pick, or null for automatic. */
  baselineParam: string | null;
  now: number;
  pickerOpen: boolean;
  onPickerOpenChange(open: boolean): void;
  onPick(id: string | null): void;
}) {
  const { comparison, reason, reasonText, loading, error, refresh } = state;
  const active = isActive(run.status);
  const baseBranch = run.source?.pr?.baseBranch ?? "main";
  const shell = "flex flex-wrap items-center gap-x-1.5 gap-y-2 rounded-lg border bg-card px-3 py-2 text-sm";
  const label = (
    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
      <GitCompareArrows className="size-4" aria-hidden />
      Compared to
    </span>
  );
  const picker = (trigger: ReactNode, selectedId: string | null) => (
    <BaselinePicker
      runId={run.id}
      selectedId={selectedId}
      manual={baselineParam !== null}
      baseBranch={baseBranch}
      open={pickerOpen}
      onOpenChange={onPickerOpenChange}
      onPick={onPick}
      shortcut
    >
      {trigger}
    </BaselinePicker>
  );

  if (!comparison && loading) return <Skeleton className="h-11 w-full rounded-lg" aria-label="Loading comparison" />;
  if (!comparison && error) {
    return (
      <Alert variant="destructive" className="py-2">
        <AlertCircle />
        <AlertTitle>Could not compare with an earlier run</AlertTitle>
        <AlertDescription>
          <span>{error}</span>
          <Button variant="link" size="xs" className="h-auto p-0" onClick={refresh}>
            Try again
          </Button>
          {baselineParam !== null ? (
            <Button variant="link" size="xs" className="h-auto p-0" onClick={() => onPick(null)}>
              Reset to automatic
            </Button>
          ) : null}
        </AlertDescription>
      </Alert>
    );
  }
  if (!comparison) {
    const text =
      reason === "no_checks"
        ? active
          ? "Comparing once the agent declares its checks."
          : "This run resolved no checks, so there is nothing to compare."
        : (reasonText ?? "No earlier run of this test to compare with yet.");
    return (
      <div className={shell}>
        {label}
        {picker(
          <Button variant="outline" size="sm" className="h-7 border-dashed px-2 font-normal">
            Pick a run…
          </Button>,
          null,
        )}
        <span className="text-muted-foreground">{text}</span>
      </div>
    );
  }

  const matched = comparison.pairs.some((p) => p.baseline && p.current);
  const baselineId = comparison.baselineRun.id;
  /** Links follow the page: a manual pick stays picked, otherwise the comparison stays automatic. */
  const linkBaseline = baselineParam ?? "auto";
  return (
    <div className={shell}>
      {label}
      {picker(<span className="inline-flex">{<BaselineChip comparison={comparison} now={now} />}</span>, baselineId)}
      <VerdictDelta run={run} comparison={comparison} />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button asChild variant="outline" size="sm" className="ml-auto h-7 px-2 text-xs xl:order-last">
            <a href={compareHash(run.id, linkBaseline)} aria-label="Open comparison">
              <GitCompareArrows />
              <span className="hidden 2xl:inline">Open comparison</span>
            </a>
          </Button>
        </TooltipTrigger>
        <TooltipContent>Open comparison</TooltipContent>
      </Tooltip>
      <div className="flex basis-full flex-wrap items-center gap-x-1 gap-y-1 sm:gap-x-3 xl:contents">
        {matched || comparison.pairs.length === 0 ? (
          <Counts comparison={comparison} baselineParam={linkBaseline} active={active} />
        ) : (
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <Unlink className="size-3.5" aria-hidden />
            None of this run's checks matched {comparison.baselineRun.title}.
            <Button asChild variant="link" size="xs" className="h-auto p-0">
              <a href={compareHash(run.id, linkBaseline)}>Link checks…</a>
            </Button>
          </span>
        )}
        <MismatchChips comparison={comparison} baselineParam={linkBaseline} />
      </div>
    </div>
  );
}
