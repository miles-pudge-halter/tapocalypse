import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const RESET_MS = 1500;

export function CopyButton({ value, label, className }: { value: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      toast.error("Could not copy to the clipboard");
      return;
    }
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), RESET_MS);
  };

  const Icon = copied ? Check : Copy;
  return (
    <Button
      type="button"
      variant="ghost"
      size={label ? "sm" : "icon"}
      aria-label={label ?? "Copy to clipboard"}
      onClick={() => void copy()}
      className={cn(label ? "h-7 gap-1.5 px-2" : "size-7", className)}
    >
      <Icon className={cn("size-3.5", copied && "text-emerald-500")} />
      {label && <span>{copied ? "Copied" : label}</span>}
    </Button>
  );
}
