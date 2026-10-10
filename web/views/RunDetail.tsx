import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { XCircle } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Lightbox } from "@/components/lightbox";
import { ChecksRail } from "@/components/run/checks-rail";
import { DevicePane } from "@/components/run/device-pane";
import { buildGallery, type GalleryItem } from "@/components/run/evidence";
import { OutcomeCallout } from "@/components/run/outcome-callout";
import { PhaseStepper } from "@/components/run/phase-stepper";
import { RunHeader } from "@/components/run/run-header";
import { ScreenshotsGallery } from "@/components/run/screenshots-gallery";
import { Timeline } from "@/components/run/timeline";
import { useRunActions } from "@/components/run/use-run-actions";
import { useFillHeight, useMinWidth, useScreenshots } from "@/components/run/use-workbench";
import { isActive, runHash, type Activity, type RunView } from "@/lib/api";
import { keyboardClaimed, useDevices, useProjects, useRunEvents } from "@/lib/hooks";
import { cn } from "@/lib/utils";

const WIDE_BREAKPOINT_PX = 1280;
const MIN_WORKBENCH_HEIGHT_PX = 520;

type TabId = "workbench" | "checks" | "timeline" | "device" | "screenshots";

const PANE = "min-h-0 overflow-hidden rounded-lg border bg-card";

export function RunDetail({ id, check }: { id: string; check?: string }) {
  const { run, activity, hasMoreActivity, loadEarlier, error, connected } = useRunEvents(id);

  if (!run && error) {
    return (
      <Alert variant="destructive">
        <XCircle />
        <AlertTitle>Could not load run</AlertTitle>
        <AlertDescription>
          {error}. <a href="#/" className="underline underline-offset-2">Back to runs</a>
        </AlertDescription>
      </Alert>
    );
  }
  if (!run) return <RunDetailSkeleton />;

  return (
    <div className="space-y-3">
      {error && !connected ? (
        <Alert variant="destructive">
          <XCircle />
          <AlertTitle>Live updates interrupted</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <Workbench
        run={run}
        activity={activity}
        hasMore={hasMoreActivity}
        loadEarlier={loadEarlier}
        connected={connected}
        initialCheck={check ?? null}
      />
    </div>
  );
}

function RunDetailSkeleton() {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading run">
      <Skeleton className="h-4 w-40" />
      <Skeleton className="h-8 w-2/3" />
      <Skeleton className="h-4 w-1/2" />
      <div className="grid gap-3 pt-2 lg:grid-cols-[300px_minmax(0,1fr)_340px]">
        <Skeleton className="h-[560px] w-full" />
        <Skeleton className="h-[560px] w-full" />
        <Skeleton className="hidden h-[560px] w-full lg:block" />
      </div>
    </div>
  );
}

function Workbench({
  run,
  activity,
  hasMore,
  loadEarlier,
  connected,
  initialCheck,
}: {
  run: RunView;
  activity: Activity[];
  hasMore: boolean;
  loadEarlier: () => Promise<void>;
  connected: boolean;
  initialCheck: string | null;
}) {
  const wide = useMinWidth(WIDE_BREAKPOINT_PX);
  const { projects } = useProjects();
  const { devices } = useDevices();
  const actions = useRunActions(run);
  const [selected, setSelected] = useState<string | null>(initialCheck);
  const [tab, setTab] = useState<TabId>("workbench");
  const [lightbox, setLightbox] = useState<number | null>(null);
  const fillRef = useRef<HTMLDivElement>(null);
  const height = useFillHeight(fillRef, MIN_WORKBENCH_HEIGHT_PX);

  // The URL is the source of truth for deep links: follow it when it changes underneath us.
  useEffect(() => setSelected(initialCheck), [initialCheck]);

  const shotsKey = `${run.status}|${run.checks.map((c) => `${c.status}:${c.screenshot ?? ""}`).join(",")}`;
  const screenshots = useScreenshots(run.id, shotsKey);
  const { id: runId, projectId: runProjectId, storage, checks } = run;
  const gallery = useMemo(
    () => buildGallery({ id: runId, projectId: runProjectId, storage }, checks, screenshots.shots),
    [runId, runProjectId, storage, checks, screenshots.shots],
  );
  const lightboxImages = useMemo(
    () => gallery.map((g) => ({ src: g.url, caption: g.checkId ? `${g.checkId} · ${g.name}` : g.name, href: g.url })),
    [gallery],
  );

  const projectName = projects.find((p) => p.id === run.projectId)?.name ?? run.projectId;
  const device = run.deviceSerial ? (devices.find((d) => d.serial === run.deviceSerial) ?? null) : null;
  const active = isActive(run.status);

  const select = useCallback(
    (checkId: string | null) => {
      setSelected(checkId);
      // replace, not push: stepping through checks must not fill the history.
      window.location.replace(runHash(run.id, checkId ?? undefined));
      if (checkId && !wide) setTab("timeline");
    },
    [run.id, wide],
  );

  const openImage = useCallback(
    (item: GalleryItem) => {
      const i = gallery.findIndex((g) => g.key === item.key);
      if (i >= 0) setLightbox(i);
    },
    [gallery],
  );

  // j/k step through checks, Esc clears the selection. Inert while typing or while a dialog/sheet is open.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey || keyboardClaimed(e)) return;
      const ids = run.checks.map((c) => c.id);
      if (e.key === "Escape") {
        if (selected) select(null);
        return;
      }
      if ((e.key !== "j" && e.key !== "k") || ids.length === 0) return;
      const at = selected ? ids.indexOf(selected) : -1;
      const next = e.key === "j" ? Math.min(ids.length - 1, at + 1) : Math.max(0, at < 0 ? 0 : at - 1);
      const nextId = ids[next];
      if (nextId) {
        e.preventDefault();
        select(nextId);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [run.checks, selected, select]);

  const rail = <ChecksRail run={run} gallery={gallery} selected={selected} onSelect={select} onOpenImage={openImage} />;
  const timeline = (
    <Timeline
      run={run}
      activity={activity}
      hasMore={hasMore}
      loadEarlier={loadEarlier}
      selectedCheck={selected}
      onSelectCheck={select}
    />
  );
  const devicePane = (
    <DevicePane
      run={run}
      device={device}
      gallery={gallery}
      selectedCheck={selected}
      onClearSelection={() => select(null)}
      onOpenImage={openImage}
    />
  );

  const shown: TabId = wide ? (tab === "screenshots" ? "screenshots" : "workbench") : tab === "workbench" ? "timeline" : tab;
  const tabs: { id: TabId; label: string }[] = wide
    ? [
        { id: "workbench", label: "Workbench" },
        { id: "screenshots", label: `Screenshots (${gallery.length})` },
      ]
    : [
        { id: "checks", label: `Checks (${run.checks.length})` },
        { id: "timeline", label: "Timeline" },
        { id: "device", label: "Device" },
        { id: "screenshots", label: `Screenshots (${gallery.length})` },
      ];

  return (
    <>
      <RunHeader run={run} device={device} projectName={projectName} connected={connected} actions={actions} />
      {active ? <PhaseStepper run={run} /> : null}
      <OutcomeCallout run={run} actions={actions} />

      <Tabs value={shown} onValueChange={(v) => setTab(v as TabId)}>
        <TabsList>
          {tabs.map((t) => (
            <TabsTrigger key={t.id} value={t.id}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <div ref={fillRef} style={{ height }} className={cn(shown === "workbench" && "grid grid-cols-[300px_minmax(0,1fr)_340px] grid-rows-[minmax(0,1fr)] gap-3")}>
        {shown === "workbench" ? (
          <>
            <div className={PANE}>{rail}</div>
            <div className={PANE}>{timeline}</div>
            <div className={PANE}>{devicePane}</div>
          </>
        ) : shown === "screenshots" ? (
          <div className={cn(PANE, "h-full overflow-y-auto")}>
            <ScreenshotsGallery
              items={gallery}
              checks={run.checks}
              loading={screenshots.loading}
              error={screenshots.error}
              onOpenImage={openImage}
            />
          </div>
        ) : (
          <div className={cn(PANE, "h-full")}>{shown === "checks" ? rail : shown === "timeline" ? timeline : devicePane}</div>
        )}
      </div>

      <Lightbox images={lightboxImages} index={lightbox} onIndexChange={setLightbox} />
    </>
  );
}
