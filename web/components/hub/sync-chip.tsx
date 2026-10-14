import { Cloud, CloudAlert, CloudCheck, CloudOff, CloudUpload, ExternalLink, Loader2, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, type HubSync, type HubSyncState, type RunView } from "@/lib/api";
import { formatRelative, formatTime } from "@/lib/format";
import { useHubStatus, useNow } from "@/lib/hooks";
import { type ChipTone, syncChip, syncReason } from "@/lib/hub";
import { cn } from "@/lib/utils";

const ICON: Record<HubSyncState, LucideIcon> = {
  waiting: Cloud,
  local: CloudOff,
  queued: CloudUpload,
  uploading: Loader2,
  uploaded: CloudCheck,
  outdated: CloudUpload,
  failed: CloudAlert,
  paused: CloudOff,
  parked: CloudOff,
};

const TONE: Record<ChipTone, string> = {
  muted: "border-border text-muted-foreground",
  busy: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300",
  done: "border-border text-foreground",
  warn: "border-orange-500/30 bg-orange-500/10 text-orange-800 dark:text-orange-300",
  error: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
};

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function stateSentence(sync: HubSync, host: string | null, screenshots: number): string {
  switch (sync.state) {
    case "waiting":
      return `This project is shared. The run uploads to ${host ?? "the hub"} when it finishes.`;
    case "local":
      return "This run finished before sharing was turned on, so it is only on this machine.";
    case "queued":
      return "Waiting its turn. Runs upload one at a time.";
    case "uploading":
      return `Sending the run, its report and ${screenshots} screenshots.`;
    case "uploaded":
      return `Uploaded ${sync.uploadedAt ? formatRelative(sync.uploadedAt, Date.now()) : "just now"}. Edits here (re-linked checks, PR info) upload again on their own.`;
    case "outdated":
      return "A newer version of this run is waiting to replace the copy on the hub.";
    case "failed":
    case "paused":
    case "parked":
      return sync.error ? syncReason(sync.error, host) : "The upload did not go through.";
  }
}

function RemoveDialog({ runId, open, onOpenChange }: { runId: string; open: boolean; onOpenChange(open: boolean): void }) {
  const [busy, setBusy] = useState(false);
  async function remove() {
    setBusy(true);
    try {
      await api.unpublishRun(runId);
      toast.success("Removed from the team hub");
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove this run from the team hub?</DialogTitle>
          <DialogDescription>
            Teammates and stakeholders will no longer see it there. The run stays on this machine. Turn off sharing for the project if you don't want it uploaded again.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Keep it
          </Button>
          <Button variant="destructive" onClick={() => void remove()} disabled={busy}>
            {busy && <Loader2 className="animate-spin" />}
            Remove from hub
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Per-run upload state on a laptop: a chip in the run header, opening a popover that says why and what to do. Null without `hubSync`. */
export function HubSyncChip({ run }: { run: RunView }) {
  const now = useNow(15_000);
  const { status } = useHubStatus();
  const [removing, setRemoving] = useState(false);
  const sync = run.hubSync;
  if (!sync) return null;
  const chip = syncChip(sync, now);
  const Icon = ICON[sync.state];
  const host = hostOf(sync.url) ?? hostOf(status?.url ?? null);
  const screenshots = run.checks.filter((c) => c.screenshot).length;
  const title = chip.text.split(" · ")[0] ?? chip.text;
  const code = sync.error?.code;
  const settings = sync.state === "paused" || sync.state === "parked" || (sync.state === "failed" && (code === "unauthorized" || code === "proxy_login" || code === "protocol_unsupported" || code === "not_a_hub"));

  async function push() {
    try {
      await api.hubPush({ runIds: [run.id] });
      toast.success("Upload queued");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <>
      <Popover>
        <PopoverTrigger asChild>
          <button type="button" className={cn("inline-flex h-5 items-center gap-1 rounded-md border px-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring", TONE[chip.tone])}>
            <Icon className={cn("size-3", sync.state === "uploading" && "animate-spin", sync.state === "uploaded" && "text-emerald-600 dark:text-emerald-400")} aria-hidden />
            {chip.text}
            {chip.opensHub && <ExternalLink className="size-3 opacity-60" aria-hidden />}
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80 space-y-2 p-3 text-sm">
          <p className="font-medium">{title}</p>
          <p>{stateSentence(sync, host, screenshots)}</p>
          <div className="space-y-0.5 text-xs text-muted-foreground">
            {sync.state === "failed" && <p>Attempts: {sync.attempts}</p>}
            {sync.state === "failed" && sync.nextAttemptAt && <p>Next try {formatTime(sync.nextAttemptAt)}</p>}
            {host && <p>Hub: {host}</p>}
          </div>
          {sync.error?.detail && sync.error.code !== "other" && (
            <pre className="whitespace-pre-wrap break-words rounded bg-muted p-2 font-mono text-[11px]">{sync.error.detail}</pre>
          )}
          <div className="flex flex-wrap gap-2">
            {(sync.state === "uploaded" || sync.state === "outdated") && (
              <>
                {sync.url && (
                  <Button asChild size="xs" variant="outline">
                    <a href={sync.url} target="_blank" rel="noopener noreferrer">
                      <ExternalLink />
                      Open on team hub
                    </a>
                  </Button>
                )}
                <Button size="xs" variant="ghost" className="text-destructive" onClick={() => setRemoving(true)}>
                  Remove from team hub…
                </Button>
              </>
            )}
            {sync.state === "failed" && (
              <Button size="xs" onClick={() => void push()}>
                Retry now
              </Button>
            )}
            {sync.state === "local" && (
              <Button size="xs" onClick={() => void push()}>
                <CloudUpload />
                Upload this run
              </Button>
            )}
            {settings && (
              <Button asChild size="xs" variant="outline">
                <a href="#/setup?section=team-hub">Team hub settings</a>
              </Button>
            )}
          </div>
        </PopoverContent>
      </Popover>
      <RemoveDialog runId={run.id} open={removing} onOpenChange={setRemoving} />
    </>
  );
}

/** List-row marker for uploads that need attention (failed, paused, parked); silent otherwise. */
export function HubSyncIcon({ sync }: { sync: HubSync | null | undefined }) {
  const now = useNow(30_000);
  if (!sync || (sync.state !== "failed" && sync.state !== "paused" && sync.state !== "parked")) return null;
  const chip = syncChip(sync, now);
  const Icon = sync.state === "parked" ? CloudOff : CloudAlert;
  const reason = sync.error ? syncReason(sync.error, null) : null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="relative z-10 shrink-0" aria-label={chip.text}>
          <Icon className={cn("size-3.5", sync.state === "parked" ? "text-red-500" : "text-orange-500")} aria-hidden />
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        {chip.text}
        {reason ? ` — ${reason}` : ""}
      </TooltipContent>
    </Tooltip>
  );
}
