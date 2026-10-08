import { CopyButton } from "@/components/copy-button";
import { cn } from "@/lib/utils";

/** Monospace block with a copy button; `prompt` prefixes a `$` that is not part of the copied text. */
export function CodeBlock({ code, prompt = false, className }: { code: string; prompt?: boolean; className?: string }) {
  return (
    <div className={cn("group relative rounded-md border bg-muted/50", className)}>
      <pre className="overflow-x-auto p-3 pr-11 font-mono text-xs leading-relaxed">
        {prompt && <span aria-hidden className="select-none text-muted-foreground">$ </span>}
        <code>{code}</code>
      </pre>
      <CopyButton value={code} className="absolute right-1.5 top-1.5 bg-background/70 backdrop-blur-sm" />
    </div>
  );
}
