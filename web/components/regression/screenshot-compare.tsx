import { ChevronsLeftRight, ImageOff, Layers, Columns2, SplitSquareHorizontal } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import { Lightbox, type LightboxImage } from "@/components/lightbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Slider } from "@/components/ui/slider";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useShortcut } from "@/lib/hooks";
import { readStorage, writeStorage } from "@/lib/storage";
import { cn } from "@/lib/utils";

type Mode = "side" | "swipe" | "onion";

const MODE_KEY = "tapocalypse-compare-mode";
const MODES: { value: Mode; label: string; icon: typeof Columns2 }[] = [
  { value: "side", label: "Side by side", icon: Columns2 },
  { value: "swipe", label: "Swipe", icon: SplitSquareHorizontal },
  { value: "onion", label: "Onion skin", icon: Layers },
];
const KEY_STEP = 10;
const DEFAULT_RATIO = 9 / 19.5;
const RATIO_TOLERANCE = 0.02;
const BOX_MAX_VH = 60;

function isMode(value: string | null): value is Mode {
  return MODES.some((m) => m.value === value);
}

type ImageInfo = { state: "loading" } | { state: "none" } | { state: "error" } | { state: "ok"; w: number; h: number };

/** Preloads `url` once to learn whether it exists and how big it is. */
function useImageInfo(url: string | null): ImageInfo {
  const [info, setInfo] = useState<ImageInfo>(url ? { state: "loading" } : { state: "none" });
  useEffect(() => {
    if (!url) {
      setInfo({ state: "none" });
      return;
    }
    setInfo({ state: "loading" });
    const img = new Image();
    img.onload = () => setInfo({ state: "ok", w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => setInfo({ state: "error" });
    img.src = url;
    return () => {
      img.onload = null;
      img.onerror = null;
    };
  }, [url]);
  return info;
}

export interface CompareImage {
  url: string | null;
  /** Eyebrow, e.g. "Baseline · main · a1b2c3d". */
  eyebrow: string;
  /** Lightbox caption. */
  caption: string;
  /** Placeholder when there is no file at all. */
  missing: string;
}

function Placeholder({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn("flex min-h-40 flex-col items-center justify-center gap-1 rounded-md border border-dashed bg-muted/40 p-3 text-center text-xs text-muted-foreground", className)}>
      <ImageOff className="size-4" />
      {text}
    </div>
  );
}

/** Side by side / swipe / onion-skin view of two screenshots of the same check (baseline left, this run right). */
export function ScreenshotCompare({ baseline, current }: { baseline: CompareImage; current: CompareImage }) {
  const [mode, setMode] = useState<Mode>(() => {
    const stored = readStorage(MODE_KEY);
    return isMode(stored) ? stored : "side";
  });
  const [pos, setPos] = useState(50);
  const [alpha, setAlpha] = useState(50);
  const [lightbox, setLightbox] = useState<number | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const a = useImageInfo(baseline.url);
  const b = useImageInfo(current.url);
  const bothLoaded = a.state === "ok" && b.state === "ok";
  const effective: Mode = bothLoaded ? mode : "side";

  function choose(next: Mode) {
    if (next !== "side" && !bothLoaded) return;
    setMode(next);
    writeStorage(MODE_KEY, next);
  }
  useShortcut("1", () => choose("side"), [bothLoaded]);
  useShortcut("2", () => choose("swipe"), [bothLoaded]);
  useShortcut("3", () => choose("onion"), [bothLoaded]);
  useShortcut("[", () => (effective === "swipe" ? setPos((p) => Math.max(0, p - KEY_STEP)) : effective === "onion" ? setAlpha((p) => Math.max(0, p - KEY_STEP)) : undefined), [effective]);
  useShortcut("]", () => (effective === "swipe" ? setPos((p) => Math.min(100, p + KEY_STEP)) : effective === "onion" ? setAlpha((p) => Math.min(100, p + KEY_STEP)) : undefined), [effective]);

  if (a.state === "none" && b.state === "none") {
    return <p className="text-sm text-muted-foreground">Neither run saved a screenshot for this check.</p>;
  }
  if (a.state === "loading" || b.state === "loading") {
    return <Skeleton className="aspect-[9/19.5] max-h-[50vh] w-full" aria-label="Loading screenshots" />;
  }

  const ratio = b.state === "ok" ? b.w / b.h : a.state === "ok" ? a.w / a.h : DEFAULT_RATIO;
  const sizeMismatch = a.state === "ok" && b.state === "ok" && Math.abs(a.w / a.h - b.w / b.h) / (b.w / b.h) > RATIO_TOLERANCE;
  const lightboxImages: LightboxImage[] = [baseline, current].flatMap((img) => (img.url ? [{ src: img.url, caption: img.caption }] : []));
  const openAt = (img: CompareImage) => setLightbox(Math.max(0, lightboxImages.findIndex((l) => l.src === img.url)));

  function dragTo(e: ReactPointerEvent<HTMLDivElement>) {
    const rect = boxRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    setPos(Math.round(Math.min(100, Math.max(0, ((e.clientX - rect.left) / rect.width) * 100))));
  }

  const switcher = (
    <ToggleGroup type="single" variant="outline" size="sm" value={effective} onValueChange={(v) => isMode(v) && choose(v)} aria-label="Screenshot comparison mode" className="overflow-x-auto">
      {MODES.map((m) => {
        const disabled = m.value !== "side" && !bothLoaded;
        const item = (
          <ToggleGroupItem key={m.value} value={m.value} disabled={disabled} className="h-8 gap-1.5 px-2 text-xs">
            <m.icon />
            {m.label}
          </ToggleGroupItem>
        );
        return disabled ? (
          <Tooltip key={m.value}>
            <TooltipTrigger asChild>
              <span tabIndex={0}>{item}</span>
            </TooltipTrigger>
            <TooltipContent>Needs a screenshot from both runs</TooltipContent>
          </Tooltip>
        ) : (
          item
        );
      })}
    </ToggleGroup>
  );

  const side = (img: CompareImage, info: ImageInfo) => (
    <figure className="min-w-0 space-y-1">
      <figcaption className="truncate text-xs text-muted-foreground" title={img.eyebrow}>
        {img.eyebrow}
      </figcaption>
      {info.state === "ok" && img.url ? (
        <button type="button" onClick={() => openAt(img)} className="block w-full rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`Open screenshot: ${img.caption}`}>
          <img src={img.url} alt={img.caption} className="max-h-[50vh] w-full rounded-md border bg-muted/40 object-contain object-top xl:max-h-[60vh]" />
        </button>
      ) : (
        <Placeholder text={info.state === "error" ? "Screenshot missing" : img.missing} />
      )}
    </figure>
  );

  return (
    <div className="space-y-2">
      {switcher}
      {effective === "side" ? (
        <div className="grid grid-cols-2 gap-2">
          {side(baseline, a)}
          {side(current, b)}
        </div>
      ) : (
        <>
          <div
            ref={boxRef}
            className={cn("relative mx-auto select-none overflow-hidden rounded-md border bg-muted/40", effective === "swipe" && "cursor-ew-resize touch-none")}
            style={{ aspectRatio: String(ratio), width: `min(100%, ${(ratio * BOX_MAX_VH).toFixed(2)}vh)` }}
            onPointerDown={(e) => {
              if (effective !== "swipe") return;
              e.currentTarget.setPointerCapture(e.pointerId);
              dragTo(e);
            }}
            onPointerMove={(e) => {
              if (effective === "swipe" && e.currentTarget.hasPointerCapture(e.pointerId)) dragTo(e);
            }}
          >
            <img src={baseline.url ?? undefined} alt={baseline.caption} draggable={false} className="absolute inset-0 size-full object-contain object-top" />
            <img
              src={current.url ?? undefined}
              alt={current.caption}
              draggable={false}
              className="absolute inset-0 size-full object-contain object-top"
              style={effective === "swipe" ? { clipPath: `inset(0 0 0 ${pos}%)` } : { opacity: alpha / 100 }}
            />
            {effective === "swipe" ? (
              <div aria-hidden className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-background shadow-[0_0_0_1px_color-mix(in_oklab,var(--foreground)_20%,transparent)]" style={{ left: `${pos}%` }}>
                <span className="absolute left-1/2 top-1/2 flex size-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border bg-background shadow-sm">
                  <ChevronsLeftRight className="size-4" />
                </span>
              </div>
            ) : null}
            <span className="pointer-events-none absolute left-1.5 top-1.5 rounded bg-background/80 px-1.5 text-[10px] font-medium">Baseline</span>
            <span className="pointer-events-none absolute right-1.5 top-1.5 rounded bg-background/80 px-1.5 text-[10px] font-medium">This run</span>
          </div>
          <div className="mx-auto flex items-center gap-3" style={{ width: `min(100%, ${(ratio * BOX_MAX_VH).toFixed(2)}vh)` }}>
            {effective === "swipe" ? (
              <Slider min={0} max={100} step={1} value={[pos]} onValueChange={([v]) => setPos(v ?? 50)} aria-label="Swipe position" />
            ) : (
              <>
                <Slider min={0} max={100} step={1} value={[alpha]} onValueChange={([v]) => setAlpha(v ?? 50)} aria-label="Onion skin opacity" />
                <span className="w-24 shrink-0 text-xs tabular-nums text-muted-foreground">This run {alpha}%</span>
              </>
            )}
          </div>
        </>
      )}
      {sizeMismatch && a.state === "ok" && b.state === "ok" && effective !== "side" ? (
        <p className="text-xs text-muted-foreground">
          Screens differ in size ({a.w}×{a.h} vs {b.w}×{b.h}). The overlay is scaled to fit and may not line up.
        </p>
      ) : null}
      <Lightbox images={lightboxImages} index={lightbox} onIndexChange={setLightbox} />
    </div>
  );
}
