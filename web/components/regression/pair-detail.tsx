import { History } from "lucide-react";
import type { ReactNode } from "react";

import { MatchBadge, type LinkActions } from "@/components/regression/match-badge";
import { NotesDiff } from "@/components/regression/notes-diff";
import { ScreenshotCompare } from "@/components/regression/screenshot-compare";
import { StatusStrip, type StripStatus } from "@/components/regression/status-strip";
import { LostCoverage, TRANSITION, TransitionChip } from "@/components/regression/transition";
import { Button } from "@/components/ui/button";
import { runHash, type ComparePair, type KeyKind, type RunComparison } from "@/lib/api";
import { formatDurationMs, formatRelative, formatTime } from "@/lib/format";
import { useCheckHistory } from "@/lib/hooks";

const SHORT_SHA = 7;
const STRIP_SIZE = 10;

const MATCH_LINE: Record<KeyKind, (pair: ComparePair) => string> = {
  suite: () => "Matched by suite check id",
  lineage: () => "Matched because this run re-ran the baseline",
  carried: (p) => `The agent carried this check over from ${p.baseline?.checkId ?? "the baseline"}`,
  title: () => "Matched by identical title",
  inferred: () => "Matched by similar title",
  manual: () => "Linked manually",
};

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[5rem_minmax(0,1fr)] items-baseline gap-3 text-sm">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

function eyebrow(prefix: string, branch: string | null | undefined, commit: string | null | undefined): string {
  return [prefix, branch, commit?.slice(0, SHORT_SHA)].filter(Boolean).join(" · ");
}

/** Everything about one selected pair: heading, both screenshots, both notes, facts and the way to each run. */
export function PairDetail({
  pair,
  comparison,
  actions,
  now,
  onOpenHistory,
}: {
  pair: ComparePair;
  comparison: RunComparison;
  actions: LinkActions;
  now: number;
  onOpenHistory(): void;
}) {
  const { current: run, baselineRun: base, baseline } = comparison;
  const side = pair.current ?? pair.baseline;
  const target = pair.checkKey ? { projectId: run.projectId, checkKey: pair.checkKey, title: side?.title ?? "" } : null;
  const { history } = useCheckHistory(target, {});
  const strip = (history?.entries ?? []).slice(0, STRIP_SIZE).reverse();
  const currentIndex = strip.findIndex((e) => e.runId === pair.current?.runId && e.checkId === pair.current?.checkId);
  const fromOtherRun = pair.baseline !== null && pair.baseline.runId !== baseline.primaryRunId;
  const otherRunTitle = history?.entries.find((e) => e.runId === pair.baseline?.runId)?.runTitle ?? pair.baseline?.runId;
  const delta = pair.baseline?.durationMs != null && pair.current?.durationMs != null ? pair.current.durationMs - pair.baseline.durationMs : null;

  return (
    <div className="space-y-4 p-4">
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-start gap-2">
          <TransitionChip transition={pair.transition} className="mt-0.5 shrink-0">
            {TRANSITION[pair.transition].short}
          </TransitionChip>
          <h2 className="min-w-0 break-words text-base font-semibold">{side?.title}</h2>
        </div>
        <p className="font-mono text-xs text-muted-foreground">
          {pair.baseline?.checkId ?? "—"} → {pair.current?.checkId ?? "—"}
        </p>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {pair.match ? <span>{MATCH_LINE[pair.match](pair)}</span> : null}
          <MatchBadge pair={pair} actions={actions} />
          {pair.lostCoverage ? <LostCoverage pair={pair} /> : null}
        </div>
        {fromOtherRun && pair.baseline ? (
          <p className="text-xs text-muted-foreground">
            Baseline result from{" "}
            <a href={runHash(pair.baseline.runId, pair.baseline.checkId)} className="underline underline-offset-2">
              “{otherRunTitle}”
            </a>{" "}
            ({formatRelative(pair.baseline.createdAt, now)})
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-3 pt-1">
          {strip.length > 0 ? (
            <StatusStrip
              statuses={strip.map((e): StripStatus => (e.status === "pending" || e.status === "running" ? null : e.status))}
              labels={strip.map((e) => [e.status, e.branch, e.commit?.slice(0, SHORT_SHA), e.deviceName, formatTime(e.createdAt)].filter(Boolean).join(" · "))}
              current={currentIndex >= 0 ? currentIndex : undefined}
              size="sm"
            />
          ) : null}
          <Button variant="outline" size="xs" onClick={onOpenHistory}>
            <History />
            History (h)
          </Button>
        </div>
      </div>

      <ScreenshotCompare
        key={pair.key}
        baseline={{
          url: pair.baseline?.screenshotUrl ?? null,
          eyebrow: eyebrow("Baseline", baseline.branch, baseline.commit ?? base.source?.commit),
          caption: `Baseline · ${pair.baseline?.checkId ?? ""} · ${pair.baseline?.title ?? ""}`,
          missing: "No screenshot in the baseline",
        }}
        current={{
          url: pair.current?.screenshotUrl ?? null,
          eyebrow: eyebrow("This run", run.source?.branch, run.source?.commit),
          caption: `This run · ${pair.current?.checkId ?? ""} · ${pair.current?.title ?? ""}`,
          missing: "No screenshot in this run",
        }}
      />

      <NotesDiff baseline={pair.baseline?.note ?? null} current={pair.current?.note ?? null} />

      <dl className="space-y-2">
        <Field label="Duration">
          {pair.current?.durationMs != null ? formatDurationMs(pair.current.durationMs) : "—"}
          {pair.baseline?.durationMs != null ? ` (was ${formatDurationMs(pair.baseline.durationMs)}${delta !== null && delta !== 0 ? `, ${delta > 0 ? "+" : "−"}${formatDurationMs(Math.abs(delta))}` : ""})` : ""}
        </Field>
        <Field label="Updated">
          {pair.current ? formatTime(pair.current.createdAt) : "—"}
          {pair.baseline ? ` (baseline ${formatTime(pair.baseline.createdAt)})` : ""}
        </Field>
      </dl>

      <div className="flex flex-wrap gap-2">
        {pair.current ? (
          <Button asChild variant="outline" size="sm">
            <a href={runHash(pair.current.runId, pair.current.checkId)}>Open in this run</a>
          </Button>
        ) : null}
        {pair.baseline ? (
          <Button asChild variant="outline" size="sm">
            <a href={runHash(pair.baseline.runId, pair.baseline.checkId)}>Open in baseline</a>
          </Button>
        ) : null}
      </div>
    </div>
  );
}
