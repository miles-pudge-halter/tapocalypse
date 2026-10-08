import { Badge } from "@/components/ui/badge";
import type { Verdict } from "@/lib/api";
import { cn } from "@/lib/utils";

const STYLES: Record<Verdict, string> = {
  PASS: "border-transparent bg-emerald-600 text-white dark:bg-emerald-500 dark:text-emerald-950",
  FAIL: "border-transparent bg-red-600 text-white dark:bg-red-500 dark:text-red-950",
  "PASS WITH ISSUES": "border-transparent bg-amber-500 text-amber-950",
  BLOCKED: "border-transparent bg-rose-900 text-rose-50 dark:bg-rose-800",
  PARTIAL: "border-amber-500 bg-transparent text-amber-700 dark:text-amber-400",
};

export function VerdictBadge({ verdict, className }: { verdict: Verdict | null; className?: string }) {
  if (!verdict) return null;
  return <Badge className={cn("font-semibold", STYLES[verdict], className)}>{verdict}</Badge>;
}
