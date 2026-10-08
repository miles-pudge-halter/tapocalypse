import {
  AlertOctagon,
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  CircleDot,
  Contrast,
  Loader2,
  Octagon,
  Power,
  Slash,
  XCircle,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { RunStatus, Verdict } from "@/lib/api";
import { cn } from "@/lib/utils";

interface IconStyle {
  icon: LucideIcon;
  tone: string;
  label: string;
}

const STATUS: Record<RunStatus, IconStyle> = {
  queued: { icon: CircleDashed, tone: "text-muted-foreground", label: "Queued" },
  preflight: { icon: Loader2, tone: "animate-spin text-blue-500", label: "Preparing" },
  running: { icon: Zap, tone: "text-blue-500 motion-safe:animate-bolt-flicker", label: "Running" },
  finishing: { icon: CircleDot, tone: "animate-pulse text-violet-500", label: "Writing report" },
  done: { icon: CheckCircle2, tone: "text-muted-foreground", label: "Done" },
  error: { icon: AlertOctagon, tone: "text-red-500", label: "Error" },
  cancelled: { icon: Slash, tone: "text-muted-foreground", label: "Cancelled" },
  interrupted: { icon: Power, tone: "text-orange-500", label: "Interrupted" },
};

const VERDICT: Record<Verdict, IconStyle> = {
  PASS: { icon: CheckCircle2, tone: "text-emerald-500", label: "PASS" },
  "PASS WITH ISSUES": { icon: AlertTriangle, tone: "text-orange-500", label: "PASS WITH ISSUES" },
  FAIL: { icon: XCircle, tone: "text-red-500", label: "FAIL" },
  BLOCKED: { icon: Octagon, tone: "text-rose-800 dark:text-rose-500", label: "BLOCKED" },
  PARTIAL: { icon: Contrast, tone: "text-orange-500", label: "PARTIAL" },
};

/** One glyph per run state; a finished run shows its verdict instead of the generic "done". */
export function RunStatusIcon({
  status,
  verdict,
  className,
}: {
  status: RunStatus;
  verdict: Verdict | null;
  className?: string;
}) {
  const style = status === "done" && verdict ? VERDICT[verdict] : STATUS[status];
  const Icon = style.icon;
  return <Icon role="img" aria-label={style.label} className={cn("size-4 shrink-0", style.tone, className)} />;
}
