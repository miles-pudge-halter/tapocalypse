import { ImageOff } from "lucide-react";
import { useState } from "react";

/** Small clickable screenshot preview; a missing file turns into a dashed "missing" tile. */
export function Thumb({ url, label, onOpen }: { url: string; label: string; onOpen: () => void }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div className="flex h-16 w-24 items-center justify-center gap-1 rounded-md border border-dashed text-[10px] text-muted-foreground">
        <ImageOff className="size-3.5" />
        missing
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Open screenshot: ${label}`}
      className="block overflow-hidden rounded-md border transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <img src={url} alt={label} loading="lazy" onError={() => setFailed(true)} className="h-auto max-h-40 w-24 object-contain object-top" />
    </button>
  );
}
