import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { api, screenUrl, type RunScreenshot } from "@/lib/api";

/** True when the viewport is at least `px` wide (matchMedia, so it follows window resizes). */
export function useMinWidth(px: number): boolean {
  const query = `(min-width: ${px}px)`;
  const subscribe = useCallback(
    (cb: () => void) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", cb);
      return () => mql.removeEventListener("change", cb);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches);
}

/**
 * Height that makes `ref` end at the bottom of the viewport (minus `bottomGap`), never below `min`.
 * Re-measured on resize and whenever content above the element changes the page layout.
 */
export function useFillHeight(ref: RefObject<HTMLElement | null>, min: number, bottomGap = 16): number {
  const [height, setHeight] = useState(min);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let frame = 0;
    const measure = () => {
      const top = el.getBoundingClientRect().top + window.scrollY;
      setHeight(Math.max(min, Math.floor(window.innerHeight - top - bottomGap)));
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("resize", schedule);
    const observer = new ResizeObserver(schedule);
    if (el.parentElement) observer.observe(el.parentElement);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      observer.disconnect();
    };
  }, [ref, min, bottomGap]);
  return height;
}

/** Page visibility; polling pauses while the tab is hidden. */
export function usePageVisible(): boolean {
  const subscribe = useCallback((cb: () => void) => {
    document.addEventListener("visibilitychange", cb);
    return () => document.removeEventListener("visibilitychange", cb);
  }, []);
  return useSyncExternalStore(subscribe, () => !document.hidden, () => true);
}

export interface ScreenshotsState {
  shots: RunScreenshot[];
  loading: boolean;
  error: string | null;
}

/** Run screenshots; refetched whenever `refreshKey` changes (a check resolved / the run ended). */
export function useScreenshots(runId: string, refreshKey: string): ScreenshotsState {
  const [state, setState] = useState<ScreenshotsState>({ shots: [], loading: true, error: null });
  const lastRun = useRef(runId);
  useEffect(() => {
    let cancelled = false;
    if (lastRun.current !== runId) {
      lastRun.current = runId;
      setState({ shots: [], loading: true, error: null });
    }
    api.screenshots(runId).then(
      (shots) => !cancelled && setState({ shots, loading: false, error: null }),
      (e: unknown) =>
        !cancelled && setState((s) => ({ shots: s.shots, loading: false, error: e instanceof Error ? e.message : String(e) })),
    );
    return () => {
      cancelled = true;
    };
  }, [runId, refreshKey]);
  return state;
}

export interface LiveScreen {
  src: string | null;
  /** Epoch ms of the last frame that loaded. */
  updatedAt: number | null;
  /** Round-trip of the last frame in ms. */
  latencyMs: number | null;
  failed: boolean;
}

const LIVE_POLL_MS = 1000;

/**
 * Polls the device PNG about once a second, swapping `src` only after the next frame has loaded
 * (no flicker), pausing while the tab is hidden.
 */
export function useLiveScreen(serial: string | null, enabled: boolean): LiveScreen {
  const visible = usePageVisible();
  const [state, setState] = useState<LiveScreen>({ src: null, updatedAt: null, latencyMs: null, failed: false });

  useEffect(() => {
    setState({ src: null, updatedAt: null, latencyMs: null, failed: false });
    if (!serial || !enabled || !visible) return;
    let cancelled = false;
    let timer: number | undefined;
    const load = () => {
      const started = Date.now();
      const url = screenUrl(serial, started);
      const img = new Image();
      const next = () => {
        if (!cancelled) timer = window.setTimeout(load, LIVE_POLL_MS);
      };
      img.onload = () => {
        if (cancelled) return;
        const now = Date.now();
        setState({ src: url, updatedAt: now, latencyMs: now - started, failed: false });
        next();
      };
      img.onerror = () => {
        if (cancelled) return;
        setState((s) => ({ ...s, failed: true }));
        next();
      };
      img.src = url;
    };
    load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [serial, enabled, visible]);

  return state;
}
