// The one ownership store for devices: a lease is either an agent's (`device_acquire`) or the implicit one a QA run holds
// from assignment to release. Everything that asks "is this device busy?" asks `deviceOwner`.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { DATA_DIR, HttpError } from "../config";
import type { Platform } from "../runs/types";
import { type Device, lastDeviceSnapshot, mobileDeviceIdOf } from "./devices";
import { isBootingSerial, markAssigned, markReleased } from "./pool";

export type LeaseSource = "agent" | "run";

export interface Lease {
  /** Secret: 16 random bytes, base64url (22 chars). Returned only by `device_acquire`; never in lists, events or logs. */
  leaseId: string;
  /** Public, non-secret handle (8 hex chars) for the UI, SSE and the stale-UI guard on force release. */
  ref: string;
  serial: string;
  platform: Platform;
  /** AVD name / simulator name at grant time; a serial that reappears as a different AVD ends the lease ("gone"). */
  avdName: string | null;
  /** The id mobile-mcp addresses this device by (AVD name on emulators, else the serial); fixed at grant time. */
  mobileDeviceId: string;
  holder: string;
  reason: string | null;
  source: LeaseSource;
  runId?: string;
  /** Absolute dir the agent works in (the Level 2 gateway runs there so mobile-mcp may write screenshots into it). */
  cwd?: string;
  ttlMinutes: number;
  acquiredAt: string;
  renewedAt: string;
  /** null for run leases: a run's lifetime is bounded by runMaxTime and it releases in finalize. */
  expiresAt: string | null;
  /** Set while a grant made to a waiting ticket is not yet picked up; `expiresAt` is the claim deadline meanwhile. */
  claimTicket?: string;
  /** True once the lease has made a gated gateway call. */
  gated?: boolean;
}

/** Public projection: what `GET /api/devices`, `qa_list_devices`, `/api/leases` and SSE carry. */
export type LeaseView = Omit<Lease, "leaseId" | "cwd" | "claimTicket" | "mobileDeviceId" | "gated"> & { gated: boolean; claimPending: boolean };

export type DeviceOwner = { kind: "run"; lease: Lease } | { kind: "agent"; lease: Lease } | { kind: "booting" };

export type LeaseChange = "acquired" | "renewed" | "released" | "expired" | "revoked" | "gone";
export type LeaseNext = { kind: "agent"; holder: string } | { kind: "run"; runId: string; title: string };
export interface LeaseEvent {
  serial: string;
  deviceName: string;
  change: LeaseChange;
  lease: LeaseView | null;
  /** Who got the device right away; null = it is free (or the event is not an ending). */
  next: LeaseNext | null;
}

export interface AgentGrant {
  serial: string;
  platform: Platform;
  avdName: string | null;
  holder: string;
  reason?: string | null;
  ttlMinutes?: number;
  cwd?: string;
  /** Grants made to a ticket nobody is waiting on: a claim-pending lease the resume call turns into a full one. */
  claimTicket?: string;
  /** This process just booted `serial`, so an agent lease still naming it describes a device that no longer exists and ends as gone. */
  booted?: boolean;
}

export const TTL = { default: 30, min: 5, max: 120 } as const;
export const CLAIM_WINDOW_MS = 60_000;
/** A leased serial absent from `listDevices()` this long ends the lease. */
const GONE_AFTER_MS = 2 * 60_000;
const TOMBSTONES = 100;

export interface LeaseStoreDeps {
  /** `leases.json` path; null keeps the store in memory only. */
  file: string | null;
  now: () => number;
  markAssigned: (serial: string) => void;
  markReleased: (serial: string) => void;
  isBootingSerial: (serial: string) => boolean;
  deviceName: (serial: string) => string;
  /** Who would take `serial` right now (first compatible queue entry); used for `LeaseEvent.next`. */
  nextFor: (serial: string) => LeaseNext | null;
}

type EndWhy = "released" | "expired" | "revoked" | "gone";
interface Tombstone {
  serial: string;
  endedAt: number;
  why: EndWhy;
}

const WHY_TEXT: Record<EndWhy, string> = {
  released: "released",
  expired: "expired",
  revoked: "revoked from the Devices page",
  gone: "ended because the device disconnected or was replaced",
};

const digest = (secret: string): Buffer => createHash("sha256").update(secret).digest();

/** The gateway's key for an agent lease: the hex SHA-256 of its id (what tombstones use too); safe to pass around, reveals nothing of the secret. */
export const leaseKey = (leaseId: string): string => digest(leaseId).toString("hex");

/** A gated call renews the lease on every call, but only tells the UI and the disk about it this often (or when `gated` flips). */
const TOUCH_PUBLISH_MS = 15_000;

/** The server's local 24-hour HH:MM clock (the same machine as the browser), as lease texts and queue reasons print times. */
export const formatClock = (at: string | number | null): string => new Date(at ?? 0).toTimeString().slice(0, 5);

export function leaseView(l: Lease): LeaseView {
  return {
    ref: l.ref,
    serial: l.serial,
    platform: l.platform,
    avdName: l.avdName,
    holder: l.holder,
    reason: l.reason,
    source: l.source,
    ...(l.runId ? { runId: l.runId } : {}),
    ttlMinutes: l.ttlMinutes,
    acquiredAt: l.acquiredAt,
    renewedAt: l.renewedAt,
    expiresAt: l.expiresAt,
    gated: l.gated === true,
    claimPending: l.claimTicket !== undefined,
  };
}

const PersistedFile = z.object({ version: z.literal(1), leases: z.array(z.unknown()) });
const PersistedLease = z.object({
  leaseId: z.string().min(1),
  ref: z.string().min(1),
  serial: z.string().min(1),
  platform: z.enum(["android", "ios"]),
  avdName: z.string().nullable(),
  holder: z.string(),
  reason: z.string().nullable(),
  source: z.literal("agent"),
  cwd: z.string().optional(),
  ttlMinutes: z.number(),
  acquiredAt: z.string(),
  renewedAt: z.string(),
  expiresAt: z.string(),
  claimTicket: z.string().optional(),
  mobileDeviceId: z.string().min(1).optional(),
  gated: z.boolean().optional(),
});

export class LeaseStore {
  readonly bus = new EventEmitter<{ lease: [LeaseEvent] }>();
  /** The gateway key of every lease that ends, whatever the reason (an agent lease's `leaseKey`, a run lease's run id): the gateway stops that lease's child. Kept off `bus` so the digest never reaches SSE. */
  readonly ends = new EventEmitter<{ end: [string] }>();
  /** At most one lease per serial. */
  private leases = new Map<string, Lease>();
  /** Ended agent leases by sha256(leaseId), newest last, so a late renew can say why the lease is gone. */
  private tombstones = new Map<string, Tombstone>();
  private deps: LeaseStoreDeps;
  /** When each leased serial was first missing from `listDevices()` in a row. */
  private absentSince = new Map<string, number>();

  constructor(deps: Partial<LeaseStoreDeps> = {}) {
    this.deps = {
      file: null,
      now: Date.now,
      markAssigned: () => {},
      markReleased: () => {},
      isBootingSerial: () => false,
      deviceName: (serial) => serial,
      nextFor: () => null,
      ...deps,
    };
    this.bus.setMaxListeners(0);
    this.ends.setMaxListeners(0);
  }

  private isLive(l: Lease, now: number): boolean {
    return l.expiresAt === null || Date.parse(l.expiresAt) > now;
  }

  /** The single busy check. Synchronous; an expired agent lease counts as absent. */
  deviceOwner(serial: string, now = this.deps.now()): DeviceOwner | null {
    const lease = this.leases.get(serial);
    if (lease && this.isLive(lease, now)) return { kind: lease.source, lease };
    return this.deps.isBootingSerial(serial) ? { kind: "booting" } : null;
  }

  /** Records an expired lease still sitting on `serial` as ended, so a new grant can replace it; for a freshly booted device any agent lease goes. */
  private clear(serial: string, now: number, booted: boolean | undefined): void {
    const lease = this.leases.get(serial);
    if (!lease) return;
    if (!this.isLive(lease, now)) this.end(lease, "expired", now);
    else if (booted && lease.source === "agent") this.end(lease, "gone", now);
  }

  /** A grant that lost the race for `serial`; a booted device nobody can lease goes back to the pool's idle clock. */
  private busy(serial: string, booted: boolean | undefined): HttpError {
    if (booted) this.deps.markReleased(serial);
    return new HttpError(409, `${serial} is already held`, "device_busy");
  }

  private newLease(fields: Omit<Lease, "leaseId" | "ref" | "acquiredAt" | "renewedAt">, now: number): Lease {
    const stamp = new Date(now).toISOString();
    const lease: Lease = { leaseId: randomBytes(16).toString("base64url"), ref: randomBytes(4).toString("hex"), acquiredAt: stamp, renewedAt: stamp, ...fields };
    this.leases.set(lease.serial, lease);
    this.deps.markAssigned(lease.serial);
    return lease;
  }

  grantAgent(req: AgentGrant): Lease {
    const now = this.deps.now();
    this.clear(req.serial, now, req.booted);
    if (this.leases.has(req.serial)) throw this.busy(req.serial, req.booted);
    const ttlMinutes = Math.min(TTL.max, Math.max(TTL.min, Math.round(req.ttlMinutes ?? TTL.default)));
    const lease = this.newLease(
      {
        serial: req.serial,
        platform: req.platform,
        avdName: req.avdName,
        mobileDeviceId: mobileDeviceIdOf({ serial: req.serial, platform: req.platform, avdName: req.avdName }),
        holder: req.holder,
        reason: req.reason || null,
        source: "agent",
        ...(req.cwd ? { cwd: req.cwd } : {}),
        ttlMinutes,
        expiresAt: new Date(now + (req.claimTicket ? CLAIM_WINDOW_MS : ttlMinutes * 60_000)).toISOString(),
        ...(req.claimTicket ? { claimTicket: req.claimTicket } : {}),
      },
      now,
    );
    this.persist();
    this.emit("acquired", lease, null);
    return lease;
  }

  release(leaseId: string): Lease {
    const now = this.deps.now();
    const lease = this.lookup(leaseId, now);
    this.end(lease, "released", now);
    return lease;
  }

  /** UI force-release: ends any agent lease without the secret, guarded by its public `ref` against a stale page. */
  revoke(serial: string, ref: string): Lease {
    const now = this.deps.now();
    const lease = this.leases.get(serial);
    if (!lease || !this.isLive(lease, now)) throw new HttpError(404, `no lease on ${serial}`, "lease_not_found");
    if (lease.source === "run") throw new HttpError(409, `${serial} is held by a QA run; cancel the run to free it`, "held_by_run");
    if (lease.ref !== ref) throw new HttpError(409, `the lease on ${serial} changed hands`, "ref_mismatch");
    this.end(lease, "revoked", now);
    return lease;
  }

  grantRun(serial: string, run: { id: string; platform: Platform }, device: { avdName: string | null; booted?: boolean }): void {
    const now = this.deps.now();
    this.clear(serial, now, device.booted);
    const held = this.leases.get(serial);
    if (held) {
      // A leftover lease on a reused emulator port (another AVD now) is stale; anything else is a real conflict.
      const stale = held.source === "agent" && held.avdName !== null && device.avdName !== null && held.avdName !== device.avdName;
      if (!stale) throw this.busy(serial, device.booted);
      this.end(held, "gone", now);
    }
    this.newLease(
      { serial, platform: run.platform, avdName: device.avdName, mobileDeviceId: mobileDeviceIdOf({ serial, platform: run.platform, avdName: device.avdName }), holder: run.id, reason: null, source: "run", runId: run.id, ttlMinutes: 0, expiresAt: null },
      now,
    );
  }

  releaseRun(runId: string): void {
    const lease = this.runLease(runId);
    if (lease) this.end(lease, "released", this.deps.now());
  }

  runLease(runId: string): Lease | null {
    for (const l of this.leases.values()) if (l.source === "run" && l.runId === runId) return l;
    return null;
  }

  /** Run leases currently held (they count against `maxConcurrentRuns`). */
  runLeaseCount(): number {
    let n = 0;
    for (const l of this.leases.values()) if (l.source === "run") n++;
    return n;
  }

  /** Live agent leases as public views. */
  listLeases(now = this.deps.now()): LeaseView[] {
    return [...this.leases.values()].filter((l) => l.source === "agent" && this.isLive(l, now)).map(leaseView);
  }

  /** The live agent lease behind `leaseId`, or a 404 that names the end reason when this id is a known tombstone. */
  private lookup(leaseId: string, now: number): Lease {
    const wanted = digest(leaseId);
    for (const l of [...this.leases.values()]) {
      if (l.source !== "agent" || !timingSafeEqual(wanted, digest(l.leaseId))) continue;
      if (this.isLive(l, now)) return l;
      this.end(l, "expired", now);
    }
    // Tombstones are keyed by the SHA-256 of the id, so a plain map lookup leaks nothing about any live secret (no constant-time compare needed).
    const tomb = this.tombstones.get(wanted.toString("hex"));
    throw new HttpError(
      404,
      tomb ? `lease ended: ${WHY_TEXT[tomb.why]} at ${formatClock(tomb.endedAt)}` : "unknown or expired lease",
      "lease_not_found",
    );
  }

  /** Sets `expiresAt = now + ttl` (optionally with a new ttl). */
  renew(leaseId: string, ttlMinutes?: number): Lease {
    const now = this.deps.now();
    const lease = this.lookup(leaseId, now);
    if (ttlMinutes !== undefined) lease.ttlMinutes = Math.min(TTL.max, Math.max(TTL.min, Math.round(ttlMinutes)));
    lease.renewedAt = new Date(now).toISOString();
    delete lease.claimTicket;
    lease.expiresAt = new Date(now + lease.ttlMinutes * 60_000).toISOString();
    this.persist();
    this.emit("renewed", lease, null);
    return lease;
  }

  /**
   * A gated gateway call: renews like `renew` (`expiresAt = now + ttl`, ttl unchanged), marks the lease `gated` and returns it.
   * A busy agent calls this twice per tool call, so the lease is announced and saved only when `gated` flips or the last
   * published renewal is older than `TOUCH_PUBLISH_MS`; the in-memory expiry is always current.
   */
  touch(leaseId: string): Lease {
    const now = this.deps.now();
    const lease = this.lookup(leaseId, now);
    const flipped = lease.gated !== true;
    const stale = now - Date.parse(lease.renewedAt) >= TOUCH_PUBLISH_MS;
    lease.gated = true;
    delete lease.claimTicket;
    lease.expiresAt = new Date(now + lease.ttlMinutes * 60_000).toISOString();
    if (flipped || stale) {
      lease.renewedAt = new Date(now).toISOString();
      this.persist();
      this.emit("renewed", lease, null);
    }
    return lease;
  }

  /** Turns the claim-pending grant made for `ticket` into a full lease (`expiresAt = now + ttl`); null when there is none or its window ran out. */
  claim(ticket: string): Lease | null {
    const now = this.deps.now();
    for (const lease of this.leases.values()) {
      if (lease.claimTicket !== ticket || !this.isLive(lease, now)) continue;
      delete lease.claimTicket;
      lease.renewedAt = new Date(now).toISOString();
      lease.expiresAt = new Date(now + lease.ttlMinutes * 60_000).toISOString();
      this.persist();
      this.emit("renewed", lease, null);
      return lease;
    }
    return null;
  }

  /** Turns a lease granted to a call whose client has gone back into a claim-pending one for `ticket`, so nobody is left holding a device they never learned of. */
  holdForClaim(lease: Lease, ticket: string): void {
    if (this.leases.get(lease.serial) !== lease) return;
    lease.claimTicket = ticket;
    lease.expiresAt = new Date(this.deps.now() + CLAIM_WINDOW_MS).toISOString();
    this.persist();
    this.emit("renewed", lease, null);
  }

  /**
   * Ends agent leases that expired (a claim window counts), whose device has been absent from `devices` for two minutes,
   * or whose serial now belongs to a different AVD. Run leases are bounded by their run and left alone.
   */
  sweep(devices: readonly Device[], now = this.deps.now()): LeaseEvent[] {
    const events: LeaseEvent[] = [];
    for (const lease of [...this.leases.values()]) {
      if (lease.source !== "agent") continue;
      let why: EndWhy | null = null;
      const device = devices.find((d) => d.serial === lease.serial);
      if (!this.isLive(lease, now)) why = "expired";
      else if (!device) {
        const since = this.absentSince.get(lease.serial) ?? now;
        this.absentSince.set(lease.serial, since);
        if (now - since >= GONE_AFTER_MS) why = "gone";
      } else {
        this.absentSince.delete(lease.serial);
        if (lease.avdName !== null && device.avdName !== undefined && device.avdName !== lease.avdName) why = "gone";
      }
      const event = why && this.end(lease, why, now);
      if (event) events.push(event);
    }
    return events;
  }

  private emit(change: LeaseChange, lease: Lease, next: LeaseNext | null): LeaseEvent | null {
    if (lease.source !== "agent") return null;
    const event: LeaseEvent = {
      serial: lease.serial,
      deviceName: this.deps.deviceName(lease.serial),
      change,
      lease: change === "acquired" || change === "renewed" ? leaseView(lease) : null,
      next,
    };
    this.bus.emit("lease", event);
    return event;
  }

  /** Removes the lease, remembers its id, frees the pool slot and announces it. */
  private end(lease: Lease, why: EndWhy, now: number): LeaseEvent | null {
    this.leases.delete(lease.serial);
    this.absentSince.delete(lease.serial);
    if (lease.source === "agent") {
      this.tombstones.set(leaseKey(lease.leaseId), { serial: lease.serial, endedAt: now, why });
      while (this.tombstones.size > TOMBSTONES) this.tombstones.delete(this.tombstones.keys().next().value!);
    }
    this.deps.markReleased(lease.serial);
    this.persist();
    this.ends.emit("end", lease.source === "run" && lease.runId ? lease.runId : leaseKey(lease.leaseId));
    return this.emit(why, lease, this.deps.nextFor(lease.serial));
  }

  setNextResolver(fn: LeaseStoreDeps["nextFor"]): void {
    this.deps.nextFor = fn;
  }

  /** Writes `leases.json` (agent leases only; it holds secrets, so 0600) atomically. A failing disk must not break lease handling. */
  private persist(): void {
    const { file } = this.deps;
    if (!file) return;
    const leases = [...this.leases.values()].filter((l) => l.source === "agent");
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(`${file}.tmp`, JSON.stringify({ version: 1, leases }, null, 2), { mode: 0o600 });
      chmodSync(`${file}.tmp`, 0o600);
      renameSync(`${file}.tmp`, file);
    } catch (e) {
      console.error("could not save leases:", e);
    }
  }

  /** Loads `leases.json` once at startup: invalid and expired entries are dropped, claim windows too (tickets do not survive a restart). */
  restore(): void {
    const { file } = this.deps;
    if (!file || !existsSync(file)) return;
    let entries: unknown[] = [];
    try {
      const parsed = PersistedFile.safeParse(JSON.parse(readFileSync(file, "utf8")));
      if (parsed.success) entries = parsed.data.leases;
    } catch {
      // A corrupt file is the same as no file.
    }
    const now = this.deps.now();
    for (const entry of entries) {
      const lease = PersistedLease.safeParse(entry);
      if (!lease.success || lease.data.claimTicket !== undefined || Date.parse(lease.data.expiresAt) <= now) continue;
      if (this.leases.has(lease.data.serial)) continue;
      this.leases.set(lease.data.serial, {
        ...lease.data,
        mobileDeviceId: lease.data.mobileDeviceId ?? mobileDeviceIdOf({ serial: lease.data.serial, platform: lease.data.platform, avdName: lease.data.avdName }),
      });
      this.deps.markAssigned(lease.data.serial);
    }
    this.persist();
  }
}

// Pool and leases import each other; the hooks are arrows so no pool binding is read before the pool module has run.
const defaultStore = new LeaseStore({
  file: path.join(DATA_DIR, "leases.json"),
  markAssigned: (serial) => markAssigned(serial),
  markReleased: (serial) => markReleased(serial),
  isBootingSerial: (serial) => isBootingSerial(serial),
  deviceName: (serial) => lastDeviceSnapshot().devices.find((d) => d.serial === serial)?.name ?? serial,
});

/** Module-level API over the process-wide store (the scheduler, API and MCP use these; tests build their own `LeaseStore`). */
export const bus = defaultStore.bus;
export const ends = defaultStore.ends;
export const deviceOwner = (serial: string, now?: number) => defaultStore.deviceOwner(serial, now);
export const grantRun = (serial: string, run: { id: string; platform: Platform }, device: { avdName: string | null; booted?: boolean }) =>
  defaultStore.grantRun(serial, run, device);
export const releaseRun = (runId: string) => defaultStore.releaseRun(runId);
export const runLease = (runId: string) => defaultStore.runLease(runId);
export const runLeaseCount = () => defaultStore.runLeaseCount();
export const grantAgent = (req: AgentGrant) => defaultStore.grantAgent(req);
export const renew = (leaseId: string, ttlMinutes?: number) => defaultStore.renew(leaseId, ttlMinutes);
export const touch = (leaseId: string) => defaultStore.touch(leaseId);
export const release = (leaseId: string) => defaultStore.release(leaseId);
export const revoke = (serial: string, ref: string) => defaultStore.revoke(serial, ref);
export const claim = (ticket: string) => defaultStore.claim(ticket);
export const holdForClaim = (lease: Lease, ticket: string) => defaultStore.holdForClaim(lease, ticket);
export const listLeases = (now?: number) => defaultStore.listLeases(now);
export const sweep = (devices: readonly Device[], now?: number) => defaultStore.sweep(devices, now);
export const restore = () => defaultStore.restore();
/** The scheduler tells the store who would take a freed device, so `lease` events can say `next`. */
export const setNextResolver = (fn: LeaseStoreDeps["nextFor"]) => defaultStore.setNextResolver(fn);
