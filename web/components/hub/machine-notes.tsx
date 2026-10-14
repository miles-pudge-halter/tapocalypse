import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { HubMachine } from "@/lib/api";
import { machineNotes } from "@/lib/hub";

/** Chips for a machine row: revoked token, clock skew, idle. Nothing for a healthy machine. */
export function MachineNotes({ machine, now }: { machine: HubMachine; now: number }) {
  const notes = machineNotes(machine, now);
  if (!notes.revoked && !notes.skew && !notes.idle) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="flex flex-wrap items-center gap-1.5 text-xs">
      {notes.revoked && <span className="rounded-md border px-1 text-[10px]">token revoked</span>}
      {notes.skew && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="text-orange-700 dark:text-orange-400">{notes.skew}</span>
          </TooltipTrigger>
          <TooltipContent>Run times from this machine may be out of order on the hub.</TooltipContent>
        </Tooltip>
      )}
      {notes.idle && <span className="text-muted-foreground">idle</span>}
    </span>
  );
}
