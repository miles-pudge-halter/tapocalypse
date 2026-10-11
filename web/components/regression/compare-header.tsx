import { AlertTriangle, ArrowLeftRight, ArrowRight, Loader2 } from "lucide-react";
import type { ReactNode } from "react";

import { SourceChips } from "@/components/source-chips";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { VerdictBadge } from "@/components/verdict-badge";
import { compareHash, isActive, runHash, type Platform, type RunComparison, type RunView } from "@/lib/api";
import { formatCost, formatDurationMs, formatRelative, formatTime, formatTokens } from "@/lib/format";
import { useHarness } from "@/lib/hooks";

const SHORT_SHA = 7;

/** Two triggers can open the baseline picker; only the one named by the slot shows it. */
export type PickerSlot = "change" | "platform";

function RunCard({ eyebrow, run, comparison, now }: { eyebrow: string; run: RunView; comparison: RunComparison; now: number }) {
  const { label } = useHarness(run.harness);
  const isBaseline = run.id === comparison.baselineRun.id;
  const more = isBaseline ? comparison.baseline.runIds.length - 1 : 0;
  const sha = (isBaseline ? (comparison.baseline.commit ?? run.source?.commit) : run.source?.commit)?.slice(0, SHORT_SHA);
  const detail = [run.deviceName, [label, run.model].filter(Boolean).join(" "), formatTime(run.createdAt)].filter(Boolean).join(" · ");
  return (
    <Card className="min-w-0 gap-1.5 p-3">
      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{eyebrow}</p>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <a href={runHash(run.id)} title={run.title} className="line-clamp-2 min-w-0 break-words font-medium underline-offset-2 hover:underline">
          {run.title}
        </a>
        {isActive(run.status) || !run.verdict ? <StatusBadge status={run.status} /> : <VerdictBadge verdict={run.verdict} />}
      </div>
      <SourceChips source={run.source} build={run.build} compact />
      <p className="truncate text-xs text-muted-foreground" title={detail}>
        {detail}
      </p>
      {more > 0 ? (
        <HoverCard openDelay={200}>
          <HoverCardTrigger asChild>
            <p tabIndex={0} className="w-fit cursor-default text-xs text-muted-foreground underline decoration-dotted underline-offset-2">
              + {more} more runs{sha ? ` at ${sha}` : ""}
            </p>
          </HoverCardTrigger>
          <HoverCardContent className="w-80 space-y-1 text-sm">
            {comparison.baseline.runIds.map((id) => (
              <a key={id} href={runHash(id)} className="block truncate font-mono text-xs underline-offset-2 hover:underline">
                {id}
                <span className="font-sans text-muted-foreground">{id === run.id ? ` · ${formatRelative(run.createdAt, now)}` : ""}</span>
              </a>
            ))}
          </HoverCardContent>
        </HoverCard>
      ) : null}
    </Card>
  );
}

function signed(n: number | null, format: (v: number) => string): string | null {
  if (n === null || n === 0) return null;
  return `${n > 0 ? "+" : "−"}${format(Math.abs(n))}`;
}

function Delta({ label, current, delta, format }: { label: string; current: number | null; delta: number | null; format: (v: number) => string }) {
  const text = current === null ? "—" : format(current);
  const change = current === null ? null : signed(delta, format);
  return (
    <span>
      {label} <span className="text-foreground">{text}</span>
      {change ? ` (${change})` : ""}
    </span>
  );
}

function platformName(p: Platform): string {
  return p === "ios" ? "iOS" : "Android";
}

const ORANGE_ALERT = "border-orange-500/40 bg-orange-500/5 text-orange-700 dark:text-orange-300";

/** Breadcrumb, title, the run pair, the delta row and the mismatch notes of the compare view. */
export function CompareHeader({
  comparison,
  runHref,
  projectName,
  now,
  picker,
}: {
  comparison: RunComparison;
  /** Link back to the compared run, carrying a manual baseline. */
  runHref: string;
  projectName: string;
  now: number;
  /** The "Change baseline" popover; `trigger` is the element that opens it. */
  picker(trigger: ReactNode, slot: PickerSlot): ReactNode;
}) {
  const { current, baselineRun: base, baseline } = comparison;
  const tokens = (r: RunView) => (r.usage ? r.usage.tokensIn + r.usage.tokensOut : null);
  const checkCount = current.checks.length;
  const baseChecks = base.checks.length;
  const tokenNow = tokens(current);
  const tokenBase = tokens(base);
  const changed = [
    baseline.deviceChanged ? `device (${base.deviceName ?? "unknown"} → ${current.deviceName ?? "unknown"})` : null,
    baseline.harnessChanged ? `agent (${base.harness} → ${current.harness})` : null,
    baseline.modelChanged ? `model (${base.model ?? "default"} → ${current.model ?? "default"})` : null,
  ].filter(Boolean);
  return (
    <header className="space-y-3">
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <a href="#/" className="hover:text-foreground hover:underline">
          Runs
        </a>
        <span aria-hidden>/</span>
        <span className="truncate">{projectName}</span>
        <span aria-hidden>/</span>
        <a href={runHref} className="truncate hover:text-foreground hover:underline">
          {current.title}
        </a>
        <span aria-hidden>/</span>
        <span>Compare</span>
      </nav>
      <h1 className="text-xl font-semibold tracking-tight">Compare runs</h1>

      <div className="grid items-stretch gap-3 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
        <div className="min-w-0 space-y-1">
          <RunCard eyebrow={baseline.auto ? "Baseline · auto" : "Baseline"} run={base} comparison={comparison} now={now} />
          {picker(
            <Button variant="link" size="xs" className="h-auto p-0">
              Change baseline
            </Button>,
            "change",
          )}
        </div>
        <div className="flex items-center justify-center gap-1 md:flex-col">
          <ArrowRight className="size-4 rotate-90 text-muted-foreground md:rotate-0" aria-hidden />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button asChild variant="ghost" size="icon-sm" aria-label="Swap runs">
                <a href={compareHash(base.id, current.id)}>
                  <ArrowLeftRight />
                </a>
              </Button>
            </TooltipTrigger>
            <TooltipContent>{`Swap: compare ${base.title} against ${current.title}`}</TooltipContent>
          </Tooltip>
        </div>
        <RunCard eyebrow="This run" run={current} comparison={comparison} now={now} />
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm tabular-nums text-muted-foreground">
        <Delta label="Duration" current={comparison.durationMs.current} delta={comparison.durationMs.delta} format={(v) => formatDurationMs(v)} />
        <Delta label="Cost" current={comparison.cost.current} delta={comparison.cost.delta} format={(v) => formatCost(v)} />
        <Delta label="Checks" current={checkCount} delta={checkCount - baseChecks} format={(v) => String(v)} />
        <Delta label="Tokens" current={tokenNow} delta={tokenNow !== null && tokenBase !== null ? tokenNow - tokenBase : null} format={(v) => formatTokens(v)} />
      </div>

      {baseline.platformMismatch ? (
        <Alert className={ORANGE_ALERT}>
          <AlertTriangle />
          <AlertTitle>Different platforms</AlertTitle>
          <AlertDescription className="space-y-2 text-current/90">
            <p>
              The baseline ran on {platformName(base.deviceRequest.platform)}, this run on {platformName(current.deviceRequest.platform)}. Screens and flows may differ, so treat these transitions as a weak signal.
            </p>
            {picker(
              <Button size="sm" variant="outline">
                Pick a {platformName(current.deviceRequest.platform)} baseline
              </Button>,
              "platform",
            )}
          </AlertDescription>
        </Alert>
      ) : null}
      {changed.length > 0 ? <p className="text-sm text-muted-foreground">Also different: {changed.join(" · ")}</p> : null}
      {isActive(base.status) ? (
        <Alert>
          <Loader2 className="animate-spin" />
          <AlertDescription>The baseline is still running. Its checks may still change.</AlertDescription>
        </Alert>
      ) : null}
      {isActive(current.status) ? (
        <Alert>
          <Loader2 className="animate-spin" />
          <AlertDescription>This run is still running. Checks it has not reached yet are listed under Not reached yet.</AlertDescription>
        </Alert>
      ) : null}
    </header>
  );
}
