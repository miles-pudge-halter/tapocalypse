import { ChevronLeft, ChevronRight, ExternalLink, X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface LightboxImage {
  src: string;
  caption?: string;
  /** Full-size link; defaults to `src`. */
  href?: string;
}

export function Lightbox({
  images,
  index,
  onIndexChange,
}: {
  images: LightboxImage[];
  index: number | null;
  onIndexChange: (i: number | null) => void;
}) {
  const [actualSize, setActualSize] = useState(false);
  const open = index !== null && index >= 0 && index < images.length;
  const current = open ? images[index] : null;
  const activeThumb = useRef<HTMLButtonElement | null>(null);

  // Each image starts fitted to the viewport.
  useEffect(() => setActualSize(false), [index]);
  useEffect(() => activeThumb.current?.scrollIntoView({ block: "nearest", inline: "center" }), [index]);

  const go = (delta: number) => {
    if (index === null || images.length < 2) return;
    onIndexChange((index + delta + images.length) % images.length);
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => !next && onIndexChange(null)}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/90 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed inset-0 z-50 flex flex-col outline-none"
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") {
              e.preventDefault();
              go(-1);
            } else if (e.key === "ArrowRight") {
              e.preventDefault();
              go(1);
            }
          }}
        >
          <DialogPrimitive.Title className="sr-only">Image viewer</DialogPrimitive.Title>
          <div className="flex items-center justify-between gap-3 px-4 py-3 text-sm text-white/80">
            <span className="tabular-nums">{open ? `${index + 1} / ${images.length}` : ""}</span>
            <span className="min-w-0 flex-1 truncate text-center text-white">{current?.caption}</span>
            <div className="flex items-center gap-1">
              {current && (
                <Button asChild variant="ghost" size="sm" className="text-white/80 hover:bg-white/10 hover:text-white">
                  <a href={current.href ?? current.src} target="_blank" rel="noreferrer">
                    <ExternalLink className="size-4" /> Open full size
                  </a>
                </Button>
              )}
              <DialogPrimitive.Close asChild>
                <Button variant="ghost" size="icon" aria-label="Close" className="text-white/80 hover:bg-white/10 hover:text-white">
                  <X className="size-5" />
                </Button>
              </DialogPrimitive.Close>
            </div>
          </div>

          <div className={cn("relative min-h-0 flex-1", actualSize ? "overflow-auto" : "flex items-center justify-center")}>
            {current && (
              <img
                src={current.src}
                alt={current.caption ?? ""}
                onClick={() => setActualSize((v) => !v)}
                className={cn(
                  "select-none",
                  actualSize ? "m-auto max-w-none cursor-zoom-out" : "max-h-full max-w-full cursor-zoom-in object-contain",
                )}
              />
            )}
            {images.length > 1 && (
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Previous image"
                  onClick={() => go(-1)}
                  className="fixed left-3 top-1/2 size-10 -translate-y-1/2 rounded-full bg-black/50 text-white hover:bg-black/70 hover:text-white"
                >
                  <ChevronLeft className="size-6" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Next image"
                  onClick={() => go(1)}
                  className="fixed right-3 top-1/2 size-10 -translate-y-1/2 rounded-full bg-black/50 text-white hover:bg-black/70 hover:text-white"
                >
                  <ChevronRight className="size-6" />
                </Button>
              </>
            )}
          </div>

          {images.length > 1 && (
            <div className="flex gap-2 overflow-x-auto px-4 py-3">
              {images.map((img, i) => (
                <button
                  key={`${img.src}-${i}`}
                  ref={i === index ? activeThumb : undefined}
                  type="button"
                  aria-label={img.caption ?? `Image ${i + 1}`}
                  onClick={() => onIndexChange(i)}
                  className={cn(
                    "h-16 w-10 shrink-0 overflow-hidden rounded border-2 bg-black opacity-60 transition hover:opacity-100",
                    i === index ? "border-white opacity-100" : "border-transparent",
                  )}
                >
                  <img src={img.src} alt="" loading="lazy" className="size-full object-contain" />
                </button>
              ))}
            </div>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
