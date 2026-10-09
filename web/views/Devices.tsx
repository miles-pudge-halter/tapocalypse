import { AlertCircle, Apple, Bot, ExternalLink, Loader2, Play, Power, RefreshCw, Smartphone } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";
import { CodeBlock } from "@/components/code-block";
import { DeviceFrame } from "@/components/device-frame";
import { DeviceName } from "@/components/device-name";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { api, type BootableDevice, type Device, type PoolView, type RunView, runHash } from "@/lib/api";
import { deviceSubtitle } from "@/lib/format";
import { useActiveRuns, useDevices, useNewRun, useNow, usePool, useProjectScope } from "@/lib/hooks";
import { cn } from "@/lib/utils";

type Tone = "free" | "busy" | "warn" | "neutral";

const TONE: Record<Tone, { badge: string; dot: string }> = {
  free: { badge: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300", dot: "bg-emerald-500" },
  busy: { badge: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300", dot: "bg-blue-500" },
  warn: { badge: "border-orange-500/30 bg-orange-500/10 text-orange-800 dark:text-orange-300", dot: "bg-orange-400" },
  neutral: { badge: "border-stone-500/30 bg-stone-500/10 text-stone-700 dark:text-stone-300", dot: "bg-stone-500" },
};

/** A chip's `pulse` marks transient states (running, booting) the way StatusBadge does for runs. */
function StateChip({ tone, pulse = false, children }: { tone: Tone; pulse?: boolean; children: ReactNode }) {
  const t = TONE[tone];
  return (
    <Badge variant="outline" className={cn("max-w-full", t.badge)}>
      <span className="relative flex size-2 shrink-0">
        {pulse && <span className={cn("absolute inline-flex size-full animate-ping rounded-full opacity-60", t.dot)} />}
        <span className={cn("relative inline-flex size-2 rounded-full", t.dot)} />
      </span>
      <span className="truncate">{children}</span>
    </Badge>
  );
}

function minutesUntil(iso: string, now: number): number {
  return Math.max(0, Math.ceil((Date.parse(iso) - now) / 60_000));
}

/** Whether Tapocalypse would ever schedule QA on this device. */
function usedForQa(device: Device): boolean {
  return device.deviceType !== "watch" && device.deviceType !== "tv";
}

function sortRank(device: Device): number {
  if (!usedForQa(device)) return 4;
  if (device.excluded === true || device.artemisOwner) return 3;
  if (device.state === "booting") return 2;
  return device.busyRunId ? 0 : 1;
}

function DeviceCard({
  device,
  run,
  now,
  shuttingDown,
  onNewRun,
  onShutdown,
}: {
  device: Device;
  run: RunView | undefined;
  now: number;
  shuttingDown: boolean;
  onNewRun(): void;
  onShutdown(): void;
}) {
  const qa = usedForQa(device);
  const excluded = device.excluded === true;
  const booting = device.state === "booting";
  const placeholder = device.serial.startsWith("booting:");
  const PlatformIcon = device.platform === "ios" ? Apple : Bot;
  const canShutdown = Boolean(device.bootedByTapocalypse) && !device.busyRunId && !booting;

  let chip: ReactNode;
  if (!qa) chip = <StateChip tone="neutral">Not used for QA</StateChip>;
  else if (booting) chip = <StateChip tone="neutral" pulse>Booting…</StateChip>;
  else if (device.busyRunId) chip = <StateChip tone="busy" pulse>Running</StateChip>;
  else if (device.artemisOwner) {
    const owner = device.artemisOwner;
    chip = <StateChip tone="warn">Artemis task {owner.sessionId ?? `pid ${owner.pid}`}</StateChip>;
  } else if (excluded) chip = <StateChip tone="neutral">Excluded in config</StateChip>;
  else if (device.idleShutdownAt) {
    const m = minutesUntil(device.idleShutdownAt, now);
    chip = <StateChip tone="warn">{m === 0 ? "Idle — shutting down" : `Idle — shuts down in ${m}m`}</StateChip>;
  } else chip = <StateChip tone="free">Free</StateChip>;

  return (
    <Card className={cn("py-4", !qa && "opacity-75")}>
      <CardContent className="flex gap-4 px-4">
        <DeviceFrame
          serial={placeholder || booting ? null : device.serial}
          live={qa}
          device={device}
          platform={device.platform}
          size="sm"
        />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="min-w-0">
            <DeviceName device={device} className="max-w-full text-sm font-medium" />
            <p className="truncate text-xs text-muted-foreground" title={deviceSubtitle(device)}>
              {deviceSubtitle(device)}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {chip}
            <Badge variant="secondary" className="gap-1 capitalize">
              <PlatformIcon />
              {device.kind}
            </Badge>
            {device.bootedByTapocalypse && <Badge variant="outline">Booted by Tapocalypse</Badge>}
            {device.artemisHelper && <Badge variant="outline">Artemis helper on</Badge>}
          </div>
          {run && (
            <a href={runHash(run.id)} className="truncate text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
              {run.title}
            </a>
          )}
          <div className="mt-auto flex flex-wrap gap-2 pt-1">
            {qa && !excluded && !booting && (
              <Button size="sm" variant={device.busyRunId ? "outline" : "default"} onClick={onNewRun}>
                <Play />
                New run here
              </Button>
            )}
            {device.busyRunId && (
              <Button asChild size="sm" variant="outline">
                <a href={runHash(device.busyRunId)}>
                  <ExternalLink />
                  Open run
                </a>
              </Button>
            )}
            {canShutdown && (
              <Button size="sm" variant="ghost" disabled={shuttingDown} onClick={onShutdown}>
                {shuttingDown ? <Loader2 className="animate-spin" /> : <Power />}
                Shut down
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function GhostCard({ target, booting, capped, onBoot }: { target: BootableDevice; booting: boolean; capped: boolean; onBoot(): void }) {
  const PlatformIcon = target.platform === "ios" ? Apple : Bot;
  return (
    <Card className="border-dashed bg-transparent py-4 shadow-none">
      <CardContent className="flex gap-4 px-4">
        <div className="flex aspect-[9/19.5] w-24 shrink-0 items-center justify-center rounded-[1.5rem] border-2 border-dashed text-muted-foreground/60">
          {booting ? <Loader2 className="size-5 animate-spin" /> : <Power className="size-5" />}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-sm font-medium">
              <PlatformIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{target.name}</span>
            </p>
            <p className="text-xs text-muted-foreground">{target.platform === "ios" ? "iOS simulator" : "Android emulator"} · not running</p>
          </div>
          <div className="mt-auto space-y-1.5 pt-1">
            <Button size="sm" variant="outline" className="strike" disabled={booting || capped} onClick={onBoot}>
              {booting ? <Loader2 className="animate-spin" /> : <Power />}
              {booting ? "Booting…" : "Boot"}
            </Button>
            {capped && !booting && <p className="text-xs text-muted-foreground">Emulator limit reached; shut one down first.</p>}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function PoolHeader({ pool }: { pool: PoolView }) {
  return (
    <Card className="mb-6 py-4">
      <CardContent className="grid gap-4 px-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <p className="text-sm font-medium tabular-nums">
            {pool.activeRuns} / {pool.maxConcurrentRuns} run slots
          </p>
          <Progress value={pool.maxConcurrentRuns > 0 ? (pool.activeRuns / pool.maxConcurrentRuns) * 100 : 0} aria-label="Run slots in use" />
          <p className="text-xs text-muted-foreground">Runs executing at once (maxConcurrentRuns). More runs wait in the queue.</p>
        </div>
        <div className="space-y-1.5">
          <p className="text-sm font-medium tabular-nums">
            {pool.bootedCount} / {pool.maxBooted} emulators booted
          </p>
          <Progress value={pool.maxBooted > 0 ? (pool.bootedCount / pool.maxBooted) * 100 : 0} aria-label="Emulators booted by Tapocalypse" />
          <p className="text-xs text-muted-foreground">Emulators Tapocalypse started itself (maxBooted). Idle ones shut down automatically.</p>
        </div>
      </CardContent>
    </Card>
  );
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const bootKey = (b: BootableDevice) => `${b.platform}:${b.target}`;

export function Devices() {
  const { devices, loading, error, refresh: refreshDevices } = useDevices(5_000);
  const { pool, error: poolError, refresh: refreshPool } = usePool();
  const { runs: activeRuns } = useActiveRuns();
  const { projectId } = useProjectScope();
  const { openNewRun } = useNewRun();
  const now = useNow(15_000);
  const [booting, setBooting] = useState<ReadonlySet<string>>(new Set());
  const [shuttingDown, setShuttingDown] = useState<ReadonlySet<string>>(new Set());

  // An optimistic "Booting…" ends as soon as the pool stops offering the target (it is running or placeholder-listed).
  useEffect(() => {
    if (!pool) return;
    const offered = new Set(pool.bootable.map(bootKey));
    setBooting((s) => {
      const next = new Set([...s].filter((k) => offered.has(k)));
      return next.size === s.size ? s : next;
    });
  }, [pool]);

  // Keep the grid fresh while a boot is in flight.
  const pendingBoots = booting.size > 0;
  useEffect(() => {
    if (!pendingBoots) return;
    const timer = setInterval(() => {
      refreshDevices();
      refreshPool();
    }, 3_000);
    return () => clearInterval(timer);
  }, [pendingBoots, refreshDevices, refreshPool]);

  async function boot(target: BootableDevice) {
    const key = bootKey(target);
    setBooting((s) => new Set(s).add(key));
    try {
      await api.bootDevice(target.platform, target.target);
      refreshPool();
      refreshDevices();
    } catch (e) {
      toast.error(`Could not boot ${target.name}: ${errorMessage(e)}`);
      setBooting((s) => {
        const next = new Set(s);
        next.delete(key);
        return next;
      });
    }
  }

  async function shutdown(device: Device) {
    setShuttingDown((s) => new Set(s).add(device.serial));
    try {
      await api.shutdownDevice(device.serial);
      toast.success(`Shut down ${device.name}`);
      refreshDevices();
      refreshPool();
    } catch (e) {
      toast.error(`Could not shut down ${device.name}: ${errorMessage(e)}`);
    } finally {
      setShuttingDown((s) => {
        const next = new Set(s);
        next.delete(device.serial);
        return next;
      });
    }
  }

  const sorted = [...devices].sort((a, b) => sortRank(a) - sortRank(b) || a.serial.localeCompare(b.serial));
  const ghosts = (pool?.bootable ?? []).filter((b) => !devices.some((d) => d.serial === `booting:${b.target}`));
  const androidCapped = pool !== null && pool.bootedCount >= pool.maxBooted;
  const showEmpty = !loading && !error && devices.length === 0 && ghosts.length === 0;

  return (
    <div>
      <PageHeader
        title="Devices"
        description="Emulators, simulators and phones Tapocalypse can run QA on, and what each one is doing right now."
        actions={
          <Button
            variant="outline"
            className="strike"
            onClick={() => {
              refreshDevices();
              refreshPool();
            }}
          >
            <RefreshCw className={cn(loading && "animate-spin")} />
            Refresh
          </Button>
        }
      />

      {error && (
        <Alert variant="destructive" className="mb-4">
          <AlertCircle />
          <AlertTitle>Could not list devices</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {pool ? (
        <PoolHeader pool={pool} />
      ) : poolError ? (
        <Alert className="mb-6">
          <AlertCircle />
          <AlertTitle>Device pool unavailable</AlertTitle>
          <AlertDescription>{poolError}</AlertDescription>
        </Alert>
      ) : (
        <Skeleton className="mb-6 h-24 w-full" />
      )}

      {loading && devices.length === 0 ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4" aria-busy>
          <Skeleton className="h-60 w-full" />
          <Skeleton className="h-60 w-full" />
          <Skeleton className="h-60 w-full" />
        </div>
      ) : showEmpty ? (
        <EmptyState
          icon={Smartphone}
          title="No devices connected"
          description={
            <>
              Start an Android emulator or iOS simulator with your app installed, or list AVDs under{" "}
              <code className="rounded bg-muted px-1 text-xs">devicePool.android.avds</code> in your Tapocalypse config so they can be booted from
              here.
            </>
          }
          action={
            <div className="w-full max-w-sm space-y-2 text-left">
              <p className="text-xs text-muted-foreground">Your installed AVD names:</p>
              <CodeBlock code="emulator -list-avds" prompt />
            </div>
          }
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {sorted.map((d) => (
            <DeviceCard
              key={d.serial}
              device={d}
              run={d.busyRunId ? activeRuns.find((r) => r.id === d.busyRunId) : undefined}
              now={now}
              shuttingDown={shuttingDown.has(d.serial)}
              onNewRun={() =>
                openNewRun({ ...(projectId && { projectId }), device: { platform: d.platform, serial: d.serial } })
              }
              onShutdown={() => void shutdown(d)}
            />
          ))}
          {ghosts.map((b) => (
            <GhostCard
              key={bootKey(b)}
              target={b}
              booting={booting.has(bootKey(b))}
              capped={b.platform === "android" && androidCapped}
              onBoot={() => void boot(b)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
