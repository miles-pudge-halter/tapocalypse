/**
 * Lightning on activation: a click (mouse, touch, Enter/Space, which all dispatch `click`) inside a `.strike` host marks it
 * with `data-strike`, which plays the arc defined by the `strike` utility in index.css once; `animationend` clears the mark so
 * the next activation plays again. One delegated listener serves every host; hosts that unmount mid-strike need no cleanup.
 */
const HOST = ".strike";
const ATTR = "data-strike";
const TRAVEL = "strike-travel";

/** Plays the arc once on `host` (restarting it mid-strike); a no-op under reduced motion, where no `animationend` would clear the mark. */
export function strikeOnce(host: HTMLElement): void {
  // Without motion there is no animation and so no `animationend` to clear the mark.
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  // Re-activation mid-strike restarts the arc: the attribute has to go away for a style flush before coming back.
  if (host.hasAttribute(ATTR)) {
    host.removeAttribute(ATTR);
    void host.offsetWidth;
  }
  host.setAttribute(ATTR, "");
}

function onClick(e: MouseEvent): void {
  if (!(e.target instanceof Element)) return;
  const host = e.target.closest<HTMLElement>(HOST);
  if (!host || host.matches(":disabled, [aria-disabled='true']")) return;
  strikeOnce(host);
}

function onAnimationDone(e: AnimationEvent): void {
  if (e.animationName !== TRAVEL || !(e.target instanceof HTMLElement)) return;
  if (e.target.matches(HOST)) e.target.removeAttribute(ATTR);
}

/** Installs the delegated listeners once; returns the uninstaller. */
export function installStrike(root: Document = document): () => void {
  root.addEventListener("click", onClick);
  root.addEventListener("animationend", onAnimationDone);
  root.addEventListener("animationcancel", onAnimationDone);
  return () => {
    root.removeEventListener("click", onClick);
    root.removeEventListener("animationend", onAnimationDone);
    root.removeEventListener("animationcancel", onAnimationDone);
  };
}
