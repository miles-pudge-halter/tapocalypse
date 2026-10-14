import { ExternalLink, FileDown, FileText } from "lucide-react";

import { CheckStatusIcon } from "@/components/check-status-icon";
import { UploadedByBrief } from "@/components/hub/uploaded-by";
import { RegressionCount } from "@/components/regression/transition";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { compareHash, reportHash, reportHtmlUrl, type ReleaseView, runHash } from "@/lib/api";
import { formatRelative } from "@/lib/format";
import { useNow } from "@/lib/hooks";
import { blockerGroups } from "@/lib/hub";
import { VerdictCell } from "@/components/hub/verdict-cell";

type Blocker = ReleaseView["blockers"][number];

function BlockerRow({ blocker, view, now }: { blocker: Blocker; view: ReleaseView; now: number }) {
  const { cell } = blocker;
  const { latest } = cell;
  const device = view.devices.find((d) => d.key === blocker.deviceKey)?.name ?? blocker.deviceKey;
  return (
    <li className="space-y-1 px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <VerdictCell verdict={latest.verdict} size="sm" />
        <a href={runHash(latest.id)} className="font-medium hover:underline">
          {blocker.title}
        </a>
        <span className="text-sm text-muted-foreground">· {device}</span>
        {cell.newlyFailing > 0 && (
          <RegressionCount
            count={cell.newlyFailing}
            href={compareHash(latest.id, "auto", { show: "newly_failing" })}
            tooltip={`${cell.newlyFailing} newly failing vs its baseline`}
          />
        )}
      </div>
      {latest.failed.length > 0 && (
        <ul className="space-y-0.5 text-xs">
          {latest.failed.map((c) => (
            <li key={c.id} className="flex items-center gap-1.5">
              <CheckStatusIcon status={c.status} className="size-3" />
              <a href={runHash(latest.id, c.id)} className="min-w-0 truncate hover:underline">
                {c.title}
              </a>
              <span className="shrink-0 text-muted-foreground">— {c.status}</span>
            </li>
          ))}
          {latest.failedMore > 0 && <li className="text-muted-foreground">+{latest.failedMore} more</li>}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
        <UploadedByBrief machine={latest.machine} uploader={latest.uploader} />
        <span>· {formatRelative(latest.endedAt ?? latest.createdAt, now)}</span>
        {cell.attempts.length > 1 && <span>· {cell.attempts.length} attempts</span>}
        <span className="ml-auto flex gap-1">
          <Button asChild variant="ghost" size="xs">
            <a href={runHash(latest.id)}>
              <ExternalLink />
              Run
            </a>
          </Button>
          {latest.reportPath && (
            <>
              <Button asChild variant="ghost" size="xs">
                <a href={reportHash(view.project.id, { id: latest.id, storage: "data", reportPath: latest.reportPath })}>
                  <FileText />
                  Report
                </a>
              </Button>
              <Button asChild variant="ghost" size="xs">
                <a href={reportHtmlUrl(latest.id, { download: true })} download>
                  <FileDown />
                  HTML
                </a>
              </Button>
            </>
          )}
        </span>
      </div>
    </li>
  );
}

function Group({ title, items, view, now }: { title: string; items: Blocker[]; view: ReleaseView; now: number }) {
  if (items.length === 0) return null;
  return (
    <div>
      <h3 className="px-3 py-1 text-xs font-medium text-muted-foreground">
        {title} ({items.length})
      </h3>
      <ul className="divide-y">
        {items.map((b) => (
          <BlockerRow key={`${b.testKey}:${b.deviceKey}`} blocker={b} view={view} now={now} />
        ))}
      </ul>
    </div>
  );
}

/** Tests whose latest run failed or could not finish, grouped, with the failing checks and links to the evidence. */
export function BlockersCard({ view }: { view: ReleaseView }) {
  const now = useNow(30_000);
  if (view.blockers.length === 0) return null;
  const groups = blockerGroups(view.blockers);
  return (
    <Card className="gap-2 py-4">
      <CardHeader className="gap-0.5 px-4">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          Blockers
          <span className="rounded-md border border-red-500/30 bg-red-500/10 px-1.5 text-xs leading-5 text-red-700 tabular-nums dark:text-red-300">{view.blockers.length}</span>
        </CardTitle>
        <CardDescription className="text-xs">Tests whose latest run failed, or could not finish testing.</CardDescription>
      </CardHeader>
      <Group title="Failing" items={groups.failing} view={view} now={now} />
      <Group title="Could not be tested" items={groups.blocked} view={view} now={now} />
    </Card>
  );
}
