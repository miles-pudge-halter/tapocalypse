import { useEffect, useMemo, useRef, useState } from "react";
import { ImageOff, ListChecks, Loader2 } from "lucide-react";

import { CheckStatusIcon } from "@/components/check-status-icon";
import { EmptyState } from "@/components/empty-state";
import { CheckCounts, SegmentedProgress } from "@/components/segmented-progress";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { isActive, type Check, type RunView } from "@/lib/api";
import { formatDurationMs } from "@/lib/format";
import { useNow } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { checkDurationMs, screenshotOfCheck, type GalleryItem } from "./evidence";

type RailFilter = "all" | "fail" | "pass" | "blocked";

const FILTERS: { value: RailFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "fail", label: "Failed" },
  { value: "pass", label: "Passed" },
  { value: "blocked", label: "Blocked" },
];

function isRailFilter(value: string): value is RailFilter {
  return FILTERS.some((f) => f.value === value);
}

const STATUS_BORDER: Record<Check["status"], string> = {
  fail: "border-l-red-500",
  blocked: "border-l-rose-800 dark:border-l-rose-500",
  running: "border-l-blue-500",
  pass: "border-l-transparent",
  skipped: "border-l-transparent",
  pending: "border-l-transparent",
};

function Thumb({ item, label, onOpen }: { item: GalleryItem; label: string; onOpen: () => void }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div className="flex h-16 w-24 items-center justify-center gap-1 rounded-md border border-dashed text-[10px] text-muted-foreground">
        <ImageOff className="size-3.5" />
        missing
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Open screenshot: ${label}`}
      className="block overflow-hidden rounded-md border transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <img src={item.url} alt={label} loading="lazy" onError={() => setFailed(true)} className="max-h-40 w-24 object-cover object-top" />
    </button>
  );
}

/** Left rail: progress, status filter tabs and one selectable row per check. */
export function ChecksRail({
  run,
  gallery,
  selected,
  onSelect,
  onOpenImage,
}: {
  run: RunView;
  gallery: GalleryItem[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  onOpenImage: (item: GalleryItem) => void;
}) {
  const active = isActive(run.status);
  const now = useNow(active ? 1000 : 60_000);
  const [filter, setFilter] = useState<RailFilter>("all");
  const selectedRef = useRef<HTMLLIElement | null>(null);
  const checks = run.checks;
  const resolved = checks.filter((c) => c.status !== "pending" && c.status !== "running").length;
  const visible = useMemo(() => (filter === "all" ? checks : checks.filter((c) => c.status === filter)), [checks, filter]);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="space-y-2 border-b p-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">Checks</h2>
          <span className="text-xs tabular-nums text-muted-foreground">
            {resolved}/{checks.length}
          </span>
        </div>
        {checks.length > 0 ? (
          <>
            <SegmentedProgress checks={checks} />
            <CheckCounts checks={checks} className="text-xs text-muted-foreground" />
            <Tabs value={filter} onValueChange={(v) => isRailFilter(v) && setFilter(v)}>
              <TabsList className="w-full">
                {FILTERS.map((f) => (
                  <TabsTrigger key={f.value} value={f.value} className="px-1.5 text-xs">
                    {f.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {checks.length === 0 ? (
          <div className="p-3">
            <EmptyState
              icon={active ? Loader2 : ListChecks}
              title={active ? "No checks declared yet" : "No test plan"}
              description={
                active
                  ? "Waiting for the agent to declare its test plan (qa_plan)…"
                  : "The agent never declared a test plan."
              }
            />
          </div>
        ) : visible.length === 0 ? (
          <p className="p-4 text-center text-sm text-muted-foreground">No checks match this filter.</p>
        ) : (
          <ul className="divide-y">
            {visible.map((c) => {
              const shot = screenshotOfCheck(run.projectId, c, gallery);
              const duration = checkDurationMs(c, run.endedAt ? Date.parse(run.endedAt) : now);
              const isSelected = selected === c.id;
              return (
                <li
                  key={c.id}
                  ref={isSelected ? selectedRef : undefined}
                  className={cn("border-l-2 px-3 py-2.5", STATUS_BORDER[c.status], isSelected && "bg-accent")}
                >
                  <button
                    type="button"
                    onClick={() => onSelect(isSelected ? null : c.id)}
                    aria-pressed={isSelected}
                    className="flex w-full min-w-0 items-start gap-2 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <CheckStatusIcon status={c.status} className="mt-0.5" />
                    <span className="min-w-0 flex-1 space-y-0.5">
                      <span className="flex items-baseline gap-2">
                        <span className="font-mono text-xs text-muted-foreground">{c.id}</span>
                        {duration !== null ? (
                          <span className="ml-auto text-xs tabular-nums text-muted-foreground">{formatDurationMs(duration)}</span>
                        ) : null}
                      </span>
                      <span className="line-clamp-2 block break-words text-sm">{c.title}</span>
                      {c.note ? (
                        <span className={cn("block break-words text-xs text-muted-foreground", !isSelected && "line-clamp-2")}>
                          {c.note}
                        </span>
                      ) : null}
                    </span>
                  </button>
                  {shot ? (
                    <div className="mt-2 pl-6">
                      <Thumb item={shot} label={`${c.id} — ${c.title}`} onOpen={() => onOpenImage(shot)} />
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
