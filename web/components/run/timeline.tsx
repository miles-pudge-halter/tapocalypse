import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type UIEvent } from "react";
import { ArrowDown, Clock, History, Loader2, Radio, Search, SearchX, TriangleAlert, X, XCircle } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { isActive, type Activity, type RunView } from "@/lib/api";
import { useNow, useShortcut } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { SteerComposer } from "./steer-composer";
import { buildTimeline, countProblems, filterTimeline, TERMINAL_CHECK_STATUSES, type TimelineFilter } from "./timeline-model";
import { SectionHeader, TimelineRowView, type TimeMode } from "./timeline-rows";

const STICK_THRESHOLD_PX = 60;
const MAX_AUTO_PAGES = 10;

const FILTER_TABS: { value: TimelineFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "agent", label: "Agent" },
  { value: "device", label: "Device" },
  { value: "shell", label: "Shell" },
  { value: "checks", label: "Checks" },
  { value: "problems", label: "Problems" },
];

function isTimelineFilter(value: string): value is TimelineFilter {
  return FILTER_TABS.some((f) => f.value === value);
}

/**
 * The run's activity, humanised and grouped by check. Owns scroll behaviour: live tail, jump-to-check,
 * and keeping the viewport still while earlier history is prepended.
 */
export function Timeline({
  run,
  activity,
  hasMore,
  loadEarlier,
  selectedCheck,
  onSelectCheck,
}: {
  run: RunView;
  activity: Activity[];
  hasMore: boolean;
  loadEarlier: () => Promise<void>;
  selectedCheck: string | null;
  onSelectCheck: (id: string) => void;
}) {
  const active = isActive(run.status);
  const now = useNow(active ? 2000 : 60_000);
  const [filter, setFilter] = useState<TimelineFilter>("all");
  const [query, setQuery] = useState("");
  const [timeMode, setTimeMode] = useState<TimeMode>("relative");
  const [liveTail, setLiveTail] = useState(active);
  const [atBottom, setAtBottom] = useState(true);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const lastTop = useRef(0);
  const anchor = useRef<{ height: number; top: number } | null>(null);
  const loadingRef = useRef(false);
  const scrolledFor = useRef<string | null>(null);
  const autoPages = useRef({ check: "", count: 0 });

  useShortcut("/", () => searchRef.current?.focus(), []);

  const sections = useMemo(() => buildTimeline(activity), [activity]);
  const filtered = useMemo(() => filterTimeline(sections, filter, query), [sections, filter, query]);
  const problems = useMemo(() => countProblems(sections), [sections]);
  const unfiltered = filter === "all" && query.trim() === "";
  const startTs = run.startedAt ?? activity[0]?.ts ?? run.createdAt;
  const firstSeq = activity[0]?.seq;
  const lastSeq = activity[activity.length - 1]?.seq;
  const allResolved = run.checks.length > 0 && run.checks.every((c) => TERMINAL_CHECK_STATUSES.includes(c.status));

  const loadEarlierKeepingScroll = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoadingEarlier(true);
    setLiveTail(false);
    const el = scrollRef.current;
    if (el) anchor.current = { height: el.scrollHeight, top: el.scrollTop };
    try {
      await loadEarlier();
    } finally {
      loadingRef.current = false;
      setLoadingEarlier(false);
    }
  }, [loadEarlier]);

  // Prepended history must not move what the user is looking at.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const a = anchor.current;
    if (el && a) {
      el.scrollTop = a.top + (el.scrollHeight - a.height);
      anchor.current = null;
    }
  }, [firstSeq]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && liveTail) el.scrollTop = el.scrollHeight;
  }, [lastSeq, liveTail, filtered]);

  const scrollToSection = useCallback((checkId: string): boolean => {
    const container = scrollRef.current;
    const target = container?.querySelector<HTMLElement>(`[data-check="${CSS.escape(checkId)}"]`);
    if (!container || !target) return false;
    setLiveTail(false);
    // Off-screen rows are content-visibility:auto, so their real height only appears as they get near the
    // viewport and the section's offset keeps moving: re-align for a few frames until it settles.
    let frames = 0;
    const align = () => {
      const top = target.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
      if (Math.abs(container.scrollTop - top) > 2) container.scrollTop = top;
      if (++frames < 4) requestAnimationFrame(align);
    };
    align();
    return true;
  }, []);

  // Selecting a check scrolls to its section, loading older history first when it is not in memory yet. Only a
  // check that has started can have a section, so pending/unknown checks never trigger paging, and one selection
  // pages back at most MAX_AUTO_PAGES times.
  useEffect(() => {
    if (!selectedCheck) {
      scrolledFor.current = null;
      autoPages.current = { check: "", count: 0 };
      return;
    }
    if (scrolledFor.current === selectedCheck) return;
    if (scrollToSection(selectedCheck)) {
      scrolledFor.current = selectedCheck;
      return;
    }
    if (autoPages.current.check !== selectedCheck) autoPages.current = { check: selectedCheck, count: 0 };
    const check = run.checks.find((c) => c.id === selectedCheck);
    const started = check !== undefined && (check.startedAt !== undefined || check.status !== "pending");
    if (started && hasMore && unfiltered && !loadingRef.current && autoPages.current.count < MAX_AUTO_PAGES) {
      autoPages.current.count += 1;
      void loadEarlierKeepingScroll();
    }
  }, [selectedCheck, run.checks, filtered, hasMore, unfiltered, loadingEarlier, loadEarlierKeepingScroll, scrollToSection]);

  // Re-selecting the current check scrolls back to it instead of doing nothing.
  const selectCheck = useCallback(
    (id: string) => {
      if (id === selectedCheck) scrollToSection(id);
      else onSelectCheck(id);
    },
    [selectedCheck, onSelectCheck, scrollToSection],
  );

  function onScroll(e: UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD_PX;
    setAtBottom(bottom);
    if (el.scrollTop < lastTop.current - 2 && !bottom) setLiveTail(false);
    lastTop.current = el.scrollTop;
  }

  function jumpToLatest() {
    const el = scrollRef.current;
    if (!el) return;
    setLiveTail(active);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }

  function toggleFilter(value: TimelineFilter) {
    setFilter((f) => (f === value ? "all" : value));
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="space-y-2 border-b p-2">
        <div className="flex items-center gap-1.5">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search activity  (/)"
              aria-label="Search activity"
              className="h-8 pl-7 pr-7 text-sm"
            />
            {query ? (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setQuery("")}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            ) : null}
          </div>
          {problems.errors > 0 ? (
            <Button
              variant={filter === "errors" ? "secondary" : "ghost"}
              size="xs"
              className="text-red-600 dark:text-red-400"
              aria-pressed={filter === "errors"}
              title="Tool errors — click to filter"
              onClick={() => toggleFilter("errors")}
            >
              <XCircle />
              {problems.errors}
            </Button>
          ) : null}
          {problems.warnings > 0 ? (
            <Button
              variant={filter === "warnings" ? "secondary" : "ghost"}
              size="xs"
              className="text-amber-600 dark:text-amber-400"
              aria-pressed={filter === "warnings"}
              title="Warnings — click to filter"
              onClick={() => toggleFilter("warnings")}
            >
              <TriangleAlert />
              {problems.warnings}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="xs"
            title="Switch between time since start and wall-clock time"
            onClick={() => setTimeMode((m) => (m === "relative" ? "absolute" : "relative"))}
          >
            <Clock />
            {timeMode === "relative" ? "+mm:ss" : "clock"}
          </Button>
          <Button
            variant={liveTail ? "secondary" : "ghost"}
            size="xs"
            aria-pressed={liveTail}
            disabled={!active && !liveTail}
            title="Follow new activity as it arrives"
            onClick={() => (liveTail ? setLiveTail(false) : jumpToLatest())}
          >
            <Radio className={cn(liveTail && "text-red-500")} />
            Live tail
          </Button>
        </div>
        <Tabs value={filter} onValueChange={(v) => isTimelineFilter(v) && setFilter(v)}>
          <TabsList className="h-8 w-full">
            {FILTER_TABS.map((f) => (
              <TabsTrigger key={f.value} value={f.value} className="px-1.5 text-xs">
                {f.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>

      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto overscroll-contain">
          {hasMore ? (
            <div className="flex justify-center border-b p-2">
              <Button variant="outline" size="sm" disabled={loadingEarlier} onClick={() => void loadEarlierKeepingScroll()}>
                {loadingEarlier ? <Loader2 className="animate-spin" /> : <History />}
                Load earlier{firstSeq ? ` (${firstSeq.toLocaleString()} earlier events)` : ""}
              </Button>
            </div>
          ) : null}

          {activity.length === 0 ? (
            <div className="p-3">
              <EmptyState
                icon={active ? Loader2 : History}
                title={active ? "Starting agent session…" : "No activity was recorded"}
                description={active ? "The agent's first steps will appear here." : "This run ended before the agent did anything."}
              />
            </div>
          ) : filtered.length === 0 ? (
            <div className="p-3">
              <EmptyState
                icon={SearchX}
                title="Nothing matches"
                description="No activity matches the current filter or search."
                action={
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setFilter("all");
                      setQuery("");
                    }}
                  >
                    Clear filters
                  </Button>
                }
              />
            </div>
          ) : (
            filtered.map((s) => (
              <section key={s.key} data-check={s.checkId ?? undefined}>
                <SectionHeader
                  section={s}
                  check={run.checks.find((c) => c.id === s.checkId)}
                  now={run.endedAt ? Date.parse(run.endedAt) : now}
                  selected={s.checkId !== null && s.checkId === selectedCheck}
                  wrapUp={allResolved && s.key === sections[sections.length - 1]?.key}
                  onSelect={selectCheck}
                />
                <div className="py-1">
                  {s.rows.map((row) => (
                    <div key={row.key} className="[contain-intrinsic-size:auto_28px] [content-visibility:auto]">
                      <TimelineRowView row={row} mode={timeMode} startTs={startTs} live={active} onSelectCheck={selectCheck} />
                    </div>
                  ))}
                </div>
              </section>
            ))
          )}
        </div>
        {!atBottom && activity.length > 0 ? (
          <Button size="sm" variant="secondary" className="absolute bottom-3 left-1/2 -translate-x-1/2 shadow-md" onClick={jumpToLatest}>
            <ArrowDown />
            Jump to latest
          </Button>
        ) : null}
      </div>

      {run.status === "running" ? <SteerComposer runId={run.id} /> : null}
    </div>
  );
}
