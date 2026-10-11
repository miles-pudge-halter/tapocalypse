import {
  ChevronsUpDown,
  FileText,
  FolderKanban,
  LayoutList,
  Monitor,
  Moon,
  Plus,
  Search,
  Settings2,
  Smartphone,
  Sun,
} from "lucide-react";
import { useEffect } from "react";
import pkg from "../../package.json";
import { LogoMark, Wordmark } from "@/components/brand";
import { openCommandPalette } from "@/components/command-palette";
import { NotificationsToggle } from "@/components/notifications";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { MOD_KEY_LABEL } from "@/components/shortcuts-dialog";
import {
  navigate,
  useActiveRuns,
  useDevices,
  useDoctor,
  useLiveConnection,
  useProjectScope,
  useProjects,
  useRoute,
} from "@/lib/hooks";
import { deviceCounts } from "@/lib/leases";
import { type Theme, useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

function ProjectSwitcher() {
  const { projects } = useProjects();
  const { projectId, setProjectId } = useProjectScope();
  const ready = projects.filter((p) => p.status === "ok");
  const current = ready.find((p) => p.id === projectId);

  // A scope that no longer exists (deleted/renamed project) must not silently filter every page to nothing.
  useEffect(() => {
    if (projectId && projects.length > 0 && !projects.some((p) => p.id === projectId)) setProjectId(null);
  }, [projectId, projects, setProjectId]);

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton size="lg" tooltip={current?.name ?? "All projects"} className="data-[state=open]:bg-sidebar-accent">
              <LogoMark size={32} />
              <div className="grid flex-1 gap-1 text-left leading-tight">
                <Wordmark className="h-[11px]" />
                <span className="truncate text-xs text-muted-foreground">{current?.name ?? "All projects"}</span>
              </div>
              <ChevronsUpDown className="ml-auto size-4 text-muted-foreground" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-(--radix-dropdown-menu-trigger-width) min-w-56">
            <DropdownMenuLabel>Project</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={projectId ?? ""} onValueChange={(v) => setProjectId(v || null)}>
              <DropdownMenuRadioItem value="">All projects</DropdownMenuRadioItem>
              {ready.map((p) => (
                <DropdownMenuRadioItem key={p.id} value={p.id}>
                  {p.name}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => navigate("#/projects?new=1")}>
              <Plus /> Add project
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

function RunsNav({ active }: { active: boolean }) {
  const { runs } = useActiveRuns();
  const running = runs.filter((r) => r.status !== "queued").length;
  const queued = runs.length - running;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={active} tooltip="Runs" className="strike">
        <a href="#/">
          <LayoutList />
          <span>Runs</span>
        </a>
      </SidebarMenuButton>
      {running + queued > 0 && (
        <SidebarMenuBadge
          className={cn(running > 0 && "bg-blue-500/15 text-blue-700 dark:text-blue-300")}
          title={`${running} running · ${queued} queued`}
        >
          {running > 0 && <span className="mr-1 inline-block size-1.5 animate-pulse rounded-full bg-blue-500" />}
          {running > 0 ? running : queued}
        </SidebarMenuBadge>
      )}
    </SidebarMenuItem>
  );
}

function DevicesNav({ active }: { active: boolean }) {
  const { devices } = useDevices();
  const { usable, running, held, busy, free } = deviceCounts(devices);
  const title = [running > 0 ? `${running} running` : null, held > 0 ? `${held} held by agents` : null, `${free} free`].filter(Boolean).join(" · ");
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={active} tooltip="Devices" className="strike">
        <a href="#/devices">
          <Smartphone />
          <span>Devices</span>
        </a>
      </SidebarMenuButton>
      {usable > 0 && (
        <SidebarMenuBadge
          className={cn(
            running > 0 && "bg-blue-500/15 text-blue-700 dark:text-blue-300",
            running === 0 && held > 0 && "bg-violet-50 text-violet-800 dark:bg-violet-950/40 dark:text-violet-300",
          )}
          title={title}
        >
          {held > 0 && <span className="mr-1 inline-block size-1.5 rounded-full bg-violet-500" />}
          {busy}/{usable}
        </SidebarMenuBadge>
      )}
    </SidebarMenuItem>
  );
}

function ReportsNav({ active }: { active: boolean }) {
  const { projects } = useProjects();
  const { projectId } = useProjectScope();
  const ready = projects.filter((p) => p.status === "ok");
  const target = ready.find((p) => p.id === projectId) ?? (ready.length === 1 ? ready[0] : undefined);
  if (target) {
    return (
      <SidebarMenuItem>
        <SidebarMenuButton asChild isActive={active} tooltip="Reports" className="strike">
          <a href={`#/p/${encodeURIComponent(target.id)}/reports`}>
            <FileText />
            <span>Reports</span>
          </a>
        </SidebarMenuButton>
      </SidebarMenuItem>
    );
  }
  return (
    <SidebarMenuItem>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuButton isActive={active} tooltip="Reports" className="strike">
            <FileText />
            <span>Reports</span>
          </SidebarMenuButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="start">
          <DropdownMenuLabel>Project reports</DropdownMenuLabel>
          {ready.length === 0 && <DropdownMenuItem disabled>No projects yet</DropdownMenuItem>}
          {ready.map((p) => (
            <DropdownMenuItem key={p.id} onSelect={() => navigate(`#/p/${encodeURIComponent(p.id)}/reports`)}>
              {p.name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  );
}

function SetupNav({ active }: { active: boolean }) {
  const { blocked } = useDoctor();
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={active}
        tooltip={blocked ? "Setup — a required prerequisite is missing" : "Setup"}
        className="strike"
      >
        <a href="#/setup">
          <Settings2 />
          <span>Setup</span>
        </a>
      </SidebarMenuButton>
      {blocked && (
        <span
          role="img"
          aria-label="Setup needed"
          className="pointer-events-none absolute right-2 top-1/2 size-2 -translate-y-1/2 rounded-full bg-red-500 group-data-[collapsible=icon]:right-1 group-data-[collapsible=icon]:top-1.5 group-data-[collapsible=icon]:translate-y-0"
        />
      )}
    </SidebarMenuItem>
  );
}

const THEME_LABEL: Record<Theme, string> = { light: "Light", dark: "Dark", system: "System" };
const THEME_ICON = { light: Sun, dark: Moon, system: Monitor } as const;

function ThemeMenu() {
  const { theme, setTheme } = useTheme();
  const Icon = THEME_ICON[theme];
  return (
    <SidebarMenuItem>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuButton tooltip={`Theme: ${THEME_LABEL[theme]}`} className="strike">
            <Icon />
            <span>Theme: {THEME_LABEL[theme]}</span>
          </SidebarMenuButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="end">
          <DropdownMenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as Theme)}>
            <DropdownMenuRadioItem value="light">
              <Sun /> Light
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="dark">
              <Moon /> Dark
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="system">
              <Monitor /> System
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  );
}

function LiveIndicator() {
  const live = useLiveConnection();
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        tooltip={live ? "Live — receiving run updates" : "Reconnecting to the Tapocalypse server…"}
        className="cursor-default hover:bg-transparent active:bg-transparent"
        aria-live="polite"
      >
        <span className="flex size-4 items-center justify-center">
          <span className="relative flex size-2">
            {live && <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500 opacity-60" />}
            <span className={cn("relative inline-flex size-2 rounded-full", live ? "bg-emerald-500" : "bg-orange-400")} />
          </span>
        </span>
        <span className={cn(!live && "text-orange-700 dark:text-orange-400")}>{live ? "Live" : "Reconnecting…"}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

export function AppSidebar() {
  const route = useRoute();
  const runsActive = route.name === "runs" || route.name === "run" || route.name === "compare" || route.name === "batch";
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <ProjectSwitcher />
        <div aria-hidden className="mx-2 h-px bg-(image:--brand-thunder) opacity-70 group-data-[collapsible=icon]:mx-1" />
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  tooltip={`Search (${MOD_KEY_LABEL} K)`}
                  onClick={openCommandPalette}
                  className="strike text-muted-foreground"
                >
                  <Search />
                  <span>Search…</span>
                  <Kbd className="ml-auto group-data-[collapsible=icon]:hidden">{MOD_KEY_LABEL} K</Kbd>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <RunsNav active={runsActive} />
              <DevicesNav active={route.name === "devices"} />
              <ReportsNav active={route.name === "reports" || route.name === "report" || route.name === "flaky"} />
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={route.name === "projects"} tooltip="Projects" className="strike">
                  <a href="#/projects">
                    <FolderKanban />
                    <span>Projects</span>
                  </a>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SetupNav active={route.name === "setup"} />
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <LiveIndicator />
          <SidebarMenuItem>
            <NotificationsToggle />
          </SidebarMenuItem>
          <ThemeMenu />
          <SidebarMenuItem>
            <span className="flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
              v{pkg.version}
            </span>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
