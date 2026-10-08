import { Ban, CheckCircle2, Circle, Loader2, SkipForward, XCircle, type LucideIcon } from "lucide-react";
import type { CheckStatus } from "@/lib/api";
import { cn } from "@/lib/utils";

const ICONS: Record<CheckStatus, { icon: LucideIcon; className: string }> = {
  pending: { icon: Circle, className: "text-muted-foreground" },
  running: { icon: Loader2, className: "animate-spin text-blue-500" },
  pass: { icon: CheckCircle2, className: "text-emerald-500" },
  fail: { icon: XCircle, className: "text-red-500" },
  blocked: { icon: Ban, className: "text-rose-500" },
  skipped: { icon: SkipForward, className: "text-muted-foreground" },
};

export function CheckStatusIcon({ status, className }: { status: CheckStatus; className?: string }) {
  const { icon: Icon, className: tone } = ICONS[status];
  return <Icon aria-label={status} className={cn("size-4 shrink-0", tone, className)} />;
}
