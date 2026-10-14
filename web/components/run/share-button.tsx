import { ChevronDown, CloudCheck, Download, ExternalLink, Link2, Loader2, Share2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { api, type HubSync, reportHtmlUrl, runHash, type ShareResult } from "@/lib/api";
import { formatExpiresIn } from "@/lib/format";
import { useShareStatus } from "@/lib/hooks";
import { isHub } from "@/lib/mode";

function sharedDescription(result: ShareResult): string {
  const expiry = formatExpiresIn(result.expiresAt, Date.now());
  const omitted =
    result.omitted > 0 ? ` ${result.omitted} ${result.omitted === 1 ? "screenshot was" : "screenshots were"} left out (size limit).` : "";
  return `Anyone with the link can open the report for ${expiry}.${omitted}`;
}

/** Copy the link; when the browser refuses (the user gesture is gone after the upload), the toast keeps the link and a Copy action. */
async function copyLink(result: ShareResult): Promise<void> {
  const description = sharedDescription(result);
  try {
    await navigator.clipboard.writeText(result.url);
    toast.success("Share link copied", { description });
  } catch {
    toast.success("Share link ready", {
      description: `${result.url} — ${description}`,
      duration: 20_000,
      action: {
        label: "Copy",
        onClick: () => {
          navigator.clipboard.writeText(result.url).then(
            () => toast.success("Share link copied"),
            () => toast.error("Could not copy to the clipboard"),
          );
        },
      },
    });
  }
}

/**
 * Share menu of a finished run: download the standalone HTML report, or (when the server has `share.s3`) upload it and
 * copy a presigned link. Disabled while the run is active because its report is not final.
 */
export function ShareButton({
  runId,
  disabled = false,
  align = "end",
  reportPath,
  hubSync,
}: {
  runId: string;
  disabled?: boolean;
  align?: "start" | "end";
  /** The run's report file; on the hub the HTML items are disabled without one. */
  reportPath?: string | null;
  /** Laptop: the run's upload state, for the "Open on team hub" items. */
  hubSync?: HubSync | null;
}) {
  const { status, loading, error } = useShareStatus();
  const [uploading, setUploading] = useState(false);
  const hub = isHub();

  async function copyHubLink(text: string, title: string, description: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(title, { description });
    } catch {
      toast.error("Could not copy to the clipboard");
    }
  }

  async function share() {
    setUploading(true);
    try {
      await copyLink(await api.shareRun(runId));
    } catch (err) {
      toast.error(`Share failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setUploading(false);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled || uploading}
          title={disabled ? "Available when the run finishes" : undefined}
        >
          {uploading ? <Loader2 className="animate-spin" /> : <Share2 />}
          Share
          <ChevronDown className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="w-64">
        {hub && (
          <>
            <DropdownMenuItem
              onSelect={() => void copyHubLink(`${location.origin}${location.pathname}${runHash(runId)}`, "Link copied", "Anyone who can sign in to the hub can open it.")}
            >
              <Link2 />
              Copy link to this run
            </DropdownMenuItem>
            {reportPath ? (
              <DropdownMenuItem asChild>
                <a href={reportHtmlUrl(runId)} target="_blank" rel="noopener noreferrer">
                  <ExternalLink />
                  Open HTML report
                </a>
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem disabled>
                <ExternalLink />
                Open HTML report
                <span className="ml-auto text-xs text-muted-foreground">No report for this run</span>
              </DropdownMenuItem>
            )}
          </>
        )}
        {hub && !reportPath ? (
          <DropdownMenuItem disabled>
            <Download />
            Download HTML report
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem asChild>
            <a href={reportHtmlUrl(runId, { download: true })} download>
              <Download />
              Download HTML report
            </a>
          </DropdownMenuItem>
        )}
        {!hub && (hubSync?.state === "uploaded" || hubSync?.state === "outdated") && hubSync.url ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <a href={hubSync.url} target="_blank" rel="noopener noreferrer">
                <CloudCheck />
                Open on team hub
              </a>
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => void copyHubLink(hubSync.url ?? "", "Team hub link copied", "Teammates and stakeholders who can sign in to the hub can open it.")}
            >
              <Link2 />
              Copy team hub link
            </DropdownMenuItem>
          </>
        ) : null}
        {hub ? null : loading ? (
          <div className="px-2 py-1.5" aria-label="Checking whether link sharing is set up">
            <Skeleton className="h-4 w-40" />
          </div>
        ) : error ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="whitespace-normal font-normal text-destructive">
              Could not check link sharing: {error}
            </DropdownMenuLabel>
          </>
        ) : status?.configured ? (
          <DropdownMenuItem disabled={uploading} onSelect={() => void share()}>
            <Link2 />
            Copy share link
          </DropdownMenuItem>
        ) : status?.problem ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="whitespace-normal font-normal text-muted-foreground">
              Link sharing is off: {status.problem}
            </DropdownMenuLabel>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
