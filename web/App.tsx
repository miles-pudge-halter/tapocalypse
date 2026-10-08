import { useEffect, useState } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { CommandPalette } from "@/components/command-palette";
import { NewRunSheet } from "@/components/new-run-sheet";
import { Notifications } from "@/components/notifications";
import { ShortcutsDialog } from "@/components/shortcuts-dialog";
import { Toaster } from "@/components/ui/sonner";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { navigate, type Route, useNewRun, useRoute, useShortcut } from "@/lib/hooks";
import { readStorage, writeStorage } from "@/lib/storage";
import { Batch } from "@/views/Batch";
import { Dashboard } from "@/views/Dashboard";
import { Devices } from "@/views/Devices";
import { Projects } from "@/views/Projects";
import { ReportList, ReportView } from "@/views/Reports";
import { RunDetail } from "@/views/RunDetail";
import { Setup } from "@/views/Setup";

const SIDEBAR_KEY = "tapocalypse-sidebar";

/** Identity of the page: filter edits on the Runs page must not count as navigation (no scroll reset, no remount). */
function pageKey(route: Route): string {
  switch (route.name) {
    case "run":
    case "batch":
      return `${route.name}:${route.id}`;
    case "reports":
      return `reports:${route.projectId}`;
    case "report":
      return `report:${route.projectId}:${route.reportName}`;
    default:
      return route.name;
  }
}

function View() {
  const route = useRoute();
  const key = pageKey(route);
  // Hash navigation keeps the document, so the previous page's scroll offset would carry over.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [key]);
  switch (route.name) {
    case "runs":
      return <Dashboard />;
    case "run":
      return <RunDetail key={route.id} id={route.id} check={route.check} />;
    case "batch":
      return <Batch key={route.id} id={route.id} />;
    case "devices":
      return <Devices />;
    case "setup":
      return <Setup />;
    case "projects":
      return <Projects openNew={route.openNew} />;
    case "reports":
      return <ReportList projectId={route.projectId} />;
    case "report":
      return <ReportView projectId={route.projectId} name={route.reportName} />;
  }
}

function GlobalShortcuts() {
  const { openNewRun } = useNewRun();
  useShortcut("n", () => openNewRun());
  useShortcut("g r", () => navigate("#/"));
  useShortcut("g d", () => navigate("#/devices"));
  useShortcut("g p", () => navigate("#/projects"));
  useShortcut("g s", () => navigate("#/setup"));
  return null;
}

export function App() {
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
          <header className="sticky top-0 z-30 flex h-12 items-center gap-2 border-b bg-background/80 px-3 backdrop-blur md:hidden">
            <SidebarTrigger />
            <span className="text-sm font-semibold tracking-tight">Tapocalypse</span>
          </header>
          <main className="w-full max-w-none px-4 py-6 sm:px-6">
            <View />
          </main>
        </SidebarInset>
      </SidebarProvider>
      <NewRunSheet />
      <CommandPalette />
      <ShortcutsDialog />
      <Notifications />
      <GlobalShortcuts />
      <Toaster richColors />
    </TooltipProvider>
  );
}
