import { AlertCircle, Apple, Bell, BellRing, Bot, ExternalLink, Loader2, Play, Power, RefreshCw, Smartphone, Unlock } from "lucide-react";
import { Fragment, type ReactNode, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { CodeBlock } from "@/components/code-block";
import { DeviceFrame } from "@/components/device-frame";
import { DeviceName } from "@/components/device-name";
import { EmptyState } from "@/components/empty-state";
import { LeaseRing } from "@/components/lease-ring";
import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Toggle } from "@/components/ui/toggle";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  api,
  type BootableDevice,
  type Device,
  type DeviceWaiter,
  type LeaseView,
  type PoolView,
  type RunView,
  runHash,
} from "@/lib/api";
import { deviceSubtitle, formatClock, formatTime } from "@/lib/format";
import {
  listenLeaseEvent,
  noteOwnRelease,
  useActiveRuns,
  useDevices,
  useNewRun,
  useNow,
  usePool,
  useProjectScope,
  useWatchedDevices,
} from "@/lib/hooks";
import {
  deviceCounts,
  deviceState,
  expiredNote,
  leaseTimes,
  poolWaitingLine,
  releaseCopy,
  releaseOutcome,
  sortRank,
  usedForQa,
} from "@/lib/leases";
import { strikeOnce } from "@/lib/strike";
import { cn } from "@/lib/utils";

type Tone = "free" | "busy" | "held" | "warn" | "neutral";

const TONE: Record<Tone, { badge: string; dot: string }> = {
  free: { badge: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300", dot: "bg-emerald-500" },
  busy: { badge: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300", dot: "bg-blue-500" },
  held: { badge: "border-violet-500/40 bg-violet-50 text-violet-800 dark:bg-violet-950/40 dark:text-violet-300", dot: "bg-violet-500" },
  warn: { badge: "border-orange-500/30 bg-orange-500/10 text-orange-800 dark:text-orange-300", dot: "bg-orange-400" },
  neutral: { badge: "border-stone-500/30 bg-stone-500/10 text-stone-700 dark:text-stone-300", dot: "bg-stone-500" },
};

/** A chip's `pulse` marks transient states (running, booting) the way StatusBadge does for runs; `glyph` replaces the dot. */
function StateChip({ tone, pulse = false, glyph, children }: { tone: Tone; pulse?: boolean; glyph?: ReactNode; children: ReactNode }) {
  const t = TONE[tone];
  return (
    <Badge variant="outline" className={cn("max-w-full", t.badge)}>
      {glyph ?? (
        <span className="relative flex size-2 shrink-0">
          {pulse && <span className={cn("absolute inline-flex size-full animate-ping rounded-full opacity-60", t.dot)} />}
          <span className={cn("relative inline-flex size-2 rounded-full", t.dot)} />
        </span>
      )}
      <span className="truncate">{children}</span>
    </Badge>
  );
}

function minutesUntil(iso: string, now: number): number {
  return Math.max(0, Math.ceil((Date.parse(iso) - now) / 60_000));
}

/** A lease that ran out while this page was open: the "Lease expired" chip for 10 s and one strike across the card. */
interface ExpiredLease {
  holder: string;
  /** ISO time the lease ran out. */
  at: string;
  /** False when the device went straight to the next waiter, so there is nothing to call "expired". */
  chip: boolean;
  /** Bumped per event so the card replays the strike. */
  seq: number;
}

const EXPIRED_CHIP_MS = 10_000;

function WaiterEntry({ waiter }: { waiter: DeviceWaiter }) {
  if (waiter.kind === "agent") return <>{waiter.holder}</>;
  return (
    <>
      run “
      <a href={runHash(waiter.runId)} className="underline-offset-4 hover:text-foreground hover:underline">
        {waiter.title}
      </a>
      ”
    </>
  );
}

/** Who waits for this device, in queue order: the first two inline, the rest in a hover card. */
function WaitersLine({ waiters }: { waiters: DeviceWaiter[] }) {
  const shown = waiters.slice(0, 2);
  const more = waiters.length - shown.length;
  return (
    <p className="truncate text-xs text-muted-foreground">
      {waiters.length} waiting:{" "}
      {shown.map((w, i) => (
        <Fragment key={i}>
          {i > 0 && ", "}
          <WaiterEntry waiter={w} />
        </Fragment>
      ))}
      {more > 0 && (
        <>
          {", "}
          <HoverCard openDelay={200}>
            <HoverCardTrigger asChild>
              <span tabIndex={0} className="cursor-default underline decoration-dotted underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                +{more} more
              </span>
            </HoverCardTrigger>
            <HoverCardContent className="w-72">
              <ol className="list-decimal space-y-1 pl-4 text-xs">
                {waiters.map((w, i) => (
                  <li key={i} className="break-words">
                    <WaiterEntry waiter={w} />
                  </li>
                ))}
              </ol>
            </HoverCardContent>
          </HoverCard>
        </>
      )}
    </p>
  );
}

/** Holder, reason and times of an agent lease, with the draining ring; the hover card carries the full text and the lease ref. */
function LeasePanel({ lease }: { lease: LeaseView }) {
  const now = useNow(lease.claimPending ? 1_000 : 10_000);
  return (
    <HoverCard openDelay={300}>
      <HoverCardTrigger asChild>
        <div
          tabIndex={0}
          className="flex gap-2 rounded-md border bg-muted/40 p-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400"
        >
          <LeaseRing size={32} lease={lease} />
          <div className="min-w-0 flex-1 space-y-0.5">
            <p className="truncate text-sm font-medium" title={lease.holder}>
              {lease.holder}
            </p>
            {lease.reason && <p className="line-clamp-2 break-words text-xs text-muted-foreground">{lease.reason}</p>}
            <p className="text-xs tabular-nums text-muted-foreground">{leaseTimes(lease, now)}</p>
          </div>
        </div>
      </HoverCardTrigger>
      <HoverCardContent className="w-80 space-y-2 text-xs">
        <p className="break-words text-sm font-medium">{lease.holder}</p>
        {lease.reason && <p className="whitespace-pre-wrap break-words">{lease.reason}</p>}
        <p className="font-mono text-muted-foreground">Lease {lease.ref}</p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-muted-foreground">
          <dt>Acquired</dt>
          <dd className="tabular-nums">{formatTime(lease.acquiredAt)}</dd>
          <dt>Renewed</dt>
          <dd className="tabular-nums">{formatTime(lease.renewedAt)}</dd>
          <dt>{lease.claimPending ? "Pick up by" : "Expires"}</dt>
          <dd className="tabular-nums">{formatTime(lease.expiresAt)}</dd>
        </dl>
      </HoverCardContent>
    </HoverCard>
  );
}

function ReleaseDialog({
  device,
  lease,
  open,
  onOpenChange,
  onDone,
}: {
  device: Device;
  /** The lease as it was when the dialog opened; only this `ref` is ever sent. */
  lease: LeaseView;
  open: boolean;
  onOpenChange(open: boolean): void;
  onDone(): void;
}) {
  const now = useNow(15_000);
  const { unwatch } = useWatchedDevices();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const waiters = device.waiters ?? [];
  const copy = releaseCopy(lease, waiters, now);
  const ended = device.lease?.ref !== lease.ref;
  const next = waiters[0];

  async function confirm() {
    setBusy(true);
    setError(null);
    noteOwnRelease(device.serial, lease.ref);
    let failure: unknown = null;
    try {
      await api.releaseDevice(device.serial, lease.ref);
    } catch (e) {
      failure = e;
    }
    const outcome = releaseOutcome(failure);
    setBusy(false);
    if (outcome.kind === "failed") {
      setError(outcome.message);
      return;
    }
    onOpenChange(false);
    if (outcome.kind === "released") {
      const who = next ? (next.kind === "agent" ? next.holder : `“${next.title}”`) : null;
      if (!next) unwatch(device.serial);
      toast.success(`Released ${device.name}`, { description: who ? `${who} has it now.` : "It is free." });
    } else if (outcome.kind === "already_free") toast.info(`${device.name} was already free`);
    else if (outcome.kind === "held_by_run") toast.info(`${device.name} is running a QA run now`, { description: "Cancel the run to free it." });
    else {
      toast.error(`The lease on ${device.name} changed hands`, {
        description: `It is now held by ${outcome.holder ?? "another agent"}. Nothing was released.`,
      });
    }
    onDone();
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Release {device.name}?</DialogTitle>
          <DialogDescription>{copy.body}</DialogDescription>
        </DialogHeader>
        {copy.wouldEnd && !ended && <p className="text-xs text-muted-foreground">{copy.wouldEnd}</p>}
        {error && (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle>Could not release {device.name}</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button variant="outline" autoFocus disabled={busy} onClick={() => onOpenChange(false)}>
            {ended ? "Close" : "Keep lease"}
          </Button>
          {ended ? (
            <p className="self-center text-sm text-muted-foreground">This lease already ended.</p>
          ) : (
            <Button variant="destructive" disabled={busy} onClick={() => void confirm()}>
              {busy ? <Loader2 className="animate-spin" /> : <Unlock />}
              Release device
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeviceCard({
  device,
  run,
  now,
  expired,
  watching,
  shuttingDown,
  onNewRun,
  onShutdown,
  onToggleWatch,
  onReleased,
}: {
  device: Device;
  run: RunView | undefined;
  now: number;
  expired: ExpiredLease | undefined;
  watching: boolean;
  shuttingDown: boolean;
  onNewRun(): void;
  onShutdown(): void;
  onToggleWatch(): void;
  onReleased(): void;
}) {
  const qa = usedForQa(device);
  const booting = device.state === "booting";
  const placeholder = device.serial.startsWith("booting:");
  const PlatformIcon = device.platform === "ios" ? Apple : Bot;
  const { lease } = device;
  const waiters = device.waiters ?? [];
  const state = deviceState(device, expired?.chip === true);
  const canShutdown = Boolean(device.bootedByTapocalypse) && !device.busyRunId && !booting && !lease;

  const cardRef = useRef<HTMLDivElement>(null);
  const [flash, setFlash] = useState(false);
  const [releaseOpen, setReleaseOpen] = useState(false);
  const [releasing, setReleasing] = useState<LeaseView | null>(null);

  // One strike per `expired` event; the class goes away again on the animation's end.
  const expiredSeq = expired?.seq;
  useEffect(() => {
    if (expiredSeq === undefined) return;
    setFlash(true);
    const frame = requestAnimationFrame(() => cardRef.current && strikeOnce(cardRef.current));
    return () => cancelAnimationFrame(frame);
  }, [expiredSeq]);

  let chip: ReactNode;
  switch (state) {
    case "not_qa":
      chip = <StateChip tone="neutral">Not used for QA</StateChip>;
      break;
    case "booting":
      chip = (
        <StateChip tone="neutral" pulse>
          Booting…
        </StateChip>
      );
      break;
    case "running":
      chip = (
        <StateChip tone="busy" pulse>
          Running
        </StateChip>
      );
      break;
    case "reserved":
      chip = (
        <StateChip tone="held" glyph={lease && <LeaseRing size={12} lease={lease} />}>
          Reserved for {lease?.holder ?? "an agent"}
        </StateChip>
      );
      break;
    case "held":
      chip = (
        <StateChip tone="held" glyph={lease && <LeaseRing size={12} lease={lease} />}>
          Held by agent
        </StateChip>
      );
      break;
    case "excluded":
      chip = <StateChip tone="neutral">Excluded in config</StateChip>;
      break;
    case "expired":
      chip = <StateChip tone="warn">Lease expired</StateChip>;
      break;
    case "idle": {
      const m = device.idleShutdownAt ? minutesUntil(device.idleShutdownAt, now) : 0;
      chip = <StateChip tone="warn">{m === 0 ? "Idle — shutting down" : `Idle — shuts down in ${m}m`}</StateChip>;
      break;
    }
    case "free":
      chip = <StateChip tone="free">Free</StateChip>;
      break;
  }

  return (
    <Card
      ref={cardRef}
      className={cn("py-4", !qa && "opacity-75", flash && "strike")}
      onAnimationEnd={(e) => e.animationName === "strike-travel" && setFlash(false)}
    >
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
          </div>
          {lease && (state === "held" || state === "reserved") && <LeasePanel lease={lease} />}
          {state === "expired" && expired && (
            <p className="text-xs text-muted-foreground">
              {expired.holder}&rsquo;s lease ran out at {formatClock(expired.at)}.
            </p>
          )}
          {run && (
            <a href={runHash(run.id)} className="truncate text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
              {run.title}
            </a>
          )}
          {waiters.length > 0 && <WaitersLine waiters={waiters} />}
          <div className="mt-auto flex flex-wrap gap-2 pt-1">
            {qa && device.excluded !== true && !booting && !lease && (
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
            {lease && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setReleasing(lease);
                    setReleaseOpen(true);
                  }}
                >
                  <Unlock />
                  Release…
                </Button>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Toggle size="sm" variant="outline" pressed={watching} onPressedChange={onToggleWatch} aria-label="Notify me when free">
                      {watching ? <BellRing /> : <Bell />}
                    </Toggle>
                  </TooltipTrigger>
                  <TooltipContent>
                    {watching ? `You'll be notified when ${device.name} is free. Click to stop.` : `Notify me when ${device.name} is free`}
                  </TooltipContent>
                </Tooltip>
              </>
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
      {releasing && <ReleaseDialog device={device} lease={releasing} open={releaseOpen} onOpenChange={setReleaseOpen} onDone={onReleased} />}
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

function PoolHeader({ pool, devices }: { pool: PoolView; devices: Device[] }) {
  const { held, usable } = deviceCounts(devices);
  const waiting = (pool.waiting ?? []).map(poolWaitingLine).filter((line): line is string => line !== null);
  const showLeases = held > 0 || waiting.length > 0;
  return (
    <Card className="mb-6 py-4">
      <CardContent className={cn("grid gap-4 px-4 sm:grid-cols-2", showLeases && "lg:grid-cols-3")}>
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
        {showLeases && (
          <div className="space-y-1.5">
            <p className="text-sm font-medium tabular-nums">
              {held} / {usable} devices held by agents
            </p>
            <Progress
              value={usable > 0 ? (held / usable) * 100 : 0}
              aria-label="Devices held by agents"
              className="bg-violet-500/20 [&>[data-slot=progress-indicator]]:bg-violet-500"
            />
            <p className="text-xs text-muted-foreground">
              Coding agents borrow devices with device_acquire. A lease ends when the agent releases it or its time runs out.
            </p>
            {waiting.map((line) => (
              <p key={line} className="text-xs">
                {line}
              </p>
            ))}
          </div>
        )}
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
  const { watched, toggle: toggleWatch } = useWatchedDevices();
  const now = useNow(15_000);
  const [booting, setBooting] = useState<ReadonlySet<string>>(new Set());
  const [shuttingDown, setShuttingDown] = useState<ReadonlySet<string>>(new Set());
  const [expired, setExpired] = useState<ReadonlyMap<string, ExpiredLease>>(new Map());
  const expiredSeq = useRef(0);

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

  // An `expired` lease event flashes the card and shows "Lease expired" for a few seconds; nothing else (not load, not release) does.
  useEffect(() => {
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const off = listenLeaseEvent((event, ended) => {
      if (event.change !== "expired") return;
      const entry: ExpiredLease = { ...expiredNote(event, ended, Date.now()), seq: ++expiredSeq.current };
      setExpired((m) => new Map(m).set(event.serial, entry));
      const timer = setTimeout(() => {
        timers.delete(timer);
        setExpired((m) => {
          if (m.get(event.serial) !== entry) return m;
          const next = new Map(m);
          next.delete(event.serial);
          return next;
        });
      }, EXPIRED_CHIP_MS);
      timers.add(timer);
    });
    return () => {
      off();
      for (const t of timers) clearTimeout(t);
    };
  }, []);

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

  const sorted = [...devices].sort(
    (a, b) => sortRank(a, expired.get(a.serial)?.chip === true) - sortRank(b, expired.get(b.serial)?.chip === true) || a.serial.localeCompare(b.serial),
  );
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
        <PoolHeader pool={pool} devices={devices} />
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
              expired={expired.get(d.serial)}
              watching={watched.has(d.serial)}
              shuttingDown={shuttingDown.has(d.serial)}
              onNewRun={() =>
                openNewRun({ ...(projectId && { projectId }), device: { platform: d.platform, serial: d.serial } })
              }
              onShutdown={() => void shutdown(d)}
              onToggleWatch={() => toggleWatch(d.serial)}
              onReleased={() => {
                refreshDevices();
                refreshPool();
              }}
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
