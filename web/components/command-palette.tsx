import {
  Bell,
  FileText,
  FolderKanban,
  Keyboard,
  LayoutList,
  Moon,
  Play,
  RotateCcw,
  Settings2,
  Smartphone,
} from "lucide-react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { RunStatusIcon } from "@/components/run-status-icon";
import { openShortcutsDialog } from "@/components/shortcuts-dialog";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { type Device, type ReportEntry, type RunView, api, reportEntryHash, runHash } from "@/lib/api";
import { deviceDisplayName, deviceSubtitle } from "@/lib/format";
import {
  navigate,
  runsHash,
  useDevices,
  useNewRun,
  useNotifications,
  useProjectScope,
  useProjects,
  useShortcut,
} from "@/lib/hooks";
import { useTheme } from "@/lib/theme";

const listeners = new Set<() => void>();
let isOpen = false;

function setOpen(next: boolean): void {
  isOpen = next;
  for (const l of listeners) l();
}

export function openCommandPalette(): void {
  setOpen(true);
}

const RECENT_RUNS = 30;
const SEARCH_DEBOUNCE_MS = 250;
const REPORTS_PER_PROJECT = 6;
const FAILED_VERDICTS = ["FAIL", "BLOCKED", "PARTIAL"];

function runKeywords(run: RunView): string[] {
  const words = [run.id, run.projectId, run.status];
  if (run.verdict) words.push(run.verdict);
  if (run.source?.branch) words.push(run.source.branch);
  if (run.source?.pr) words.push(`#${run.source.pr.number}`, `PR ${run.source.pr.number}`);
  if (run.source?.tickets.length) words.push(...run.source.tickets);
  return words;
}

function runDetail(run: RunView): string {
  const parts: string[] = [run.projectId];
  if (run.source?.branch) parts.push(run.source.branch);
  if (run.source?.pr) parts.push(`#${run.source.pr.number}`);
  return parts.join(" · ");
}

interface ProjectReport extends ReportEntry {
  projectId: string;
  projectName: string;
}

function PaletteContent({ close }: { close: () => void }) {
  const [query, setQuery] = useState("");
  const [recent, setRecent] = useState<RunView[]>([]);
  const [found, setFound] = useState<RunView[]>([]);
  const [reports, setReports] = useState<ProjectReport[]>([]);
  const { projects } = useProjects();
  const { devices } = useDevices();
  const { openNewRun } = useNewRun();
  const { projectId: scopeId, setProjectId } = useProjectScope();
  const { enabled: notificationsOn, setEnabled } = useNotifications();
  const { setTheme } = useTheme();

  const readyProjects = useMemo(() => projects.filter((p) => p.status === "ok"), [projects]);

  useEffect(() => {
    let cancelled = false;
    api.runs({ limit: RECENT_RUNS }).then(
      (r) => !cancelled && setRecent(r.runs),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setFound([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      api.runs({ q, limit: 10 }).then(
        (r) => !cancelled && setFound(r.runs),
        () => undefined,
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  const reportProjects = useMemo(
    () => (scopeId ? readyProjects.filter((p) => p.id === scopeId) : readyProjects),
    [readyProjects, scopeId],
  );
  useEffect(() => {
    let cancelled = false;
    Promise.all(
      reportProjects.map((p) =>
        api.reports(p.id).then(
          (list) =>
            list.slice(0, REPORTS_PER_PROJECT).map((r): ProjectReport => ({ ...r, projectId: p.id, projectName: p.name })),
          () => [],
        ),
      ),
    ).then((lists) => !cancelled && setReports(lists.flat()));
    return () => {
      cancelled = true;
    };
  }, [reportProjects]);

  const runs = useMemo(() => {
    const seen = new Set<string>();
    return [...found, ...recent].filter((r) => !seen.has(r.id) && seen.add(r.id));
  }, [found, recent]);

  const lastFailed = recent.find((r) => r.status === "error" || (r.verdict !== null && FAILED_VERDICTS.includes(r.verdict)));
  const bookable = devices.filter((d: Device) => d.state === "ready" && d.deviceType !== "watch" && d.deviceType !== "tv");

  const run = (action: () => void) => () => {
    close();
    action();
  };
  const go = (hash: string) => run(() => navigate(hash));

  const rerunLastFailed = run(() => {
    if (!lastFailed) return;
    api.rerun(lastFailed.id, "failed").then(
      (created) => navigate(runHash(created.id)),
      (e: unknown) => toast.error(e instanceof Error ? e.message : String(e)),
    );
  });

  const reportsProjectId = scopeId ?? readyProjects[0]?.id;

  return (
    <>
      <CommandInput value={query} onValueChange={setQuery} placeholder="Search runs, projects, devices, reports, actions…" />
      <CommandList className="max-h-[60vh]">
        <CommandEmpty>Nothing matches “{query}”.</CommandEmpty>

        <CommandGroup heading="Actions">
          <CommandItem value="action new run" keywords={["start", "create"]} onSelect={run(() => openNewRun())}>
            <Play /> New run
          </CommandItem>
          {bookable.map((d) => (
            <CommandItem
              key={d.serial}
              value={`action new run on ${deviceDisplayName(d)} ${d.serial}`}
              onSelect={run(() => openNewRun({ device: { platform: d.platform, serial: d.serial } }))}
            >
              <Smartphone /> New run on {deviceDisplayName(d)}
              <span className="ml-auto text-xs text-muted-foreground">{d.serial}</span>
            </CommandItem>
          ))}
          {lastFailed && (
            <CommandItem value="action re-run last failed" keywords={["retry", "rerun"]} onSelect={rerunLastFailed}>
              <RotateCcw /> Re-run last failed
              <span className="ml-auto max-w-48 truncate text-xs text-muted-foreground">{lastFailed.title}</span>
            </CommandItem>
          )}
          <CommandItem
            value="action toggle theme"
            keywords={["dark", "light", "appearance"]}
            onSelect={run(() => setTheme(document.documentElement.classList.contains("dark") ? "light" : "dark"))}
          >
            <Moon /> Toggle theme
          </CommandItem>
          <CommandItem
            value="action toggle notifications"
            keywords={["notify", "alerts"]}
            onSelect={run(() => void setEnabled(!notificationsOn))}
          >
            <Bell /> Toggle notifications
            <span className="ml-auto text-xs text-muted-foreground">{notificationsOn ? "on" : "off"}</span>
          </CommandItem>
          <CommandItem value="action keyboard shortcuts" keywords={["help", "keys"]} onSelect={run(openShortcutsDialog)}>
            <Keyboard /> Keyboard shortcuts
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />
        <CommandGroup heading="Go to">
          <CommandItem value="page runs" onSelect={go("#/")}>
            <LayoutList /> Runs
          </CommandItem>
          <CommandItem value="page devices" onSelect={go("#/devices")}>
            <Smartphone /> Devices
          </CommandItem>
          <CommandItem
            value="page reports"
            disabled={!reportsProjectId}
            onSelect={go(`#/p/${encodeURIComponent(reportsProjectId ?? "")}/reports`)}
          >
            <FileText /> Reports
          </CommandItem>
          <CommandItem value="page projects" onSelect={go("#/projects")}>
            <FolderKanban /> Projects
          </CommandItem>
          <CommandItem value="page setup" keywords={["doctor", "mcp", "connect agent"]} onSelect={go("#/setup")}>
            <Settings2 /> Setup
          </CommandItem>
        </CommandGroup>

        {readyProjects.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Projects">
              {readyProjects.map((p) => (
                <CommandItem
                  key={p.id}
                  value={`project ${p.name} ${p.id}`}
                  onSelect={run(() => {
                    setProjectId(p.id);
                    navigate(runsHash({ project: p.id }));
                  })}
                >
                  <FolderKanban /> {p.name}
                  <span className="ml-auto text-xs text-muted-foreground">{p.id}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {devices.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Devices">
              {devices.map((d) => (
                <CommandItem key={d.serial} value={`device ${deviceDisplayName(d)} ${d.serial}`} onSelect={go("#/devices")}>
                  <Smartphone /> {deviceDisplayName(d)}
                  <span className="ml-auto text-xs text-muted-foreground">{deviceSubtitle(d)}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {runs.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Runs">
              {runs.map((r) => (
                <CommandItem
                  key={r.id}
                  value={`run ${r.id} ${r.title}`}
                  keywords={runKeywords(r)}
                  onSelect={go(runHash(r.id))}
                >
                  <RunStatusIcon status={r.status} verdict={r.verdict} />
                  <span className="truncate">{r.title}</span>
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">{runDetail(r)}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {reports.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Reports">
              {reports.map((r) => (
                <CommandItem
                  key={`${r.projectId}/${r.name}`}
                  value={`report ${r.title} ${r.name} ${r.projectName}`}
                  onSelect={go(reportEntryHash(r.projectId, r.name))}
                >
                  <FileText /> <span className="truncate">{r.title}</span>
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">{r.projectName}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </>
  );
}

/** ⌘K / Ctrl+K palette. Content mounts only while open so its data fetches don't run in the background. */
export function CommandPalette() {
  const open = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    () => isOpen,
  );
  useShortcut("mod+k", () => setOpen(!isOpen));
  return (
    <CommandDialog open={open} onOpenChange={setOpen} title="Command palette" description="Jump to a page, run, device or report, or run an action.">
      {open && <PaletteContent close={() => setOpen(false)} />}
    </CommandDialog>
  );
}
