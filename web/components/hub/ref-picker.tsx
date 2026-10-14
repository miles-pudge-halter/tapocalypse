import { Check, ChevronDown, GitBranch, Layers, Tag, type LucideIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import type { Ref, RefSummary } from "@/lib/api";
import { formatRelative } from "@/lib/format";
import { useNow, useRefs } from "@/lib/hooks";
import { groupRefs } from "@/lib/hub";
import { cn } from "@/lib/utils";

const sameRef = (a: Ref | null, b: Ref | null) => a?.kind === b?.kind && a?.name === b?.name;

function RefItem({ summary, current, now, onPick }: { summary: RefSummary; current: Ref | null; now: number; onPick(ref: Ref): void }) {
  const Icon = summary.ref.kind === "version" ? Tag : GitBranch;
  return (
    <CommandItem value={`${summary.ref.kind}:${summary.ref.name}`} onSelect={() => onPick(summary.ref)} className="gap-2">
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className={cn("min-w-0 truncate", summary.ref.kind === "branch" && "font-mono text-xs")}>{summary.ref.name}</span>
      {summary.isDefaultBranch && (
        <Badge variant="secondary" className="h-4 px-1 text-[10px]">
          default
        </Badge>
      )}
      <span className="ml-auto shrink-0 text-xs text-muted-foreground">
        {summary.runs} runs · {formatRelative(summary.lastAt, now)}
      </span>
      {sameRef(current, summary.ref) && <Check className="size-3.5 shrink-0" />}
    </CommandItem>
  );
}

/** Scope picker: all branches, a version, or a branch. `releasesOnly` lists only releases (versions and release branches). */
export function RefPicker({
  projectId,
  value,
  allowAll,
  releasesOnly = false,
  onChange,
  trigger,
  extra,
  align = "end",
}: {
  projectId: string;
  value: Ref | null;
  allowAll: boolean;
  releasesOnly?: boolean;
  onChange(ref: Ref | null): void;
  /** Replaces the default trigger button (the release header uses a link-style one). */
  trigger?: ReactNode;
  /** An extra first item, e.g. "Automatic (previous release)". */
  extra?: { label: string; icon: LucideIcon; onSelect(): void };
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  const { refs, loading, error } = useRefs(projectId);
  const now = useNow(60_000);
  const groups = groupRefs(releasesOnly ? refs.filter((r) => r.release) : refs);
  const label = value ? value.name : "All branches";
  const TriggerIcon = value ? (value.kind === "version" ? Tag : GitBranch) : Layers;
  const pick = (ref: Ref | null) => {
    setOpen(false);
    onChange(ref);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {trigger ?? (
          <Button variant="outline" size="sm" className="max-w-64 gap-1.5" aria-label={`Scope: ${label}. Change`}>
            <TriggerIcon className="size-3.5 shrink-0" />
            <span className={cn("truncate", value?.kind === "branch" && "font-mono text-xs")}>{label}</span>
            <ChevronDown className="size-3.5 shrink-0 opacity-60" />
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent align={align} className="w-80 p-0">
        <Command>
          <CommandInput placeholder="Search versions and branches…" />
          <CommandList>
            {loading ? (
              <div className="space-y-1 p-2" aria-label="Loading versions and branches">
                <Skeleton className="h-8" />
                <Skeleton className="h-8" />
                <Skeleton className="h-8" />
              </div>
            ) : error ? (
              <CommandEmpty>Could not load versions and branches: {error}</CommandEmpty>
            ) : (
              <>
                <CommandEmpty>No versions or branches match.</CommandEmpty>
                {(allowAll || extra) && (
                  <CommandGroup>
                    {extra && (
                      <CommandItem value="automatic previous release" onSelect={() => { setOpen(false); extra.onSelect(); }} className="gap-2">
                        <extra.icon className="size-3.5 shrink-0 text-muted-foreground" />
                        {extra.label}
                      </CommandItem>
                    )}
                    {allowAll && (
                      <CommandItem value="all branches" onSelect={() => pick(null)} className="gap-2">
                        <Layers className="size-3.5 shrink-0 text-muted-foreground" />
                        All branches
                        {value === null && <Check className="ml-auto size-3.5" />}
                      </CommandItem>
                    )}
                  </CommandGroup>
                )}
                {groups.versions.length > 0 && (
                  <CommandGroup heading="Versions">
                    {groups.versions.map((r) => (
                      <RefItem key={`v:${r.ref.name}`} summary={r} current={value} now={now} onPick={pick} />
                    ))}
                  </CommandGroup>
                )}
                {groups.releaseBranches.length > 0 && (
                  <CommandGroup heading="Release branches">
                    {groups.releaseBranches.map((r) => (
                      <RefItem key={`b:${r.ref.name}`} summary={r} current={value} now={now} onPick={pick} />
                    ))}
                  </CommandGroup>
                )}
                {!releasesOnly && groups.branches.length > 0 && (
                  <CommandGroup heading="Branches">
                    {groups.branches.map((r) => (
                      <RefItem key={`b:${r.ref.name}`} summary={r} current={value} now={now} onPick={pick} />
                    ))}
                  </CommandGroup>
                )}
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
