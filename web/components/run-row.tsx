import { Copy, Download, ExternalLink, FileText, Link2, Loader2, MoreHorizontal, RotateCcw, Trash2, XCircle } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { HubSyncIcon } from "@/components/hub/sync-chip";
import { RegressionCount } from "@/components/regression/transition";
import { rerunWithChangesPrefill } from "@/components/run/use-run-actions";
import { RunStatusIcon } from "@/components/run-status-icon";
import { SegmentedProgress } from "@/components/segmented-progress";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { VerdictBadge } from "@/components/verdict-badge";
import { api, batchHash, compareHash, isActive, reportHash, reportHtmlUrl, runHash, type RunStatus, type RunView, type Verdict } from "@/lib/api";
import { formatCost, formatDuration, formatRelative, formatTime } from "@/lib/format";
import { navigate, useNewRun } from "@/lib/hooks";
import { attribution } from "@/lib/hub";
import { isHub } from "@/lib/mode";
import { cn } from "@/lib/utils";

const VERDICT_SEVERITY: Verdict[] = ["FAIL", "BLOCKED", "PARTIAL", "PASS WITH ISSUES", "PASS"];

/** Worst verdict across lanes; null while any lane has none. */
export function rollupVerdict(runs: RunView[]): Verdict | null {
  let worst = VERDICT_SEVERITY.length;
  for (const run of runs) {
    if (!run.verdict) return null;
    worst = Math.min(worst, VERDICT_SEVERITY.indexOf(run.verdict));
  }
  return VERDICT_SEVERITY[worst] ?? null;
}

export interface BatchSummary {
  active: boolean;
  /** Status the batch icon shows: the most "alive" lane while active, `done` once all lanes ended. */
  status: RunStatus;
  verdict: Verdict | null;
  cost: number | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
}

export function summarizeBatch(runs: RunView[]): BatchSummary {
  const active = runs.some((r) => isActive(r.status));
  const status: RunStatus = active
    ? runs.some((r) => r.status === "running" || r.status === "finishing")
      ? "running"
      : runs.some((r) => r.status === "preflight")
        ? "preflight"
        : "queued"
    : runs.every((r) => r.status === "done")
      ? "done"
      : (runs.find((r) => r.status !== "done")?.status ?? "done");
  const costs = runs.map((r) => r.usage?.cost ?? null).filter((c): c is number => c !== null);
  const starts = runs.map((r) => r.startedAt).filter((s): s is string => s !== null).sort();
  const ends = runs.map((r) => r.endedAt).filter((s): s is string => s !== null).sort();
  return {
    active,
    status,
    verdict: active ? null : rollupVerdict(runs),
    cost: costs.length > 0 ? costs.reduce((a, b) => a + b, 0) : null,
    startedAt: starts[0] ?? null,
    endedAt: active ? null : (ends.at(-1) ?? null),
    createdAt: runs.map((r) => r.createdAt).sort()[0] ?? "",
  };
}

/** Batch titles are `<title> · <device or platform #n>`; drops the per-lane suffix. */
export function batchTitle(runs: RunView[]): string {
  const first = runs[0]?.title ?? "Batch";
  const cut = first.lastIndexOf(" · ");
  return cut > 0 ? first.slice(0, cut) : first;
}

/** A finished lane that did not pass (cancelled lanes are deliberate and excluded). */
export function isFailedLane(run: RunView): boolean {
  return !isActive(run.status) && run.status !== "cancelled" && run.verdict !== "PASS" && run.verdict !== "PASS WITH ISSUES";
}

/** Re-runs every failed lane, only its failed checks when it has any; returns how many were queued. */
export async function rerunFailedLanes(runs: RunView[]): Promise<number> {
  const failed = runs.filter(isFailedLane);
  const results = await Promise.all(
    failed.map((r) =>
      api.rerun(r.id, "failed").catch(() => api.rerun(r.id, "all")).then(
        () => true,
        () => false,
      ),
    ),
  );
  return results.filter(Boolean).length;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `↓ n` chip linking to the newly failing checks of a run; null when the run has no regression against its baseline. */
export function RunRegressionChip({ run, now }: { run: RunView; now: number }) {
  const reg = run.regression;
  if (!reg || reg.newlyFailing <= 0) return null;
  const where = reg.baselineBranch ? `${reg.baselineBranch} · ` : "";
  return (
    <RegressionCount
      count={reg.newlyFailing}
      href={compareHash(run.id, "auto", { show: "newly_failing" })}
      tooltip={`${reg.newlyFailing} newly failing vs “${reg.baselineTitle}” (${where}${formatRelative(reg.baselineCreatedAt, now)})`}
    />
  );
}

/** One muted segment of a row's second line; `className` carries the container-query rule that hides it at narrow widths. */
interface MetaPart {
  text: string | null | undefined;
  className?: string;
}

/**
 * The muted second line as ONE truncating flow: segments are ordered by priority, lower-priority ones carry a
 * container-query hide class, and whatever still overflows is ellipsised from the end — so project, branch and PR
 * stay readable while requester, model and device give way first. A segment's separator hides with it.
 */
function MetaLine({ parts }: { parts: MetaPart[] }) {
  const shown = parts.filter((p): p is MetaPart & { text: string } => Boolean(p.text));
  return (
    <div className="truncate text-xs text-muted-foreground" title={shown.map((p) => p.text).join(" · ")}>
      {shown.map((p, i) => (
        <span key={`${i}-${p.text}`} className={p.className}>
          {i > 0 && (
            <span aria-hidden="true" className="mx-1.5 text-muted-foreground/50">
              ·
            </span>
          )}
          {p.text}
        </span>
      ))}
    </div>
  );
}

/** Relative time with the absolute timestamp in a tooltip. */
export function RelativeTime({ iso, now, className }: { iso: string; now: number; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn("relative z-10 whitespace-nowrap", className)}>{formatRelative(iso, now)}</span>
      </TooltipTrigger>
      <TooltipContent>{formatTime(iso)}</TooltipContent>
    </Tooltip>
  );
}

export function RunActions({ run, onChanged }: { run: RunView; onChanged(): void }) {
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { openNewRun } = useNewRun();
  const hub = isHub();
  const active = isActive(run.status);
  const hasFailed = !active && run.checks.some((c) => c.status !== "pass" && c.status !== "skipped");

  async function rerun(only: "all" | "failed") {
    try {
      const next = await api.rerun(run.id, only);
      toast.success(`Re-run queued: ${next.title}`);
      navigate(runHash(next.id));
    } catch (err) {
      toast.error(errorText(err));
    }
  }

  async function cancel() {
    try {
      await api.cancel(run.id);
      toast.success("Cancel requested");
    } catch (err) {
      toast.error(errorText(err));
    }
  }

  async function copyId() {
    try {
      await navigator.clipboard.writeText(run.id);
      toast.success("Run id copied");
    } catch (err) {
      toast.error(errorText(err));
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(`${location.origin}${location.pathname}${runHash(run.id)}`);
      toast.success("Link copied", { description: "Anyone who can sign in to the hub can open it." });
    } catch (err) {
      toast.error(errorText(err));
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await api.deleteRun(run.id);
      setConfirmDelete(false);
      toast.success("Run deleted");
      onChanged();
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="relative z-10 size-7" aria-label={`Actions for ${run.title}`}>
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem onSelect={() => navigate(runHash(run.id))}>
            <ExternalLink />
            {active && !hub ? "Open / steer" : "Open run"}
          </DropdownMenuItem>
          {hub ? null : active ? (
            <DropdownMenuItem variant="destructive" onSelect={() => void cancel()}>
              <XCircle />
              Cancel run
            </DropdownMenuItem>
          ) : (
            <>
              <DropdownMenuItem onSelect={() => void rerun("all")}>
                <RotateCcw />
                Re-run
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!hasFailed} onSelect={() => void rerun("failed")}>
                <RotateCcw />
                Re-run failed
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => openNewRun(rerunWithChangesPrefill(run))}>
                <RotateCcw />
                Re-run with changes…
              </DropdownMenuItem>
            </>
          )}
          {run.reportPath && (
            <DropdownMenuItem onSelect={() => navigate(reportHash(run.projectId, run))}>
              <FileText />
              Open report
            </DropdownMenuItem>
          )}
          {hub && run.reportPath && (
            <DropdownMenuItem asChild>
              <a href={reportHtmlUrl(run.id, { download: true })} download>
                <Download />
                Download HTML report
              </a>
            </DropdownMenuItem>
          )}
          {hub && (
            <DropdownMenuItem onSelect={() => void copyLink()}>
              <Link2 />
              Copy link
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => void copyId()}>
            <Copy />
            Copy id
          </DropdownMenuItem>
          {!active && !hub && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => setConfirmDelete(true)}>
                <Trash2 />
                Delete
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this run?</DialogTitle>
            <DialogDescription>
              “{run.title}” and its transcript are removed from Tapocalypse, along with its report and screenshots when Tapocalypse stores them. Reports in your repository are not touched.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(false)} disabled={busy}>
              Keep
            </Button>
            <Button variant="destructive" onClick={() => void remove()} disabled={busy}>
              {busy && <Loader2 className="animate-spin" />}
              Delete run
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Column widths shared by every row so a list stays aligned; columns drop out with the container width. */
const COL_PROGRESS = "hidden w-28 shrink-0 @2xl:block";
const COL_DURATION = "hidden w-16 shrink-0 text-right tabular-nums @xl:block";
const COL_COST = "hidden w-14 shrink-0 text-right tabular-nums @3xl:block";
const COL_TIME = "w-16 shrink-0 text-right";

const ROW = "group relative flex items-center gap-3 px-3 py-2 hover:bg-muted/50 focus-within:bg-muted/50";

export interface RunRowProps {
  run: RunView;
  projectName: string;
  /** Friendly device name when the device is connected; falls back to the serial. */
  deviceName: string | null;
  now: number;
  onChanged(): void;
  /** Indented under a batch header. */
  nested?: boolean;
}

export function RunRow({ run, projectName, deviceName, now, onChanged, nested }: RunRowProps) {
  const pr = run.source?.pr?.number;
  const requester = run.hub ? attribution(run.hub).short : run.requestedBy;
  return (
    <div className={cn(ROW, nested && "pl-9")}>
      <RunStatusIcon status={run.status} verdict={run.verdict} className="size-4 shrink-0" />
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <a
            href={runHash(run.id)}
            className="truncate text-sm font-medium after:absolute after:inset-0 hover:underline focus-visible:outline-none"
            title={run.title}
          >
            {run.title}
          </a>
          {run.verdict ? <VerdictBadge verdict={run.verdict} className="shrink-0" /> : <StatusBadge status={run.status} className="shrink-0" />}
          <RunRegressionChip run={run} now={now} />
          <HubSyncIcon sync={run.hubSync} />
          {run.attempt > 1 && (
            <span className="shrink-0 rounded border px-1 text-[10px] leading-4 text-muted-foreground">attempt {run.attempt}</span>
          )}
        </div>
        <MetaLine
          parts={[
            { text: projectName },
            { text: run.source?.branch },
            { text: pr !== undefined ? `#${pr}` : null },
            { text: run.deviceName ?? deviceName ?? run.deviceSerial, className: "hidden @3xl:inline" },
            { text: requester, className: run.hub ? "hidden @3xl:inline" : "hidden @4xl:inline" },
            { text: run.model, className: "hidden @5xl:inline" },
          ]}
        />
      </div>
      <div className={COL_PROGRESS}>
        <SegmentedProgress checks={run.checks} size="sm" />
      </div>
      <div className={cn(COL_DURATION, "text-xs text-muted-foreground")}>{run.startedAt ? formatDuration(run.startedAt, run.endedAt, now) : "—"}</div>
      <div className={cn(COL_COST, "text-xs text-muted-foreground")}>{formatCost(run.usage?.cost ?? null)}</div>
      <RelativeTime iso={run.createdAt} now={now} className={cn(COL_TIME, "text-xs text-muted-foreground")} />
      <RunActions run={run} onChanged={onChanged} />
    </div>
  );
}

export interface BatchRowProps {
  batchId: string;
  runs: RunView[];
  projectName: string;
  now: number;
  onChanged(): void;
}

/** One row for a parallel batch: aggregate verdict, one status dot per lane, wall-clock span. */
export function BatchRow({ batchId, runs, projectName, now, onChanged }: BatchRowProps) {
  const [busy, setBusy] = useState(false);
  const summary = summarizeBatch(runs);
  const failedLanes = runs.some(isFailedLane);
  const laneRegressions = runs.filter((r) => (r.regression?.newlyFailing ?? 0) > 0);
  const regressionTotal = laneRegressions.reduce((sum, r) => sum + (r.regression?.newlyFailing ?? 0), 0);

  async function rerunFailed() {
    setBusy(true);
    try {
      const count = await rerunFailedLanes(runs);
      if (count === 0) toast.error("No lane could be re-run");
      else toast.success(`Re-running ${count} lane${count === 1 ? "" : "s"}`);
      onChanged();
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={ROW}>
      <RunStatusIcon status={summary.status} verdict={summary.verdict} className="size-4 shrink-0" />
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <a
            href={batchHash(batchId)}
            className="truncate text-sm font-medium after:absolute after:inset-0 hover:underline focus-visible:outline-none"
            title={batchTitle(runs)}
          >
            {batchTitle(runs)}
          </a>
          <span className="shrink-0 rounded border px-1.5 text-[10px] font-medium uppercase leading-4 tracking-wide text-muted-foreground">
            {runs.length} lanes
          </span>
          {summary.verdict ? (
            <VerdictBadge verdict={summary.verdict} className="shrink-0" />
          ) : (
            <StatusBadge status={summary.status} className="shrink-0" />
          )}
          {regressionTotal > 0 ? (
            <RegressionCount
              count={regressionTotal}
              href={laneRegressions.length === 1 ? compareHash(laneRegressions[0]?.id ?? "", "auto", { show: "newly_failing" }) : batchHash(batchId)}
              tooltip={laneRegressions.map((r) => `${r.deviceName ?? r.title}: ↓ ${r.regression?.newlyFailing ?? 0}`).join("\n")}
            />
          ) : null}
        </div>
        <MetaLine
          parts={[
            { text: projectName },
            { text: "parallel batch" },
            { text: runs[0]?.requestedBy, className: "hidden @4xl:inline" },
            { text: runs[0]?.model, className: "hidden @5xl:inline" },
          ]}
        />
      </div>
      <div className={cn(COL_PROGRESS, "flex items-center gap-1")} aria-label="Lanes">
        {runs.slice(0, 8).map((r) => (
          <Tooltip key={r.id}>
            <TooltipTrigger asChild>
              <span className="relative z-10">
                <RunStatusIcon status={r.status} verdict={r.verdict} className="size-3.5" />
              </span>
            </TooltipTrigger>
            <TooltipContent>{r.title}</TooltipContent>
          </Tooltip>
        ))}
      </div>
      <div className={cn(COL_DURATION, "text-xs text-muted-foreground")}>
        {summary.startedAt ? formatDuration(summary.startedAt, summary.endedAt, now) : "—"}
      </div>
      <div className={cn(COL_COST, "text-xs text-muted-foreground")}>{formatCost(summary.cost)}</div>
      <RelativeTime iso={summary.createdAt} now={now} className={cn(COL_TIME, "text-xs text-muted-foreground")} />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="relative z-10 size-7" aria-label={`Actions for batch ${batchTitle(runs)}`}>
            {busy ? <Loader2 className="animate-spin" /> : <MoreHorizontal />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem onSelect={() => navigate(batchHash(batchId))}>
            <ExternalLink />
            Open batch
          </DropdownMenuItem>
          {isHub() ? null : (
            <DropdownMenuItem disabled={!failedLanes || busy} onSelect={() => void rerunFailed()}>
              <RotateCcw />
              Re-run failed lanes
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
