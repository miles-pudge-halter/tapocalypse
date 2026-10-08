import { useEffect, useEffectEvent, type RefObject } from "react";

/** The element that scrolls the page content: the nearest scrollable ancestor, or the window. */
export type Scroller = HTMLElement | Window;

export function findScroller(el: HTMLElement): Scroller {
  for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") return node;
  }
  return window;
}

export interface ScrollMetrics {
  /** Distance scrolled from the top, in px. */
  top: number;
  /** Scrollable distance (content height minus viewport height), in px. */
  range: number;
  /** Viewport top edge in client coordinates (0 for the window). */
  viewportTop: number;
}

export function readMetrics(scroller: Scroller): ScrollMetrics {
  if (scroller instanceof Window) {
    const doc = document.documentElement;
    return { top: scroller.scrollY, range: doc.scrollHeight - scroller.innerHeight, viewportTop: 0 };
  }
  return {
    top: scroller.scrollTop,
    range: scroller.scrollHeight - scroller.clientHeight,
    viewportTop: scroller.getBoundingClientRect().top,
  };
}

/**
 * Calls `onScroll` (coalesced to one call per frame) with fresh metrics whenever the scroller of `anchor`
 * scrolls or the window resizes, and once after mount and whenever `resetKey` changes.
 */
export function useScrollSync(
  anchor: RefObject<HTMLElement | null>,
  onScroll: (metrics: ScrollMetrics) => void,
  resetKey: unknown,
): void {
  const notify = useEffectEvent(onScroll);

  useEffect(() => {
    const el = anchor.current;
    if (!el) return;
    const scroller = findScroller(el);
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        notify(readMetrics(scroller));
      });
    };
    scroller.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    schedule();
    return () => {
      scroller.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [anchor, resetKey]);
}
