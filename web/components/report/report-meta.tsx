import { ExternalLink, FileText, Play } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { CopyButton } from "@/components/copy-button";
import { CheckCounts, SegmentedProgress } from "@/components/segmented-progress";
import { RunStatusIcon } from "@/components/run-status-icon";
import { SourceChips } from "@/components/source-chips";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { TooltipProvider } from "@/components/ui/tooltip";
import { VerdictBadge } from "@/components/verdict-badge";
import { api, ApiError, type RunView } from "@/lib/api";
import { formatDuration, formatTime } from "@/lib/format";
import { useNow } from "@/lib/hooks";

function MetaRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-right">{children}</dd>
    </div>
  );
}

type RunState =
  | { kind: "loading" }
  | { kind: "ready"; run: RunView }
  | { kind: "missing" }
  | { kind: "error"; message: string };

function useReportRun(runId: string): RunState {
  const [state, setState] = useState<{ runId: string; value: RunState } | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.run(runId).then(
      (run) => {
        if (!cancelled) setState({ runId, value: { kind: "ready", run } });
      },
      (e: unknown) => {
        if (cancelled) return;
        const value: RunState =
          e instanceof ApiError && e.status === 404
            ? { kind: "missing" }
            : { kind: "error", message: e instanceof Error ? e.message : String(e) };
        setState({ runId, value });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [runId]);

  return state?.runId === runId ? state.value : { kind: "loading" };
}

/** The run that produced a report: outcome, device, source, checks, and links both ways. */
export function ReportRunCard({ runId }: { runId: string }) {
  const state = useReportRun(runId);
  const now = useNow(30_000);
  const runHref = `#/runs/${encodeURIComponent(runId)}`;

  if (state.kind === "loading") {
    return (
      <Card className="gap-3 p-4">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-2 w-full" />
      </Card>
    );
  }

  if (state.kind !== "ready") {
    return (
      <Card className="gap-3 p-4">
        <h2 className="text-sm font-semibold">Run</h2>
        <p className="text-sm text-muted-foreground">
          {state.kind === "missing" ? "This run was deleted, but its report is still here." : state.message}
        </p>
        <p className="break-all font-mono text-xs text-muted-foreground">{runId}</p>
      </Card>
    );
  }

  const { run } = state;
  return (
    <Card className="gap-4 p-4">
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">Run details</h2>
          <div className="flex items-center gap-1.5">
            <VerdictBadge verdict={run.verdict} />
            {run.verdictSource === "derived" ? <Badge variant="outline">derived</Badge> : null}
          </div>
        </div>
        <a href={runHref} className="flex items-start gap-2 text-sm font-medium hover:underline">
          <RunStatusIcon status={run.status} verdict={run.verdict} className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 break-words">{run.title}</span>
        </a>
      </div>

      <dl className="space-y-1.5">
        <MetaRow label="Device">
          {run.deviceName ? (
            <span title={run.deviceSerial ?? undefined}>{run.deviceName}</span>
          ) : (
            <span className="font-mono text-xs">{run.deviceSerial ?? run.deviceRequest.platform}</span>
          )}
        </MetaRow>
        <MetaRow label="Backend">{run.backend}</MetaRow>
        <MetaRow label="Requested by">{run.requestedBy}</MetaRow>
        <MetaRow label="Started">{formatTime(run.startedAt)}</MetaRow>
        <MetaRow label="Duration">{formatDuration(run.startedAt, run.endedAt, now)}</MetaRow>
      </dl>

      <TooltipProvider>
        <SourceChips source={run.source} build={run.build} />
      </TooltipProvider>

      {run.checks.length > 0 ? (
        <div className="space-y-1.5">
          <SegmentedProgress checks={run.checks} size="sm" />
          <div className="text-xs text-muted-foreground">
            <CheckCounts checks={run.checks} />
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button asChild size="sm">
          <a href={runHref}>
            <Play />
            Open run
          </a>
        </Button>
        {run.transcriptHtml ? (
          <Button asChild size="sm" variant="outline">
            <a href={`/api/runs/${encodeURIComponent(run.id)}/transcript`} target="_blank" rel="noopener noreferrer">
              <ExternalLink />
              Transcript
            </a>
          </Button>
        ) : null}
      </div>
    </Card>
  );
}

/** File facts for the report itself; the only card shown for hand-written reports with no run. */
export function ReportFileCard({
  name,
  path,
  imageCount,
}: {
  name: string;
  /** Absolute path on disk as the server reports it; null until the report list has loaded. */
  path: string | null;
  imageCount: number;
}) {
  return (
    <Card className="gap-3 p-4">
      <div className="flex items-center gap-2">
        <FileText className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">File</h2>
      </div>
      <dl className="space-y-1.5">
        <MetaRow label="Name">
          <span className="font-mono text-xs" title={name}>
            {name}
          </span>
        </MetaRow>
        <MetaRow label="Screenshots">{imageCount}</MetaRow>
      </dl>
      {path ? <CopyButton value={path} label="Copy path" /> : null}
    </Card>
  );
}
