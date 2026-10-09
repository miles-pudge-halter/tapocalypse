import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Smartphone, Tablet, Tv, Watch, type LucideIcon } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { screenUrl, type Device } from "@/lib/api";
import { cn } from "@/lib/utils";

type DeviceType = Device["deviceType"];

const POLL_MS = 3000;
const MIN_ASPECT = 0.25;
const MAX_ASPECT = 4;
const SCREEN_RE = /^(\d+)\s*[×x]\s*(\d+)$/;

export const DEFAULT_ASPECT: Record<DeviceType, number> = {
  phone: 9 / 19.5,
  tablet: 3 / 4,
  watch: 410 / 502,
  tv: 16 / 9,
  unknown: 9 / 19.5,
};

/** Widths per size: a portrait frame is narrow, a landscape one (tablet, TV, rotated phone) is wider. */
const WIDTH: Record<"sm" | "tile", { portrait: string; landscape: string }> = {
  sm: { portrait: "w-24", landscape: "w-40" },
  tile: { portrait: "w-[120px]", landscape: "w-40" },
};

export const TYPE_ICON: Record<DeviceType, LucideIcon> = {
  phone: Smartphone,
  tablet: Tablet,
  watch: Watch,
  tv: Tv,
  unknown: Smartphone,
};

/** Hardware per device type; every radius and bezel is a multiple of `--u` (1% of the short side). */
const CHROME: Record<DeviceType, { body: string; bezel: string; screen: string }> = {
  phone: {
    body: "",
    bezel: "rounded-[calc(var(--u)*17)] p-[max(4px,calc(var(--u)*3))]",
    screen: "rounded-[calc(var(--u)*14)]",
  },
  tablet: {
    body: "",
    bezel: "rounded-[calc(var(--u)*7)] p-[max(5px,calc(var(--u)*4))]",
    screen: "rounded-[calc(var(--u)*3)]",
  },
  watch: {
    body: "mr-[calc(var(--u)*5)]",
    bezel: "rounded-[calc(var(--u)*26)] p-[max(4px,calc(var(--u)*5))]",
    screen: "rounded-[calc(var(--u)*21)]",
  },
  tv: {
    body: "",
    bezel: "rounded-[calc(var(--u)*2.5)] p-[max(3px,calc(var(--u)*2))]",
    screen: "rounded-[calc(var(--u)*1)]",
  },
  unknown: {
    body: "",
    bezel: "rounded-[calc(var(--u)*10)] p-[max(4px,calc(var(--u)*3))]",
    screen: "rounded-[calc(var(--u)*7)]",
  },
};

const inRange = (a: number | null): a is number => a !== null && Number.isFinite(a) && a >= MIN_ASPECT && a <= MAX_ASPECT;

/** Natural image size, then the reported screen, then the type default. Out-of-range candidates fall through. */
export function deviceAspect(type: DeviceType, screen: string | null, natural: number | null): number {
  const match = screen ? SCREEN_RE.exec(screen) : null;
  const fromScreen = match ? Number(match[1]) / Number(match[2]) : null;
  return [natural, fromScreen].find(inRange) ?? DEFAULT_ASPECT[type];
}

/** Draws only the hardware; `children` is the screen content and always fills the screen. Needs an explicit width. */
export function DeviceChrome({
  deviceType,
  platform,
  aspect,
  className,
  style,
  children,
}: {
  deviceType: DeviceType;
  platform: Device["platform"];
  aspect: number;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const C = CHROME[deviceType];
  const watch = deviceType === "watch";
  const round = watch && Math.abs(aspect - 1) < 0.03;
  // Only tall, edge-to-edge phones (≤ 1:2) have a notch or punch-hole; 16:9 phones with a forehead/home button do not.
  const portraitPhone = deviceType === "phone" && aspect <= 0.5;
  const vars: CSSProperties & Record<"--u", string> = { ...style, "--u": aspect > 1 ? `calc(1cqw / ${aspect})` : "1cqw" };
  return (
    <div className={cn("@container shrink-0", className)} style={vars}>
      <div className={cn("relative", C.body)}>
        <div className={cn("relative bg-zinc-950 ring-2 ring-zinc-800 dark:ring-zinc-700", C.bezel, round && "rounded-full")}>
          <div
            data-part="screen"
            className={cn("relative overflow-hidden bg-zinc-900", C.screen, round && "rounded-full")}
            style={{ aspectRatio: aspect }}
          >
            {portraitPhone && platform === "ios" ? (
              <div
                data-part="notch"
                className="absolute left-1/2 top-[calc(var(--u)*3.5)] z-10 h-[calc(var(--u)*8)] w-[30%] -translate-x-1/2 rounded-full bg-zinc-950"
              />
            ) : null}
            {portraitPhone && platform !== "ios" ? (
              <div
                data-part="punch"
                className="absolute left-1/2 top-[calc(var(--u)*3)] z-10 size-[calc(var(--u)*5)] -translate-x-1/2 rounded-full bg-zinc-950"
              />
            ) : null}
            {children}
          </div>
        </div>
        {watch ? (
          <>
            <div
              data-part="crown"
              className="absolute left-full top-[22%] h-[18%] w-[calc(var(--u)*4)] rounded-r-[calc(var(--u)*2)] bg-zinc-800 dark:bg-zinc-700"
            />
            <div
              data-part="side-button"
              className="absolute left-full top-[48%] h-[12%] w-[calc(var(--u)*2.5)] rounded-r-[calc(var(--u)*1)] bg-zinc-800 dark:bg-zinc-700"
            />
          </>
        ) : null}
      </div>
      {deviceType === "tv" ? (
        <div data-part="stand" className="mx-auto h-[calc(var(--u)*5)] w-[30%] rounded-b-[calc(var(--u)*2)] bg-zinc-800 dark:bg-zinc-700" />
      ) : null}
    </div>
  );
}

/** Preloads each frame off-screen and only swaps `src` once it has loaded, so the screen never flickers. */
function useScreenSrc(serial: string | null, live: boolean): { src: string | null; failed: boolean; aspect: number | null } {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [aspect, setAspect] = useState<number | null>(null);

  // Only a new device invalidates the last frame; a `live` flip just starts or stops polling.
  useEffect(() => {
    setSrc(null);
    setFailed(false);
    setAspect(null);
  }, [serial]);

  useEffect(() => {
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
        setAspect(img.naturalWidth / img.naturalHeight);
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

  return { src, failed, aspect };
}

export function DeviceFrame({
  serial,
  live,
  device,
  platform,
  size,
}: {
  serial: string | null;
  live: boolean;
  device: Pick<Device, "deviceType" | "screen"> | null | undefined;
  platform: Device["platform"];
  size: "sm" | "tile";
}) {
  const { src, failed, aspect: natural } = useScreenSrc(serial, live);
  const deviceType = device?.deviceType ?? "unknown";
  const aspect = deviceAspect(deviceType, device?.screen ?? null, natural);
  const Icon = TYPE_ICON[deviceType];
  return (
    <DeviceChrome
      deviceType={deviceType}
      platform={platform}
      aspect={aspect}
      className={aspect > 1 ? WIDTH[size].landscape : WIDTH[size].portrait}
    >
      {!serial ? (
        <div className="flex size-full flex-col items-center justify-center gap-1 text-zinc-500">
          <Icon className="size-5" />
          <span className="text-[10px]">No device</span>
        </div>
      ) : src ? (
        <img src={src} alt={`Screen of ${serial}`} className="size-full object-contain" />
      ) : failed ? (
        <div className="flex size-full flex-col items-center justify-center gap-1 px-2 text-center text-zinc-500">
          <Icon className="size-5" />
          <span className="text-[10px]">Screen unavailable</span>
        </div>
      ) : (
        <Skeleton className="size-full rounded-none bg-zinc-800" />
      )}
    </DeviceChrome>
  );
}
