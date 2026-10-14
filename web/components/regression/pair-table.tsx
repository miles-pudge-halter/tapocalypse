import { ChevronRight, Snowflake } from "lucide-react";
import type { ReactNode } from "react";

import { CheckStatusIcon } from "@/components/check-status-icon";
import { MatchBadge, type LinkActions } from "@/components/regression/match-badge";
import { FLAKY_TEXT, TRANSITION, TransitionChip } from "@/components/regression/transition";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { CompareSide, ComparePair } from "@/lib/api";
import { formatDurationMs } from "@/lib/format";
import { isHub } from "@/lib/mode";
import { suggestionKey, type PairGroup } from "@/lib/regression";
import { cn } from "@/lib/utils";

function SideCell({ side, flaky, badge }: { side: CompareSide | null; flaky?: boolean; badge?: ReactNode }) {
  if (!side) return <span className="text-sm text-muted-foreground">—</span>;
  return (
    <span className="flex min-w-0 items-start gap-2">
      <CheckStatusIcon status={side.status} className="mt-0.5" />
      <span className="min-w-0 space-y-0.5">
        <span className="block font-mono text-xs text-muted-foreground">{side.checkId}</span>
        <span className="line-clamp-2 block break-words text-sm">
          {side.title}
          {flaky ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Snowflake aria-label="flaky" className={cn("ml-1 inline size-3", FLAKY_TEXT)} />
              </TooltipTrigger>
              <TooltipContent>Flaky: flips between pass and fail on the same code</TooltipContent>
            </Tooltip>
          ) : null}
        </span>
        {badge}
      </span>
    </span>
  );
}

function deltaText(pair: ComparePair): string {
  const a = pair.baseline?.durationMs;
  const b = pair.current?.durationMs;
  if (a == null || b == null) return "";
  const d = b - a;
  if (Math.abs(d) < 500) return "";
  return `${d > 0 ? "+" : "−"}${formatDurationMs(Math.abs(d))}`;
}

function Suggestion({ pair, actions }: { pair: ComparePair; actions: LinkActions }) {
  const s = pair.suggestion;
  const key = suggestionKey(pair);
  if (!s || !key || actions.dismissed.has(key)) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 px-3 pb-2 pl-9 text-xs">
      <span className="min-w-0 break-words text-muted-foreground">
        Possibly the same as <span className="font-mono">{s.checkId}</span> “{s.title}” ({Math.round(s.similarity * 100)}% similar)
      </span>
      {isHub() ? null : (
        <>
          <Button variant="outline" size="xs" disabled={actions.busy} onClick={() => void actions.link(pair)}>
            Link
          </Button>
          <Button variant="ghost" size="xs" disabled={actions.busy} onClick={() => actions.dismiss(pair)}>
            Not the same
          </Button>
        </>
      )}
    </div>
  );
}

function Row({ pair, selected, onSelect, actions, detail }: { pair: ComparePair; selected: boolean; onSelect(): void; actions: LinkActions; detail: ReactNode }) {
  const style = TRANSITION[pair.transition];
  const Icon = style.icon;
  const titleDiffers = pair.baseline && pair.current && pair.baseline.title !== pair.current.title;
  const delta = deltaText(pair);
  return (
    <li className={cn("border-l-2", style.border)}>
      <button
        type="button"
        id={`pair-${pair.key}`}
        aria-pressed={selected}
        onClick={onSelect}
        className={cn("w-full px-3 py-2 text-left outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring", selected && "bg-accent")}
      >
        <span className="hidden grid-cols-[minmax(0,1fr)_1.25rem_minmax(0,1fr)] items-start gap-3 @md:grid @md:grid-cols-[minmax(0,1fr)_1.25rem_minmax(0,1fr)_3.5rem]">
          <SideCell side={pair.baseline} />
          <Icon className={cn("mt-0.5 size-3.5", style.text)} aria-hidden />
          <SideCell
            side={pair.current}
            flaky={pair.flaky}
            badge={titleDiffers ? <span className="block"><MatchBadge pair={pair} actions={actions} /></span> : undefined}
          />
          <span className="text-right text-xs tabular-nums text-muted-foreground">{delta}</span>
        </span>
        <span className="block space-y-1 @md:hidden">
          <span className="flex items-center gap-2">
            <TransitionChip transition={pair.transition}>{style.short}</TransitionChip>
            <span className="line-clamp-2 break-words text-sm">{(pair.current ?? pair.baseline)?.title}</span>
          </span>
          {pair.baseline ? (
            <span className="block break-words text-xs text-muted-foreground">
              Baseline: {pair.baseline.status} · {pair.baseline.title}
            </span>
          ) : null}
        </span>
      </button>
      <Suggestion pair={pair} actions={actions} />
      {detail}
    </li>
  );
}

/** The grouped, collapsible list of pairs. `detail` renders a pair's pane inline below its row (narrow layouts). */
export function PairTable({
  groups,
  selectedKey,
  collapsed,
  onToggle,
  onSelect,
  actions,
  detail,
}: {
  groups: PairGroup[];
  selectedKey: string | null;
  collapsed: ReadonlySet<string>;
  onToggle(transition: string, open: boolean): void;
  onSelect(key: string): void;
  actions: LinkActions;
  detail(pair: ComparePair): ReactNode;
}) {
  return (
    <div className="@container">
      {groups.map((group) => {
        const style = TRANSITION[group.transition];
        const Icon = style.icon;
        const open = !collapsed.has(group.transition);
        return (
          <Collapsible key={group.transition} open={open} onOpenChange={(next) => onToggle(group.transition, next)}>
            <CollapsibleTrigger className="sticky top-0 z-10 flex w-full items-center gap-2 border-b bg-muted/60 px-3 py-1.5 text-xs font-medium backdrop-blur">
              <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} aria-hidden />
              <Icon className={cn("size-3.5", style.text)} aria-hidden />
              {style.label}
              <span className="text-muted-foreground">{group.pairs.length}</span>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <ul className="divide-y border-b">
                {group.pairs.map((pair) => (
                  <Row
                    key={pair.key}
                    pair={pair}
                    selected={pair.key === selectedKey}
                    onSelect={() => onSelect(pair.key)}
                    actions={actions}
                    detail={pair.key === selectedKey ? detail(pair) : null}
                  />
                ))}
              </ul>
            </CollapsibleContent>
          </Collapsible>
        );
      })}
    </div>
  );
}
