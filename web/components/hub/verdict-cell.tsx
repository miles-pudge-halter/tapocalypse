import { AlertTriangle, CheckCircle2, CircleDashed, Contrast, Octagon, XCircle, type LucideIcon } from "lucide-react";
import type { ComponentProps } from "react";

import type { Verdict } from "@/lib/api";
import { cn } from "@/lib/utils";

interface CellStyle {
  icon: LucideIcon;
  word: string;
  className: string;
}

const NO_VERDICT: CellStyle = { icon: CircleDashed, word: "No verdict", className: "bg-stone-500/10 text-stone-700 dark:text-stone-300" };

const STYLES: Record<Verdict, CellStyle> = {
  PASS: { icon: CheckCircle2, word: "Pass", className: "bg-emerald-500/15 text-emerald-800 dark:text-emerald-300" },
  FAIL: { icon: XCircle, word: "Fail", className: "bg-red-500/15 text-red-800 dark:text-red-300" },
  "PASS WITH ISSUES": { icon: AlertTriangle, word: "Issues", className: "bg-orange-500/15 text-orange-800 dark:text-orange-300" },
  BLOCKED: { icon: Octagon, word: "Blocked", className: "bg-rose-500/15 text-rose-800 dark:text-rose-300" },
  PARTIAL: { icon: Contrast, word: "Partial", className: "border border-orange-400 bg-transparent text-orange-700 dark:text-orange-400" },
};

/** Short word for a verdict ("Pass", "Issues", "No verdict"), as printed inside `VerdictCell`. */
export function verdictWord(verdict: Verdict | null): string {
  return (verdict ? STYLES[verdict] : NO_VERDICT).word;
}

/** One cell of a results grid: tinted fill, an icon and a short word (shape and word stay the second channel next to colour). */
export function VerdictCell({
  verdict,
  attempts,
  size,
  label,
  className,
  as: Tag = "span",
  ...rest
}: {
  verdict: Verdict | null;
  attempts?: number;
  size: "sm" | "md";
  /** Prepended to the word ("Pixel 8 · "). */
  label?: string;
  as?: "button" | "span";
} & Omit<ComponentProps<"span">, "children">) {
  const style = verdict ? STYLES[verdict] : NO_VERDICT;
  const Icon = style.icon;
  const folded = attempts !== undefined && attempts > 1;
  const common = cn(
    "inline-flex items-center gap-1 rounded-md font-medium tabular-nums",
    size === "sm" ? "h-5 px-1.5 text-[11px]" : "h-8 min-w-20 justify-center px-2 text-xs",
    style.className,
    Tag === "button" && "outline-none hover:brightness-95 focus-visible:ring-2 focus-visible:ring-ring dark:hover:brightness-110",
    className,
  );
  const body = (
    <>
      <Icon className={cn("shrink-0", size === "sm" ? "size-3" : "size-3.5")} aria-hidden />
      <span className="truncate">
        {label ? `${label} · ` : ""}
        {style.word}
      </span>
      {folded && <span className="text-[10px] opacity-70">×{attempts}</span>}
    </>
  );
  const aria = `${style.word}${folded ? `, ${attempts} runs` : ""}`;
  if (Tag === "button") {
    return (
      <button type="button" {...(rest as ComponentProps<"button">)} aria-label={(rest["aria-label"] as string | undefined) ?? aria} className={common}>
        {body}
      </button>
    );
  }
  return (
    <span {...rest} aria-label={rest["aria-label"] ?? aria} className={common}>
      {body}
    </span>
  );
}
