import { ChevronRight } from "lucide-react";

import { TRANSITION } from "@/components/regression/transition";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { type ChangeItem, compareHash, type ReleaseView, runHash, type Transition } from "@/lib/api";
import { PLATFORM_LABEL } from "@/lib/format";
import { cn } from "@/lib/utils";

const ORDER: Transition[] = ["newly_failing", "flaky", "fixed", "changed", "still_failing", "new", "removed", "unchanged"];
const LABEL: Partial<Record<Transition, string>> = { new: "New in this release", removed: "Not tested in this release" };

function ChangeRow({ item }: { item: ChangeItem }) {
  const style = TRANSITION[item.transition];
  const target = item.current ?? item.previous;
  return (
    <li className={cn("grid grid-cols-[minmax(0,1fr)_auto] gap-2 border-l-2 px-3 py-2", style.border)}>
      <div className="min-w-0">
        <div className="line-clamp-2 text-sm" title={item.title}>
          {item.title}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {item.testTitle} · {PLATFORM_LABEL[item.platform]}
        </div>
        <div className="text-xs text-muted-foreground">
          {item.previous?.status ?? "—"} → {item.current?.status ?? "—"}
        </div>
      </div>
      <div className="flex items-start gap-1">
        {item.current && item.previous && (
          <Button asChild variant="ghost" size="xs">
            <a href={compareHash(item.current.runId, item.previous.runId)}>Compare</a>
          </Button>
        )}
        {target && (
          <Button asChild variant="ghost" size="xs">
            <a href={runHash(target.runId, target.checkId)}>Run</a>
          </Button>
        )}
      </div>
    </li>
  );
}

/** Every check that changed between this release and the previous one, grouped like the compare page. */
export function ReleaseChanges({ view }: { view: ReleaseView }) {
  const { changes, previous } = view;
  return (
    <section aria-labelledby="changes-title" id="changes" className="scroll-mt-16 space-y-2">
      <h2 id="changes-title" className="text-sm font-medium">
        Changes since {previous?.name ?? "the previous release"}
      </h2>
      {!changes || !previous ? (
        <p className="text-sm text-muted-foreground">First release on the hub, so there is nothing to compare with yet.</p>
      ) : (
        <Card className="gap-0 overflow-hidden p-0">
          {ORDER.every((t) => t === "unchanged" || changes.counts[t] === 0) && (
            <p className="border-b px-3 py-3 text-sm text-muted-foreground">Every check that ran in both releases kept its result.</p>
          )}
          {ORDER.map((t) => {
            const items = changes.items.filter((i) => i.transition === t);
            if (items.length === 0) return null;
            const style = TRANSITION[t];
            const Icon = style.icon;
            return (
              <Collapsible key={t} defaultOpen={t !== "unchanged"} id={`changes-${t}`} className="group/changes scroll-mt-16 border-b last:border-b-0">
                <CollapsibleTrigger className="sticky top-0 z-10 flex w-full items-center gap-2 bg-muted/60 px-3 py-1.5 text-left text-xs font-medium backdrop-blur">
                  <ChevronRight className="size-3.5 transition-transform group-data-[state=open]/changes:rotate-90" aria-hidden />
                  <Icon className={cn("size-3.5", style.text)} aria-hidden />
                  {LABEL[t] ?? style.label}
                  <span className="tabular-nums text-muted-foreground">{items.length}</span>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <ul className="divide-y">
                    {items.map((item) => (
                      <ChangeRow key={`${item.checkKey}:${item.platform}:${item.testKey}`} item={item} />
                    ))}
                  </ul>
                </CollapsibleContent>
              </Collapsible>
            );
          })}
        </Card>
      )}
    </section>
  );
}
