import { useEffect, useState } from "react";
import { Smartphone } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { screenUrl } from "@/lib/api";
import { cn } from "@/lib/utils";

const POLL_MS = 3000;
const SIZES = { sm: "w-24", md: "w-40", lg: "w-64" } as const;

/** Preloads each frame off-screen and only swaps `src` once it has loaded, so the screen never flickers. */
function useScreenSrc(serial: string | null, live: boolean): { src: string | null; failed: boolean } {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setSrc(null);
    setFailed(false);
    if (!serial) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      const url = screenUrl(serial, Date.now());
      const img = new Image();
      img.onload = () => {
        if (cancelled) return;
        setSrc(url);
        setFailed(false);
        if (live) timer = setTimeout(load, POLL_MS);
      };
      img.onerror = () => {
        if (cancelled) return;
        setFailed(true);
        if (live) timer = setTimeout(load, POLL_MS);
      };
      img.src = url;
    };
    load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [serial, live]);

  return { src, failed };
}

export function DeviceFrame({
  serial,
  live,
  className,
  size = "md",
}: {
  serial: string | null;
  live: boolean;
  className?: string;
  size?: keyof typeof SIZES;
}) {
  const { src, failed } = useScreenSrc(serial, live);
  return (
    <div
      className={cn(
        "relative aspect-[9/19] shrink-0 overflow-hidden rounded-[1.5rem] bg-zinc-950 p-1.5 ring-2 ring-zinc-800 dark:ring-zinc-700",
        SIZES[size],
        className,
      )}
    >
      <div className="absolute left-1/2 top-2 z-10 h-1.5 w-1/4 -translate-x-1/2 rounded-full bg-zinc-800" />
      <div className="relative size-full overflow-hidden rounded-[1.1rem] bg-zinc-900">
        {!serial ? (
          <div className="flex size-full flex-col items-center justify-center gap-1 text-zinc-500">
            <Smartphone className="size-5" />
            <span className="text-[10px]">No device</span>
          </div>
        ) : src ? (
          <img src={src} alt={`Screen of ${serial}`} className="size-full object-cover object-top" />
        ) : failed ? (
          <div className="flex size-full items-center justify-center px-2 text-center text-[10px] text-zinc-500">
            Screen unavailable
          </div>
        ) : (
          <Skeleton className="size-full rounded-none bg-zinc-800" />
        )}
      </div>
    </div>
  );
}
