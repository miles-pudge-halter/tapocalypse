import { Badge } from "@/components/ui/badge";
import type { RunStatus } from "@/lib/api";
import { isActive } from "@/lib/api";
import { cn } from "@/lib/utils";

const STYLES: Record<RunStatus, { badge: string; dot: string }> = {
  queued: {
    badge: "border-slate-500/30 bg-slate-500/10 text-slate-700 dark:text-slate-300",
    dot: "bg-slate-500",
  },
  preflight: {
    badge: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300",
    dot: "bg-blue-500",
  },
  running: {
    badge: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300",
    dot: "bg-blue-500",
  },
  finishing: {
    badge: "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300",
    dot: "bg-violet-500",
  },
  done: {
    badge: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    dot: "bg-emerald-500",
  },
  error: {
    badge: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
    dot: "bg-red-500",
  },
  cancelled: {
    badge: "border-stone-500/30 bg-stone-500/10 text-stone-700 dark:text-stone-300",
    dot: "bg-stone-500",
  },
  interrupted: {
    badge: "border-orange-500/30 bg-orange-500/10 text-orange-800 dark:text-orange-300",
    dot: "bg-orange-400",
  },
};

export function StatusBadge({ status, className }: { status: RunStatus; className?: string }) {
  const style = STYLES[status];
  return (
    <Badge variant="outline" className={cn("capitalize", style.badge, className)}>
      <span className="relative flex size-2">
        {isActive(status) && (
          <span className={cn("absolute inline-flex size-full animate-ping rounded-full opacity-60", style.dot)} />
        )}
        <span className={cn("relative inline-flex size-2 rounded-full", style.dot)} />
      </span>
      {status}
    </Badge>
  );
}
