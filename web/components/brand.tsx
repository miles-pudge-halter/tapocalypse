import { useId } from "react";
import { cn } from "@/lib/utils";

const CREAM = "#F6EFE6";
const AMBER = "#FFC21A";

/**
 * The Tapocalypse mark. Three drawings by size: `micro` (< 48, full-bleed tile), `flat` (48-95) and `full`
 * (>= 96, gradient rim, glow, sparks). Decorative unless `title` is given. The `<span>` wrapper keeps the svg
 * from being shrunk by parents that force `[&>svg]:size-4`.
 */
export function LogoMark({ size = 32, title, className }: { size?: number; title?: string; className?: string }) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const a11y = title ? { role: "img", "aria-label": title } : { "aria-hidden": true };
  return (
    <span className={cn("inline-flex shrink-0", className)} style={{ width: size, height: size }}>
      <svg viewBox="0 0 200 200" width={size} height={size} {...a11y}>
        {size < 48 ? (
          <>
            <rect width="200" height="200" rx="46" className="fill-brand-tile" />
            <rect x="3" y="3" width="194" height="194" rx="43" fill="none" strokeWidth="6" className="stroke-brand-rim" />
            <rect x="50" y="18" width="100" height="164" rx="20" fill="none" stroke={CREAM} strokeWidth="18" />
            <rect x="66" y="44" width="68" height="24" rx="4" fill={AMBER} />
            <polygon points="86,68 118,68 108,100 128,100 92,162 100,114 78,114" fill={AMBER} strokeLinejoin="round" />
          </>
        ) : size < 96 ? (
          <>
            <rect x="10" y="10" width="180" height="180" rx="44" className="fill-brand-tile" />
            <rect x="12" y="12" width="176" height="176" rx="42" fill="none" strokeWidth="4" className="stroke-brand-rim" />
            <rect x="56" y="26" width="88" height="148" rx="16" fill="none" stroke={CREAM} strokeWidth="9" />
            <ellipse cx="96" cy="150" rx="22" ry="5.5" fill="none" stroke="#FF8A1F" strokeWidth="4" />
            <rect x="70" y="50" width="60" height="15" rx="3" fill={AMBER} />
            <polygon points="91,64 113,64 105,94 120,94 94,146 100,106 85,106" fill={AMBER} strokeLinejoin="round" />
          </>
        ) : (
          <>
            <defs>
              <linearGradient id={`${uid}-rim`} x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#FFF1B0" />
                <stop offset="0.5" stopColor={AMBER} />
                <stop offset="1" stopColor="#FF6A0D" />
              </linearGradient>
              <linearGradient id={`${uid}-bolt`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#FFF1B0" />
                <stop offset="0.4" stopColor={AMBER} />
                <stop offset="1" stopColor="#FF6A0D" />
              </linearGradient>
              <filter id={`${uid}-glow`} x="-60%" y="-30%" width="220%" height="160%">
                <feGaussianBlur stdDeviation="5" result="b" />
                <feMerge>
                  <feMergeNode in="b" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>
            <rect x="10" y="10" width="180" height="180" rx="44" fill="#1A120A" stroke={`url(#${uid}-rim)`} strokeWidth="5" />
            <line x1="44" y1="60" x2="30" y2="82" stroke="#FF6A0D" strokeWidth="4" strokeLinecap="round" opacity="0.6" />
            <line x1="44" y1="98" x2="34" y2="114" stroke="#FF6A0D" strokeWidth="3.5" strokeLinecap="round" opacity="0.4" />
            <line x1="160" y1="70" x2="170" y2="60" stroke={AMBER} strokeWidth="3.5" strokeLinecap="round" opacity="0.7" />
            <rect x="56" y="26" width="88" height="148" rx="16" fill="#0F0B07" stroke={CREAM} strokeWidth="7" />
            <rect x="88" y="34" width="24" height="4" rx="2" fill={CREAM} />
            <ellipse cx="96" cy="150" rx="34" ry="8" fill="none" stroke="#FF6A0D" strokeWidth="2" strokeDasharray="4 6" opacity="0.5" />
            <ellipse cx="96" cy="150" rx="22" ry="5.5" fill="none" stroke="#FF8A1F" strokeWidth="3" opacity="0.8" />
            <rect x="70" y="50" width="60" height="14" rx="3" fill={AMBER} filter={`url(#${uid}-glow)`} />
            <polygon
              points="91,64 113,64 105,94 120,94 94,146 100,106 85,106"
              fill={`url(#${uid}-bolt)`}
              stroke="#FFF1B0"
              strokeWidth="1.5"
              strokeLinejoin="round"
              filter={`url(#${uid}-glow)`}
            />
            <circle cx="95" cy="149" r="4" fill="#FFF1B0" />
          </>
        )}
      </svg>
    </span>
  );
}

// Chakra Petch 700 italic outlines at 100 units/em (cap height 70), so the viewBox is exactly cap-height tall.
const TAP =
  "M18.1 70L28.4 11.5L7.5 11.5L9.5 0L64.9 0L62.8 11.5L42 11.5L31.7 70M56.2 70L94.1 0L106.5 0L119.8 70L106 70L103.2 54.5L78.6 54.5L70 70L56.2 70M83.4 43.3L101.9 43.3L97.4 16.7L97.2 16.7M128.6 70L140.9 0L183.9 0L193.4 11.6L189 36.4L177.5 46.2L146.4 46.2L142.2 70L128.6 70M148.4 34.8L172.4 34.8L176.5 31.3L179.4 14.9L176.5 11.4L152.5 11.4";
const OCALYPSE =
  "M206.3 70L196.1 57.6L204.4 10.7L216.9 0L252.9 0L263.1 12.3L254.7 59.7L242.5 70L206.3 70M214.6 58.4L236.2 58.4L242.2 53.3L248.7 16.7L244.5 11.6L223 11.6L217 16.7L210.4 53.3M278 70L267.8 57.6L276.1 10.7L288.6 0L322.7 0L332.8 12.1L331 22L317.4 22L318.4 16.3L314.6 11.6L294.6 11.6L288.6 16.7L282.1 53.3L286.3 58.4L306.3 58.4L311.8 53.7L312.9 48L326.5 48L324.4 59.5L312.1 70M327.8 70L365.7 0L378.1 0L391.4 70L377.6 70L374.8 54.5L350.2 54.5L341.6 70L327.8 70M355 43.3L373.5 43.3L369 16.7L368.8 16.7M400.2 70L412.5 0L426.1 0L415.8 58.5L450.7 58.5L448.7 70M476.5 70L481.5 41.4L463.9 0L478 0L489.6 28.7L489.8 28.7L511.6 0L527.3 0L495.1 41.4L490.1 70M523.2 70L535.5 0L578.5 0L588 11.6L583.6 36.4L572.1 46.2L541 46.2L536.8 70L523.2 70M543 34.8L567 34.8L571.1 31.3L574 14.9L571.1 11.4L547.1 11.4M599.6 70L590 58.4L591.7 49.2L605.1 49.2L604 55.1L606.7 58.4L627.3 58.4L631.3 55L633.4 43.4L630.7 40.1L605 40.1L595.4 28.5L598.6 10L610.4 0L641.9 0L651.6 11.6L650 20.9L636.6 20.9L637.6 14.9L634.9 11.6L615.1 11.6L611.2 14.9L609.4 25.2L612.1 28.5L637.8 28.5L647.4 40.1L643.8 60L632.1 70M654.9 70L667.2 0L717.7 0L715.7 11.5L678.8 11.5L675.7 29.2L709.7 29.2L707.7 40.5L673.7 40.5L670.5 58.5L707.4 58.5L705.4 70";

/**
 * The outlined "TAPOCALYPSE" logotype. Height comes from the caller; width follows the viewBox. "TAP" uses the
 * brand colour, the rest inherits `currentColor`.
 */
export function Wordmark({ className }: { className?: string }) {
  return (
    <svg viewBox="7 0 711 70" role="img" aria-label="Tapocalypse" className={cn("h-3 w-auto shrink-0", className)}>
      <path className="fill-brand-tap" d={TAP} />
      <path fill="currentColor" d={OCALYPSE} />
    </svg>
  );
}

export function Lockup({ size }: { size: "sm" | "lg" }) {
  if (size === "sm") {
    return (
      <div className="flex items-center gap-2">
        <LogoMark size={24} />
        <Wordmark className="h-2.5" />
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row sm:gap-6">
      <LogoMark size={96} />
      <div className="flex max-w-full flex-col items-center gap-3 sm:items-start">
        <Wordmark className="h-5 sm:h-7" />
        <div className="flex items-center gap-3">
          <span aria-hidden className="h-[3px] w-8 rounded-full bg-brand-orange" />
          <span className="font-mono text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
            Agentic mobile QA
          </span>
        </div>
      </div>
    </div>
  );
}
