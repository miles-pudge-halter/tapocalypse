import { leaseFraction, leaseLeft } from "@/lib/format";
import { useNow } from "@/lib/hooks";
import { cn } from "@/lib/utils";

const CIRCUMFERENCE = 97.4;
const WARN_MS = 120_000;

/**
 * A draining ring: full right after a lease is granted or renewed, empty at expiry. Size 32 carries the time left in its
 * centre; size 12 is a glyph next to text that already says it. The last two minutes turn orange.
 */
export function LeaseRing({
  lease,
  size,
  className,
}: {
  lease: { renewedAt: string; expiresAt: string | null };
  size: 12 | 32;
  className?: string;
}) {
  const remaining = lease.expiresAt ? Date.parse(lease.expiresAt) - Date.now() : Number.POSITIVE_INFINITY;
  // Cards with minutes left need no per-second re-render.
  const now = useNow(remaining < WARN_MS ? 1_000 : 5_000);
  if (!lease.expiresAt) return null;
  const fraction = leaseFraction({ renewedAt: lease.renewedAt, expiresAt: lease.expiresAt }, now);
  const left = leaseLeft(lease.expiresAt, now);
  const expiring = Date.parse(lease.expiresAt) - now < WARN_MS;
  const ring = (
    <svg
      viewBox="0 0 36 36"
      className={cn("size-full -rotate-90", size === 12 && "shrink-0")}
      fill="none"
      aria-hidden={size === 12 ? true : undefined}
    >
      <circle cx="18" cy="18" r="15.5" className="stroke-border" strokeWidth={size === 32 ? 3 : 4} />
      {fraction > 0 && (
        <circle
          cx="18"
          cy="18"
          r="15.5"
          className={cn(
            "motion-safe:transition-[stroke-dasharray] motion-safe:duration-1000 motion-safe:ease-linear",
            expiring ? "stroke-orange-400" : "stroke-violet-500 dark:stroke-violet-400",
          )}
          strokeWidth={size === 32 ? 3 : 4}
          strokeLinecap="round"
          strokeDasharray={`${fraction * CIRCUMFERENCE} ${CIRCUMFERENCE}`}
        />
      )}
    </svg>
  );
  if (size === 12) return <span className={cn("inline-flex size-3 shrink-0", className)}>{ring}</span>;
  return (
    <span role="img" aria-label={`${left} left`} className={cn("relative inline-flex size-8 shrink-0", className)}>
      {ring}
      <span className="absolute inset-0 grid place-items-center text-[10px] font-medium tabular-nums text-foreground">{left}</span>
    </span>
  );
}
