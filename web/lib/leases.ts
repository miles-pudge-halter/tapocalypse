import { ApiError, type Device, type DeviceWaiter, type LeaseEvent, type LeaseView, type Platform, type PoolView, type QueueHold } from "./api";
import { deviceDisplayName, formatClock, leaseLeft } from "./format";

/** What a force-release attempt ended in, as the Devices page reports it. */
export type ReleaseOutcome =
  | { kind: "released" }
  | { kind: "already_free" }
  | { kind: "held_by_run" }
  | { kind: "changed_hands"; holder: string | null }
  | { kind: "failed"; message: string };

/** Classifies the result of `api.releaseDevice`: `null` is success (204), anything else is the error it threw. */
export function releaseOutcome(error: unknown): ReleaseOutcome {
  if (error === null) return { kind: "released" };
  if (error instanceof ApiError) {
    if (error.status === 404) return { kind: "already_free" };
    if (error.status === 409) {
      return error.code === "held_by_run" ? { kind: "held_by_run" } : { kind: "changed_hands", holder: error.lease?.holder ?? null };
    }
  }
  return { kind: "failed", message: error instanceof Error ? error.message : String(error) };
}

/** Whether Tapocalypse would ever schedule QA on this device. */
export function usedForQa(device: Pick<Device, "deviceType">): boolean {
  return device.deviceType !== "watch" && device.deviceType !== "tv";
}

export type DeviceStateKind = "not_qa" | "booting" | "running" | "reserved" | "held" | "excluded" | "expired" | "idle" | "free";

/** The card's main state, in the spec's precedence order; `recentlyExpired` is the client-side 10 s "Lease expired" flash. */
export function deviceState(device: Device, recentlyExpired: boolean): DeviceStateKind {
  if (!usedForQa(device)) return "not_qa";
  if (device.state === "booting") return "booting";
  if (device.busyRunId) return "running";
  if (device.lease?.claimPending) return "reserved";
  if (device.lease) return "held";
  if (device.excluded === true) return "excluded";
  if (recentlyExpired) return "expired";
  if (device.idleShutdownAt) return "idle";
  return "free";
}

const SORT_RANK: Record<DeviceStateKind, number> = {
  running: 0,
  held: 1,
  reserved: 1,
  free: 2,
  idle: 2,
  expired: 2,
  booting: 3,
  excluded: 4,
  not_qa: 5,
};

/** Card order on the Devices page: running, held, free, booting, excluded, not used for QA. */
export function sortRank(device: Device, recentlyExpired: boolean): number {
  return SORT_RANK[deviceState(device, recentlyExpired)];
}

export interface DeviceCounts {
  /** Ready QA devices (watches, TVs and booting devices excluded). */
  usable: number;
  running: number;
  held: number;
  /** Running a QA run or held by an agent. */
  busy: number;
  free: number;
}

/** Counters behind the live strip, the sidebar badge and the Devices pool header. */
export function deviceCounts(devices: readonly Device[]): DeviceCounts {
  const usable = devices.filter((d) => d.state === "ready" && usedForQa(d));
  const running = usable.filter((d) => d.busyRunId).length;
  const held = usable.filter((d) => !d.busyRunId && d.lease).length;
  return { usable: usable.length, running, held, busy: running + held, free: usable.length - running - held };
}

/** The lease panel's time line: when it started and when it ends, or the claim countdown while it waits to be picked up. */
export function leaseTimes(lease: LeaseView, now: number): string {
  const since = formatClock(lease.acquiredAt);
  if (lease.claimPending && lease.expiresAt) return `granted ${since} · picks it up within ${leaseLeft(lease.expiresAt, now)}`;
  if (!lease.expiresAt) return `since ${since}`;
  if (Date.parse(lease.expiresAt) <= now) return `since ${since} · ending…`;
  const renewed = lease.renewedAt !== lease.acquiredAt && !lease.gated ? " · renewed" : "";
  return `since ${since} · until ${formatClock(lease.expiresAt)}${renewed}`;
}

/** Who gets the device when the lease ends: the first waiter, or nobody. */
function nextText(waiters: readonly DeviceWaiter[]): string {
  const next = waiters[0];
  if (!next) return "nobody (it becomes free)";
  return next.kind === "agent" ? next.holder : `the queued run “${next.title}”`;
}

const WOULD_END_AFTER_MS = 2 * 60_000;

/** The Release dialog's description: what releasing does to this lease, plus when it would end on its own. */
export function releaseCopy(lease: LeaseView, waiters: readonly DeviceWaiter[], now: number): { body: string; wouldEnd: string | null } {
  const next = nextText(waiters);
  if (lease.claimPending) return { body: `${lease.holder} has not picked it up yet. Releasing hands the device to ${next}.`, wouldEnd: null };
  const reason = lease.reason ? ` for “${lease.reason}”` : "";
  const body = `${lease.holder} is holding it${reason}. Releasing ends the lease now and hands the device to ${next}. The agent is not stopped: it learns about it on its next lease call and may still touch the device until then.`;
  const long = lease.expiresAt !== null && Date.parse(lease.expiresAt) - now > WOULD_END_AFTER_MS;
  return { body, wouldEnd: long && lease.expiresAt ? `It would end on its own at ${formatClock(lease.expiresAt)}.` : null };
}

/**
 * Remembers the last known agent lease per serial. The server sends `lease: null` on every ending event
 * (released, expired, revoked, gone), so holder, platform and expiry of what just ended come from here.
 */
export interface LeaseCache {
  /** Records agent leases from a list (device list or `/api/leases`); never forgets one. */
  seed(leases: readonly LeaseView[]): void;
  /** Applies a `lease` event: acquired/renewed update the cache; an ending event returns the lease that ended (once) and forgets it. */
  resolve(event: LeaseEvent): LeaseView | null;
}

export function createLeaseCache(): LeaseCache {
  const bySerial = new Map<string, LeaseView>();
  return {
    seed(leases) {
      for (const l of leases) if (l.source === "agent") bySerial.set(l.serial, l);
    },
    resolve(event) {
      if (event.change === "acquired" || event.change === "renewed") {
        if (event.lease) bySerial.set(event.serial, event.lease);
        return event.lease;
      }
      const known = bySerial.get(event.serial) ?? null;
      bySerial.delete(event.serial);
      return known;
    },
  };
}

/** The Devices page's "Lease expired" note for an `expired` event: who held it and when it really ran out. */
export function expiredNote(event: LeaseEvent, lease: LeaseView | null, now: number): { holder: string; at: string; chip: boolean } {
  return { holder: lease?.holder ?? "an agent", at: lease?.expiresAt ?? new Date(now).toISOString(), chip: event.next === null };
}

export type ToastTarget = { type: "new-run"; platform: Platform; serial: string } | { type: "run"; runId: string };

/** A notification the Notifications component shows for a `lease` event. */
export interface LeaseToast {
  kind: "success" | "warning" | "info";
  title: string;
  description: string;
  action?: { label: string; to: ToastTarget };
  /** True when the device is free (or gone), so the bell turns itself off. */
  unwatch: boolean;
}

export interface LeaseToastContext {
  watching: boolean;
  /** The serial and `ref` this tab just released through the dialog; its own `revoked` event is skipped. */
  ownRelease: { serial: string; ref: string } | null;
  /** The device's last known lease (the server sends `lease: null` on every ending event); null when this tab never saw it. */
  lease: LeaseView | null;
}

/** The toast for a `lease` event on a watched device (null: say nothing). */
export function leaseToast(event: LeaseEvent, ctx: LeaseToastContext): LeaseToast | null {
  if (!ctx.watching) return null;
  const device = event.deviceName || event.serial;
  const holder = ctx.lease?.holder ?? "an agent";
  const { change } = event;
  if (change === "acquired" || change === "renewed") return null;
  if (change === "gone") return { kind: "info", title: `${device} disconnected`, description: `The lease of ${holder} ended with it.`, unwatch: true };
  if (change === "revoked" && ctx.ownRelease?.serial === event.serial && (!ctx.lease || ctx.lease.ref === ctx.ownRelease.ref)) return null;
  if (event.next?.kind === "agent") {
    return { kind: "info", title: `${device} went to the next agent`, description: `${event.next.holder} has it now. Still watching.`, unwatch: false };
  }
  if (event.next?.kind === "run") {
    return {
      kind: "info",
      title: `${device} went to a queued run`,
      description: `“${event.next.title}” is starting on it. Still watching.`,
      action: { label: "View run", to: { type: "run", runId: event.next.runId } },
      unwatch: false,
    };
  }
  const action: LeaseToast["action"] = ctx.lease ? { label: "New run here", to: { type: "new-run", platform: ctx.lease.platform, serial: event.serial } } : undefined;
  const free: Record<"released" | "expired" | "revoked", Pick<LeaseToast, "kind" | "title" | "description">> = {
    released: { kind: "success", title: `${device} is free`, description: `${holder} released it.` },
    expired: {
      kind: "warning",
      title: `${device} is free: the lease expired`,
      description: `${holder} did not release or renew it in time. It may have stopped.`,
    },
    revoked: { kind: "info", title: `${device} is free`, description: "Released from Tapocalypse." },
  };
  return { ...free[change], ...(action && { action }), unwatch: true };
}

/** The New run picker's text for a device an agent holds: status chip, the line under the subtitle and the row's hover title. */
export function heldRowCopy(lease: LeaseView, now: number): { status: string; line: string; title: string } {
  const until = lease.expiresAt ? formatClock(lease.expiresAt) : null;
  const status = lease.claimPending ? "Reserved" : lease.expiresAt ? `Held · ${leaseLeft(lease.expiresAt, now)}` : "Held";
  const reason = lease.reason ? `: ${lease.reason}` : "";
  return {
    status,
    line: until ? `${lease.holder} · free by ${until}` : lease.holder,
    title: `Held by ${lease.holder}${reason}.${until ? ` Free by ${until} at the latest.` : ""}`,
  };
}

const PLATFORM_NAME: Record<Platform, string> = { android: "Android", ios: "iOS" };

/**
 * Why "Any <platform>" will wait: every candidate emulator is busy with agents, nothing can be booted, and at least one
 * lease is the cause. Null while the pool loads (no warning flash) or when the wait is the normal run queue.
 */
export function anyDeviceHint(
  platform: Platform,
  devices: readonly Device[],
  pool: Pick<PoolView, "bootable" | "bootedCount" | "maxBooted"> | null,
): string | null {
  if (!pool) return null;
  const candidates = devices.filter((d) => d.platform === platform && usedForQa(d) && d.kind !== "physical" && d.excluded !== true && d.state !== "booting");
  const running = candidates.filter((d) => d.busyRunId).length;
  const leased = candidates.filter((d) => !d.busyRunId && d.lease);
  const canBoot = pool.bootable.some((b) => b.platform === platform) && (platform !== "android" || pool.bootedCount < pool.maxBooted);
  if (candidates.length - running - leased.length > 0 || canBoot || leased.length === 0) return null;
  const name = PLATFORM_NAME[platform];
  if (running > 0) {
    return `All ${name} devices are in use (${leased.length} held by agents, ${running} running QA). The run waits for the first one to free up.`;
  }
  const ends = leased.flatMap((d) => (d.lease?.expiresAt ? [d.lease.expiresAt] : [])).sort();
  const by = ends[0] ? `, by ${formatClock(ends[0])} at the latest` : "";
  return `All ${name} devices are held by agents. The run waits for the first one to free up${by}.`;
}

/** The run page's wait texts while a queued run waits on an agent lease. */
export function queueHoldCopy(
  hold: QueueHold,
  request: { platform: Platform; serial?: string },
): { note: string; paneTitle: string; paneDescription: string } {
  const until = formatClock(hold.expiresAt);
  const note = request.serial
    ? `Waiting for ${hold.deviceName}: held by ${hold.holder}${hold.reason ? ` for “${hold.reason}”` : ""}. Free by ${until} at the latest.`
    : `Waiting for any ${PLATFORM_NAME[request.platform]} device: the next agent lease (${hold.holder} on ${hold.deviceName}) ends by ${until} at the latest.`;
  return {
    note,
    paneTitle: `Waiting for ${hold.deviceName}`,
    paneDescription: `Held by ${hold.holder} until ${until}. The live screen appears once the device is free.`,
  };
}

/** One pool-header line per platform whose "any" requests are waiting; null when nobody is. */
export function poolWaitingLine(waiting: { platform: Platform; holders: readonly string[]; runIds: readonly string[] }): string | null {
  const runs = waiting.runIds.length > 0 ? [`${waiting.runIds.length} ${waiting.runIds.length === 1 ? "run" : "runs"}`] : [];
  const parts = [...waiting.holders, ...runs];
  return parts.length > 0 ? `Waiting for any ${PLATFORM_NAME[waiting.platform]}: ${parts.join(", ")}` : null;
}

const TITLE_LINES = 3;

/** The live strip's "N held by agents" pill: its label, hover title and the lease that ends first (for the ring). */
export function heldSummary(devices: readonly Device[]): { label: string; title: string; earliest: LeaseView } | null {
  const held = devices.filter((d) => d.state === "ready" && usedForQa(d) && !d.busyRunId && d.lease);
  const leases = held.flatMap((d) => (d.lease ? [{ device: d, lease: d.lease }] : []));
  const earliest = [...leases].sort((a, b) => Date.parse(a.lease.expiresAt ?? "") - Date.parse(b.lease.expiresAt ?? ""))[0];
  if (!earliest) return null;
  const lines = leases.slice(0, TITLE_LINES).map(({ device, lease }) => {
    const until = lease.expiresAt ? ` until ${formatClock(lease.expiresAt)}` : "";
    return `${lease.holder} on ${deviceDisplayName(device)}${until}`;
  });
  if (leases.length > TITLE_LINES) lines.push(`+${leases.length - TITLE_LINES} more`);
  return {
    label: leases.length === 1 ? "1 held by an agent" : `${leases.length} held by agents`,
    title: lines.join("\n"),
    earliest: earliest.lease,
  };
}

/** The serials stored under `tapocalypse-watched-devices` (a JSON string array); unreadable data is an empty list. */
export function parseWatched(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? [...new Set(parsed.filter((v): v is string => typeof v === "string"))] : [];
  } catch {
    return [];
  }
}

/** The Setup pill text while devices are lent out to agents (agent leases only); null when none is. */
export function lentOutLabel(leases: readonly LeaseView[]): string | null {
  const agent = leases.filter((l) => l.source === "agent");
  const latest = [...agent].sort((a, b) => Date.parse(b.acquiredAt) - Date.parse(a.acquiredAt))[0];
  if (!latest) return null;
  const count = agent.length === 1 ? "1 device lent out" : `${agent.length} devices lent out`;
  return `${count} · ${latest.holder} since ${formatClock(latest.acquiredAt)}`;
}
