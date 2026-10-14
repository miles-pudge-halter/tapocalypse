import { ArrowDown, EyeOff, Plus } from "lucide-react";

import { TransitionChip } from "@/components/regression/transition";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PLATFORM_LABEL } from "@/lib/format";
import { type ChangeItem, type Ref, releaseHash, runHash, type Transition } from "@/lib/api";
import { cn } from "@/lib/utils";

export interface ChangesData {
  ref: Ref;
  previous: Ref | null;
  counts: Record<Transition, number>;
  top: ChangeItem[];
}

const MUTED_CHIP = "inline-flex items-center gap-1 rounded-md border border-border px-1.5 text-xs leading-5 tabular-nums text-muted-foreground";

/** The counts row shared by the overview card and the release page: newly failing always, the rest only when non-zero. */
export function ChangeCounts({ counts }: { counts: Record<Transition, number> }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      <TransitionChip transition="newly_failing" count={counts.newly_failing}>
        newly failing
      </TransitionChip>
      {counts.fixed > 0 && (
        <TransitionChip transition="fixed" count={counts.fixed}>
          fixed
        </TransitionChip>
      )}
      {counts.flaky > 0 && (
        <TransitionChip transition="flaky" count={counts.flaky}>
          flaky
        </TransitionChip>
      )}
      {counts.changed > 0 && <span className={MUTED_CHIP}>{counts.changed} changed</span>}
      {counts.new > 0 && (
        <span className={MUTED_CHIP} title="Distinct checks with no result in the previous release. Reruns and platforms do not count twice.">
          <Plus className="size-3" aria-hidden />
          {counts.new} new checks
        </span>
      )}
      {counts.removed > 0 && (
        <span
          className="inline-flex h-5 items-center gap-1 rounded-md border border-dashed border-orange-500/40 px-1.5 text-xs text-orange-700 dark:text-orange-400"
          title="Checks that ran in the previous release but have no result in this one."
        >
          <EyeOff className="size-3" aria-hidden />
          {counts.removed} no longer tested
        </span>
      )}
      {counts.unchanged > 0 && counts.newly_failing === 0 && counts.fixed === 0 && counts.flaky === 0 && (
        <span className={MUTED_CHIP}>{counts.unchanged} unchanged</span>
      )}
    </div>
  );
}

/** Changes of the latest (or selected) release against the one before it. `onSeeAll` replaces the footer link with a scroll action. */
export function ChangesCard({
  data,
  projectId,
  onSeeAll,
  className,
}: {
  data: ChangesData | null;
  projectId: string;
  onSeeAll?: () => void;
  className?: string;
}) {
  if (!data) {
    return (
      <Card className={cn("gap-2 py-4", className)}>
        <CardHeader className="px-4">
          <CardTitle className="text-sm font-medium">Releases</CardTitle>
        </CardHeader>
        <CardContent className="px-4 text-sm text-muted-foreground">
          No releases yet. Runs show up as releases by app version, or by branch when it starts with release/, releases/ or hotfix/.
        </CardContent>
      </Card>
    );
  }
  const { ref, previous, counts, top } = data;
  const open = (
    <Button asChild={!onSeeAll} variant="link" size="xs" className="h-auto p-0" onClick={onSeeAll}>
      {onSeeAll ? <span>See all changes</span> : <a href={releaseHash(projectId, ref)}>Open release {ref.name}</a>}
    </Button>
  );
  if (!previous) {
    return (
      <Card className={cn("gap-2 py-4", className)}>
        <CardHeader className="px-4">
          <CardTitle className="text-sm font-medium">{ref.name}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 px-4 text-sm text-muted-foreground">
          <p>First release on the hub, so there is nothing to compare with yet.</p>
          {open}
        </CardContent>
      </Card>
    );
  }
  const noChanges = counts.newly_failing === 0 && counts.fixed === 0 && counts.flaky === 0 && counts.changed === 0 && counts.new === 0 && counts.removed === 0;
  return (
    <Card className={cn("gap-3 py-4", className)}>
      <CardHeader className="gap-0.5 px-4">
        <CardTitle className="text-sm font-medium">What changed since {previous.name}</CardTitle>
        <p className="text-xs text-muted-foreground">
          <a className="underline-offset-2 hover:underline" href={releaseHash(projectId, ref)}>
            {ref.name}
          </a>{" "}
          vs{" "}
          <a className="underline-offset-2 hover:underline" href={releaseHash(projectId, previous)}>
            {previous.name}
          </a>
        </p>
      </CardHeader>
      <CardContent className="space-y-3 px-4">
        <ChangeCounts counts={counts} />
        {noChanges ? (
          <p className="text-sm text-muted-foreground">Every check that ran in both releases kept its result.</p>
        ) : top.length > 0 ? (
          <ul className="space-y-1.5 text-sm">
            {top.map((item) => (
              <li key={`${item.checkKey}:${item.platform}`} className="flex items-start gap-2">
                <ArrowDown className="mt-0.5 size-3.5 shrink-0 text-red-600 dark:text-red-400" aria-hidden />
                <span className="min-w-0">
                  {item.current ? (
                    <a href={runHash(item.current.runId, item.current.checkId)} className="line-clamp-1 hover:underline" title={item.title}>
                      {item.title}
                    </a>
                  ) : (
                    <span className="line-clamp-1">{item.title}</span>
                  )}
                  <span className="block truncate text-xs text-muted-foreground">
                    {item.testTitle} · {PLATFORM_LABEL[item.platform]}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        {open}
      </CardContent>
    </Card>
  );
}
