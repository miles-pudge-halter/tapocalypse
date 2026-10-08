import { useEffect, useState, type ReactNode } from "react";
import { Download, ExternalLink, ImageOff, Smartphone, Radio } from "lucide-react";

import { DeviceName } from "@/components/device-name";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { screenUrl, type CheckStatus, type Device, type RunView } from "@/lib/api";
import { deviceSubtitle } from "@/lib/format";
import { useNow } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { screenshotOfCheck, type GalleryItem } from "./evidence";
import { useLiveScreen } from "./use-workbench";

const STALE_AFTER_S = 10;

const FILM_BORDER: Record<CheckStatus, string> = {
  pass: "border-t-emerald-500",
  fail: "border-t-red-500",
  blocked: "border-t-rose-800 dark:border-t-rose-500",
  skipped: "border-t-stone-400",
  running: "border-t-blue-500",
  pending: "border-t-transparent",
};

function Freshness({ updatedAt, failed, latencyMs }: { updatedAt: number | null; failed: boolean; latencyMs: number | null }) {
  const now = useNow(1000);
  const age = updatedAt === null ? null : Math.max(0, Math.round((now - updatedAt) / 1000));
  const stale = age !== null && age > STALE_AFTER_S;
  const lost = failed && (age === null || stale);
  const tone = lost
    ? "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300"
    : stale
      ? "border-orange-500/40 bg-orange-500/10 text-orange-800 dark:text-orange-300"
      : "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  return (
    <span
      className={cn("inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium", tone)}
      title={latencyMs !== null ? `Last frame took ${latencyMs} ms` : undefined}
    >
      <Radio className={cn("size-3", !lost && !stale && "animate-pulse")} />
      {lost ? (
        "No signal — device disconnected?"
      ) : age === null ? (
        "LIVE · connecting…"
      ) : (
        <>LIVE · updated {age <= 1 ? "just now" : `${age}s ago`}</>
      )}
    </span>
  );
}

function FrameShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-3 py-2">
      <div className="flex max-h-full max-w-full overflow-hidden rounded-[1.75rem] bg-zinc-950 p-1.5 ring-2 ring-zinc-800 dark:ring-zinc-700">
        <div className="flex max-h-full min-h-0 max-w-[300px] items-center justify-center overflow-hidden rounded-[1.35rem] bg-zinc-900">
          {children}
        </div>
      </div>
    </div>
  );
}

function StillImage({ item, onOpen }: { item: GalleryItem; onOpen: () => void }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [item.url]);
  if (failed) {
    return (
      <div className="flex h-64 w-48 flex-col items-center justify-center gap-1 text-zinc-500">
        <ImageOff className="size-5" />
        <span className="text-xs">Screenshot file is missing</span>
      </div>
    );
  }
  return (
    <button type="button" onClick={onOpen} aria-label={`Open ${item.name}`} className="block max-h-full cursor-zoom-in">
      <img src={item.url} alt={item.name} onError={() => setFailed(true)} className="max-h-full max-w-full object-contain" />
    </button>
  );
}

/** Right pane: the live screen while the run is active, otherwise the selected/latest screenshot, plus a filmstrip. */
export function DevicePane({
  run,
  device,
  gallery,
  selectedCheck,
  onClearSelection,
  onOpenImage,
}: {
  run: RunView;
  device: Device | null;
  gallery: GalleryItem[];
  selectedCheck: string | null;
  onClearSelection: () => void;
  onOpenImage: (item: GalleryItem) => void;
}) {
  const deviceLive = run.deviceSerial !== null && (run.status === "preflight" || run.status === "running" || run.status === "finishing");
  const check = selectedCheck ? run.checks.find((c) => c.id === selectedCheck) : undefined;
  const pinned = check ? screenshotOfCheck(run.projectId, check, gallery) : null;
  const showLive = deviceLive && pinned === null;
  const live = useLiveScreen(run.deviceSerial, showLive);
  const still = pinned ?? (showLive ? null : (gallery[gallery.length - 1] ?? null));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="space-y-1.5 border-b p-3">
        <h2 className="text-sm font-semibold">Device</h2>
        {showLive ? <Freshness updatedAt={live.updatedAt} failed={live.failed} latencyMs={live.latencyMs} /> : null}
        {device ? (
          <div className="min-w-0 text-xs">
            <DeviceName device={run.deviceName ? { ...device, name: run.deviceName } : device} className="text-sm font-medium" />
            <div className="truncate text-muted-foreground">{deviceSubtitle(device)}</div>
          </div>
        ) : run.deviceSerial ? (
          <div className="truncate text-xs text-muted-foreground">
            {run.deviceName ? `${run.deviceName} · ` : null}
            <span className="font-mono">{run.deviceSerial}</span>
          </div>
        ) : null}
        {deviceLive && pinned && check ? (
          <Button variant="outline" size="xs" onClick={onClearSelection}>
            <Radio />
            Back to live · showing {check.id}
          </Button>
        ) : pinned && check ? (
          <p className="truncate text-xs text-muted-foreground">
            Showing {check.id} · {check.title}
          </p>
        ) : null}
      </div>

      {showLive && run.deviceSerial ? (
        <>
          <FrameShell>
            {live.src ? (
              <img src={live.src} alt={`Live screen of ${run.deviceSerial}`} className="max-h-full max-w-full object-contain" />
            ) : live.failed ? (
              <div className="flex h-64 w-48 flex-col items-center justify-center gap-1 px-3 text-center text-zinc-500">
                <Smartphone className="size-5" />
                <span className="text-xs">Screen unavailable</span>
              </div>
            ) : (
              <Skeleton className="h-96 w-44 rounded-none bg-zinc-800" />
            )}
          </FrameShell>
          <div className="flex items-center justify-center gap-1 pb-1">
            <Button asChild variant="ghost" size="xs">
              <a href={screenUrl(run.deviceSerial, Date.now())} target="_blank" rel="noopener noreferrer">
                <ExternalLink />
                Open
              </a>
            </Button>
            {live.src ? (
              <Button asChild variant="ghost" size="xs">
                <a href={live.src} download={`${run.deviceSerial}-${Date.now()}.png`}>
                  <Download />
                  Save frame
                </a>
              </Button>
            ) : null}
          </div>
        </>
      ) : still ? (
        <FrameShell>
          <StillImage item={still} onOpen={() => onOpenImage(still)} />
        </FrameShell>
      ) : (
        <div className="flex flex-1 items-center justify-center p-4">
          <EmptyState
            icon={Smartphone}
            title={run.status === "queued" ? "Waiting for a device" : "No screenshots"}
            description={
              run.status === "queued"
                ? "The live screen appears once a device is assigned."
                : "This run did not save any screenshots."
            }
          />
        </div>
      )}

      {gallery.length > 0 ? (
        <div className="border-t p-2">
          <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Screenshots ({gallery.length})
          </div>
          <div className="flex gap-1.5 overflow-x-auto pb-1">
            {gallery.map((item) => {
              const status = run.checks.find((c) => c.id === item.checkId)?.status ?? "pending";
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => onOpenImage(item)}
                  title={item.name}
                  className={cn(
                    "relative h-12 shrink-0 overflow-hidden rounded border border-t-2 outline-none hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring",
                    FILM_BORDER[status],
                    still?.key === item.key && "ring-2 ring-ring",
                  )}
                >
                  <img src={item.url} alt="" loading="lazy" className="h-full w-auto object-cover" />
                  {item.checkId ? (
                    <span className="absolute bottom-0 left-0 rounded-tr bg-background/80 px-1 font-mono text-[9px]">{item.checkId}</span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
