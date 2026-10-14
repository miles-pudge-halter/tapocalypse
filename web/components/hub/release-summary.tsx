import { AlertTriangle, CheckCircle2, CircleDashed, XCircle, type LucideIcon } from "lucide-react";

import type { ReleaseView } from "@/lib/api";
import { formatRelative } from "@/lib/format";
import { useNow } from "@/lib/hooks";
import { releaseBanner, type ReleaseBannerKind } from "@/lib/hub";
import { cn } from "@/lib/utils";

const STYLE: Record<ReleaseBannerKind, { icon: LucideIcon; className: string }> = {
  blockers: { icon: XCircle, className: "border-red-500/40 bg-red-500/5 text-red-700 dark:text-red-300" },
  issues: { icon: AlertTriangle, className: "border-orange-500/40 bg-orange-500/5 text-orange-700 dark:text-orange-300" },
  pass: { icon: CheckCircle2, className: "border-emerald-500/40 bg-emerald-500/5 text-emerald-800 dark:text-emerald-300" },
  none: { icon: CircleDashed, className: "border-border bg-muted/30 text-foreground" },
};

/** The one-sentence verdict on a release, with how stale it is. The hub only ever sees finished runs, so "missing" is not "failed". */
export function ReleaseSummary({ view, fetchedAt, onShowUntested }: { view: ReleaseView; fetchedAt: number | null; onShowUntested(): void }) {
  const now = useNow(30_000);
  const banner = releaseBanner(view);
  const { icon: Icon, className } = STYLE[banner.kind];
  const untested = view.untested.length;
  return (
    <div role="status" className={cn("space-y-1 rounded-lg border p-3 text-sm", className)}>
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
        <div className="min-w-0">
          <p className="font-medium">{banner.title}</p>
          <p>{banner.description}</p>
        </div>
      </div>
      {untested > 0 && view.previous && (
        <p className="pl-6">
          {untested} {untested === 1 ? "test" : "tests"} from {view.previous.name} {untested === 1 ? "has" : "have"} not run in this release yet.{" "}
          <button type="button" className="underline underline-offset-2" onClick={onShowUntested}>
            Show
          </button>
        </p>
      )}
      {fetchedAt !== null && (
        <p className="pl-6 text-xs text-muted-foreground">
          As of {formatRelative(new Date(fetchedAt).toISOString(), now)}. Runs still running on teammates' machines appear when they finish.
        </p>
      )}
    </div>
  );
}
