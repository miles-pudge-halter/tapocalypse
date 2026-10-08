import type { Device } from "./api";

export function formatDuration(startIso: string | null, endIso: string | null, now: number): string {
  if (!startIso) return "—";
  const end = endIso ? Date.parse(endIso) : now;
  const total = Math.max(0, Math.floor((end - Date.parse(startIso)) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" });

export function formatTime(iso: string | null): string {
  return iso ? timeFormat.format(new Date(iso)) : "—";
}

export function formatRelative(iso: string, now: number): string {
  const sec = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

export function formatCost(n: number | null): string {
  if (n === null) return "—";
  if (n > 0 && n < 0.005) return "<$0.01";
  return `$${n.toFixed(2)}`;
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${n < 10_000 ? (n / 1000).toFixed(1).replace(/\.0$/, "") : Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

export function formatDurationMs(ms: number | null): string {
  if (ms === null) return "—";
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function deviceDisplayName(d: Pick<Device, "serial" | "model" | "name">): string {
  return d.name || d.model || d.serial;
}

/** "Android 14 · 1440×3120 · emulator-5556" — missing parts are skipped. */
export function deviceSubtitle(d: Pick<Device, "serial" | "osVersion" | "screen">): string {
  return [d.osVersion, d.screen, d.serial].filter(Boolean).join(" · ");
}
