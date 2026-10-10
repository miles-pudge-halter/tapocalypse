import { useState } from "react";
import { ChevronDown, ExternalLink, FileText, Info, Loader2, RotateCcw, Trash2, XCircle } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { RunStatusIcon } from "@/components/run-status-icon";
import { SourceChips } from "@/components/source-chips";
import { UsageStrip } from "@/components/usage-strip";
import { VerdictBadge } from "@/components/verdict-badge";
import { batchHash, isActive, reportHash, transcriptUrl, type Device, type RunView } from "@/lib/api";
import { deviceDisplayName } from "@/lib/format";
import { useHarness, useNow } from "@/lib/hooks";
import { DetailsSheet } from "./details-sheet";
import { failedChecks, type RunActions } from "./use-run-actions";

/** Dense one-strip header: breadcrumb, identity, status/verdict, key facts and the run's actions. */
export function RunHeader({
  run,
  device,
  projectName,
  connected,
  actions,
}: {
  run: RunView;
  device: Device | null;
  projectName: string;
  connected: boolean;
  actions: RunActions;
}) {
  const active = isActive(run.status);
  const now = useNow(active ? 1000 : 60_000);
  const { label: harnessLabel } = useHarness(run.harness);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const failed = failedChecks(run.checks).length;
  const statusText = run.status === "queued" && run.queuePosition !== null ? `queued #${run.queuePosition}` : run.status;
  const deviceText = run.deviceName ?? (device ? deviceDisplayName(device) : run.deviceSerial);

  return (
    <header className="space-y-2">
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <a href="#/" className="hover:text-foreground hover:underline">
          Runs
        </a>
        {run.batchId ? (
          <>
            <span aria-hidden>/</span>
            <a href={batchHash(run.batchId)} className="hover:text-foreground hover:underline">
              Batch
            </a>
          </>
        ) : null}
        <span aria-hidden>/</span>
        <span className="truncate">{projectName}</span>
      </nav>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="min-w-0 max-w-full break-words text-xl font-semibold tracking-tight">{run.title}</h1>
        <span className="inline-flex items-center gap-1.5 text-sm capitalize">
          <RunStatusIcon status={run.status} verdict={run.verdict} />
          {statusText}
        </span>
        <VerdictBadge verdict={run.verdict} />
        {run.verdict && run.verdictSource === "derived" ? (
          <Badge variant="outline" className="text-muted-foreground" title="The agent never reported a verdict; it was derived from the checks">
            derived
          </Badge>
        ) : null}
        {active && !connected ? (
          <Badge variant="outline" className="gap-1 text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            reconnecting
          </Badge>
        ) : null}

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {active ? (
            <Button variant="outline" size="sm" className="text-destructive" onClick={() => setCancelOpen(true)}>
              <XCircle />
              Cancel
            </Button>
          ) : (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" disabled={actions.busy}>
                  {actions.busy ? <Loader2 className="animate-spin" /> : <RotateCcw />}
                  Re-run
                  <ChevronDown className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => void actions.rerun("all")}>Re-run all checks</DropdownMenuItem>
                <DropdownMenuItem disabled={failed === 0} onSelect={() => void actions.rerun("failed")}>
                  Re-run failed only{failed > 0 ? ` (${failed})` : ""}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {!active && run.reportPath ? (
            <Button asChild size="sm">
              <a href={reportHash(run.projectId, run)}>
                <FileText />
                Open report
              </a>
            </Button>
          ) : null}
          {!active && run.transcriptHtml ? (
            <Button asChild variant="outline" size="sm">
              <a href={transcriptUrl(run.id)} target="_blank" rel="noopener noreferrer">
                <ExternalLink />
                Transcript
              </a>
            </Button>
          ) : null}
          <Button variant="outline" size="sm" onClick={() => setDetailsOpen(true)}>
            <Info />
            Details
          </Button>
          {!active ? (
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground hover:text-destructive"
              aria-label="Delete run"
              onClick={() => setDeleteOpen(true)}
            >
              <Trash2 />
            </Button>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
        {deviceText ? <span>{deviceText}</span> : <span>no device yet</span>}
        <span aria-hidden>·</span>
        <span>by {run.requestedBy}</span>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <SourceChips source={run.source} build={run.build} />
        <UsageStrip run={run} now={now} harnessLabel={harnessLabel} />
      </div>

      <DetailsSheet
        run={run}
        device={device}
        projectName={projectName}
        harnessLabel={harnessLabel}
        open={detailsOpen}
        onOpenChange={setDetailsOpen}
      />

      <Dialog open={cancelOpen} onOpenChange={(open) => !actions.busy && setCancelOpen(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel this run?</DialogTitle>
            <DialogDescription>
              {run.status === "queued"
                ? "The run will be removed from the queue."
                : "The agent will be aborted and the device released. This cannot be undone."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelOpen(false)} disabled={actions.busy}>
              Keep running
            </Button>
            <Button
              variant="destructive"
              disabled={actions.busy}
              onClick={() => void actions.cancel().then((ok) => ok && setCancelOpen(false))}
            >
              {actions.busy ? <Loader2 className="animate-spin" /> : null}
              Cancel run
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={(open) => !actions.busy && setDeleteOpen(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this run?</DialogTitle>
            <DialogDescription>
              The run's activity log, transcript and stats are removed, along with its report and screenshots when Tapocalypse stores them. Reports in your repository stay.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)} disabled={actions.busy}>
              Keep it
            </Button>
            <Button
              variant="destructive"
              disabled={actions.busy}
              onClick={() => void actions.remove().then((ok) => ok && setDeleteOpen(false))}
            >
              {actions.busy ? <Loader2 className="animate-spin" /> : null}
              Delete run
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </header>
  );
}
