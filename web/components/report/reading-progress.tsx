import { useState, type RefObject } from "react";
import { useScrollSync } from "./use-scroll";

/** Thin bar pinned to the top of the viewport showing how far the page has been scrolled. */
export function ReadingProgress({ anchor, resetKey }: { anchor: RefObject<HTMLElement | null>; resetKey: unknown }) {
  const [progress, setProgress] = useState(0);

  useScrollSync(
    anchor,
    ({ top, range }) => setProgress(range > 0 ? Math.min(1, Math.max(0, top / range)) : 0),
    resetKey,
  );

  return (
    <div
      role="progressbar"
      aria-label="Reading progress"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(progress * 100)}
      className="pointer-events-none fixed inset-x-0 top-0 z-50 h-0.5"
    >
      <div className="h-full origin-left bg-(image:--brand-thunder)" style={{ transform: `scaleX(${progress})` }} />
    </div>
  );
}
