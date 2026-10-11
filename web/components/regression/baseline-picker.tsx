import { Check, RotateCcw } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { VERDICT_DOT } from "@/components/verdict-badge";
import { RunStatusIcon } from "@/components/run-status-icon";
import { isActive, type BaselineCandidate, type RunView } from "@/lib/api";
import { formatRelative } from "@/lib/format";
import { useBaselineCandidates, useNow, useShortcut } from "@/lib/hooks";
import { cn } from "@/lib/utils";

const SEARCH_DEBOUNCE_MS = 250;
const SHORT_SHA = 7;

const GROUPS: BaselineCandidate["group"][] = ["suggested", "branch", "base", "test", "other"];

function groupHeading(group: BaselineCandidate["group"], baseBranch: string): string {
  switch (group) {
    case "suggested":
      return "Suggested";
    case "branch":
      return "Same branch";
    case "base":
      return `Base branch (${baseBranch})`;
    case "test":
      return "Other runs of this test";
    case "other":
      return "Other runs in this project";
  }
}

function platformLabel(run: RunView): string {
  return run.deviceRequest.platform === "ios" ? "iOS" : "Android";
}

function CandidateItem({ candidate, selected, now, onPick }: { candidate: BaselineCandidate; selected: boolean; now: number; onPick(): void }) {
  const { run } = candidate;
  const meta = [run.source?.branch, run.source?.commit?.slice(0, SHORT_SHA), run.deviceName, formatRelative(run.createdAt, now)].filter(Boolean).join(" · ");
  return (
    <CommandItem value={run.id} onSelect={onPick} className="items-start gap-2">
      {isActive(run.status) ? (
        <RunStatusIcon status={run.status} verdict={run.verdict} className="mt-0.5 size-3.5" />
      ) : (
        <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", run.verdict ? VERDICT_DOT[run.verdict] : "bg-muted-foreground/40")} />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{run.title}</span>
        <span className="block truncate text-xs text-muted-foreground">{meta}</span>
        {candidate.suggested && candidate.reason ? <span className="block text-xs text-muted-foreground">{candidate.reason}</span> : null}
      </span>
      {candidate.platformMismatch ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="shrink-0 text-xs font-medium text-orange-700 dark:text-orange-400">{platformLabel(run)}</span>
          </TooltipTrigger>
          <TooltipContent>Different platform</TooltipContent>
        </Tooltip>
      ) : null}
      {selected ? <Check className="mt-0.5 size-4 shrink-0" aria-label="Current baseline" /> : null}
    </CommandItem>
  );
}

/**
 * Popover to pick the run a run is compared with. `onPick(null)` resets to the automatic baseline (offered only when
 * `manual`). Controlled by `open`. With `shortcut`, the `b` key opens it while it is mounted: the key lives with the
 * control, so it never queues an open for a picker that is not on screen yet (loading strip) and pops it up later.
 */
export function BaselinePicker({
  runId,
  selectedId,
  manual,
  baseBranch,
  open,
  onOpenChange,
  onPick,
  shortcut = false,
  children,
}: {
  runId: string;
  selectedId: string | null;
  manual: boolean;
  baseBranch: string;
  open: boolean;
  onOpenChange(open: boolean): void;
  onPick(id: string | null): void;
  /** Opens the picker on the `b` key. At most one mounted picker per page sets it. */
  shortcut?: boolean;
  children: ReactNode;
}) {
  useShortcut("b", () => shortcut && onOpenChange(true), [shortcut, onOpenChange]);
  const [input, setInput] = useState("");
  const [q, setQ] = useState("");
  const now = useNow(60_000);
  useEffect(() => {
    const timer = setTimeout(() => setQ(input.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [input]);
  const { candidates, loading, error } = useBaselineCandidates(runId, q, open);
  const shown = candidates.filter((c) => c.run.id !== runId);

  function pick(id: string | null) {
    onPick(id);
    onOpenChange(false);
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="start" className="w-[26rem] max-w-[calc(100vw-2rem)] p-0">
        <Command shouldFilter={false}>
          <CommandInput placeholder="Search runs by title, branch, commit, PR…" value={input} onValueChange={setInput} />
          <CommandList>
            {loading && shown.length === 0 ? (
              <div className="space-y-1 p-2" aria-busy="true" aria-label="Loading runs">
                {Array.from({ length: 3 }, (_, i) => (
                  <Skeleton key={i} className="h-8 w-full" />
                ))}
              </div>
            ) : error ? (
              <CommandEmpty>Could not load runs: {error}</CommandEmpty>
            ) : shown.length === 0 ? (
              <CommandEmpty>{q ? `No runs match “${q}”.` : "No other finished runs in this project."}</CommandEmpty>
            ) : (
              GROUPS.map((group) => {
                const items = shown.filter((c) => (group === "suggested" ? c.suggested : !c.suggested && c.group === group));
                if (items.length === 0) return null;
                return (
                  <CommandGroup key={group} heading={groupHeading(group, baseBranch)}>
                    {items.map((c) => (
                      <CandidateItem key={c.run.id} candidate={c} selected={c.run.id === selectedId} now={now} onPick={() => pick(c.run.id)} />
                    ))}
                  </CommandGroup>
                );
              })
            )}
            {manual ? (
              <>
                <CommandSeparator />
                <CommandGroup>
                  <CommandItem value="reset-to-automatic" onSelect={() => pick(null)}>
                    <RotateCcw />
                    Reset to automatic
                  </CommandItem>
                </CommandGroup>
              </>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
