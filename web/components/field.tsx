import { Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { Label } from "@/components/ui/label";

export function DetectedTag() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded border border-primary/40 bg-primary/15 px-1.5 py-px text-[10px] font-medium leading-none text-foreground dark:text-primary">
      <Sparkles className="size-2.5" />
      detected
    </span>
  );
}

export function FieldError({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} role="alert" className="text-xs text-destructive">
      {children}
    </p>
  );
}

/** Label, helper text and an inline error for one input; `id` is the input's id, hint/error get `<id>-hint` / `<id>-error`. */
export function Field({
  id,
  label,
  hint,
  error,
  detected,
  children,
}: {
  id: string;
  label: string;
  hint?: ReactNode;
  error?: string | undefined;
  detected?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Label htmlFor={id}>{label}</Label>
        {detected && <DetectedTag />}
      </div>
      {children}
      {hint && (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {error && <FieldError id={`${id}-error`}>{error}</FieldError>}
    </div>
  );
}
