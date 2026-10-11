import { Unlink } from "lucide-react";
import { useState } from "react";

import { CheckStatusIcon } from "@/components/check-status-icon";
import { EmptyState } from "@/components/empty-state";
import type { LinkActions } from "@/components/regression/match-badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { CompareSide, ComparePair, RunComparison } from "@/lib/api";
import { cn } from "@/lib/utils";

function PickList({
  heading,
  pairs,
  side,
  selectedKey,
  suggestedId,
  onSelect,
}: {
  heading: string;
  pairs: ComparePair[];
  side: "baseline" | "current";
  selectedKey: string | null;
  suggestedId(pair: ComparePair): string | null;
  onSelect(pair: ComparePair): void;
}) {
  return (
    <Card className="gap-0 overflow-hidden p-0">
      <h3 className="border-b bg-muted/40 px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{heading}</h3>
      <ul className="divide-y">
        {pairs.map((pair) => {
          const check: CompareSide | null = pair[side];
          if (!check) return null;
          const selected = pair.key === selectedKey;
          const suggested = suggestedId(pair);
          return (
            <li key={pair.key}>
              <button
                type="button"
                aria-pressed={selected}
                onClick={() => onSelect(pair)}
                className={cn("flex w-full items-start gap-2 px-3 py-2 text-left outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring", selected && "bg-accent ring-1 ring-ring")}
              >
                <CheckStatusIcon status={check.status} className="mt-0.5" />
                <span className="min-w-0">
                  <span className="block font-mono text-xs text-muted-foreground">{check.checkId}</span>
                  <span className="block break-words text-sm">{check.title}</span>
                  {suggested ? <span className="block text-xs text-muted-foreground">suggested: {suggested}</span> : null}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/** Shown when no check of the two runs matched: pick one check on each side and link them. */
export function LinkMode({ comparison, actions }: { comparison: RunComparison; actions: LinkActions }) {
  const baselineRows = comparison.pairs.filter((p) => p.baseline && !p.current);
  const currentRows = comparison.pairs.filter((p) => p.current && !p.baseline);
  const [a, setA] = useState<ComparePair | null>(null);
  const [b, setB] = useState<ComparePair | null>(null);
  return (
    <div className="space-y-4">
      <EmptyState
        icon={Unlink}
        title="No checks could be matched"
        description="The two runs describe their checks differently, so there is no common ground yet. Link checks that test the same thing, and future comparisons and history will line up."
      />
      <div className="grid gap-3 md:grid-cols-2">
        <PickList heading="Baseline checks" side="baseline" pairs={baselineRows} selectedKey={a?.key ?? null} suggestedId={(p) => p.suggestion?.checkId ?? null} onSelect={setA} />
        <PickList
          heading="This run's checks"
          side="current"
          pairs={currentRows}
          selectedKey={b?.key ?? null}
          suggestedId={(p) => p.suggestion?.checkId ?? null}
          onSelect={setB}
        />
      </div>
      {a?.baseline && b?.current ? (
        <div className="sticky bottom-4 flex justify-center">
          <Button
            disabled={actions.busy}
            onClick={() => {
              const from = a.baseline;
              const to = b.current;
              if (!from || !to) return;
              void actions.linkChecks({ runId: from.runId, checkId: from.checkId }, { runId: to.runId, checkId: to.checkId }).then(() => {
                setA(null);
                setB(null);
              });
            }}
          >
            Link {a.baseline.checkId} and {b.current.checkId}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
