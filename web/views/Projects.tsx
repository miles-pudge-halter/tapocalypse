import {
  AlertCircle,
  Apple,
  ArrowLeft,
  Bot,
  Check,
  Copy,
  FileText,
  FolderGit2,
  FolderOpen,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  ScanSearch,
  Sparkles,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { SetupChecklist } from "@/components/setup-checklist";
import { StatusBadge } from "@/components/status-badge";
import { VerdictBadge } from "@/components/verdict-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
  isActive,
  type Platform,
  type Project,
  type ProjectInput,
  type ProjectStatus,
  type RunView,
} from "@/lib/api";
import { formatRelative } from "@/lib/format";
import { navigate, useNow, useProjects, useRuns } from "@/lib/hooks";
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

const PLATFORM_LABEL: Record<Platform, string> = { android: "Android", ios: "iOS" };
const PLATFORMS: Platform[] = ["android", "ios"];

const VALIDATE_DEBOUNCE_MS = 400;
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

interface ProjectRunStats {
  total: number;
  activeIds: string[];
  last: RunView | null;
}

function collectStats(runs: RunView[]): Map<string, ProjectRunStats> {
  const stats = new Map<string, ProjectRunStats>();
  for (const run of runs) {
    const s = stats.get(run.projectId) ?? { total: 0, activeIds: [], last: null };
    s.total++;
    if (isActive(run.status)) s.activeIds.push(run.id);
    else if (!s.last || run.createdAt > s.last.createdAt) s.last = run;
    stats.set(run.projectId, s);
  }
  return stats;
}

interface SheetState {
  open: boolean;
  /** null = add flow. */
  project: ProjectStatus | null;
  /** Bumped on every open so the form remounts with fresh state. */
  nonce: number;
}

export function Projects({ openNew }: { openNew: boolean }) {
  const { projects, loading, error, refresh } = useProjects();
  const { runs } = useRuns();
  const now = useNow(30_000);
  const [sheet, setSheet] = useState<SheetState>({ open: false, project: null, nonce: 0 });
  const [deleting, setDeleting] = useState<ProjectStatus | null>(null);
  const stats = useMemo(() => collectStats(runs), [runs]);

  function openSheet(project: ProjectStatus | null) {
    setSheet((s) => ({ open: true, project, nonce: s.nonce + 1 }));
  }

  // `#/projects?new=1` is a one-shot request from elsewhere in the app; consume it so a reload doesn't reopen the sheet.
  useEffect(() => {
    if (!openNew) return;
    openSheet(null);
    navigate("#/projects");
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
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : projects.length === 0 && !error ? (
        <EmptyState
          icon={FolderOpen}
          title="Add your first project"
          description="Point Tapocalypse at your app's repository folder. It detects the framework, package name and QA persona, so adding a project takes about a minute."
          action={
            <Button onClick={() => openSheet(null)}>
              <Plus />
              Add your first project
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {projects.map((p) => (
            <ProjectCard
              key={p.id}
              project={p}
              stats={stats.get(p.id)}
              now={now}
              onEdit={() => openSheet(p)}
              onDelete={() => setDeleting(p)}
            />
          ))}
        </div>
      )}

      <section className="mt-10" aria-label="Setup">
        <SetupChecklist />
      </section>

      <Sheet open={sheet.open} onOpenChange={(open) => setSheet((s) => ({ ...s, open }))}>
        <SheetContent
          side="right"
          className="w-full gap-0 overflow-y-auto sm:max-w-xl"
          // The form focuses its own first field.
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <SheetHeader>
            <SheetTitle>{sheet.project ? `Edit ${sheet.project.name}` : "Add a project"}</SheetTitle>
            <SheetDescription>
              {sheet.project
                ? "Changes apply to new runs straight away; runs already in progress are not affected."
                : "Two quick steps: tell us where the app lives, then check what we detected."}
            </SheetDescription>
          </SheetHeader>
          <ProjectForm
            key={sheet.nonce}
            project={sheet.project}
            onSaved={() => {
              setSheet((s) => ({ ...s, open: false }));
              refresh();
            }}
          />
        </SheetContent>
      </Sheet>

      <DeleteDialog
        project={deleting}
        activeCount={deleting ? (stats.get(deleting.id)?.activeIds.length ?? 0) : 0}
        onClose={() => setDeleting(null)}
        onDeleted={refresh}
      />
    </div>
  );
}

// --- Project card ---

function ProjectCard({
  project,
  stats,
  now,
  onEdit,
  onDelete,
}: {
  project: ProjectStatus;
  stats: ProjectRunStats | undefined;
  now: number;
  onEdit(): void;
  onDelete(): void;
}) {
  const ok = project.status === "ok";
  const activeCount = stats?.activeIds.length ?? 0;
  const last = stats?.last ?? null;
  const PlatformIcon = project.defaultPlatform === "ios" ? Apple : Bot;
  const deleteHint =
    activeCount === 0 ? null : `${activeCount} active run${activeCount === 1 ? "" : "s"} — cancel or wait for ${activeCount === 1 ? "it" : "them"} to finish first`;

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="truncate text-base">{project.name}</CardTitle>
        <CardDescription className="font-mono text-xs">{project.id}</CardDescription>
        <CardAction>
          <Badge
            variant="outline"
            className={cn(
              ok
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                : "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
            )}
          >
            {ok ? <Check /> : <TriangleAlert />}
            {ok ? "Ready" : "Needs attention"}
          </Badge>
        </CardAction>
      </CardHeader>

      <CardContent className="space-y-3">
        {!ok && (
          <ul className="space-y-1 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-800 dark:text-amber-300">
            {project.problems.map((problem) => (
              <li key={problem} className="flex items-start gap-2">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                <span className="min-w-0 break-words">{problem}</span>
              </li>
            ))}
          </ul>
        )}
        <dl className="space-y-2 text-sm">
          <Row label="App">
            <span className="flex min-w-0 items-center gap-2">
              <Badge variant="secondary" className="shrink-0 gap-1">
                <PlatformIcon />
                {PLATFORM_LABEL[project.defaultPlatform]}
              </Badge>
              <span className="truncate font-mono text-xs" title={project.defaultPackage}>
                {project.defaultPackage}
              </span>
            </span>
          </Row>
          <Row label="Repo">
            <span className="flex min-w-0 items-center gap-1">
              <span className="truncate font-mono text-xs" title={project.repoPath}>
                {project.repoPath}
              </span>
              <CopyButton text={project.repoPath} label="Copy repository path" />
            </span>
          </Row>
          <Row label="Persona">
            {project.personaFile ? (
              <span className="truncate font-mono text-xs" title={project.personaFile}>
                {project.personaFile}
              </span>
            ) : (
              <span>Built-in QA persona</span>
            )}
          </Row>
          <Row label="Reports">
            <span className="truncate font-mono text-xs" title={project.reportsDir}>
              {project.reportsDir}/
            </span>
          </Row>
          <Row label="Runs">
            {stats && stats.total > 0 ? (
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="tabular-nums">{stats.total} total</span>
                {activeCount > 0 && <span className="tabular-nums text-blue-700 dark:text-blue-300">{activeCount} active</span>}
                {last && (
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    · last
                    {last.verdict ? <VerdictBadge verdict={last.verdict} /> : <StatusBadge status={last.status} />}
                    {formatRelative(last.endedAt ?? last.createdAt, now)}
                  </span>
                )}
              </span>
            ) : (
              <span className="text-muted-foreground">No runs yet</span>
            )}
          </Row>
        </dl>
      </CardContent>

      <CardFooter className="flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={onEdit}>
          <Pencil />
          Edit
        </Button>
        {ok ? (
          <Button asChild variant="outline" size="sm">
            <a href={`#/p/${encodeURIComponent(project.id)}/reports`}>
              <FileText />
              Reports
            </a>
          </Button>
        ) : (
          <DisabledHint reason="Fix this project first — reports are only available for ready projects">
            <Button variant="outline" size="sm" disabled>
              <FileText />
              Reports
            </Button>
          </DisabledHint>
        )}
        <div className="ml-auto">
          <DisabledHint reason={deleteHint}>
            <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" disabled={activeCount > 0} onClick={onDelete}>
              <Trash2 />
              Delete
            </Button>
          </DisabledHint>
        </div>
      </CardFooter>
    </Card>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <dt className="w-16 shrink-0 pt-0.5 text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1">{children}</dd>
    </div>
  );
}

/** Wraps a (possibly disabled) control so a tooltip can still explain why it is disabled. */
function DisabledHint({ reason, children }: { reason: string | null; children: ReactNode }) {
  if (reason === null) return <>{children}</>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="inline-flex rounded-md [&>button]:pointer-events-none">
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Could not copy to the clipboard");
    }
  }
  return (
    <Button type="button" variant="ghost" size="icon-xs" aria-label={label} onClick={() => void copy()}>
      {copied ? <Check /> : <Copy />}
    </Button>
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

function ProjectForm({ project, onSaved }: { project: ProjectStatus | null; onSaved(): void }) {
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

  const options = useMemo(() => personaOptions(detection, project?.personaFile ?? null), [detection, project]);
  const built = useMemo(() => buildFields(form, options), [form, options]);
  const errors: FieldErrors = { ...serverErrors, ...saveErrors, ...built.local };
  const hasErrors = Object.values(errors).some(Boolean);

  // Move focus to the first field of whichever step is showing.
  useEffect(() => {
    document.getElementById(stage === "locate" ? "pj-repo" : "pj-name")?.focus();
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

  async function detect() {
    const path = form.repoPath.trim();
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
        setForm(formFromDetection(d));
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
      } else {
        await api.createProject({ id: form.id, ...built.fields });
        toast.success(`Added ${form.name.trim()}`);
      }
      onSaved();
    } catch (err) {
      const message = errorMessage(err);
      const match = SAVE_ERROR.exec(message);
      const field = PROJECT_FIELDS.find((f) => f === match?.[1]);
      if (field && match?.[2]) {
        const next: FieldErrors = {};
        next[field] = match[2];
        setSaveErrors(next);
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
        <Field
          id="pj-repo"
          label="Repository folder"
          hint={
            <>
              In a terminal, <code className="rounded bg-muted px-1">cd</code> into your app and run{" "}
              <code className="rounded bg-muted px-1">pwd</code>, then paste the result here. <code className="rounded bg-muted px-1">~</code> works too.
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
              <Button type="button" variant="outline" disabled={detecting || !form.repoPath.trim()} onClick={() => void detect()}>
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
          form.platform === "ios"
            ? "The iOS bundle identifier of the build installed on the simulator."
            : "The Android application ID of the build installed on the emulator. Dev or debug flavors are listed first when found."
        }
        error={errors.defaultPackage}
      >
        <div className="space-y-2">
          {choices.length > 0 && (
            <Select
              value={customPackage ? CUSTOM : form.packageId}
              onValueChange={(v) => (v === CUSTOM ? patch({ packageCustom: true }) : patch({ packageCustom: false, packageId: v }))}
            >
              <SelectTrigger id="pj-package" className="w-full font-mono text-xs" aria-invalid={errors.defaultPackage ? true : undefined}>
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
              autoComplete="off"
              spellCheck={false}
              aria-invalid={errors.defaultPackage ? true : undefined}
              aria-describedby="pj-package-hint pj-package-error"
            />
          )}
        </div>
      </Field>

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
    <span className="inline-flex shrink-0 items-center gap-1 rounded border border-primary/30 bg-primary/10 px-1.5 py-px text-[10px] font-medium leading-none text-primary">
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
      className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-accent"
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
