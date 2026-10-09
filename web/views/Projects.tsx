import {
  AlertCircle,
  Apple,
  ArrowLeft,
  Atom,
  Bot,
  Boxes,
  Check,
  CheckCircle2,
  ChevronDown,
  FileText,
  Feather,
  FolderGit2,
  FolderOpen,
  ListChecks,
  Loader2,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  ScanSearch,
  Search,
  Sparkles,
  Trash2,
  TriangleAlert,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { CopyButton } from "@/components/copy-button";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { useStartSmokeRun } from "@/components/setup-checklist";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  api,
  type Detection,
  type Framework,
  type Platform,
  type Project,
  type ProjectInput,
  type ProjectStatus,
  type ProjectSuggestion,
  type RunView,
  runHash,
} from "@/lib/api";
import { formatCost, formatRelative } from "@/lib/format";
import { navigate, useActiveRuns, useNewRun, useNow, useProjects, useRuns, useStats, useSuites } from "@/lib/hooks";
import { cn } from "@/lib/utils";

const FRAMEWORK_LABEL: Record<Framework, string> = {
  flutter: "Flutter",
  "react-native": "React Native",
  expo: "Expo",
  android: "Native Android",
  ios: "Native iOS",
  kmp: "Kotlin Multiplatform",
  unknown: "Unknown framework",
};

const FRAMEWORK_ICON: Record<Framework, LucideIcon> = {
  flutter: Feather,
  "react-native": Atom,
  expo: Atom,
  android: Bot,
  ios: Apple,
  kmp: Boxes,
  unknown: FolderGit2,
};

const PLATFORM_LABEL: Record<Platform, string> = { android: "Android", ios: "iOS" };
const PLATFORM_ICON: Record<Platform, LucideIcon> = { android: Bot, ios: Apple };
const PLATFORMS: Platform[] = ["android", "ios"];
const PACKAGE_EXAMPLE: Record<Platform, string> = { android: "com.example.myapp.dev", ios: "com.example.myapp" };

const VALIDATE_DEBOUNCE_MS = 400;
const STRIP_RUNS = 12;
/** Select / radio sentinels; real values (packages, repo-relative paths) never start with ":". */
const CUSTOM = ":custom";
const BUILTIN = ":builtin";
const SAVE_ERROR = /^(\w+): (.+)$/s;
const PROJECT_FIELDS: (keyof Project)[] = ["id", "name", "repoPath", "personaFile", "reportsDir", "defaultPackage", "defaultPlatform"];

type FieldErrors = Partial<Record<keyof Project, string>>;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}

/** Detection is cheap but not free; every card for the same repo shares one request for the page's lifetime. */
const detections = new Map<string, Promise<Detection | null>>();

function loadDetection(repoPath: string): Promise<Detection | null> {
  let pending = detections.get(repoPath);
  if (!pending) {
    pending = api.detectProject(repoPath).catch(() => null);
    detections.set(repoPath, pending);
  }
  return pending;
}

function useDetection(project: ProjectStatus): Detection | null {
  const [detection, setDetection] = useState<Detection | null>(null);
  const { repoPath, status } = project;
  useEffect(() => {
    if (status !== "ok") return;
    let cancelled = false;
    void loadDetection(repoPath).then((d) => {
      if (!cancelled) setDetection(d);
    });
    return () => {
      cancelled = true;
    };
  }, [repoPath, status]);
  return detection;
}

interface SheetState {
  open: boolean;
  /** null = add flow. */
  project: ProjectStatus | null;
  /** Set once the add flow saved; the sheet then shows next steps instead of the form. */
  created: ProjectStatus | null;
  /** Bumped on every open so the form remounts with fresh state. */
  nonce: number;
}

export function Projects({ openNew }: { openNew: boolean }) {
  const { projects, loading, error, refresh } = useProjects();
  const { runs: activeRuns } = useActiveRuns();
  const now = useNow(30_000);
  const [sheet, setSheet] = useState<SheetState>({ open: false, project: null, created: null, nonce: 0 });
  const [deleting, setDeleting] = useState<ProjectStatus | null>(null);

  function openSheet(project: ProjectStatus | null) {
    setSheet((s) => ({ open: true, project, created: null, nonce: s.nonce + 1 }));
  }

  const activeCount = (projectId: string) => activeRuns.filter((r) => r.projectId === projectId).length;

  // `#/projects?new=1` is a one-shot request from elsewhere in the app; consume it so a reload doesn't reopen the
  // sheet. Replace (not push) the entry so Back never lands on `?new=1` again.
  useEffect(() => {
    if (!openNew) return;
    openSheet(null);
    window.location.replace("#/projects");
  }, [openNew]);

  return (
    <div>
      <PageHeader
        title="Projects"
        description="The mobile apps Tapocalypse can test. Each project points at a repository on this machine."
        actions={
          <Button onClick={() => openSheet(null)}>
            <Plus />
            Add project
          </Button>
        }
      />

      {error && (
        <Alert variant="destructive" className="mb-4">
          <AlertCircle />
          <AlertTitle>Could not load projects</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {loading && projects.length === 0 ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" aria-busy>
          <Skeleton className="h-72 w-full" />
          <Skeleton className="h-72 w-full" />
          <Skeleton className="h-72 w-full" />
        </div>
      ) : projects.length === 0 && !error ? (
        <EmptyState
          icon={FolderOpen}
          title="Add your first project"
          description="Pick your app's repository folder. Tapocalypse detects the framework, package name and QA persona, so adding a project takes about a minute."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button onClick={() => openSheet(null)}>
                <Plus />
                Add your first project
              </Button>
              <Button variant="outline" onClick={() => navigate("#/setup")}>
                <ListChecks />
                Open setup guide
              </Button>
            </div>
          }
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {projects.map((p) => (
            <ProjectCard
              key={p.id}
              project={p}
              activeCount={activeCount(p.id)}
              now={now}
              onEdit={() => openSheet(p)}
              onDelete={() => setDeleting(p)}
            />
          ))}
        </div>
      )}

      <Sheet open={sheet.open} onOpenChange={(open) => setSheet((s) => ({ ...s, open }))}>
        <SheetContent
          side="right"
          className="w-full gap-0 overflow-y-auto sm:max-w-xl"
          // The form focuses its own first field.
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <SheetHeader>
            <SheetTitle>{sheet.created ? `${sheet.created.name} added` : sheet.project ? `Edit ${sheet.project.name}` : "Add a project"}</SheetTitle>
            <SheetDescription>
              {sheet.created
                ? "Your project is ready. Here is what to do next."
                : sheet.project
                  ? "Changes apply to new runs straight away; runs already in progress are not affected."
                  : "Two quick steps: tell us where the app lives, then check what we detected."}
            </SheetDescription>
          </SheetHeader>
          {sheet.created ? (
            <AddedSuccess project={sheet.created} onClose={() => setSheet((s) => ({ ...s, open: false }))} />
          ) : (
            <ProjectForm
              key={sheet.nonce}
              project={sheet.project}
              onCreated={(created) => {
                setSheet((s) => ({ ...s, created }));
                refresh();
              }}
              onUpdated={() => {
                setSheet((s) => ({ ...s, open: false }));
                refresh();
              }}
            />
          )}
        </SheetContent>
      </Sheet>

      <DeleteDialog
        project={deleting}
        activeCount={deleting ? activeCount(deleting.id) : 0}
        onClose={() => setDeleting(null)}
        onDeleted={refresh}
      />
    </div>
  );
}

// --- Project card ---

/** Dot colour for the verdict strip: the verdict when there is one, else the status. */
function dotClass(run: RunView): string {
  switch (run.verdict) {
    case "PASS":
      return "bg-emerald-500";
    case "FAIL":
      return "bg-red-500";
    case "PASS WITH ISSUES":
      return "bg-orange-400";
    case "BLOCKED":
      return "bg-rose-800 dark:bg-rose-700";
    case "PARTIAL":
      return "border-2 border-orange-400 bg-transparent";
    case null:
      break;
  }
  if (run.status === "queued" || run.status === "preflight" || run.status === "running" || run.status === "finishing") {
    return "animate-pulse bg-blue-500";
  }
  if (run.status === "error") return "border-2 border-red-500/60 bg-transparent";
  return "bg-stone-400 dark:bg-stone-600";
}

function VerdictStrip({ runs }: { runs: RunView[] }) {
  // The list is newest first; the strip reads oldest to newest, left to right.
  const dots = runs.slice(0, STRIP_RUNS).reverse();
  return (
    <div className="flex items-center gap-1" role="list" aria-label="Most recent runs">
      {dots.map((run) => (
        <Tooltip key={run.id}>
          <TooltipTrigger asChild>
            <a
              role="listitem"
              href={runHash(run.id)}
              aria-label={`${run.title}: ${run.verdict ?? run.status}`}
              className={cn("size-3 rounded-full outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring", dotClass(run))}
            />
          </TooltipTrigger>
          <TooltipContent>
            {run.title} · {run.verdict ?? run.status}
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}

function SuitesCount({ projectId }: { projectId: string }) {
  const { suites, loading } = useSuites(projectId);
  if (loading) return null;
  return <span className="ml-auto text-xs tabular-nums text-muted-foreground">{suites.length}</span>;
}

function SuitesDialog({ project, open, onClose }: { project: ProjectStatus; open: boolean; onClose(): void }) {
  const { suites, loading, error } = useSuites(project.id);
  const { openNewRun } = useNewRun();
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{project.name} suites</DialogTitle>
          <DialogDescription>
            A suite is a saved brief with a fixed list of checks. Run one to get comparable results every time.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle>Could not load suites</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {loading ? (
          <Skeleton className="h-16 w-full" />
        ) : suites.length === 0 && !error ? (
          <p className="text-sm text-muted-foreground">
            No suites yet. Save one from the New run sheet, or add a markdown file at{" "}
            <code className="rounded bg-muted px-1 text-xs">.tapocalypse/suites/&lt;id&gt;.md</code> in the repository.
          </p>
        ) : (
          <ul className="divide-y rounded-md border">
            {suites.map((suite) => (
              <li key={suite.id} className="flex items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{suite.title}</p>
                  <p className="truncate font-mono text-xs text-muted-foreground">{suite.id}</p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    onClose();
                    openNewRun({ projectId: project.id, suiteId: suite.id, device: { platform: project.defaultPlatform } });
                  }}
                >
                  <Play />
                  Run
                </Button>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ProjectCard({
  project,
  activeCount,
  now,
  onEdit,
  onDelete,
}: {
  project: ProjectStatus;
  activeCount: number;
  now: number;
  onEdit(): void;
  onDelete(): void;
}) {
  const ok = project.status === "ok";
  const detection = useDetection(project);
  const { runs } = useRuns({ project: project.id, limit: STRIP_RUNS });
  const { stats } = useStats(project.id, 7);
  const { openNewRun } = useNewRun();
  const startSmokeRun = useStartSmokeRun();
  const [suitesOpen, setSuitesOpen] = useState(false);

  const FrameworkGlyph = FRAMEWORK_ICON[detection?.framework ?? "unknown"];
  const platforms = detection && detection.platforms.length > 0 ? detection.platforms : [project.defaultPlatform];
  const conclusive = stats ? stats.pass + stats.fail + stats.issues : 0;
  const passRate = stats && conclusive > 0 ? Math.round((stats.pass / conclusive) * 100) : null;
  const last = runs[0];

  return (
    <Card className="gap-4 py-5">
      <CardHeader className="px-5">
        <CardTitle className="flex min-w-0 items-center gap-2 text-base">
          <FrameworkGlyph className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate">{project.name}</span>
        </CardTitle>
        <CardDescription className="truncate font-mono text-xs">{project.id}</CardDescription>
        <CardAction>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${project.name}`}>
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={onEdit}>
                <Pencil />
                Edit
              </DropdownMenuItem>
              <DropdownMenuItem asChild disabled={!ok}>
                <a href={`#/p/${encodeURIComponent(project.id)}/reports`}>
                  <FileText />
                  Reports
                </a>
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!ok} onSelect={() => setSuitesOpen(true)}>
                <ListChecks />
                Suites
                {ok && <SuitesCount projectId={project.id} />}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" disabled={activeCount > 0} onSelect={onDelete}>
                <Trash2 />
                {activeCount > 0 ? `Delete (${activeCount} active run${activeCount === 1 ? "" : "s"})` : "Delete"}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </CardAction>
      </CardHeader>

      <CardContent className="space-y-4 px-5">
        <div className="flex flex-wrap items-center gap-1.5">
          {detection && (
            <Badge variant="secondary" className="gap-1">
              <FrameworkGlyph />
              {FRAMEWORK_LABEL[detection.framework]}
            </Badge>
          )}
          {platforms.map((platform) => {
            const Icon = PLATFORM_ICON[platform];
            return (
              <Badge key={platform} variant={platform === project.defaultPlatform ? "secondary" : "outline"} className="gap-1">
                <Icon />
                {PLATFORM_LABEL[platform]}
              </Badge>
            );
          })}
          {activeCount > 0 && (
            <Badge variant="outline" className="border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300">
              {activeCount} active
            </Badge>
          )}
        </div>

        {!ok && (
          <ul className="space-y-1 rounded-md border border-orange-500/30 bg-orange-500/5 p-3 text-sm text-orange-800 dark:text-orange-300">
            {project.problems.map((problem) => (
              <li key={problem} className="flex items-start gap-2">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                <span className="min-w-0 break-words">{problem}</span>
              </li>
            ))}
          </ul>
        )}

        <dl className="space-y-2 text-sm">
          <Row label="Package">
            <span className="block truncate font-mono text-xs" title={project.defaultPackage}>
              {project.defaultPackage}
            </span>
          </Row>
          <Row label="Repo">
            <span className="flex min-w-0 items-center gap-1">
              <span className="truncate font-mono text-xs" title={project.repoPath}>
                {project.repoPath}
              </span>
              <CopyButton value={project.repoPath} />
            </span>
          </Row>
        </dl>

        {ok &&
          (runs.length > 0 ? (
            <div className="space-y-2">
              <VerdictStrip runs={runs} />
              <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
                {passRate !== null && stats ? (
                  <span className="tabular-nums" title={`${stats.pass} pass of ${conclusive} runs with a verdict in the last 7 days`}>
                    <span className="font-medium text-foreground">{passRate}%</span> pass · 7d
                  </span>
                ) : (
                  <span>No verdicts in 7d</span>
                )}
                {stats && stats.cost !== null && (
                  <>
                    <span aria-hidden>·</span>
                    <span className="tabular-nums">{formatCost(stats.cost)}</span>
                  </>
                )}
                {last && (
                  <>
                    <span aria-hidden>·</span>
                    <span>last run {formatRelative(last.endedAt ?? last.createdAt, now)}</span>
                  </>
                )}
              </p>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No runs yet.</p>
          ))}
      </CardContent>

      <CardFooter className="flex-wrap gap-2 px-5">
        {ok ? (
          <>
            <Button size="sm" onClick={() => openNewRun({ projectId: project.id, device: { platform: project.defaultPlatform } })}>
              <Play />
              New run
            </Button>
            {runs.length === 0 && (
              <Button size="sm" variant="outline" className="strike" onClick={() => startSmokeRun(project)}>
                Run a smoke test
              </Button>
            )}
          </>
        ) : (
          <Button size="sm" onClick={onEdit}>
            <Wrench />
            Fix
          </Button>
        )}
      </CardFooter>

      {ok && <SuitesDialog project={project} open={suitesOpen} onClose={() => setSuitesOpen(false)} />}
    </Card>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <dt className="w-14 shrink-0 pt-0.5 text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1">{children}</dd>
    </div>
  );
}

// --- Added: next steps ---

function AddedSuccess({ project, onClose }: { project: ProjectStatus; onClose(): void }) {
  const startSmokeRun = useStartSmokeRun();
  return (
    <div className="flex flex-col gap-4 p-4 pt-2">
      <div className="flex items-start gap-3 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4">
        <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-500" />
        <div className="min-w-0 space-y-1">
          <p className="font-medium">{project.name} is ready</p>
          <p className="text-sm text-muted-foreground">
            Try the built-in smoke test to confirm your app, a device and the QA agent work together end to end.
          </p>
        </div>
      </div>
      <Button
        onClick={() => {
          onClose();
          startSmokeRun(project);
        }}
      >
        <Play />
        Start first run
      </Button>
      <Button
        variant="outline"
        onClick={() => {
          onClose();
          navigate("#/setup");
        }}
      >
        Connect your agent
      </Button>
      <Button variant="ghost" onClick={onClose}>
        Done
      </Button>
    </div>
  );
}

// --- Delete ---

function DeleteDialog({
  project,
  activeCount,
  onClose,
  onDeleted,
}: {
  project: ProjectStatus | null;
  activeCount: number;
  onClose(): void;
  onDeleted(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    if (!project) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteProject(project.id);
      toast.success(`Deleted ${project.name}`);
      onDeleted();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={project !== null}
      onOpenChange={(open) => {
        if (open) return;
        setError(null);
        onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {project?.name}?</DialogTitle>
          <DialogDescription>
            This only removes the project from Tapocalypse. Your repository and any QA reports in it are not touched, and past runs stay in the
            run history.
          </DialogDescription>
        </DialogHeader>
        {activeCount > 0 && (
          <Alert>
            <TriangleAlert />
            <AlertDescription>This project still has {activeCount} active run(s).</AlertDescription>
          </Alert>
        )}
        {error && (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle>Could not delete</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => void confirm()} disabled={busy || activeCount > 0}>
            {busy ? <Loader2 className="animate-spin" /> : <Trash2 />}
            Delete project
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// --- Add / edit form ---

interface FormState {
  name: string;
  id: string;
  /** Once the user edits the ID by hand it stops following the name. */
  idTouched: boolean;
  repoPath: string;
  platform: Platform;
  packageId: string;
  /** The user picked "Custom…" in the package select. */
  packageCustom: boolean;
  /** BUILTIN, CUSTOM, or a detected / current repo-relative persona path. */
  persona: string;
  customPersona: string;
  reportsDir: string;
}

type Fields = Omit<ProjectInput, "id">;

function formFromProject(p: Project): FormState {
  return {
    name: p.name,
    id: p.id,
    idTouched: true,
    repoPath: p.repoPath,
    platform: p.defaultPlatform,
    packageId: p.defaultPackage,
    packageCustom: false,
    persona: p.personaFile ?? BUILTIN,
    customPersona: "",
    reportsDir: p.reportsDir,
  };
}

function formFromDetection(d: Detection): FormState {
  const { suggestion } = d;
  return {
    name: suggestion.name,
    id: suggestion.id,
    idTouched: false,
    repoPath: d.repoPath,
    platform: suggestion.defaultPlatform,
    packageId: suggestion.defaultPackage ?? packageChoices(d, suggestion.defaultPlatform, "")[0]?.value ?? "",
    packageCustom: false,
    persona: suggestion.personaFile ?? BUILTIN,
    customPersona: "",
    reportsDir: suggestion.reportsDir,
  };
}

interface PackageChoice {
  value: string;
  detected: boolean;
}

function packageChoices(detection: Detection | null, platform: Platform, current: string): PackageChoice[] {
  const found = detection ? (platform === "android" ? detection.androidPackages : detection.iosBundleIds) : [];
  const choices = found.map((value) => ({ value, detected: true }));
  if (current && !found.includes(current)) choices.push({ value: current, detected: false });
  return choices;
}

function personaOptions(detection: Detection | null, initialFile: string | null): string[] {
  return [...new Set([...(detection?.personaCandidates ?? []), ...(initialFile ? [initialFile] : [])])];
}

interface Built {
  fields: Fields;
  /** Errors known without asking the server. */
  local: FieldErrors;
}

function buildFields(form: FormState, options: string[]): Built {
  const local: FieldErrors = {};
  let personaFile: string | null = null;
  if (form.persona === CUSTOM) {
    personaFile = form.customPersona.trim() || null;
    if (!personaFile) local.personaFile = "Enter the path of your persona file, relative to the repository";
  } else if (form.persona !== BUILTIN && options.includes(form.persona)) {
    personaFile = form.persona;
  }
  return {
    local,
    fields: {
      name: form.name.trim(),
      repoPath: form.repoPath.trim(),
      personaFile,
      reportsDir: form.reportsDir.trim(),
      defaultPackage: form.packageId.trim(),
      defaultPlatform: form.platform,
    },
  };
}

function ProjectForm({
  project,
  onCreated,
  onUpdated,
}: {
  project: ProjectStatus | null;
  onCreated(created: ProjectStatus): void;
  onUpdated(): void;
}) {
  const mode = project ? "update" : "create";
  const [stage, setStage] = useState<"locate" | "details">(project ? "details" : "locate");
  const [form, setForm] = useState<FormState>(() => (project ? formFromProject(project) : emptyForm()));
  const [detection, setDetection] = useState<Detection | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [serverErrors, setServerErrors] = useState<FieldErrors>({});
  const [saveErrors, setSaveErrors] = useState<FieldErrors>({});
  const [warnings, setWarnings] = useState<string[]>([]);
  const [validating, setValidating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [generalError, setGeneralError] = useState<string | null>(null);
  /** Fields the user has left (or tried to submit) once; undetected values stay a neutral hint until then. */
  const [touched, setTouched] = useState<ReadonlySet<keyof Project>>(new Set());
  const [qaOpen, setQaOpen] = useState(Boolean(project));

  const options = useMemo(() => personaOptions(detection, project?.personaFile ?? null), [detection, project]);
  const built = useMemo(() => buildFields(form, options), [form, options]);
  const errors: FieldErrors = { ...serverErrors, ...saveErrors, ...built.local };
  const hasErrors = Object.values(errors).some(Boolean);
  // A package that simply was not detected is not an error yet: show it only after the user touched the field.
  const packageShown = touched.has("defaultPackage") || Boolean(form.packageId.trim());
  const packageError = packageShown ? errors.defaultPackage : undefined;

  // Step 2 starts on its first field; step 1 leads with the folder list, so focus stays put.
  useEffect(() => {
    if (stage === "details") document.getElementById("pj-name")?.focus();
  }, [stage]);

  // Debounced server-side validation; every edit also clears errors left over from a failed save.
  useEffect(() => {
    if (stage !== "details") return;
    let cancelled = false;
    setSaveErrors({});
    setValidating(true);
    const timer = setTimeout(() => {
      api.validateProject({ id: form.id, ...built.fields }, mode, project?.id).then(
        (result) => {
          if (cancelled) return;
          setServerErrors(result.errors);
          setWarnings(result.warnings);
          setGeneralError(null);
          setValidating(false);
        },
        (err: unknown) => {
          if (cancelled) return;
          setGeneralError(`Could not validate: ${errorMessage(err)}`);
          setValidating(false);
        },
      );
    }, VALIDATE_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [stage, form.id, built.fields, mode, project?.id]);

  function patch(next: Partial<FormState>) {
    setForm((f) => ({ ...f, ...next }));
  }

  function touch(field: keyof Project) {
    setTouched((t) => (t.has(field) ? t : new Set(t).add(field)));
  }

  /** Detects `path` and moves to step 2 (add) or refreshes suggestions (edit). */
  async function detect(path = form.repoPath.trim()) {
    if (!path) {
      setDetectError("Enter the folder path of your app's repository");
      return;
    }
    setDetecting(true);
    setDetectError(null);
    try {
      const d = await api.detectProject(path);
      if (!d.exists) {
        setDetectError(`No folder exists at ${path}. Run pwd inside your repository and paste the full path.`);
        return;
      }
      setDetection(d);
      if (project) {
        toast.success("Detection refreshed");
      } else {
        const next = formFromDetection(d);
        setForm(next);
        // Nothing to decide when the persona and reports folder are just what detection suggested.
        setQaOpen(!((next.persona === BUILTIN || next.persona === d.suggestion.personaFile) && next.reportsDir === d.suggestion.reportsDir));
        setStage("details");
      }
    } catch (err) {
      setDetectError(errorMessage(err));
    } finally {
      setDetecting(false);
    }
  }

  function changeName(name: string) {
    setForm((f) => ({ ...f, name, id: f.idTouched ? f.id : slugify(name) }));
  }

  function changePlatform(platform: Platform) {
    setForm((f) => {
      if (f.packageCustom) return { ...f, platform };
      return { ...f, platform, packageId: packageChoices(detection, platform, "")[0]?.value ?? "" };
    });
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    setSaving(true);
    setGeneralError(null);
    try {
      if (project) {
        await api.updateProject(project.id, built.fields);
        toast.success(`Saved ${form.name.trim()}`);
        onUpdated();
      } else {
        onCreated(await api.createProject({ id: form.id, ...built.fields }));
      }
    } catch (err) {
      const message = errorMessage(err);
      const match = SAVE_ERROR.exec(message);
      const field = PROJECT_FIELDS.find((f) => f === match?.[1]);
      if (field && match?.[2]) {
        const next: FieldErrors = {};
        next[field] = match[2];
        setSaveErrors(next);
        touch(field);
      } else {
        setGeneralError(message);
      }
    } finally {
      setSaving(false);
    }
  }

  const choices = packageChoices(detection, form.platform, form.packageId);
  const customPackage = form.packageCustom || choices.length === 0;
  const canSave =
    stage === "details" && !saving && !hasErrors && Boolean(form.name.trim() && form.id && form.repoPath.trim() && form.packageId.trim());

  if (stage === "locate") {
    return (
      <form
        className="flex flex-col gap-5 p-4 pt-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!detecting) void detect();
        }}
      >
        <StepHeading
          step={1}
          title="Where is your app?"
          description="Tapocalypse reads your repository to suggest the settings. It never changes anything in it."
        />
        <FolderSuggestions
          busyPath={detecting ? form.repoPath : null}
          disabled={detecting}
          onPick={(path) => {
            patch({ repoPath: path });
            void detect(path);
          }}
        />
        <Field
          id="pj-repo"
          label="Other folder…"
          hint={
            <>
              Paste the absolute path of your app's repository (<code className="rounded bg-muted px-1">pwd</code> inside it prints it).{" "}
              <code className="rounded bg-muted px-1">~</code> works too.
            </>
          }
          error={detectError ?? undefined}
        >
          <Input
            id="pj-repo"
            className="font-mono"
            placeholder="/Users/you/code/my_app"
            value={form.repoPath}
            onChange={(e) => {
              patch({ repoPath: e.target.value });
              setDetectError(null);
            }}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={detectError ? true : undefined}
            aria-describedby="pj-repo-hint pj-repo-error"
          />
        </Field>
        <Button type="submit" disabled={detecting || !form.repoPath.trim()}>
          {detecting ? <Loader2 className="animate-spin" /> : <ScanSearch />}
          {detecting ? "Detecting…" : "Detect settings"}
        </Button>
      </form>
    );
  }

  const detectedName = detection?.suggestion.name === form.name.trim();
  const reportsDetected = detection?.reportsDirCandidates.includes(form.reportsDir.trim()) ?? false;

  return (
    <form onSubmit={(e) => void save(e)} className="flex flex-col gap-5 p-4 pt-2">
      {!project && (
        <StepHeading
          step={2}
          title="Check what we found"
          description="Values marked “detected” came from your repository. Change anything that isn't right."
        />
      )}

      <div className="space-y-2">
        {project ? (
          <Field
            id="pj-repo"
            label="Repository folder"
            hint="Re-detect refreshes the package, persona and report-folder suggestions below."
            error={errors.repoPath ?? detectError ?? undefined}
          >
            <div className="flex gap-2">
              <Input
                id="pj-repo"
                className="font-mono"
                value={form.repoPath}
                onChange={(e) => {
                  patch({ repoPath: e.target.value });
                  setDetectError(null);
                }}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={errors.repoPath || detectError ? true : undefined}
                aria-describedby="pj-repo-hint pj-repo-error"
              />
              <Button type="button" variant="outline" className="strike" disabled={detecting || !form.repoPath.trim()} onClick={() => void detect()}>
                {detecting ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                Re-detect
              </Button>
            </div>
          </Field>
        ) : (
          <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
            <FolderGit2 className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate font-mono text-xs" title={form.repoPath}>
              {form.repoPath}
            </span>
            <Button type="button" variant="ghost" size="xs" onClick={() => setStage("locate")}>
              <ArrowLeft />
              Change
            </Button>
          </div>
        )}
        {!project && errors.repoPath && (
          <p role="alert" className="text-xs text-destructive">
            {errors.repoPath}
          </p>
        )}
        {detection && <DetectionSummary detection={detection} />}
      </div>

      {generalError && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>{project ? "Could not save" : "Could not add project"}</AlertTitle>
          <AlertDescription>{generalError}</AlertDescription>
        </Alert>
      )}

      <section className="space-y-5" aria-labelledby="pj-section-app">
      <h3 id="pj-section-app" className="text-sm font-semibold">
        App
      </h3>
      <Field
        id="pj-name"
        label="Name"
        detected={detectedName}
        hint="Shown in the Tapocalypse UI."
        error={errors.name}
      >
        <Input
          id="pj-name"
          value={form.name}
          onChange={(e) => changeName(e.target.value)}
          autoComplete="off"
          aria-invalid={errors.name ? true : undefined}
          aria-describedby="pj-name-hint pj-name-error"
        />
      </Field>

      <Field
        id="pj-id"
        label="ID"
        hint={
          project
            ? "The ID can't be changed after a project is created."
            : "Used in URLs and when other agents start runs. Lowercase letters, digits and dashes; can't be changed later."
        }
        error={errors.id}
      >
        <Input
          id="pj-id"
          className="font-mono"
          value={form.id}
          readOnly={Boolean(project)}
          disabled={Boolean(project)}
          onChange={(e) => patch({ id: e.target.value, idTouched: true })}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={errors.id ? true : undefined}
          aria-describedby="pj-id-hint pj-id-error"
        />
      </Field>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium leading-none">Platform</legend>
        <p className="text-xs text-muted-foreground">The platform runs use when you don't pick a specific device.</p>
        <RadioGroup
          value={form.platform}
          onValueChange={(v) => changePlatform(v === "ios" ? "ios" : "android")}
          className="grid grid-cols-2 gap-3"
          aria-label="Platform"
        >
          {PLATFORMS.map((platform) => (
            <ChoiceCard
              key={platform}
              id={`pj-platform-${platform}`}
              value={platform}
              title={PLATFORM_LABEL[platform]}
              detected={detection?.platforms.includes(platform) ?? false}
            />
          ))}
        </RadioGroup>
        {errors.defaultPlatform && <FieldError id="pj-platform-error">{errors.defaultPlatform}</FieldError>}
      </fieldset>

      <Field
        id="pj-package"
        label="App package"
        detected={choices.some((c) => c.detected && c.value === form.packageId)}
        hint={
          !packageShown ? (
            <>Not detected — enter your app's {form.platform === "ios" ? "bundle identifier" : "application ID"}, for example {PACKAGE_EXAMPLE[form.platform]}.</>
          ) : form.platform === "ios" ? (
            "The iOS bundle identifier of the build installed on the simulator."
          ) : (
            "The Android application ID of the build installed on the emulator. Dev or debug flavors are listed first when found."
          )
        }
        error={packageError}
      >
        <div className="space-y-2">
          {choices.length > 0 && (
            <Select
              value={customPackage ? CUSTOM : form.packageId}
              onValueChange={(v) => (v === CUSTOM ? patch({ packageCustom: true }) : patch({ packageCustom: false, packageId: v }))}
            >
              <SelectTrigger id="pj-package" className="w-full font-mono text-xs" aria-invalid={packageError ? true : undefined} onBlur={() => touch("defaultPackage")}>
                <SelectValue placeholder="Choose a package" />
              </SelectTrigger>
              <SelectContent>
                {choices.map((c) => (
                  <SelectItem key={c.value} value={c.value} className="font-mono text-xs">
                    {c.value}
                    {c.detected && <DetectedTag />}
                  </SelectItem>
                ))}
                <SelectItem value={CUSTOM}>Custom…</SelectItem>
              </SelectContent>
            </Select>
          )}
          {customPackage && (
            <Input
              id={choices.length === 0 ? "pj-package" : "pj-package-custom"}
              className="font-mono"
              placeholder={form.platform === "ios" ? "com.example.myapp" : "com.example.myapp.dev"}
              aria-label="Custom app package"
              value={form.packageId}
              onChange={(e) => patch({ packageId: e.target.value })}
              onBlur={() => touch("defaultPackage")}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={packageError ? true : undefined}
              aria-describedby="pj-package-hint pj-package-error"
            />
          )}
        </div>
      </Field>
      </section>

      <Collapsible
        open={qaOpen || Boolean(errors.personaFile || errors.reportsDir)}
        onOpenChange={setQaOpen}
        className="rounded-lg border"
      >
        <CollapsibleTrigger className="group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold">QA agent</span>
            <span className="block truncate text-xs text-muted-foreground">
              {personaSummary(form)} · reports in {form.reportsDir.trim() || "…"}/
            </span>
          </span>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=closed]:-rotate-90" />
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-5 border-t p-3">
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium leading-none">QA persona</legend>
        <p className="text-xs text-muted-foreground">The instructions the QA agent follows when it tests your app.</p>
        <RadioGroup
          value={form.persona === CUSTOM || form.persona === BUILTIN || options.includes(form.persona) ? form.persona : BUILTIN}
          onValueChange={(persona) => patch({ persona })}
          className="gap-2"
          aria-label="QA persona"
        >
          <ChoiceCard
            id="pj-persona-builtin"
            value={BUILTIN}
            title="Built-in QA persona (recommended)"
            description="A general-purpose mobile QA agent. Works with any app, no setup."
          />
          {options.map((file, i) => (
            <ChoiceCard
              key={file}
              id={`pj-persona-file-${i}`}
              value={file}
              title={<span className="font-mono text-xs">{file}</span>}
              description="Your repository's own QA agent definition."
              detected={detection?.personaCandidates.includes(file) ?? false}
            />
          ))}
          <ChoiceCard id="pj-persona-custom" value={CUSTOM} title="Another file…" description="A path inside the repository." />
        </RadioGroup>
        {form.persona === CUSTOM && (
          <Input
            className="font-mono"
            placeholder=".omp/agents/mobile-qa.md"
            aria-label="Persona file path"
            value={form.customPersona}
            onChange={(e) => patch({ customPersona: e.target.value })}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={errors.personaFile ? true : undefined}
            aria-describedby="pj-persona-error"
          />
        )}
        {errors.personaFile && <FieldError id="pj-persona-error">{errors.personaFile}</FieldError>}
      </fieldset>

      <Field
        id="pj-reports"
        label="Reports folder"
        detected={reportsDetected}
        hint="Where QA reports and screenshots are written, relative to the repository. Created on the first run if it doesn't exist."
        error={errors.reportsDir}
      >
        <Input
          id="pj-reports"
          className="font-mono"
          value={form.reportsDir}
          onChange={(e) => patch({ reportsDir: e.target.value })}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={errors.reportsDir ? true : undefined}
          aria-describedby="pj-reports-hint pj-reports-error"
        />
      </Field>
        </CollapsibleContent>
      </Collapsible>

      {warnings.length > 0 && (
        <Alert>
          <TriangleAlert />
          <AlertTitle>Worth knowing</AlertTitle>
          <AlertDescription>
            <ul className="list-disc space-y-1 pl-4">
              {warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      <div className="sticky bottom-0 -mx-4 flex items-center justify-end gap-2 border-t bg-background px-4 py-3">
        {validating && !saving && (
          <span className="mr-auto flex items-center gap-1.5 text-xs text-muted-foreground" aria-live="polite">
            <Loader2 className="size-3 animate-spin" />
            Checking…
          </span>
        )}
        <Button type="submit" disabled={!canSave}>
          {saving ? <Loader2 className="animate-spin" /> : <Check />}
          {saving ? "Saving…" : project ? "Save changes" : "Add project"}
        </Button>
      </div>
    </form>
  );
}

function emptyForm(): FormState {
  return {
    name: "",
    id: "",
    idTouched: false,
    repoPath: "",
    platform: "android",
    packageId: "",
    packageCustom: false,
    persona: BUILTIN,
    customPersona: "",
    reportsDir: "qa",
  };
}

/** Searchable list of app folders found in common locations; picking one runs detection straight away. */
function FolderSuggestions({ busyPath, disabled, onPick }: { busyPath: string | null; disabled: boolean; onPick(path: string): void }) {
  const [suggestions, setSuggestions] = useState<ProjectSuggestion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    api.projectSuggestions().then(
      (list) => {
        if (!cancelled) setSuggestions(list);
      },
      (e: unknown) => {
        if (!cancelled) setError(errorMessage(e));
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const needle = query.trim().toLowerCase();
  const shown = (suggestions ?? []).filter((x) => !needle || x.name.toLowerCase().includes(needle) || x.path.toLowerCase().includes(needle));

  return (
    <div className="space-y-2">
      <Label htmlFor="pj-search">Suggested folders</Label>
      {error ? (
        <p className="text-xs text-muted-foreground">Could not look for app folders ({error}). Paste the path below instead.</p>
      ) : suggestions === null ? (
        <div className="space-y-2" aria-busy>
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-full" />
        </div>
      ) : suggestions.length === 0 ? (
        <p className="text-xs text-muted-foreground">No app folders found in common locations. Paste the path below instead.</p>
      ) : (
        <>
          {suggestions.length > 5 && (
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="pj-search"
                className="pl-8"
                placeholder="Search folders"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                autoComplete="off"
              />
            </div>
          )}
          <ul className="max-h-72 divide-y overflow-y-auto rounded-md border">
            {shown.map((x) => {
              const Icon = FRAMEWORK_ICON[x.framework];
              return (
                <li key={x.path}>
                  <button
                    type="button"
                    disabled={disabled || x.alreadyAdded}
                    onClick={() => onPick(x.path)}
                    className="flex w-full items-center gap-3 px-3 py-2 text-left outline-none hover:bg-accent focus-visible:bg-accent disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
                  >
                    {busyPath === x.path ? (
                      <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
                    ) : (
                      <Icon className="size-4 shrink-0 text-muted-foreground" aria-label={FRAMEWORK_LABEL[x.framework]} />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{x.name}</span>
                      <span className="block truncate font-mono text-xs text-muted-foreground" title={x.path}>
                        {x.path}
                      </span>
                    </span>
                    {x.alreadyAdded && <Badge variant="outline">Already added</Badge>}
                  </button>
                </li>
              );
            })}
            {shown.length === 0 && <li className="px-3 py-3 text-sm text-muted-foreground">No folder matches “{query.trim()}”.</li>}
          </ul>
        </>
      )}
    </div>
  );
}

function personaSummary(form: FormState): string {
  if (form.persona === BUILTIN) return "Built-in persona";
  if (form.persona === CUSTOM) return form.customPersona.trim() || "Custom persona file";
  return form.persona;
}

function StepHeading({ step, title, description }: { step: number; title: string; description: string }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Step {step} of 2</p>
      <h3 className="text-base font-semibold tracking-tight">{title}</h3>
      <p className="text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

function DetectionSummary({ detection }: { detection: Detection }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Badge variant="secondary" className="gap-1">
        <Sparkles />
        {FRAMEWORK_LABEL[detection.framework]}
      </Badge>
      {detection.platforms.map((p) => (
        <Badge key={p} variant="outline">
          {PLATFORM_LABEL[p]}
        </Badge>
      ))}
      <Badge variant="outline" className={cn(!detection.isGitRepo && "text-muted-foreground")}>
        {detection.isGitRepo ? "Git repository" : "Not a git repository"}
      </Badge>
    </div>
  );
}

function DetectedTag() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded border border-primary/40 bg-primary/15 px-1.5 py-px text-[10px] font-medium leading-none text-foreground dark:text-primary">
      <Sparkles className="size-2.5" />
      detected
    </span>
  );
}

function FieldError({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} role="alert" className="text-xs text-destructive">
      {children}
    </p>
  );
}

/** Label, helper text and an inline error for one input; `id` is the input's id, hint/error get `<id>-hint` / `<id>-error`. */
function Field({
  id,
  label,
  hint,
  error,
  detected,
  children,
}: {
  id: string;
  label: string;
  hint?: ReactNode;
  error?: string | undefined;
  detected?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Label htmlFor={id}>{label}</Label>
        {detected && <DetectedTag />}
      </div>
      {children}
      {hint && (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {error && <FieldError id={`${id}-error`}>{error}</FieldError>}
    </div>
  );
}

function ChoiceCard({
  id,
  value,
  title,
  description,
  detected,
}: {
  id: string;
  value: string;
  title: ReactNode;
  description?: string;
  detected?: boolean;
}) {
  return (
    <Label
      htmlFor={id}
      className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 has-[[data-state=checked]]:border-ring has-[[data-state=checked]]:bg-accent"
    >
      <RadioGroupItem id={id} value={value} className="mt-0.5" />
      <span className="min-w-0 flex-1 space-y-0.5">
        <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
          {title}
          {detected && <DetectedTag />}
        </span>
        {description && <span className="block text-xs font-normal text-muted-foreground">{description}</span>}
      </span>
    </Label>
  );
}
