import { GitBranch, GitCommitHorizontal, GitPullRequest, Loader2, Package } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { BuildInfo, PullRequestInfo, RunSource } from "@/lib/api";
import { externalUrl } from "@/lib/hub";
import { cn } from "@/lib/utils";

const SHORT_SHA_LENGTH = 7;

const PR_STATE_STYLE: Record<string, string> = {
  OPEN: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  MERGED: "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300",
  CLOSED: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
};
const PR_DRAFT_STYLE = "border-stone-500/30 bg-stone-500/10 text-stone-700 dark:text-stone-300";

/** `https://github.com/o/r/commit/<sha>` when the remote is GitHub, otherwise null. */
function commitUrl(remoteUrl: string | null, sha: string): string | null {
  if (!remoteUrl) return null;
  try {
    const url = new URL(remoteUrl);
    if (url.hostname !== "github.com") return null;
    return `${remoteUrl.replace(/\/+$/, "")}/commit/${sha}`;
  } catch {
    return null;
  }
}

function prStyle(pr: PullRequestInfo): string {
  if (pr.isDraft) return PR_DRAFT_STYLE;
  return PR_STATE_STYLE[pr.state?.toUpperCase() ?? ""] ?? "";
}

function buildLabel(build: BuildInfo): string | null {
  if (build.versionName && build.versionCode) return `v${build.versionName} (${build.versionCode})`;
  if (build.versionName) return `v${build.versionName}`;
  if (build.versionCode) return `build ${build.versionCode}`;
  return null;
}

function Chip({
  icon: Icon,
  tooltip,
  href,
  mono = true,
  maxWidth,
  className,
  children,
}: {
  icon?: LucideIcon;
  tooltip: ReactNode;
  href?: string | null;
  mono?: boolean;
  maxWidth?: string;
  className?: string;
  children: ReactNode;
}) {
  const classes = cn(mono && "font-mono", className);
  const content = (
    <>
      {Icon ? <Icon /> : null}
      <span className={cn("truncate", maxWidth)}>{children}</span>
    </>
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {externalUrl(href) ? (
          <Badge asChild variant="outline" className={classes}>
            <a href={externalUrl(href) ?? undefined} target="_blank" rel="noopener noreferrer">
              {content}
            </a>
          </Badge>
        ) : (
          <Badge variant="outline" className={classes} tabIndex={0}>
            {content}
          </Badge>
        )}
      </TooltipTrigger>
      <TooltipContent className="max-w-sm break-words">{tooltip}</TooltipContent>
    </Tooltip>
  );
}

function PullRequestChip({ source, compact }: { source: RunSource; compact: boolean }) {
  const { pr, prStatus } = source;
  if (pr) {
    const text = compact || !pr.title ? `#${pr.number}` : `#${pr.number} ${pr.title}`;
    const detail = [pr.title, pr.state && (pr.isDraft ? `${pr.state} (draft)` : pr.state), pr.baseBranch && `into ${pr.baseBranch}`, pr.author && `by ${pr.author}`]
      .filter(Boolean)
      .join(" · ");
    return (
      <Chip icon={GitPullRequest} href={pr.url} mono={false} maxWidth="max-w-80" className={prStyle(pr)} tooltip={detail || `Pull request #${pr.number}`}>
        {text}
      </Chip>
    );
  }
  if (prStatus === "pending") {
    return (
      <Chip icon={GitPullRequest} mono={false} className="text-muted-foreground" tooltip="Looking up the pull request for this branch…">
        <span className="flex items-center gap-1">
          PR
          <Loader2 className="size-3 animate-spin" aria-label="Looking up pull request" />
        </span>
      </Chip>
    );
  }
  return null;
}

/**
 * Where a run's code came from (branch, commit, PR, tickets) and which app build was on the device.
 * `compact` shows branch + PR number only, for cards and table rows. Renders nothing when there is nothing to show.
 */
export function SourceChips({
  source,
  build,
  compact = false,
}: {
  source?: RunSource | null;
  build?: BuildInfo | null;
  compact?: boolean;
}) {
  const buildText = build ? buildLabel(build) : null;
  const hasPr = source ? source.pr !== null || source.prStatus === "pending" : false;
  const hasContent = compact
    ? Boolean(source?.branch) || hasPr
    : Boolean(source?.branch || source?.commit || hasPr || source?.tickets.length || source?.dirty || buildText);
  if (!hasContent) return null;

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      {source?.branch ? (
        <Chip icon={GitBranch} maxWidth={compact ? "max-w-36" : "max-w-72"} tooltip={source.branch}>
          {source.branch}
        </Chip>
      ) : null}
      {!compact && source?.commit ? (
        <Chip
          icon={GitCommitHorizontal}
          href={commitUrl(source.remoteUrl, source.commit)}
          tooltip={
            <span className="space-y-0.5">
              <span className="block font-mono">{source.commit}</span>
              {source.commitSubject ? <span className="block">{source.commitSubject}</span> : null}
            </span>
          }
        >
          {source.commit.slice(0, SHORT_SHA_LENGTH)}
        </Chip>
      ) : null}
      {!compact && source?.dirty ? (
        <Chip
          mono={false}
          className="border-orange-500/30 bg-orange-500/10 text-orange-800 dark:text-orange-300"
          tooltip={`Uncommitted changes in ${source.path}`}
        >
          uncommitted
        </Chip>
      ) : null}
      {source ? <PullRequestChip source={source} compact={compact} /> : null}
      {!compact && source
        ? source.tickets.map((ticket) => (
            <Badge key={ticket} variant="outline" className="font-mono">
              {ticket}
            </Badge>
          ))
        : null}
      {!compact && build && buildText ? (
        <Chip icon={Package} tooltip={`${build.packageId} installed on the device`}>
          {buildText}
        </Chip>
      ) : null}
    </div>
  );
}
