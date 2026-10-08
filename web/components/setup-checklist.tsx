import {
  AlertTriangle,
  ArrowRight,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  Loader2,
  MinusCircle,
  Power,
  RefreshCw,
  Rocket,
  X,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";
import { CodeBlock } from "@/components/code-block";
import { ConnectAgent } from "@/components/connect-agent";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { api, type Device, type DoctorCheck, type DoctorReport, type Platform, type PoolView, type ProjectStatus, type RunView } from "@/lib/api";
import { deviceDisplayName, deviceSubtitle } from "@/lib/format";
import {
  navigate,
  useDevices,
  useDoctor,
  useMcpStatus,
  useNewRun,
  usePool,
  useProjectScope,
  useProjects,
  useRuns,
  useTemplates,
} from "@/lib/hooks";
import { cn } from "@/lib/utils";

const REPO_URL = "https://github.com/miles-pudge-halter/tapocalypse";
const BANNER_DISMISSED_KEY = "tapocalypse.setupBannerDismissed";
const MCP_SEEN_KEY = "tapocalypse.mcpConnected";
const TOOL_CHECK_IDS: Record<string, true> = { bun: true, omp: true, node: true, git: true, gh: true, xcrun: true, adb: true, emulator: true };
const CODE_SPAN = /`([^`]+)`/g;

const STATUS: Record<DoctorCheck["status"], { icon: LucideIcon; className: string }> = {
  ok: { icon: CheckCircle2, className: "text-emerald-500" },
  warn: { icon: AlertTriangle, className: "text-orange-500" },
  error: { icon: XCircle, className: "text-red-500" },
  skip: { icon: MinusCircle, className: "text-muted-foreground" },
};

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function getFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function setFlag(key: string): void {
  try {
    localStorage.setItem(key, "1");
  } catch {
    // storage unavailable (private mode): the flag just won't persist
  }
}

/** Doctor fixes are sentences with the runnable commands in backticks; split them so each command gets a copy button. */
function splitFix(fix: string): { text: string; commands: string[] } {
  const commands: string[] = [];
  for (const match of fix.matchAll(CODE_SPAN)) {
    const command = match[1];
    if (command && /\s/.test(command) && !commands.includes(command)) commands.push(command);
  }
  return { text: fix.replace(CODE_SPAN, "$1"), commands };
}

export function DoctorRow({ check }: { check: DoctorCheck }) {
  const { icon: Icon, className } = STATUS[check.status];
  const needsFix = check.fix && (check.status === "error" || check.status === "warn");
  const fix = needsFix && check.fix ? splitFix(check.fix) : null;
  const anchor = TOOL_CHECK_IDS[check.id] ? "prerequisites" : "troubleshooting";
  return (
    <li className="flex gap-3 py-3">
      <Icon aria-label={check.status} className={cn("mt-0.5 size-4 shrink-0", className)} />
      <div className="min-w-0 flex-1 space-y-1.5">
        <p className="text-sm font-medium">{check.label}</p>
        <p className="break-words text-sm text-muted-foreground">{check.detail}</p>
        {fix && (
          <div className="space-y-2 pt-1">
            <p className="break-words text-sm">{fix.text}</p>
            {fix.commands.map((command) => (
              <CodeBlock key={command} code={command} prompt />
            ))}
            <a
              href={`${REPO_URL}#${anchor}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              <BookOpen className="size-3" />
              {anchor === "prerequisites" ? "Prerequisites in the README" : "Troubleshooting in the README"}
            </a>
          </div>
        )}
      </div>
    </li>
  );
}

/** Doctor rows grouped Required / Optional, each group headed by its ok count. */
export function DoctorList({ checks }: { checks: DoctorCheck[] }) {
  const groups = [
    { title: "Required", rows: checks.filter((c) => c.required) },
    { title: "Optional", rows: checks.filter((c) => !c.required) },
  ];
  return (
    <div className="space-y-6">
      {groups
        .filter((g) => g.rows.length > 0)
        .map((g) => {
          const ok = g.rows.filter((c) => c.status === "ok" || c.status === "skip").length;
          return (
            <section key={g.title} aria-label={g.title}>
              <h3 className="flex items-baseline gap-2 text-sm font-semibold">
                {g.title}
                <span className="text-xs font-normal text-muted-foreground tabular-nums">
                  {ok}/{g.rows.length} ok
                </span>
              </h3>
              <ul className="divide-y">
                {g.rows.map((c) => (
                  <DoctorRow key={c.id} check={c} />
                ))}
              </ul>
            </section>
          );
        })}
    </div>
  );
}

type MilestoneId = "prereq" | "project" | "device" | "run" | "agent";

interface Milestone {
  id: MilestoneId;
  title: string;
  done: boolean;
  /** One line shown under the title; says what was detected or what is missing. */
  summary: string;
}

export interface SetupProgress {
  milestones: Milestone[];
  done: number;
  total: number;
  complete: boolean;
  activeId: MilestoneId | null;
  /** False until the first full load; the guide shows skeletons instead of flashing "nothing done". */
  ready: boolean;
  doctor: { report: DoctorReport | null; loading: boolean; error: string | null; recheck(): void };
  projects: ProjectStatus[];
  readyProjects: ProjectStatus[];
  /** Connected phones and tablets that can run QA. */
  qaDevices: Device[];
  pool: PoolView | null;
  runs: RunView[];
}

/** Everything the guide derives its milestones from, so the Setup page and the Runs banner always agree. */
export function useSetupProgress(mcpPollMs: number): SetupProgress {
  const doctor = useDoctor();
  const { projects, loading: projectsLoading } = useProjects();
  const devices = useDevices(mcpPollMs);
  const { pool } = usePool();
  const { runs, loading: runsLoading } = useRuns({ limit: 1 });
  const { status: mcp } = useMcpStatus(mcpPollMs);
  const mcpCalled = mcp?.lastCallAt != null;

  useEffect(() => {
    if (mcpCalled) setFlag(MCP_SEEN_KEY);
  }, [mcpCalled]);

  const required = doctor.report?.checks.filter((c) => c.required) ?? [];
  const requiredOk = required.filter((c) => c.status === "ok" || c.status === "skip").length;
  const readyProjects = projects.filter((p) => p.status === "ok");
  const qaDevices = devices.devices.filter((d) => d.state === "ready" && d.deviceType !== "watch" && d.deviceType !== "tv");

  const milestones: Milestone[] = [
    {
      id: "prereq",
      title: "Prerequisites",
      done: required.length > 0 && requiredOk === required.length,
      summary: doctor.report ? `${requiredOk}/${required.length} required ok` : "Checking…",
    },
    {
      id: "project",
      title: "Add a project",
      done: readyProjects.length > 0,
      summary:
        readyProjects.length > 0
          ? readyProjects.map((p) => p.name).join(", ")
          : projects.length > 0
            ? "A project needs attention"
            : "No project yet",
    },
    {
      id: "device",
      title: "Connect a device",
      done: qaDevices.length > 0,
      summary:
        qaDevices.length > 0
          ? `${qaDevices.length} device${qaDevices.length === 1 ? "" : "s"} ready`
          : "No emulator or simulator is running",
    },
    {
      id: "run",
      title: "Run your first QA",
      done: runs.length > 0,
      summary: runs.length > 0 ? "Your first run is in" : "No runs yet",
    },
    {
      id: "agent",
      title: "Connect your coding agent (MCP)",
      done: mcpCalled || getFlag(MCP_SEEN_KEY),
      summary: mcpCalled || getFlag(MCP_SEEN_KEY) ? "Your agent has called Tapocalypse" : "Waiting for the first MCP call",
    },
  ];

  const dataReady = doctor.report !== null && !projectsLoading && !runsLoading && !(devices.loading && devices.devices.length === 0);
  // Later refreshes flip the loading flags again; once the first full load happened the guide must not flicker back to skeletons.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (dataReady) setReady(true);
  }, [dataReady]);

  const done = milestones.filter((m) => m.done).length;
  return {
    milestones,
    done,
    total: milestones.length,
    complete: done === milestones.length,
    activeId: milestones.find((m) => !m.done)?.id ?? null,
    ready,
    doctor,
    projects,
    readyProjects,
    qaDevices,
    pool,
    runs,
  };
}

/** Returns a function that opens the New run sheet prefilled with the built-in smoke-test brief for `project`. */
export function useStartSmokeRun(): (project: { id: string; defaultPlatform: Platform } | undefined) => void {
  const { openNewRun } = useNewRun();
  const { templates } = useTemplates();
  return (project) => {
    const template = templates.find((t) => t.id === "smoke");
    openNewRun({
      ...(project && { projectId: project.id, device: { platform: project.defaultPlatform } }),
      ...(template && { title: template.title, brief: template.brief }),
    });
  };
}

function MilestoneCard({
  index,
  milestone,
  open,
  onOpenChange,
  children,
}: {
  index: number;
  milestone: Milestone;
  open: boolean;
  onOpenChange(open: boolean): void;
  children: ReactNode;
}) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange} className="rounded-lg border bg-card text-card-foreground">
      <CollapsibleTrigger className="flex w-full items-center gap-3 rounded-lg px-4 py-3 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
        <span
          aria-hidden
          className={cn(
            "flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium tabular-nums",
            milestone.done ? "border-emerald-500 bg-emerald-500 text-white" : "text-muted-foreground",
          )}
        >
          {milestone.done ? <Check className="size-3.5" /> : index + 1}
        </span>
        <span className="min-w-0 flex-1">
          <span className={cn("block text-sm font-medium", milestone.done && "text-muted-foreground line-through")}>{milestone.title}</span>
          <span className="block truncate text-xs text-muted-foreground">{milestone.summary}</span>
        </span>
        <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform", !open && "-rotate-90")} />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="space-y-3 border-t px-4 py-4 pl-[3.25rem]">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function BootButtons({ pool, max }: { pool: PoolView; max: number }) {
  const [booting, setBooting] = useState<ReadonlySet<string>>(new Set());
  const targets = pool.bootable.slice(0, max);

  // "Booting…" ends once the pool stops offering the target; keys must not outlive that, or the button would
  // stay disabled when the emulator is later stopped and offered again.
  useEffect(() => {
    const offered = new Set(pool.bootable.map((b) => `${b.platform}:${b.target}`));
    setBooting((s) => {
      const next = new Set([...s].filter((k) => offered.has(k)));
      return next.size === s.size ? s : next;
    });
  }, [pool.bootable]);

  async function boot(platform: Platform, target: string, name: string) {
    const key = `${platform}:${target}`;
    setBooting((s) => new Set(s).add(key));
    try {
      await api.bootDevice(platform, target);
      toast.success(`Booting ${name}…`);
    } catch (e) {
      toast.error(`Could not boot ${name}: ${errorMessage(e)}`);
      setBooting((s) => {
        const next = new Set(s);
        next.delete(key);
        return next;
      });
    }
  }

  return (
    <div className="flex flex-wrap gap-2">
      {targets.map((b) => {
        const pending = booting.has(`${b.platform}:${b.target}`);
        return (
          <Button key={`${b.platform}:${b.target}`} size="sm" disabled={pending} onClick={() => void boot(b.platform, b.target, b.name)}>
            {pending ? <Loader2 className="animate-spin" /> : <Power />}
            {pending ? "Booting…" : `Boot ${b.name}`}
          </Button>
        );
      })}
    </div>
  );
}

function MilestoneBody({ id, setup }: { id: MilestoneId; setup: SetupProgress }) {
  const { scopeProject, startSmokeRun } = useSmokeTarget(setup.readyProjects);
  const { report } = setup.doctor;

  if (id === "prereq") {
    const required = report?.checks.filter((c) => c.required) ?? [];
    return (
      <>
        <p className="text-sm text-muted-foreground">Tapocalypse needs these tools on this machine to drive devices and run the QA agent.</p>
        {required.length > 0 && (
          <ul className="divide-y">
            {required.map((c) => (
              <DoctorRow key={c.id} check={c} />
            ))}
          </ul>
        )}
      </>
    );
  }

  if (id === "project") {
    const broken = setup.projects.filter((p) => p.status !== "ok");
    return (
      <>
        <p className="text-sm text-muted-foreground">
          Point Tapocalypse at your app's repository folder. It detects the framework, package name and QA persona for you.
        </p>
        {broken.map((p) => (
          <Alert key={p.id}>
            <AlertTriangle />
            <AlertTitle>{p.name} needs attention</AlertTitle>
            <AlertDescription>
              <ul className="list-disc pl-4">
                {p.problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ))}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => navigate("#/projects?new=1")}>
            Add a project
            <ArrowRight />
          </Button>
          {broken.length > 0 && (
            <Button size="sm" variant="outline" onClick={() => navigate("#/projects")}>
              Fix existing project
            </Button>
          )}
        </div>
      </>
    );
  }

  if (id === "device") {
    const hasBootable = (setup.pool?.bootable.length ?? 0) > 0;
    return (
      <>
        <p className="text-sm text-muted-foreground">
          Runs execute on an Android emulator or iOS simulator with your app installed. Tapocalypse can boot the ones listed in your device pool.
        </p>
        {setup.qaDevices.length > 0 && (
          <ul className="space-y-1 text-sm">
            {setup.qaDevices.slice(0, 4).map((d) => (
              <li key={d.serial} className="flex min-w-0 items-baseline gap-2">
                <CheckCircle2 className="size-3.5 shrink-0 translate-y-0.5 text-emerald-500" />
                <span className="truncate font-medium">{deviceDisplayName(d)}</span>
                <span className="truncate text-xs text-muted-foreground">{deviceSubtitle(d)}</span>
              </li>
            ))}
          </ul>
        )}
        {setup.pool && hasBootable && <BootButtons pool={setup.pool} max={3} />}
        {setup.qaDevices.length === 0 && !hasBootable && (
          <div className="space-y-2">
            <p className="text-sm">Start an emulator yourself, or list an AVD under <code className="rounded bg-muted px-1">devicePool.android.avds</code> in your config so Tapocalypse can boot it.</p>
            <CodeBlock code="emulator -list-avds" prompt />
          </div>
        )}
        <Button size="sm" variant="outline" onClick={() => navigate("#/devices")}>
          Open Devices
        </Button>
      </>
    );
  }

  if (id === "run") {
    const noProject = setup.readyProjects.length === 0;
    return (
      <>
        <p className="text-sm text-muted-foreground">
          The smoke test launches your app, walks through its main navigation and reports PASS or FAIL with screenshots. It is the quickest way to
          see everything working.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={noProject} onClick={() => startSmokeRun()}>
            Run a smoke test
            <ArrowRight />
          </Button>
          {setup.runs.length > 0 && (
            <Button size="sm" variant="outline" onClick={() => navigate("#/")}>
              View runs
            </Button>
          )}
        </div>
        {noProject && <p className="text-xs text-muted-foreground">Add a project first.</p>}
        {!noProject && scopeProject && <p className="text-xs text-muted-foreground">Starts on {scopeProject.name}.</p>}
      </>
    );
  }

  return <ConnectAgent />;
}

/** The project a smoke run should target: the sidebar scope when it is a ready project, else the first ready one. */
function useSmokeTarget(readyProjects: ProjectStatus[]) {
  const { projectId } = useProjectScope();
  const startSmokeRun = useStartSmokeRun();
  const scopeProject = readyProjects.find((p) => p.id === projectId) ?? readyProjects[0];
  return { scopeProject, startSmokeRun: () => startSmokeRun(scopeProject) };
}

/** The "Get started" guide: milestone cards that complete themselves from machine state. */
export function SetupChecklist() {
  const setup = useSetupProgress(5_000);
  const [overrides, setOverrides] = useState<Partial<Record<MilestoneId, boolean>>>({});
  const { doctor } = setup;

  if (!setup.ready) {
    if (doctor.error && !doctor.report) {
      return (
        <Alert variant="destructive">
          <XCircle />
          <AlertTitle>Could not run the setup checks</AlertTitle>
          <AlertDescription>{doctor.error}</AlertDescription>
        </Alert>
      );
    }
    return (
      <div className="space-y-3" aria-busy>
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <Card className="gap-3 py-4">
        <CardHeader className="px-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="text-base">{setup.complete ? "You're all set" : "Get started"}</CardTitle>
              <p className="text-sm text-muted-foreground">
                {setup.complete
                  ? "Everything is connected. The steps below stay here if you need them again."
                  : "Steps complete themselves as Tapocalypse detects them. Skip around freely."}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium tabular-nums">
                {setup.done} of {setup.total} complete
              </span>
              <Button variant="outline" size="sm" onClick={doctor.recheck} disabled={doctor.loading}>
                <RefreshCw className={cn("size-3.5", doctor.loading && "animate-spin")} />
                Re-check
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="px-4">
          <Progress value={(setup.done / setup.total) * 100} aria-label="Setup progress" />
        </CardContent>
      </Card>

      {setup.milestones.map((m, i) => (
        <MilestoneCard
          key={m.id}
          index={i}
          milestone={m}
          open={overrides[m.id] ?? m.id === setup.activeId}
          onOpenChange={(open) => setOverrides((o) => ({ ...o, [m.id]: open }))}
        >
          <MilestoneBody id={m.id} setup={setup} />
        </MilestoneCard>
      ))}
    </div>
  );
}

/** Compact "Finish setup (2 of 5)" strip for the Runs page; stays gone once dismissed or complete. */
export function SetupBanner() {
  const [dismissed, setDismissed] = useState(() => getFlag(BANNER_DISMISSED_KEY));
  if (dismissed) return null;
  return (
    <ActiveBanner
      onDismiss={() => {
        setFlag(BANNER_DISMISSED_KEY);
        setDismissed(true);
      }}
    />
  );
}

function ActiveBanner({ onDismiss }: { onDismiss(): void }) {
  const setup = useSetupProgress(30_000);
  if (!setup.ready || setup.complete) return null;
  const next = setup.milestones.find((m) => m.id === setup.activeId);
  return (
    <div role="status" className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border bg-muted/40 px-4 py-2.5">
      <Rocket className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1 text-sm">
        <span className="font-medium">
          Finish setup ({setup.done} of {setup.total})
        </span>
        {next && <span className="text-muted-foreground"> · next: {next.title}</span>}
      </div>
      <div className="flex items-center gap-1" aria-hidden>
        {setup.milestones.map((m) => (
          <span key={m.id} className={cn("h-1.5 w-6 rounded-full", m.done ? "bg-emerald-500" : "bg-muted-foreground/25")} />
        ))}
      </div>
      <Button asChild size="sm" variant="outline">
        <a href="#/setup">
          Continue
          <ArrowRight />
        </a>
      </Button>
      <Button variant="ghost" size="icon-xs" aria-label="Dismiss setup banner" onClick={onDismiss}>
        <X />
      </Button>
    </div>
  );
}
