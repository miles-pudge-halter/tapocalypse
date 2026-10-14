import { Users } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** "Team hub" identity badge (brand amber tint: identity, not status). */
export function TeamHubBadge({ className }: { className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="outline"
          className={cn("h-4 shrink-0 gap-0.5 rounded border-primary/40 bg-primary/15 px-1 text-[10px] font-medium text-foreground dark:text-primary", className)}
        >
          <Users className="size-2.5" aria-hidden />
          Team hub
        </Badge>
      </TooltipTrigger>
      <TooltipContent>You're viewing the team hub: a read-only copy of runs uploaded from teammates' machines.</TooltipContent>
    </Tooltip>
  );
}
