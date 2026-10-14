import { LaptopMinimal } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { SidebarMenuButton } from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { HubMachine } from "@/lib/api";
import { formatRelative, formatTime } from "@/lib/format";
import { useHubMachines, useNow } from "@/lib/hooks";
import { displayPerson, machineNotes, machinesSummary } from "@/lib/hub";
import { cn } from "@/lib/utils";

function MachineRow({ machine, now }: { machine: HubMachine; now: number }) {
  const notes = machineNotes(machine, now);
  const person = displayPerson(machine.uploader);
  return (
    <li className={cn("space-y-0.5 px-3 py-2", notes.idle && "opacity-70")}>
      <div className="flex items-baseline gap-1">
        <span className="min-w-0 truncate font-mono text-xs">{machine.name}</span>
        {notes.idle && machine.lastUploadAt && <span className="shrink-0 text-xs text-muted-foreground">· idle</span>}
        <span className="ml-auto shrink-0 text-xs text-muted-foreground" title={machine.lastUploadAt ? formatTime(machine.lastUploadAt) : undefined}>
          {machine.lastUploadAt ? formatRelative(machine.lastUploadAt, now) : "never"}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
        <span title={machine.uploader ?? undefined}>
          {person ? `${person} · ` : ""}
          {machine.runs30d} runs in 30 days
        </span>
        {notes.revoked && <span className="rounded-md border px-1 text-[10px]">token revoked</span>}
        {notes.skew && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-orange-700 dark:text-orange-400">{notes.skew}</span>
            </TooltipTrigger>
            <TooltipContent>Run times from this machine may be out of order on the hub.</TooltipContent>
          </Tooltip>
        )}
      </div>
    </li>
  );
}

/** Sidebar footer item: "4 machines · 12m ago" with the per-machine list in a popover. */
export function MachinesNav() {
  const { machines, loading, error } = useHubMachines();
  const now = useNow(30_000);
  const summary = machinesSummary(machines, now);
  const label = error
    ? "Machines unavailable"
    : summary.count === 0 || !summary.lastUploadAt
      ? "No uploads yet"
      : `${summary.count} ${summary.count === 1 ? "machine" : "machines"} · ${formatRelative(summary.lastUploadAt, now)}`;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <SidebarMenuButton tooltip={label} className={cn(error && "text-muted-foreground")}>
          <span className="relative flex size-4 items-center justify-center">
            <LaptopMinimal />
            <span
              aria-hidden
              className={cn("absolute -right-0.5 -top-0.5 hidden size-1.5 rounded-full group-data-[collapsible=icon]:block", summary.recent ? "bg-emerald-500" : "bg-stone-400")}
            />
          </span>
          {loading ? <Skeleton className="h-4 w-24" /> : <span>{label}</span>}
        </SidebarMenuButton>
      </PopoverTrigger>
      <PopoverContent side="right" align="end" className="w-80 p-0">
        <div className="border-b px-3 py-2">
          <p className="text-sm font-medium">Machines uploading to this hub</p>
          <p className="text-xs text-muted-foreground">Updated live.</p>
        </div>
        {error ? (
          <div className="p-3">
            <Alert variant="destructive">
              <AlertTitle>Could not load machines</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          </div>
        ) : summary.count === 0 ? (
          <p className="px-3 py-4 text-sm text-muted-foreground">No machine has uploaded yet. Teammates connect from Setup on their own Tapocalypse.</p>
        ) : (
          <ul className="max-h-72 divide-y overflow-y-auto">
            {summary.sorted.map((m) => (
              <MachineRow key={m.name} machine={m} now={now} />
            ))}
          </ul>
        )}
        <div className="border-t px-3 py-2">
          <Button asChild variant="link" size="xs" className="h-auto p-0">
            <a href="#/about">About this hub</a>
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
