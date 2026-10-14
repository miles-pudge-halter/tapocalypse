import { AlertCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { Lockup } from "@/components/brand";
import { TeamHubBadge } from "@/components/hub/team-hub-badge";
import { CommandPalette } from "@/components/command-palette";
import { CheckHistorySheet } from "@/components/regression/check-history-sheet";
import { NewRunSheet } from "@/components/new-run-sheet";
import { Notifications } from "@/components/notifications";
import { ShortcutsDialog } from "@/components/shortcuts-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Toaster } from "@/components/ui/sonner";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { overviewHash, releasesHash } from "@/lib/api";
import { navigate, useNewRun, useProjectScope, useProjects, useRoute, useShortcut } from "@/lib/hooks";
import { isHub, useAppMode } from "@/lib/mode";
import { pageKey } from "@/lib/page-key";
import { readStorage, writeStorage } from "@/lib/storage";
import { About } from "@/views/About";
import { Batch } from "@/views/Batch";
import { Compare } from "@/views/Compare";
import { Dashboard } from "@/views/Dashboard";
import { Devices } from "@/views/Devices";
import { FlakyChecks } from "@/views/Flaky";
import { HubHome } from "@/views/HubHome";
import { HubProjects } from "@/views/HubProjects";
import { HubUnavailable } from "@/views/HubUnavailable";
import { Overview } from "@/views/Overview";
import { ReleaseDetail, ReleaseList } from "@/views/Releases";
import { Projects } from "@/views/Projects";
import { ReportList, ReportView } from "@/views/Reports";
import { RunDetail } from "@/views/RunDetail";
import { Setup } from "@/views/Setup";

const SIDEBAR_KEY = "tapocalypse-sidebar";

function View() {
  const route = useRoute();
  const key = pageKey(route, isHub());
  // Hash navigation keeps the document, so the previous page's scroll offset would carry over.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [key]);
  const hub = isHub();
  switch (route.name) {
    case "home":
      return hub ? <HubHome /> : <Dashboard />;
    case "runs":
      return <Dashboard />;
    case "run":
      return <RunDetail key={route.id} id={route.id} check={route.check} baseline={route.baseline} />;
    case "compare":
      return <Compare key={`${route.id}:${route.baselineId}`} id={route.id} baselineId={route.baselineId} show={route.show} pair={route.pair} />;
    case "batch":
      return <Batch key={route.id} id={route.id} />;
    case "devices":
      return hub ? <HubUnavailable /> : <Devices />;
    case "setup":
      return hub ? <HubUnavailable /> : <Setup section={route.section} />;
    case "projects":
      return hub ? <HubProjects /> : <Projects openNew={route.openNew} />;
    case "overview":
      return <Overview key={route.projectId} projectId={route.projectId} refValue={route.ref} show={route.show} />;
    case "releases":
      return <ReleaseList key={route.projectId} projectId={route.projectId} />;
    case "release":
      return <ReleaseDetail key={`${route.projectId}:${route.ref.kind}:${route.ref.name}`} projectId={route.projectId} refValue={route.ref} against={route.against} group={route.group} />;
    case "about":
      return hub ? <About /> : <SetupRedirect />;
    case "reports":
      return <ReportList projectId={route.projectId} />;
    case "flaky":
      return <FlakyChecks projectId={route.projectId} />;
    case "report":
      return <ReportView projectId={route.projectId} name={route.reportName} />;
  }
}

/** `#/about` only exists on the hub; a laptop's equivalent is Setup. */
function SetupRedirect() {
  useEffect(() => window.location.replace("#/setup"), []);
  return null;
}

function LocalShortcuts() {
  const { openNewRun } = useNewRun();
  useShortcut("n", () => openNewRun());
  useShortcut("g d", () => navigate("#/devices"));
  useShortcut("g s", () => navigate("#/setup"));
  return null;
}

/** The overview and releases pages belong to one project: the scoped one, or the only one. */
function useTargetProject(): string | null {
  const { projects } = useProjects();
  const { projectId } = useProjectScope();
  const ready = projects.filter((p) => p.status === "ok");
  return ready.find((p) => p.id === projectId)?.id ?? (ready.length === 1 ? (ready[0]?.id ?? null) : null);
}

function GlobalShortcuts() {
  const target = useTargetProject();
  useShortcut("g r", () => navigate("#/runs"));
  useShortcut("g p", () => navigate("#/projects"));
  useShortcut("g o", () => navigate(target ? overviewHash(target) : "#/"));
  useShortcut("g e", () => navigate(target ? releasesHash(target) : "#/"));
  useShortcut("g a", () => navigate(isHub() ? "#/about" : "#/setup"), []);
  return isHub() ? null : <LocalShortcuts />;
}

function BootGate() {
  const { error, retry } = useAppMode();
  if (error) {
    return (
      <div className="mx-auto mt-24 max-w-md px-4">
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Could not reach the Tapocalypse server</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>{error}</p>
            <Button variant="outline" size="sm" onClick={retry}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    );
  }
  return (
    <div className="flex min-h-svh" aria-label="Loading Tapocalypse">
      <div className="hidden w-64 shrink-0 space-y-2 border-r p-3 md:block">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-8" />
        ))}
      </div>
      <div className="flex-1 space-y-4 p-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40" />
      </div>
    </div>
  );
}

export function App() {
  const { mode } = useAppMode();
  if (mode === null) return <BootGate />;
  return <Shell />;
}

function Shell() {
  const hub = isHub();
  const [sidebarOpen, setSidebarOpen] = useState(() => readStorage(SIDEBAR_KEY) !== "0");
  return (
    <TooltipProvider>
      <SidebarProvider
        open={sidebarOpen}
        onOpenChange={(open) => {
          setSidebarOpen(open);
          writeStorage(SIDEBAR_KEY, open ? "1" : "0");
        }}
      >
        <AppSidebar />
        <SidebarInset className="min-w-0">
          <header className="sticky top-0 z-30 flex h-12 items-center gap-2 border-b bg-background/80 px-3 backdrop-blur after:absolute after:inset-x-0 after:-bottom-px after:h-px after:bg-(image:--brand-thunder) after:opacity-70 md:hidden">
            <SidebarTrigger />
            <Lockup size="sm" />
            {hub ? <TeamHubBadge className="ml-1" /> : null}
          </header>
          <main className="w-full max-w-none px-4 py-6 sm:px-6">
            <View />
          </main>
        </SidebarInset>
      </SidebarProvider>
      {hub ? null : <NewRunSheet />}
      <CheckHistorySheet />
      <CommandPalette />
      <ShortcutsDialog />
      <Notifications />
      <GlobalShortcuts />
      <Toaster richColors />
    </TooltipProvider>
  );
}
