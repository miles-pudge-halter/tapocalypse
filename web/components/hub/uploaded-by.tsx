import { LaptopMinimal } from "lucide-react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { HubAttribution } from "@/lib/api";
import { formatRelative } from "@/lib/format";
import { attribution, briefAttribution } from "@/lib/hub";
import { useNow } from "@/lib/hooks";
import { cn } from "@/lib/utils";

/** "by Ann on ann-mbp" with the full identity in a tooltip. Renders nothing without a hub origin, so it is safe on laptops. */
export function UploadedBy({ hub, className, withTime = false }: { hub: HubAttribution | null | undefined; className?: string; withTime?: boolean }) {
  const now = useNow(30_000);
  if (!hub) return null;
  const { short, long } = attribution(hub);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn("inline-flex min-w-0 items-center gap-1", className)}>
          <LaptopMinimal className="size-3 shrink-0 opacity-70" aria-hidden />
          <span className="truncate">
            {short}
            {withTime && ` · uploaded ${formatRelative(hub.receivedAt, now)}`}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent>{long}</TooltipContent>
    </Tooltip>
  );
}

/** "by Ann" (or "from ann-mbp") for the brief runs of the overview and release pages; the machine goes into the tooltip. */
export function UploadedByBrief({ machine, uploader, className }: { machine: string | null; uploader: string | null; className?: string }) {
  const brief = briefAttribution(machine, uploader);
  if (!brief) return null;
  return (
    <span className={className} title={brief.title}>
      {brief.text}
    </span>
  );
}
