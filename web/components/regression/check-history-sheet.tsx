import { AlertCircle, History, Loader2, Smartphone, Unlink } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { CheckStatusIcon } from "@/components/check-status-icon";
import { EmptyState } from "@/components/empty-state";
import { Lightbox } from "@/components/lightbox";
import { StatusStrip, type StripStatus } from "@/components/regression/status-strip";
import { FLAKY_TEXT, SUSPECT_CHIP, TransitionChip } from "@/components/regression/transition";
import { Thumb } from "@/components/run/thumb";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { compareHash, runHash, type CheckHistory, type CheckHistoryEntry, type Platform } from "@/lib/api";
import { formatRelative, formatTime } from "@/lib/format";
import { navigate, useCheckHistory, useCheckHistorySheet, useNow, useProjects } from "@/lib/hooks";
import { cn } from "@/lib/utils";

const ALL = "all";
const SHORT_SHA = 7;
const STRIP_SIZE = 30;
const MAX_BRANCHES = 20;
const FLASH_MS = 1000;

const IDENTITY: Record<CheckHistory["keyKind"], (id: string) => ReactNode> = {
  suite: (id) => (
    <>
      Identified by suite check id <span className="font-mono">{id}</span>
    </>
  ),
  lineage: () => "Identified by re-run lineage",
  carried: () => "Identified by checks the agent carried over between runs",
  title: () => "Identified by title. Runs that worded this check differently are not included.",
  inferred: () => "Includes runs matched by a similar title",
  manual: () => "Includes checks you linked manually",
};

function entryKey(e: CheckHistoryEntry): string {
  return `${e.runId}:${e.checkId}`;
}

function isResolved(status: CheckHistoryEntry["status"]): boolean {
  return status !== "pending" && status !== "running";
}

function entryLabel(e: CheckHistoryEntry): string {
  const sha = e.commit?.slice(0, SHORT_SHA);
  return [isResolved(e.status) ? e.status : "not reached", e.branch, sha, e.deviceName, formatTime(e.createdAt)].filter(Boolean).join(" · ");
}

function Summary({ history, now }: { history: CheckHistory; now: number }) {
  const lastFail = history.entries.find((e) => e.status === "fail");
  const oldest = history.entries.at(-1);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
      {history.flaky === "flaky" ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <TransitionChip transition="flaky" tabIndex={0}>
              flaky
            </TransitionChip>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            Flipped {history.flips} times in its last {history.window} decisive results on the same code and device
          </TooltipContent>
        </Tooltip>
      ) : null}
      {history.flaky === "suspect" ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0} className={cn("inline-flex items-center gap-1 rounded-md border px-1.5 text-xs font-medium leading-5", SUSPECT_CHIP)}>
              ❄ suspect
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">Flipped once on the same code and device. One more flip makes it flaky.</TooltipContent>
        </Tooltip>
      ) : null}
      {history.deviceSensitive ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0} className="inline-flex items-center gap-1 rounded-md border px-1.5 text-xs leading-5 text-muted-foreground">
              <Smartphone className="size-3" aria-hidden />
              device-sensitive
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">Passes on some devices and fails on others. That is a device difference, not flakiness.</TooltipContent>
        </Tooltip>
      ) : null}
      {history.passRate !== null ? (
        <span className="tabular-nums">
          Pass rate {Math.round(history.passRate * 100)}%
        </span>
      ) : null}
      {lastFail ? (
        <span className="text-muted-foreground">
          Last failed {formatRelative(lastFail.createdAt, now)}
          {lastFail.branch ? ` on ${lastFail.branch}` : ""}
        </span>
      ) : null}
      {oldest && !history.hasMore ? <span className="text-muted-foreground">First seen {formatTime(oldest.createdAt)}</span> : null}
    </div>
  );
}

function EntryRow({
  entry,
  latestCheckId,
  fromRunId,
  highlighted,
  flashing,
  now,
  onOpenImage,
  imageIndex,
}: {
  entry: CheckHistoryEntry;
  latestCheckId: string | undefined;
  fromRunId: string | undefined;
  highlighted: boolean;
  flashing: boolean;
  now: number;
  imageIndex: number | null;
  onOpenImage(index: number): void;
}) {
  const [expanded, setExpanded] = useState(false);
  const resolved = isResolved(entry.status);
  const sha = entry.commit?.slice(0, SHORT_SHA);
  return (
    <li id={`history-${entryKey(entry)}`} className={cn("space-y-1.5 px-4 py-3 transition-colors", (highlighted || flashing) && "bg-accent/60")}>
      {highlighted ? <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">This run</p> : null}
      <div className="flex min-w-0 items-center gap-2">
        {resolved ? <CheckStatusIcon status={entry.status} /> : <span className="size-4 shrink-0 rounded-full border border-dashed border-muted-foreground/50" aria-label="not reached" />}
        <span className="text-sm font-medium capitalize">{resolved ? entry.status : "Not reached"}</span>
        <a href={runHash(entry.runId, entry.checkId)} className="min-w-0 flex-1 truncate text-sm underline-offset-2 hover:underline" title={entry.runTitle}>
          {entry.runTitle}
        </a>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">{formatRelative(entry.createdAt, now)}</span>
          </TooltipTrigger>
          <TooltipContent>{formatTime(entry.createdAt)}</TooltipContent>
        </Tooltip>
      </div>
      <p className="break-words text-xs text-muted-foreground">
        {[entry.branch, sha && <span key="sha" className="font-mono">{sha}</span>, entry.deviceName, entry.model]
          .filter(Boolean)
          .flatMap((part, i) => (i === 0 ? [part] : [" · ", part]))}
        {entry.checkId !== latestCheckId ? <span className="hidden xl:inline"> · as {entry.checkId}</span> : null}
      </p>
      {entry.note ? (
        <button type="button" onClick={() => setExpanded((v) => !v)} className={cn("block w-full break-words text-left text-xs", !expanded && "line-clamp-2")} aria-expanded={expanded}>
          {entry.note}
        </button>
      ) : null}
      {entry.flippedOnSameCode ? (
        <p className={cn("text-[10px]", FLAKY_TEXT)}>flipped on the same code</p>
      ) : entry.flip ? (
        <p className="text-[10px] text-muted-foreground">changed since previous</p>
      ) : null}
      {entry.screenshotUrl && imageIndex !== null ? <Thumb url={entry.screenshotUrl} label={`${entry.checkId} — ${entry.title}`} onOpen={() => onOpenImage(imageIndex)} /> : null}
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <a href={runHash(entry.runId, entry.checkId)} className="underline underline-offset-2">
          Open run
        </a>
        {fromRunId && fromRunId !== entry.runId ? (
          <a href={compareHash(fromRunId, entry.runId)} className="underline underline-offset-2">
            Compare with this run
          </a>
        ) : null}
      </div>
    </li>
  );
}

/** Right-hand sheet with the history of one check across runs; mounted once in the app shell. */
export function CheckHistorySheet() {
  const { open, target, close } = useCheckHistorySheet();
  // A link inside the sheet (open run, compare) navigates away; the sheet must not stay on top of the new page.
  useEffect(() => {
    if (!open) return;
    window.addEventListener("hashchange", close);
    return () => window.removeEventListener("hashchange", close);
  }, [open, close]);
  return (
    <Sheet open={open} onOpenChange={(next) => !next && close()}>
      <SheetContent className="w-full gap-0 sm:max-w-xl">{target ? <HistoryBody key={`${target.projectId}:${target.checkKey ?? ""}:${target.runId ?? ""}:${target.checkId ?? ""}`} /> : null}</SheetContent>
    </Sheet>
  );
}

function HistoryBody() {
  const { target } = useCheckHistorySheet();
  const { projects } = useProjects();
  const now = useNow(60_000);
  const [branch, setBranch] = useState(ALL);
  const [platform, setPlatform] = useState<Platform | typeof ALL>(ALL);
  const [lightbox, setLightbox] = useState<number | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const { history, loading, loadingMore, error, moreError, notFound, loadMore, refresh } = useCheckHistory(target, {
    branch: branch === ALL ? undefined : branch,
    platform: platform === ALL ? undefined : platform,
  });
  const [knownBranches, setKnownBranches] = useState<string[]>([]);
  useEffect(() => {
    if (!history) return;
    setKnownBranches((prev) => {
      const next = new Set(prev);
      for (const e of history.entries) if (e.branch) next.add(e.branch);
      return next.size === prev.length ? prev : [...next].slice(0, MAX_BRANCHES);
    });
  }, [history]);
  useEffect(() => () => clearTimeout(flashTimer.current), []);

  const entries = history?.entries ?? [];
  const images = useMemo(() => entries.filter((e) => e.screenshotUrl), [entries]);
  const imageIndexOf = (e: CheckHistoryEntry) => {
    const i = images.indexOf(e);
    return i >= 0 ? i : null;
  };
  if (!target) return null;
  const projectName = projects.find((p) => p.id === target.projectId)?.name ?? target.projectId;
  const strip = entries.slice(0, STRIP_SIZE).reverse();
  const currentIndex = target.runId ? strip.findIndex((e) => e.runId === target.runId) : -1;
  const onlyThisRun = history !== null && entries.length > 0 && entries.every((e) => e.runId === target.runId) && branch === ALL && platform === ALL;
  const title = history?.title ?? target.title;

  function jumpTo(i: number) {
    const entry = strip[i];
    if (!entry) return;
    document.getElementById(`history-${entryKey(entry)}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    setFlash(entryKey(entry));
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), FLASH_MS);
  }

  return (
    <>
      <SheetHeader className="space-y-1 border-b">
        <SheetTitle className="pr-8 break-words">{title}</SheetTitle>
        <SheetDescription>Check history · {projectName}</SheetDescription>
        {history ? <p className="text-xs text-muted-foreground">{IDENTITY[history.keyKind](entries[0]?.checkId ?? "")}</p> : null}
      </SheetHeader>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && !history ? (
          <div className="space-y-3 p-4" aria-busy="true" aria-label="Loading check history">
            <Skeleton className="h-5 w-2/3" />
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        ) : notFound ? (
          <div className="p-4">
            <EmptyState
              icon={Unlink}
              title="This check has no history yet"
              description="It does not match any check in earlier runs. Link it to an earlier check from a comparison."
              action={
                target.runId ? (
                  <Button variant="outline" size="sm" onClick={() => navigate(compareHash(target.runId ?? "", "auto"))}>
                    Open comparison
                  </Button>
                ) : undefined
              }
            />
          </div>
        ) : !history ? (
          <div className="p-4">
            <Alert variant="destructive">
              <AlertCircle />
              <AlertTitle>Could not load the check history</AlertTitle>
              <AlertDescription>
                <span>{error}</span>
                <Button variant="link" size="xs" className="h-auto p-0" onClick={refresh}>
                  Try again
                </Button>
              </AlertDescription>
            </Alert>
          </div>
        ) : (
          <>
            <div className="space-y-3 p-4" aria-busy={loading}>
              {error ? (
                <Alert variant="destructive">
                  <AlertCircle />
                  <AlertTitle>Could not load the check history</AlertTitle>
                  <AlertDescription>
                    <span>{error}</span>
                    <Button variant="link" size="xs" className="h-auto p-0" onClick={refresh}>
                      Try again
                    </Button>
                  </AlertDescription>
                </Alert>
              ) : null}
              <Summary history={history} now={now} />
              <StatusStrip
                statuses={strip.map((e): StripStatus => (isResolved(e.status) ? e.status : null))}
                labels={strip.map(entryLabel)}
                sameCodeFlip={strip.map((e) => e.flippedOnSameCode)}
                current={currentIndex >= 0 ? currentIndex : undefined}
                onSelect={jumpTo}
                size="md"
              />
              <div className="flex flex-wrap gap-2">
                <Select value={branch} onValueChange={setBranch}>
                  <SelectTrigger size="sm" className="w-44" aria-label="Filter by branch">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL}>All branches</SelectItem>
                    {knownBranches.map((b) => (
                      <SelectItem key={b} value={b}>
                        {b}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={platform} onValueChange={(v) => setPlatform(v === "android" || v === "ios" ? v : ALL)}>
                  <SelectTrigger size="sm" className="w-36" aria-label="Filter by platform">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL}>All platforms</SelectItem>
                    <SelectItem value="android">Android</SelectItem>
                    <SelectItem value="ios">iOS</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {onlyThisRun ? (
              <div className="px-4 pb-4">
                <EmptyState
                  icon={History}
                  title="First run of this check"
                  description="History builds up as more runs use the same check. Re-run this run, or save the brief as a suite, to keep check titles stable."
                />
              </div>
            ) : entries.length === 0 ? (
              <div className="space-y-2 px-4 pb-4 text-sm text-muted-foreground">
                <p>
                  No results on {[branch === ALL ? null : branch, platform === ALL ? null : platform === "ios" ? "iOS" : "Android"].filter(Boolean).join(" / ")}.
                </p>
                <Button
                  variant="link"
                  size="xs"
                  className="h-auto p-0"
                  onClick={() => {
                    setBranch(ALL);
                    setPlatform(ALL);
                  }}
                >
                  Clear filters
                </Button>
              </div>
            ) : (
              <ul className={cn("divide-y border-t", loading && "opacity-60")}>
                {entries.map((e) => (
                  <EntryRow
                    key={entryKey(e)}
                    entry={e}
                    latestCheckId={entries[0]?.checkId}
                    fromRunId={target.runId}
                    highlighted={e.runId === target.runId && (target.checkId === undefined || e.checkId === target.checkId)}
                    flashing={flash === entryKey(e)}
                    now={now}
                    imageIndex={imageIndexOf(e)}
                    onOpenImage={setLightbox}
                  />
                ))}
              </ul>
            )}
            {history.hasMore ? (
              <div className="space-y-2 p-4">
                {moreError ? (
                  <Alert variant="destructive">
                    <AlertCircle />
                    <AlertTitle>Could not load older results</AlertTitle>
                    <AlertDescription>{moreError}</AlertDescription>
                  </Alert>
                ) : null}
                <Button variant="outline" size="sm" className="w-full" disabled={loadingMore} onClick={() => void loadMore()}>
                  {loadingMore ? <Loader2 className="animate-spin" /> : null}
                  {loadingMore ? "Loading…" : "Show older results"}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>
      <Lightbox
        images={images.map((e) => ({ src: e.screenshotUrl ?? "", caption: `${e.checkId} · ${e.runTitle}` }))}
        index={lightbox}
        onIndexChange={setLightbox}
      />
    </>
  );
}
