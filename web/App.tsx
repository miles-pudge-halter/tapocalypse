import { useEffect } from "react";
import { ChevronDown, FileText, Smartphone } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { navigate, useDoctor, useProjects, useRoute, useRuns } from "@/lib/hooks";
import { Dashboard } from "@/views/Dashboard";
import { Projects } from "@/views/Projects";
import { ReportList, ReportView } from "@/views/Reports";
import { RunDetail } from "@/views/RunDetail";

function LiveCounters() {
  const { runs } = useRuns();
  const running = runs.filter((r) => r.status === "preflight" || r.status === "running" || r.status === "finishing").length;
  const queued = runs.filter((r) => r.status === "queued").length;
  return (
    <div className="flex items-center gap-2 text-xs tabular-nums">
      <Badge variant="outline" className="gap-1.5 border-blue-500/30 text-blue-700 dark:text-blue-300">
        <span className={running > 0 ? "size-2 animate-pulse rounded-full bg-blue-500" : "size-2 rounded-full bg-muted-foreground/40"} />
        {running} running
      </Badge>
      <Badge variant="outline" className="gap-1.5 text-muted-foreground">
        {queued} queued
      </Badge>
    </div>
  );
}

function ReportsMenu() {
  const { projects } = useProjects();
  const ready = projects.filter((p) => p.status === "ok");
  const route = useRoute();
  const active = route.name === "reports" || route.name === "report";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant={active ? "secondary" : "ghost"} size="sm" className="gap-1">
          <FileText className="size-4" />
          Reports
          <ChevronDown className="size-3.5 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>Project reports</DropdownMenuLabel>
        {ready.length === 0 && <DropdownMenuItem disabled>No projects</DropdownMenuItem>}
        {ready.map((p) => (
          <DropdownMenuItem key={p.id} onSelect={() => navigate(`#/p/${encodeURIComponent(p.id)}/reports`)}>
            {p.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TopBar() {
  const route = useRoute();
  const { blocked } = useDoctor();
  return (
    <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-4 px-4 sm:px-6">
        <a href="#/" className="flex items-center gap-2 font-semibold tracking-tight">
          <span className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Smartphone className="size-4" />
          </span>
          Tapocalypse
        </a>
        <nav className="flex items-center gap-1">
          <Button asChild variant={route.name === "dashboard" || route.name === "run" ? "secondary" : "ghost"} size="sm">
            <a href="#/">Runs</a>
          </Button>
          <Button asChild variant={route.name === "projects" ? "secondary" : "ghost"} size="sm">
            <a href="#/projects" className="relative">
              Projects
              {blocked && (
                <span
                  role="img"
                  aria-label="Setup needed"
                  title="A required prerequisite is missing — see Setup on the Projects page"
                  className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-red-500"
                />
              )}
            </a>
          </Button>
          <ReportsMenu />
        </nav>
        <div className="ml-auto flex items-center gap-3">
          <LiveCounters />
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}

function View() {
  const route = useRoute();
  const routeKey = JSON.stringify(route);
  // Hash navigation keeps the document, so the previous page's scroll offset would carry over.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [routeKey]);
  switch (route.name) {
    case "dashboard":
      return <Dashboard rerunId={route.rerunId} />;
    case "run":
      return <RunDetail key={route.id} id={route.id} />;
    case "projects":
      return <Projects openNew={route.openNew} />;
    case "reports":
      return <ReportList projectId={route.projectId} />;
    case "report":
      return <ReportView projectId={route.projectId} name={route.reportName} />;
  }
}

export function App() {
  return (
    <TooltipProvider>
      <div className="min-h-screen bg-background text-foreground">
        <TopBar />
        <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
          <View />
        </main>
      </div>
      <Toaster richColors />
    </TooltipProvider>
  );
}
