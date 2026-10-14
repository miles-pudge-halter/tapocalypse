import type { HubAttribution, Ref, HubErrorCode, HubMachine, HubStatus, HubSync, RunView, LaneCell, OverviewShow, Platform, ProjectOverview, RefSummary, ReleaseCell, ReleaseView, Verdict } from "./api";
import { formatTime } from "./format";

/** The URL when it is an absolute https link, else null: uploaded data (a PR url) never becomes a clickable `http:`, `javascript:` or relative link. */
export function externalUrl(value: string | null | undefined): string | null {
  return value && /^https:\/\/[^/\s]/.test(value) ? value : null;
}

// --- people and machines ---

/** "ann.lee@acme.dev" → "Ann"; "ann" → "ann"; null → null. */
export function displayPerson(uploader: string | null): string | null {
  if (uploader === null) return null;
  const at = uploader.indexOf("@");
  if (at < 0) return uploader;
  const first = uploader.slice(0, at).split(/[._+-]/)[0] ?? "";
  return first ? first.charAt(0).toUpperCase() + first.slice(1) : uploader;
}

/** `short`: "by Ann on ann-mbp" or "from ann-mbp"; `long`: the full sentence for a tooltip. */
export function attribution(hub: Pick<HubAttribution, "machine" | "uploader" | "receivedAt">): { short: string; long: string } {
  const person = displayPerson(hub.uploader);
  return {
    short: person ? `by ${person} on ${hub.machine}` : `from ${hub.machine}`,
    long: `Uploaded ${formatTime(hub.receivedAt)}${hub.uploader ? ` by ${hub.uploader}` : ""} from the machine “${hub.machine}”`,
  };
}

/** Compact form for release/overview lines: the person when known (machine in the tooltip), else the machine. */
export function briefAttribution(machine: string | null, uploader: string | null): { text: string; title: string } | null {
  if (!machine) return null;
  const person = displayPerson(uploader);
  if (!person) return { text: `from ${machine}`, title: `from ${machine}` };
  return { text: `by ${person}`, title: `by ${uploader} on ${machine}` };
}

const SKEW_LIMIT_MS = 5 * 60_000;
const IDLE_MS = 7 * 24 * 60 * 60_000;
const RECENT_MS = 24 * 60 * 60_000;

/** The flags a machine row shows: revoked token, clock skew beyond 5 minutes, no upload in 7 days. */
export function machineNotes(m: HubMachine, now: number): { revoked: boolean; skew: string | null; idle: boolean } {
  let skew: string | null = null;
  if (m.clockSkewMs !== null && Math.abs(m.clockSkewMs) > SKEW_LIMIT_MS) {
    skew = `clock ${Math.round(Math.abs(m.clockSkewMs) / 60_000)} min ${m.clockSkewMs > 0 ? "ahead" : "behind"}`;
  }
  const idle = m.lastUploadAt === null || now - Date.parse(m.lastUploadAt) >= IDLE_MS;
  return { revoked: m.revoked, skew, idle };
}

/** Machine count, newest upload, whether anything arrived in the last 24 h, and the machines newest first (never-uploaded last). */
export function machinesSummary(
  machines: HubMachine[],
  now: number,
): { count: number; lastUploadAt: string | null; recent: boolean; sorted: HubMachine[] } {
  const sorted = [...machines].sort((a, b) => {
    if (a.lastUploadAt === b.lastUploadAt) return a.name.localeCompare(b.name);
    if (a.lastUploadAt === null) return 1;
    if (b.lastUploadAt === null) return -1;
    return Date.parse(b.lastUploadAt) - Date.parse(a.lastUploadAt);
  });
  const lastUploadAt = sorted[0]?.lastUploadAt ?? null;
  return { count: machines.length, lastUploadAt, recent: lastUploadAt !== null && now - Date.parse(lastUploadAt) < RECENT_MS, sorted };
}

// --- project overview ---

/** Pass-rate change against the previous window, in whole percentage points. */
export function passRateDelta(rate: ProjectOverview["passRate"]): { kind: "none" | "same" | "up" | "down"; points: number } {
  if (rate.current === null || rate.previous === null) return { kind: "none", points: 0 };
  const diff = (rate.current - rate.previous) * 100;
  if (Math.abs(diff) < 1) return { kind: "same", points: 0 };
  return { kind: diff > 0 ? "up" : "down", points: Math.round(Math.abs(diff)) };
}

const FIRST_SYNC_MS = 60 * 60_000;
const QUIET_MS = 2 * 60_000;

/**
 * Whether a project is still receiving its first backfill: first seen within the hour and something arrived in the last 2 minutes.
 * Once the uploaders go quiet the banner clears, because no machine has queued work left to send.
 */
export function firstSyncInProgress(project: Pick<ProjectOverview["project"], "firstSeenAt" | "lastUploadAt">, now: number): boolean {
  if (project.firstSeenAt === null || project.lastUploadAt === null) return false;
  return now - Date.parse(project.firstSeenAt) < FIRST_SYNC_MS && now - Date.parse(project.lastUploadAt) < QUIET_MS;
}

type TrendDay = ProjectOverview["trend"][number];
export type TrendKind = "pass" | "issues" | "fail" | "other";
const TREND_KINDS: readonly TrendKind[] = ["pass", "issues", "fail", "other"];

export const TREND_COLUMN = 10;
const BAR_X = 1.5;
const BAR_AREA = 96;
const BAR_BOTTOM = 98;
const BAR_MIN = 3;

export interface TrendBar {
  x: number;
  empty: boolean;
  /** Bottom-up: pass first. */
  segments: { kind: TrendKind; y: number; height: number }[];
}

/** SVG geometry of the stacked daily bars (viewBox `0 0 days×10 100`); the busiest day fills 96 units, any run shows at least 3. */
export function trendBars(trend: TrendDay[]): TrendBar[] {
  const busiest = Math.max(1, ...trend.map((d) => d.runs));
  return trend.map((day, i) => {
    const x = i * TREND_COLUMN + BAR_X;
    if (day.runs === 0) return { x, empty: true, segments: [] };
    const parts = TREND_KINDS.map((kind) => ({ kind, count: day[kind] })).filter((p) => p.count > 0);
    if (parts.length === 0) parts.push({ kind: "other", count: day.runs });
    const total = parts.reduce((sum, p) => sum + p.count, 0);
    const height = Math.max(BAR_MIN, (day.runs / busiest) * BAR_AREA);
    let top = BAR_BOTTOM;
    const segments = parts.map((p) => {
      const h = (p.count / total) * height;
      top -= h;
      return { kind: p.kind, y: top, height: h };
    });
    return { x, empty: false, segments };
  });
}

/** "Mon 12 Oct · 4 runs · 3 pass · 1 fail"; zero parts are left out. */
export function trendTooltip(dateLabel: string, day: TrendDay): string {
  if (day.runs === 0) return `${dateLabel} · no runs`;
  const parts = [
    `${day.runs} ${day.runs === 1 ? "run" : "runs"}`,
    day.pass > 0 ? `${day.pass} pass` : null,
    day.issues > 0 ? `${day.issues} with issues` : null,
    day.fail > 0 ? `${day.fail} fail` : null,
    day.other > 0 ? `${day.other} other` : null,
  ];
  return [dateLabel, ...parts.filter(Boolean)].join(" · ");
}

export type LaneRow = ProjectOverview["lanes"][number];
export type LaneSort = "problems" | "recent" | "title";

export function laneCells(lane: LaneRow): LaneCell[] {
  return Object.values(lane.platforms).filter((c): c is LaneCell => c !== undefined);
}

/** 0 = most urgent: a FAIL that newly failed, FAIL, BLOCKED, issues or partial, no verdict, PASS. */
function cellTier(cell: LaneCell): number {
  switch (cell.latest.verdict) {
    case "FAIL":
      return cell.newlyFailing > 0 ? 0 : 1;
    case "BLOCKED":
      return 2;
    case "PASS WITH ISSUES":
    case "PARTIAL":
      return 3;
    case null:
      return 4;
    case "PASS":
      return 5;
  }
}

function newestAt(lane: LaneRow): number {
  return Math.max(0, ...laneCells(lane).map((c) => Date.parse(c.latest.createdAt)));
}

export function sortLanes(lanes: LaneRow[], sort: LaneSort): LaneRow[] {
  const tier = (l: LaneRow) => Math.min(6, ...laneCells(l).map(cellTier));
  return [...lanes].sort((a, b) => {
    if (sort === "title") return a.title.localeCompare(b.title);
    if (sort === "problems" && tier(a) !== tier(b)) return tier(a) - tier(b);
    return newestAt(b) - newestAt(a);
  });
}

export function filterLanes(lanes: LaneRow[], filter: { show: OverviewShow | null; q: string }): LaneRow[] {
  const q = filter.q.trim().toLowerCase();
  return lanes.filter((lane) => {
    if (q && !lane.title.toLowerCase().includes(q)) return false;
    const cells = laneCells(lane);
    if (filter.show === "failing") return cells.some((c) => c.latest.verdict === "FAIL" || c.latest.verdict === "BLOCKED");
    if (filter.show === "newly_failing") return cells.some((c) => c.newlyFailing > 0);
    if (filter.show === "flaky") return cells.some((c) => c.flaky > 0);
    return true;
  });
}

export const PLATFORM_ORDER: readonly Platform[] = ["android", "ios"];

// --- releases ---

export type ReleaseBannerKind = "blockers" | "issues" | "pass" | "none";

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function releaseCells(test: ReleaseView["tests"][number]): ReleaseCell[] {
  return Object.values(test.cells).filter((c): c is ReleaseCell => c !== null);
}

/** The callout above a release: blockers first, then issues, all passing, or no results. */
export function releaseBanner(view: ReleaseView): { kind: ReleaseBannerKind; title: string; description: string } {
  const total = view.tests.length;
  const verdictsOf = (t: ReleaseView["tests"][number]) => releaseCells(t).map((c) => c.latest.verdict);
  const cleanTests = view.tests.filter((t) => {
    const v = verdictsOf(t);
    return v.length > 0 && v.every((x) => x === "PASS");
  }).length;
  if (view.blockers.length > 0) {
    const device = (key: string) => view.devices.find((d) => d.key === key)?.name ?? key;
    const named = view.blockers
      .slice(0, 2)
      .map((b) => `“${b.title}” ${b.cell.latest.verdict === "BLOCKED" ? "could not be tested" : "fails"} on ${device(b.deviceKey)}`)
      .join("; ");
    const more = view.blockers.length - 2;
    return {
      kind: "blockers",
      title: plural(view.blockers.length, "blocker", "blockers"),
      description: `${named}${more > 0 ? ` and ${more} more.` : "."} ${cleanTests} of ${total} tests pass.`,
    };
  }
  const withVerdict = view.tests.filter((t) => verdictsOf(t).some((v) => v !== null));
  if (withVerdict.length === 0) return { kind: "none", title: "No results yet", description: "Runs in this release ended without a verdict." };
  const issueTests = view.tests.filter((t) => verdictsOf(t).some((v) => v === "PASS WITH ISSUES" || v === "PARTIAL")).length;
  if (issueTests > 0) {
    return {
      kind: "issues",
      title: `No blockers. ${plural(issueTests, "test", "tests")} passed with issues`,
      description: `${cleanTests} of ${total} tests pass cleanly. Open a test to read the issues.`,
    };
  }
  return { kind: "pass", title: `All ${total} tests pass`, description: "On the latest run of each test on each device." };
}

type Blocker = ReleaseView["blockers"][number];

/** Newly failing first, then the most recent run. */
export function blockerGroups(blockers: Blocker[]): { failing: Blocker[]; blocked: Blocker[] } {
  const order = (a: Blocker, b: Blocker) =>
    b.cell.newlyFailing - a.cell.newlyFailing || Date.parse(b.cell.latest.createdAt) - Date.parse(a.cell.latest.createdAt);
  return {
    failing: blockers.filter((b) => b.cell.latest.verdict === "FAIL").sort(order),
    blocked: blockers.filter((b) => b.cell.latest.verdict === "BLOCKED").sort(order),
  };
}

function rowTier(cells: ReleaseCell[]): number {
  const verdicts = cells.map((c) => c.latest.verdict);
  if (verdicts.includes("FAIL")) return 0;
  if (verdicts.includes("BLOCKED")) return 1;
  if (verdicts.includes("PASS WITH ISSUES") || verdicts.includes("PARTIAL")) return 2;
  if (verdicts.includes(null) || verdicts.length === 0) return 3;
  return 4;
}

/** Matrix rows filtered by title (case-insensitive), the ones with fails first, A–Z inside a tier. */
export function matrixRows(tests: ReleaseView["tests"], q: string, group: "device" | "platform" = "device"): ReleaseView["tests"] {
  const needle = q.trim().toLowerCase();
  const cellsOf = (t: ReleaseView["tests"][number]) =>
    group === "platform" ? Object.values(t.platforms).filter((c): c is ReleaseCell => c !== undefined) : releaseCells(t);
  return tests
    .filter((t) => !needle || t.title.toLowerCase().includes(needle))
    .sort((a, b) => rowTier(cellsOf(a)) - rowTier(cellsOf(b)) || a.title.localeCompare(b.title));
}

/** "Ann, ben-pc and 2 more" (the person when known, else the machine) plus the full list for a tooltip. */
export function testedBy(machines: { name: string; uploader: string | null }[]): { text: string | null; all: string } {
  const names = machines.map((m) => displayPerson(m.uploader) ?? m.name);
  const all = machines.map((m, i) => (displayPerson(m.uploader) ? `${names[i]} on ${m.name}` : m.name)).join(", ");
  const unique = [...new Set(names)];
  if (unique.length === 0) return { text: null, all };
  const shown = unique.slice(0, 2);
  const rest = unique.length - shown.length;
  const joined = shown.length === 2 && rest === 0 ? `${shown[0]} and ${shown[1]}` : shown.join(", ");
  return { text: rest > 0 ? `${joined} and ${rest} more` : joined, all };
}

export type ReleaseStatusKind = "blockers" | "issues" | "partial" | "none" | "pass";

/**
 * Chip for a release row: blockers (fail + blocked) beat issues, which beat incomplete lanes (partial or without a verdict), which beat all passing.
 * Only a release whose every lane passed is "pass"; no lanes at all is "none".
 */
export function releaseStatus(lanes: RefSummary["lanes"]): { kind: ReleaseStatusKind; count: number } {
  const blockers = lanes.fail + lanes.blocked;
  if (blockers > 0) return { kind: "blockers", count: blockers };
  if (lanes.issues > 0) return { kind: "issues", count: lanes.issues };
  if (lanes.other > 0) return { kind: "partial", count: lanes.other };
  if (lanes.pass === 0) return { kind: "none", count: 0 };
  return { kind: "pass", count: 0 };
}

const STATUS_TEXT: Record<Exclude<ReleaseStatusKind, "blockers">, (count: number) => string> = {
  issues: (n) => `${n} with issues`,
  partial: (n) => `${n} incomplete`,
  none: () => "no results",
  pass: () => "all passing",
};

/** "2 blockers", "1 with issues", "3 incomplete", "no results" or "all passing". */
export function releaseStatusText(status: { kind: ReleaseStatusKind; count: number }): string {
  return status.kind === "blockers" ? plural(status.count, "blocker", "blockers") : STATUS_TEXT[status.kind](status.count);
}

/**
 * What a 404 on a project page means: an unknown ref (the page shows "No runs for <ref>") or an unknown project.
 * The server's `code` decides when it sends one; otherwise a project the hub lists means the ref is the missing part.
 */
export function missingKind(error: { status: number | null; code: string | null }, projectKnown: boolean): "ref" | "project" | null {
  if (error.status !== 404) return null;
  if (error.code === "unknown_ref") return "ref";
  if (error.code === "unknown_project") return "project";
  return projectKnown ? "ref" : "project";
}

/** The release with the newest activity (what the overview's "what changed" card shows), null without releases. */
export function latestRelease(refs: RefSummary[]): RefSummary | null {
  return refs.reduce<RefSummary | null>((best, r) => (r.release && (best === null || r.lastAt > best.lastAt) ? r : best), null);
}

/** The ref picker's groups: release versions, release branches, then other branches (default first). */
export function groupRefs(refs: RefSummary[]): { versions: RefSummary[]; releaseBranches: RefSummary[]; branches: RefSummary[] } {
  return {
    versions: refs.filter((r) => r.ref.kind === "version"),
    releaseBranches: refs.filter((r) => r.ref.kind === "branch" && r.release),
    branches: refs.filter((r) => r.ref.kind === "branch" && !r.release).sort((a, b) => Number(b.isDefaultBranch) - Number(a.isDefaultBranch)),
  };
}

// --- laptop: per-run sync state ---

export type ChipTone = "muted" | "busy" | "done" | "warn" | "error";

/** "in 4 min", "in 30s" or "now" for a retry time. */
function formatIn(iso: string, now: number): string {
  const ms = Date.parse(iso) - now;
  if (ms <= 0) return "now";
  if (ms < 60_000) return `in ${Math.ceil(ms / 1000)}s`;
  const min = Math.ceil(ms / 60_000);
  return min < 60 ? `in ${min} min` : `in ${Math.ceil(min / 60)} h`;
}

const SYNC_TEXT: Record<Exclude<HubSync["state"], "failed" | "uploaded">, { text: string; tone: ChipTone }> = {
  waiting: { text: "Team hub: after it finishes", tone: "muted" },
  local: { text: "Not on team hub", tone: "muted" },
  queued: { text: "Queued for team hub", tone: "muted" },
  uploading: { text: "Uploading to team hub…", tone: "busy" },
  outdated: { text: "Team hub update queued", tone: "muted" },
  paused: { text: "Team hub uploads paused", tone: "warn" },
  parked: { text: "Not uploaded: id taken on hub", tone: "error" },
};

/** Text, tone and whether the chip links to the hub copy, for a run's `hubSync`. */
export function syncChip(sync: HubSync, now: number): { text: string; tone: ChipTone; opensHub: boolean } {
  if (sync.state === "uploaded") return { text: "On team hub", tone: "done", opensHub: sync.url !== null };
  if (sync.state === "failed") {
    return { text: sync.nextAttemptAt ? `Upload failed · retrying ${formatIn(sync.nextAttemptAt, now)}` : "Upload failed", tone: "warn", opensHub: false };
  }
  return { ...SYNC_TEXT[sync.state], opensHub: false };
}

/** The sentence explaining an upload problem; `host` is the hub's host (null when unknown). */
export function syncReason(error: { code: HubErrorCode; detail: string }, host: string | null): string {
  const hub = host ?? "the hub";
  switch (error.code) {
    case "unauthorized":
      return "The hub rejected this machine's upload token. Paste a new token in Setup → Connect to a team hub.";
    case "proxy_login":
      return "The access proxy asked for a login instead of passing the upload through. Add the headers it accepts from machines in Setup, or ask your admin to let /api/hub/v1/ through.";
    case "protocol_unsupported":
      return "The hub needs a newer Tapocalypse on this machine. Update it, then retry.";
    case "id_conflict":
      return "Another machine already uploaded a run with this id. This run stays on this machine; nothing on the hub was overwritten.";
    case "unreachable":
      return `Could not reach ${hub}: ${error.detail}. Uploads retry on their own.`;
    case "too_large":
      return `The hub refused the upload as too large: ${error.detail}.`;
    case "not_a_hub":
      return `${hub} answered, but not like a Tapocalypse hub. Check the address in Setup.`;
    case "other":
      return error.detail;
  }
}

export type PillTone = "ok" | "busy" | "warn" | "error" | "muted";

/** The Setup status pill. */
export function hubStatusPill(status: HubStatus): { tone: PillTone; text: string } {
  if (!status.configured) return { tone: "muted", text: "Not connected" };
  if (status.paused) return { tone: "warn", text: "Uploads paused" };
  switch (status.connection.state) {
    case "ok":
      return { tone: "ok", text: `Connected as ${status.connection.machine ?? "this machine"}` };
    case "unauthorized":
    case "proxy_login":
    case "not_a_hub":
      return { tone: "error", text: "Can't upload" };
    case "unreachable":
      return { tone: "warn", text: "Hub unreachable" };
    case "protocol_unsupported":
      return { tone: "warn", text: "Update needed" };
    case "unknown":
      return { tone: "muted", text: "Not tested yet" };
  }
}

/** The Projects page pill; null when no hub is configured. */
export function hubQueueChip(status: HubStatus): { tone: PillTone; text: string } | null {
  if (!status.configured) return null;
  if (status.paused) return { tone: "warn", text: "Team hub: paused" };
  if (status.queue.failed > 0) return { tone: "warn", text: `Team hub: ${status.queue.failed} failed` };
  if (status.queue.waiting > 0) return { tone: "busy", text: `Team hub: ${status.queue.waiting} waiting` };
  return { tone: "ok", text: "Team hub: all uploaded" };
}

const URL_ERROR = "Use the hub's https:// address.";

/** https only, except for a hub on this machine. */
export function hubUrlError(value: string): string | null {
  return /^https:\/\/[^/\s]/.test(value.trim()) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(value.trim()) ? null : URL_ERROR;
}

export function hubTokenError(value: string): string | null {
  return value === "" || value.startsWith("tpu_") ? null : "Upload tokens start with tpu_.";
}

export interface HeaderRow {
  name: string;
  value: string;
  /** The name is already saved: an empty value keeps the saved secret. */
  saved: boolean;
}

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/** The `headers` field of `PUT /api/hub/connection`: untouched saved rows send null (keep), typed values replace, no rows clears. */
export function headersInput(
  rows: HeaderRow[],
  hadSaved: boolean,
): { ok: true; headers: Record<string, string | null> | undefined } | { ok: false; error: string } {
  const headers: Record<string, string | null> = {};
  const seen = new Set<string>();
  for (const row of rows) {
    const name = row.name.trim();
    if (!name) continue;
    if (!HEADER_NAME.test(name)) return { ok: false, error: `${name} is not a valid header name.` };
    if (seen.has(name.toLowerCase())) return { ok: false, error: `Header ${name} appears twice.` };
    seen.add(name.toLowerCase());
    if (row.value === "" && !row.saved) return { ok: false, error: `Header ${name} needs a value.` };
    headers[name] = row.value === "" ? null : row.value;
  }
  if (Object.keys(headers).length === 0) return { ok: true, headers: hadSaved ? {} : undefined };
  return { ok: true, headers };
}

// --- hub: failure alerts ---

const FRESH_UPLOAD_MS = 60_000;
const FRESH_RUN_MS = 30 * 60_000;
const COALESCE_WINDOW_MS = 10_000;
const COALESCE_AT = 3;

/** A toast for a fresh failing or regressed upload; null for passes, backfills and old runs. */
export function uploadAlert(run: RunView, now: number): { severity: "error" | "warning"; title: string; description: string } | null {
  if (!run.hub || !run.endedAt) return null;
  if (now - Date.parse(run.hub.receivedAt) > FRESH_UPLOAD_MS || now - Date.parse(run.endedAt) > FRESH_RUN_MS) return null;
  const newly = run.regression?.newlyFailing ?? 0;
  const failed = run.verdict === "FAIL" || run.verdict === "BLOCKED";
  if (!failed && newly <= 0) return null;
  const description = [attribution(run.hub).short, run.source?.branch, newly > 0 ? `${newly} newly failing` : null].filter(Boolean).join(" · ");
  return {
    severity: run.verdict === "BLOCKED" && newly <= 0 ? "warning" : "error",
    title: `${run.title}: ${run.verdict ?? "regressed"}`,
    description,
  };
}

/** Keeps the alert times of the last 10 s; `collapse` once 3 or more arrived in that window. */
export function alertCoalesce(history: number[], now: number): { history: number[]; collapse: boolean } {
  const next = [...history.filter((t) => now - t <= COALESCE_WINDOW_MS), now];
  return { history: next, collapse: next.length >= COALESCE_AT };
}

/** The Runs-page filters that show only runs of a ref. */
export function refRunFilters(ref: Ref | null): { branch?: string; version?: string } {
  if (!ref) return {};
  return ref.kind === "version" ? { version: ref.name } : { branch: ref.name };
}
