import { screenshotUrl, type Check, type RunScreenshot } from "@/lib/api";

/** One image of a run: either listed by `/api/runs/:id/screenshots` or referenced only by a check. */
export interface GalleryItem {
  key: string;
  url: string;
  name: string;
  checkId: string | null;
}

/**
 * Chronological list of every screenshot of a run: the files on disk first (oldest → newest), then check
 * screenshots the listing did not return (e.g. saved outside the run's screenshot folder).
 */
export function buildGallery(projectId: string, checks: readonly Check[], shots: readonly RunScreenshot[]): GalleryItem[] {
  const items: GalleryItem[] = [...shots]
    .sort((a, b) => Date.parse(a.mtime) - Date.parse(b.mtime))
    .map((s) => ({ key: s.path, url: s.url, name: s.name, checkId: s.checkId }));
  const known = new Set(shots.flatMap((s) => [s.path, s.url]));
  for (const c of checks) {
    if (!c.screenshot) continue;
    const url = screenshotUrl(projectId, c.screenshot);
    if (known.has(c.screenshot) || known.has(url)) continue;
    known.add(url);
    items.push({ key: c.screenshot, url, name: c.screenshot.split("/").pop() ?? c.screenshot, checkId: c.id });
  }
  return items;
}

export interface GalleryGroup {
  checkId: string | null;
  check: Check | null;
  items: GalleryItem[];
}

/** Gallery items grouped by check, in plan order; screenshots without a known check come last. */
export function groupGallery(items: readonly GalleryItem[], checks: readonly Check[]): GalleryGroup[] {
  const groups: GalleryGroup[] = [];
  for (const check of checks) {
    const mine = items.filter((i) => i.checkId === check.id);
    if (mine.length > 0) groups.push({ checkId: check.id, check, items: mine });
  }
  const rest = items.filter((i) => !i.checkId || !checks.some((c) => c.id === i.checkId));
  if (rest.length > 0) groups.push({ checkId: null, check: null, items: rest });
  return groups;
}

/** The image that proves a check: its own `screenshot`, else the newest file attributed to it. */
export function screenshotOfCheck(projectId: string, check: Check, items: readonly GalleryItem[]): GalleryItem | null {
  if (check.screenshot) {
    const url = screenshotUrl(projectId, check.screenshot);
    const hit = items.find((i) => i.url === url || i.key === check.screenshot);
    return hit ?? { key: check.screenshot, url, name: check.screenshot.split("/").pop() ?? check.screenshot, checkId: check.id };
  }
  return [...items].reverse().find((i) => i.checkId === check.id) ?? null;
}

/**
 * Wall time spent on a check: first `running` → first terminal status (or `now` while it runs). On a finished run
 * callers pass the run's end time as `now`, so a check stranded in `running` stops counting when the run ended.
 */
export function checkDurationMs(check: Check, now: number): number | null {
  if (!check.startedAt) return null;
  const end = check.endedAt ? Date.parse(check.endedAt) : check.status === "running" ? now : null;
  if (end === null) return null;
  return Math.max(0, end - Date.parse(check.startedAt));
}
