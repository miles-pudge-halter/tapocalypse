import { AlertCircle, ChevronsUpDown, Clock, FileText, Layers, Loader2, Minus, Play, Plus } from "lucide-react";
import { type FormEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { DeviceName } from "@/components/device-name";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  api,
  batchHash,
  runHash,
  type Backend,
  type Device,
  type HarnessId,
  type HarnessInfo,
  type DeviceTarget,
  type Platform,
  type ProjectStatus,
  type Suite,
  type Template,
} from "@/lib/api";
import { deviceDisplayName, deviceSubtitle } from "@/lib/format";
import {
  navigate,
  useDevices,
  useDoctor,
  useHarnesses,
  useModels,
  useNewRun,
  useProjects,
  useProjectScope,
  useRuns,
  useSuites,
  useTemplates,
  type NewRunPrefill,
} from "@/lib/hooks";
import { cn } from "@/lib/utils";

const MAX_TARGETS = 8;
const RECENT_BRIEFS = 5;
const DRAFT_PREFIX = "tapocalypse:new-run-draft:";
const BRIEF_PLACEHOLDER =
  "Open the Plan tab. Verify the “My Plans” title is visible. Create a plan named “QA test” and verify it appears in the list.";

interface Draft {
  title: string;
  brief: string;
}

function readDraft(projectId: string): Draft | null {
  try {
    const raw = window.localStorage.getItem(DRAFT_PREFIX + projectId);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object" && "brief" in parsed && "title" in parsed) {
      const { title, brief } = parsed;
      if (typeof title === "string" && typeof brief === "string" && (title || brief)) return { title, brief };
    }
  } catch {
    // storage unavailable or corrupt draft: behave as if there is none
  }
  return null;
}

function writeDraft(projectId: string, draft: Draft | null): void {
  try {
    if (draft && (draft.title.trim() || draft.brief.trim())) window.localStorage.setItem(DRAFT_PREFIX + projectId, JSON.stringify(draft));
    else window.localStorage.removeItem(DRAFT_PREFIX + projectId);
  } catch {
    // storage unavailable: autosave is best effort
  }
}

/** First sentence of the brief, stripped of markdown, as a title suggestion. */
function suggestTitle(brief: string): string {
  const firstLine = brief.split("\n").find((l) => l.trim()) ?? "";
  const sentence = firstLine.replace(/^[#>*\-\s\d.)]+/, "").split(/(?<=[.!?])\s/)[0] ?? "";
  const clean = sentence.trim().replace(/[.!?]+$/, "");
  return clean.length > 80 ? `${clean.slice(0, 77).trimEnd()}…` : clean;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/** Devices that can run QA: phones and tablets only. */
function isQaDevice(d: Device): boolean {
  return d.deviceType !== "watch" && d.deviceType !== "tv";
}

/** What the user picked: N "any" devices per platform plus explicit serials. */
interface Targets {
  anyAndroid: number;
  anyIos: number;
  serials: DeviceTarget[];
}

function targetsFromPrefill(prefill: NewRunPrefill | null, fallback: Platform): Targets {
  const entries = prefill?.devices ?? (prefill?.device ? [prefill.device] : [{ platform: fallback }]);
  const targets: Targets = { anyAndroid: 0, anyIos: 0, serials: [] };
  for (const e of entries) {
    if (e.serial) targets.serials.push({ platform: e.platform, serial: e.serial });
    else if (e.platform === "ios") targets.anyIos += 1;
    else targets.anyAndroid += 1;
  }
  return targets;
}

function targetCount(t: Targets): number {
  return t.anyAndroid + t.anyIos + t.serials.length;
}

function expandTargets(t: Targets): DeviceTarget[] {
  return [
    ...Array.from({ length: t.anyAndroid }, (): DeviceTarget => ({ platform: "android" })),
    ...Array.from({ length: t.anyIos }, (): DeviceTarget => ({ platform: "ios" })),
    ...t.serials,
  ];
}

/** Marks which "Start from" chip seeded the form, for highlighting. */
type Source = { kind: "blank" } | { kind: "template" | "suite" | "recent"; id: string };

export function NewRunSheet() {
  const { open, prefill, close } = useNewRun();
  return (
    <Sheet open={open} onOpenChange={(next) => !next && close()}>
      <SheetContent side="right" className="w-full gap-0 overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>New run</SheetTitle>
          <SheetDescription>Pick a project and device, then describe what the QA agent should verify.</SheetDescription>
        </SheetHeader>
        {/* Radix unmounts the content when closed, so the form (and its state) is fresh on every open. */}
        <NewRunForm prefill={prefill} onDone={close} />
      </SheetContent>
    </Sheet>
  );
}

function NewRunForm({ prefill, onDone }: { prefill: NewRunPrefill | null; onDone(): void }) {
  const { projects, loading: projectsLoading } = useProjects();
  const ready = useMemo(() => projects.filter((p) => p.status === "ok"), [projects]);
  const { projectId: scopeProject } = useProjectScope();
  const { devices } = useDevices();
  const { report: doctor } = useDoctor();
  const { templates } = useTemplates();
  const { harnesses, defaultId, loading: harnessesLoading, error: harnessesError } = useHarnesses();

  const initialProject = useMemo(
    () => ready.find((p) => p.id === prefill?.projectId) ?? ready.find((p) => p.id === scopeProject) ?? ready[0],
    // resolved once the projects have loaded; later changes are the user's
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectsLoading],
  );

  if (projectsLoading) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Loading projects…
      </div>
    );
  }
  if (!initialProject) {
    return (
      <div className="p-4">
        <Alert>
          <AlertCircle />
          <AlertTitle>No project is ready</AlertTitle>
          <AlertDescription>
            Add or fix a project on the{" "}
            <a href="#/projects" className="underline">
              Projects page
            </a>{" "}
            before starting a run.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <RunFormBody
      prefill={prefill}
      projects={ready}
      initialProject={initialProject}
      devices={devices.filter(isQaDevice)}
      templates={templates}
      harnesses={harnesses}
      defaultHarness={defaultId}
      harnessesLoading={harnessesLoading}
      harnessesError={harnessesError}
      artemisAvailable={doctor?.backends.includes("artemis") ?? false}
      onDone={onDone}
    />
  );
}

interface BodyProps {
  prefill: NewRunPrefill | null;
  projects: ProjectStatus[];
  initialProject: ProjectStatus;
  devices: Device[];
  templates: Template[];
  harnesses: HarnessInfo[];
  defaultHarness: HarnessId | null;
  harnessesError: string | null;
  harnessesLoading: boolean;
  artemisAvailable: boolean;
  onDone(): void;
}

function RunFormBody({
  prefill,
  projects,
  initialProject,
  devices,
  templates,
  harnesses,
  defaultHarness,
  harnessesError,
  harnessesLoading,
  artemisAvailable,
  onDone,
}: BodyProps) {
  const [projectId, setProjectId] = useState(initialProject.id);
  const project = projects.find((p) => p.id === projectId) ?? initialProject;
  const [targets, setTargets] = useState<Targets>(() => targetsFromPrefill(prefill, initialProject.defaultPlatform));
  const [backend, setBackend] = useState<Backend>(prefill?.backend ?? "mobile-mcp");
  const [packageId, setPackageId] = useState(prefill?.packageId ?? initialProject.defaultPackage);
  const installed = useMemo(() => harnesses.filter((h) => h.installed), [harnesses]);
  /** Set by the user or a prefill; null = untouched, so the run request names no harness and the project or persona decides. */
  const [chosenHarness, setChosenHarness] = useState<HarnessId | null>(prefill?.harness ?? null);
  const explicitHarness = installed.find((h) => h.id === chosenHarness)?.id ?? null;
  /** What an untouched picker shows: the project's harness, else the server default, among the installed ones. */
  function defaultHarnessFor(p: ProjectStatus): HarnessId | null {
    return (
      installed.find((h) => h.id === p.agent?.harness)?.id ??
      installed.find((h) => h.id === defaultHarness)?.id ??
      installed[0]?.id ??
      null
    );
  }
  const harness = explicitHarness ?? defaultHarnessFor(project);
  const harnessInfo = installed.find((h) => h.id === harness) ?? null;
  const noRuntime = !harnessesLoading && !harnessesError && installed.length === 0;
  const { models, loading: modelsLoading } = useModels(harness ?? undefined);
  const [model, setModel] = useState(prefill?.model ?? "");
  const [effort, setEffort] = useState(prefill?.effort ?? "");

  // A prefilled harness that is not installed is dropped, and so are the harness-native model and effort that came with it.
  useEffect(() => {
    if (harnessesLoading || !prefill?.harness || installed.some((h) => h.id === prefill.harness)) return;
    setModel((m) => (m === prefill.model ? "" : m));
    setEffort((e) => (e === prefill.effort ? "" : e));
  }, [harnessesLoading, installed, prefill]);
  const [sourcePath, setSourcePath] = useState(prefill?.sourcePath ?? "");
  const [prNumber, setPrNumber] = useState("");
  const [installPath, setInstallPath] = useState("");

  const initialDraft = useMemo(
    () => (prefill?.brief || prefill?.title || prefill?.suiteId ? null : readDraft(initialProject.id)),
    [prefill, initialProject.id],
  );
  const [title, setTitle] = useState(prefill?.title ?? initialDraft?.title ?? "");
  const [titleTouched, setTitleTouched] = useState(Boolean(prefill?.title ?? initialDraft?.title));
  const [editingTitle, setEditingTitle] = useState(false);
  const [brief, setBrief] = useState(prefill?.brief ?? initialDraft?.brief ?? "");
  const [draftRestored, setDraftRestored] = useState(initialDraft !== null);
  /** Autosave starts with the first edit so merely opening a prefilled sheet never overwrites a saved draft. */
  const [dirty, setDirty] = useState(false);
  const [suite, setSuite] = useState<Suite | null>(null);
  const [source, setSource] = useState<Source | null>(null);
  const [saveAsSuite, setSaveAsSuite] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  /** Synchronous guard: `requestSubmit()` ignores the disabled button and state updates lag a render behind. */
  const submittingRef = useRef(false);

  const { suites } = useSuites(projectId);
  const { runs: recentRuns } = useRuns({ project: projectId, limit: 50 });
  const recentBriefs = useMemo(() => {
    const seen = new Set<string>();
    const out: { id: string; title: string; brief: string }[] = [];
    for (const run of recentRuns) {
      const text = run.brief.trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      out.push({ id: run.id, title: run.title, brief: run.brief });
      if (out.length === RECENT_BRIEFS) break;
    }
    return out;
  }, [recentRuns]);

  // Prefilled suite (e.g. opened from a suite list): adopt it once the suites have loaded, unless the user already typed.
  const adoptedSuite = useRef(false);
  useEffect(() => {
    if (adoptedSuite.current || !prefill?.suiteId) return;
    const found = suites.find((s) => s.id === prefill.suiteId);
    if (!found) return;
    adoptedSuite.current = true;
    if (dirty) return;
    setSuite(found);
    setSource({ kind: "suite", id: found.id });
    setTitle(found.title);
    setTitleTouched(true);
    setBrief(found.brief);
    if (found.model && !prefill.model) setModel(found.model);
  }, [suites, prefill?.suiteId, prefill?.model, dirty]);

  const hasIos = targets.anyIos > 0 || targets.serials.some((t) => t.platform === "ios");
  const harnessAllowsArtemis = harnessInfo ? harnessInfo.capabilities.backends.includes("artemis") : true;
  const effectiveBackend: Backend = artemisAvailable && !hasIos && harnessAllowsArtemis ? backend : "mobile-mcp";
  const total = targetCount(targets);
  const suggested = suggestTitle(brief);
  const shownTitle = titleTouched ? title : suggested;
  const activeSuite = suite && brief === suite.brief ? suite : null;
  const runTitle = (titleTouched ? title : suggested).trim() || (activeSuite?.title ?? "");
  const suiteId = slugify(runTitle);

  // Draft autosave per project (title and brief only; the device and options are cheap to re-pick).
  // projectId is deliberately not a dependency: switching project must not rewrite the new project's saved
  // draft with the previous project's text; the text is saved under the new key from the next edit on.
  useEffect(() => {
    if (dirty) writeDraft(projectId, titleTouched ? { title, brief } : { title: "", brief });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, title, titleTouched, brief]);

  function applyText(next: { title: string; brief: string }, from: Source, nextSuite: Suite | null = null) {
    setTitle(next.title);
    setTitleTouched(next.title !== "");
    setBrief(next.brief);
    setSuite(nextSuite);
    setSource(from);
    setDraftRestored(false);
    setDirty(true);
    if (nextSuite?.model) setModel(nextSuite.model);
  }

  function changeProject(id: string) {
    const next = projects.find((p) => p.id === id);
    if (!next) return;
    setProjectId(id);
    if (explicitHarness === null && defaultHarnessFor(next) !== harness) {
      // the untouched picker follows the project: model and effort are harness-native, so they do not carry over
      setModel("");
      setEffort("");
    }
    setPackageId(next.defaultPackage);
    setSuite(null);
    setSource(null);
    setTargets((t) =>
      t.serials.length === 0 && total === 1
        ? { anyAndroid: next.defaultPlatform === "android" ? 1 : 0, anyIos: next.defaultPlatform === "ios" ? 1 : 0, serials: [] }
        : t,
    );
    if (!brief.trim()) {
      const draft = readDraft(id);
      if (draft) {
        setTitle(draft.title);
        setTitleTouched(Boolean(draft.title));
        setBrief(draft.brief);
        setDraftRestored(true);
      }
    }
  }

  function discardDraft() {
    writeDraft(projectId, null);
    applyText({ title: "", brief: "" }, { kind: "blank" });
  }

  function onKeyDown(e: KeyboardEvent<HTMLFormElement>) {
    if (e.key !== "Enter") return;
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      if (!submittingRef.current) formRef.current?.requestSubmit();
    } else if (e.target instanceof HTMLInputElement) {
      // plain Enter in a single-line field must not trigger the browser's implicit submit
      e.preventDefault();
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (submittingRef.current) return;
    setError(null);
    const prText = prNumber.trim().replace(/^#/, "");
    if (prText && !/^[1-9]\d*$/.test(prText)) {
      setError("PR number must be a positive integer");
      return;
    }
    if (total === 0) {
      setError("Pick at least one device");
      return;
    }
    if (!brief.trim()) {
      setError("Describe what the agent should verify");
      return;
    }
    const path = sourcePath.trim();
    const runSource = { ...(path ? { path } : {}), ...(prText ? { prNumber: Number(prText) } : {}) };
    const common = {
      projectId,
      title: runTitle || undefined,
      ...(activeSuite ? { suiteId: activeSuite.id } : { brief: brief.trim() }),
      backend: effectiveBackend,
      packageId: packageId.trim() || project.defaultPackage,
      ...(explicitHarness ? { harness: explicitHarness } : {}),
      model: model.trim() || undefined,
      thinking: effort || undefined,
      ...(Object.keys(runSource).length > 0 ? { source: runSource } : {}),
    };
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const devicesToUse = expandTargets(targets);
      let destination: string;
      if (devicesToUse.length > 1) {
        const { batchId, runs } = await api.startBatch({ ...common, devices: devicesToUse });
        toast.success(`${runs.length} runs queued`);
        destination = batchHash(batchId);
      } else {
        const first = devicesToUse[0];
        if (!first) throw new Error("Pick at least one device");
        const run = await api.startRun({
          ...common,
          device: first,
          ...(installPath.trim() ? { install: { path: installPath.trim() } } : {}),
        });
        toast.success(`Run queued: ${run.title}`);
        destination = runHash(run.id);
      }
      writeDraft(projectId, null);
      if (saveAsSuite && !activeSuite && suiteId && runTitle) {
        await api.saveSuite(projectId, { id: suiteId, title: runTitle, brief: brief.trim() }).then(
          () => toast.success(`Saved suite ${suiteId}`),
          (err: unknown) => toast.error(`Run started, but the suite was not saved: ${err instanceof Error ? err.message : String(err)}`),
        );
      }
      onDone();
      navigate(destination);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  const advancedSummary = [
    effectiveBackend,
    harnessInfo?.label ?? (noRuntime ? "no runtime" : null),
    packageId.trim() || project.defaultPackage,
    model.trim() || null,
    sourcePath.trim() || "project root",
    prNumber.trim() ? `PR #${prNumber.trim().replace(/^#/, "")}` : null,
    installPath.trim() ? "install" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <form ref={formRef} onSubmit={submit} onKeyDown={onKeyDown} className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-5 p-4 pt-0">
        {error && (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle>Could not start run</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <StartFrom
          templates={templates}
          suites={suites}
          recent={recentBriefs}
          source={source}
          onBlank={() => applyText({ title: "", brief: "" }, { kind: "blank" })}
          onTemplate={(t) => applyText({ title: t.title, brief: t.brief }, { kind: "template", id: t.id })}
          onSuite={(s) => applyText({ title: s.title, brief: s.brief }, { kind: "suite", id: s.id }, s)}
          onRecent={(r) => applyText({ title: "", brief: r.brief }, { kind: "recent", id: r.id })}
        />

        <div className="space-y-2">
          <Label htmlFor="nr-project">Project</Label>
          <Select value={projectId} onValueChange={changeProject}>
            <SelectTrigger id="nr-project" className="w-full">
              <SelectValue placeholder="Select a project" />
            </SelectTrigger>
            <SelectContent>
              {projects.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label>Device</Label>
          <DevicePicker devices={devices} targets={targets} onChange={setTargets} artemisAvailable={artemisAvailable} />
          {total > 1 && (
            <p className="text-xs text-muted-foreground">
              {total} runs start in parallel as one batch, each on its own device.
            </p>
          )}
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="nr-brief">Brief</Label>
            {draftRestored && (
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                Draft restored
                <Button type="button" variant="link" size="sm" className="h-auto p-0 text-xs" onClick={discardDraft}>
                  Discard
                </Button>
              </span>
            )}
          </div>
          <Textarea
            id="nr-brief"
            className="min-h-64 resize-y field-sizing-fixed"
            placeholder={BRIEF_PLACEHOLDER}
            value={brief}
            onChange={(e) => {
              setBrief(e.target.value);
              setDraftRestored(false);
              setDirty(true);
            }}
            autoFocus={!prefill?.brief}
          />
          <p className="text-xs text-muted-foreground">
            One check per sentence works best — the agent turns them into C1, C2… <kbd className="rounded border px-1 font-mono text-[10px]">⌘↵</kbd> starts the run.
          </p>
          <div className="flex min-w-0 items-center gap-2 text-sm">
            <span className="shrink-0 text-muted-foreground">Title</span>
            {editingTitle ? (
              <Input
                autoFocus
                className="h-7"
                value={shownTitle}
                placeholder={suggested || "Run title"}
                onChange={(e) => {
                  setTitle(e.target.value);
                  setTitleTouched(true);
                  setDirty(true);
                }}
                onBlur={() => setEditingTitle(false)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
                    e.preventDefault();
                    setEditingTitle(false);
                  }
                }}
              />
            ) : (
              <>
                <span className={cn("min-w-0 truncate", !runTitle && "text-muted-foreground")}>{runTitle || "from the first sentence of the brief"}</span>
                <Button type="button" variant="link" size="sm" className="h-auto shrink-0 p-0 text-xs" onClick={() => setEditingTitle(true)}>
                  Edit
                </Button>
              </>
            )}
          </div>
        </div>

        <HarnessNotice error={harnessesError} none={noRuntime} unknown={harnesses.length === 0} />

        <Collapsible defaultOpen={Boolean(prefill?.harness || prefill?.model || prefill?.effort || prefill?.sourcePath || prefill?.packageId)}>
          <CollapsibleTrigger asChild>
            <Button type="button" variant="outline" className="h-auto w-full justify-between py-2 text-left font-normal">
              <span className="min-w-0">
                <span className="block text-sm font-medium">Advanced</span>
                <span className="block truncate text-xs text-muted-foreground">{advancedSummary}</span>
              </span>
              <ChevronsUpDown className="shrink-0" />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-4 pt-4">
            <HarnessField
              installed={installed}
              value={harness}
              explicit={explicitHarness !== null}
              loading={harnessesLoading}
              error={harnessesError}
              onChange={(next) => {
                setChosenHarness(next);
                // models and effort levels are harness-native strings: they do not carry over
                setModel("");
                setEffort("");
              }}
            />
            {artemisAvailable && (
              <div className="space-y-2">
                <Label>Backend</Label>
                <RadioGroup
                  value={effectiveBackend}
                  onValueChange={(v) => setBackend(v === "artemis" ? "artemis" : "mobile-mcp")}
                  className="grid grid-cols-2 gap-3"
                >
                  <BackendOption value="mobile-mcp" title="mobile-mcp" description="Android and iOS" />
                  <BackendOption
                    value="artemis"
                    title="artemis"
                    description={
                      !harnessAllowsArtemis
                        ? `Not available with ${harnessInfo?.label ?? "this agent runtime"}`
                        : hasIos
                          ? "Android only — iOS device selected"
                          : "Android only"
                    }
                    disabled={hasIos || !harnessAllowsArtemis}
                  />
                </RadioGroup>
                {!harnessAllowsArtemis && (
                  <p className="text-xs text-muted-foreground">
                    The artemis backend needs your own MCP config, which only omp sessions inherit.
                  </p>
                )}
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="nr-package">Package</Label>
              <Input id="nr-package" className="font-mono" value={packageId} onChange={(e) => setPackageId(e.target.value)} autoComplete="off" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="nr-model">Model</Label>
              <ModelCombobox id="nr-model" value={model} models={models} loading={modelsLoading} onChange={setModel} />
              <p className="text-xs text-muted-foreground">{modelHint(harness)}</p>
            </div>
            <EffortField harness={harness} value={effort} onChange={setEffort} />
            <div className="space-y-2">
              <Label htmlFor="nr-source-path">Working directory</Label>
              <Input
                id="nr-source-path"
                className="font-mono"
                placeholder="project repo root"
                value={sourcePath}
                onChange={(e) => setSourcePath(e.target.value)}
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">Absolute path of a git worktree of the project, to record its branch, commit and PR.</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="nr-source-pr">PR number</Label>
              <Input
                id="nr-source-pr"
                className="font-mono"
                inputMode="numeric"
                placeholder="auto-detect from branch"
                value={prNumber}
                onChange={(e) => setPrNumber(e.target.value)}
                autoComplete="off"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="nr-install">Install before the run</Label>
              <Input
                id="nr-install"
                className="font-mono"
                placeholder="/path/to/app-debug.apk or MyApp.app"
                value={installPath}
                onChange={(e) => setInstallPath(e.target.value)}
                disabled={total > 1}
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">
                {total > 1 ? "Install is only available for single-device runs." : "Absolute path of an .apk (Android) or .app / .ipa (iOS simulator)."}
              </p>
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>

      <div className="sticky bottom-0 mt-auto flex flex-col gap-3 border-t bg-background p-4">
        {!activeSuite && brief.trim() && (
          <label className="flex items-start gap-2 text-sm">
            <Checkbox checked={saveAsSuite} onCheckedChange={(v) => setSaveAsSuite(v === true)} className="mt-0.5" />
            <span>
              Save as suite
              {saveAsSuite && (
                <span className="block text-xs text-muted-foreground">
                  {suiteId ? `Writes .tapocalypse/suites/${suiteId}.md in the project repo.` : "Give the run a title to name the suite."}
                </span>
              )}
            </span>
          </label>
        )}
        <Button type="submit" disabled={submitting || harnessesLoading || noRuntime || total === 0 || !brief.trim()}>
          {submitting ? <Loader2 className="animate-spin" /> : <Play />}
          {submitting ? "Starting…" : total > 1 ? `Start ${total} runs` : "Start run"}
        </Button>
      </div>
    </form>
  );
}

function StartFrom({
  templates,
  suites,
  recent,
  source,
  onBlank,
  onTemplate,
  onSuite,
  onRecent,
}: {
  templates: Template[];
  suites: Suite[];
  recent: { id: string; title: string; brief: string }[];
  source: Source | null;
  onBlank(): void;
  onTemplate(t: Template): void;
  onSuite(s: Suite): void;
  onRecent(r: { id: string; title: string; brief: string }): void;
}) {
  const is = (kind: Source["kind"], id?: string) => source?.kind === kind && (id === undefined || ("id" in source && source.id === id));
  const chip = (active: boolean) => cn("h-7 max-w-52 gap-1.5 px-2 text-xs font-normal", active && "border-ring bg-accent");
  return (
    <div className="space-y-2">
      <Label>Start from</Label>
      <div className="flex flex-wrap gap-1.5">
        <Button type="button" variant="outline" size="sm" className={chip(is("blank"))} onClick={onBlank}>
          Blank
        </Button>
        {templates.map((t) => (
          <Button key={t.id} type="button" variant="outline" size="sm" className={chip(is("template", t.id))} title={t.description} onClick={() => onTemplate(t)}>
            <FileText className="size-3.5 shrink-0" />
            <span className="truncate">{t.title}</span>
          </Button>
        ))}
        {suites.map((s) => (
          <Button key={s.id} type="button" variant="outline" size="sm" className={chip(is("suite", s.id))} title="Saved suite" onClick={() => onSuite(s)}>
            <Layers className="size-3.5 shrink-0" />
            <span className="truncate">{s.title}</span>
          </Button>
        ))}
        {recent.map((r) => (
          <Button key={r.id} type="button" variant="outline" size="sm" className={chip(is("recent", r.id))} title={`Recent brief: ${r.title}`} onClick={() => onRecent(r)}>
            <Clock className="size-3.5 shrink-0" />
            <span className="truncate">{r.brief.trim().split("\n")[0]}</span>
          </Button>
        ))}
      </div>
    </div>
  );
}

function DeviceChip({ children, tone }: { children: string; tone?: "busy" | "free" }) {
  return (
    <span
      className={cn(
        "rounded border px-1 py-px text-[10px] leading-none",
        tone === "free" && "border-emerald-500/30 text-emerald-700 dark:text-emerald-400",
        tone === "busy" && "border-orange-500/30 text-orange-700 dark:text-orange-400",
        !tone && "text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

function deviceStatus(d: Device): { label: string; tone?: "busy" | "free" } {
  if (d.state === "booting") return { label: "Booting" };
  if (d.busyRunId) return { label: "Busy", tone: "busy" };
  if (d.artemisOwner) return { label: "Artemis task", tone: "busy" };
  return { label: "Free", tone: "free" };
}

function DevicePicker({
  devices,
  targets,
  onChange,
  artemisAvailable,
}: {
  devices: Device[];
  targets: Targets;
  onChange(next: Targets): void;
  artemisAvailable: boolean;
}) {
  const total = targetCount(targets);
  const atCap = total >= MAX_TARGETS;
  const byPlatform = (platform: Platform, kind: "virtual" | "physical") =>
    devices.filter((d) => d.platform === platform && (kind === "physical" ? d.kind === "physical" : d.kind !== "physical"));
  const groups: { label: string; note?: string; devices: Device[] }[] = [
    { label: "Android", devices: byPlatform("android", "virtual") },
    { label: "iOS", devices: byPlatform("ios", "virtual") },
    { label: "Physical", note: "only used when chosen", devices: [...byPlatform("android", "physical"), ...byPlatform("ios", "physical")] },
  ];
  const names = new Map(devices.map((d) => [d.serial, deviceDisplayName(d)]));

  const summary = [
    targets.anyAndroid > 0 ? `Any Android${targets.anyAndroid > 1 ? ` ×${targets.anyAndroid}` : ""}` : null,
    targets.anyIos > 0 ? `Any iOS${targets.anyIos > 1 ? ` ×${targets.anyIos}` : ""}` : null,
    ...targets.serials.map((t) => (t.serial ? (names.get(t.serial) ?? t.serial) : null)),
  ].filter(Boolean);

  function setAny(platform: Platform, count: number) {
    const next = Math.max(0, count);
    onChange(platform === "ios" ? { ...targets, anyIos: next } : { ...targets, anyAndroid: next });
  }

  function toggleSerial(d: Device, on: boolean) {
    onChange({
      ...targets,
      serials: on ? [...targets.serials, { platform: d.platform, serial: d.serial }] : targets.serials.filter((t) => t.serial !== d.serial),
    });
  }

  const anyRow = (platform: Platform, label: string) => {
    const count = platform === "ios" ? targets.anyIos : targets.anyAndroid;
    return (
      <div className="flex items-center gap-2 rounded-sm px-2 py-1.5 hover:bg-accent">
        <Checkbox
          id={`nr-any-${platform}`}
          checked={count > 0}
          disabled={count === 0 && atCap}
          onCheckedChange={(v) => setAny(platform, v === true ? 1 : 0)}
        />
        <Label htmlFor={`nr-any-${platform}`} className="flex-1 cursor-pointer font-normal">
          {label}
        </Label>
        {count > 0 && (
          <span className="flex items-center gap-1" aria-label={`${label} count`}>
            <Button type="button" variant="outline" size="icon" className="size-6" aria-label="Fewer" onClick={() => setAny(platform, count - 1)}>
              <Minus />
            </Button>
            <span className="w-6 text-center text-sm tabular-nums">×{count}</span>
            <Button type="button" variant="outline" size="icon" className="size-6" aria-label="More" disabled={atCap} onClick={() => setAny(platform, count + 1)}>
              <Plus />
            </Button>
          </span>
        )}
      </div>
    );
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" className="h-auto min-h-9 w-full justify-between py-1.5 font-normal">
          <span className={cn("truncate text-left", summary.length === 0 && "text-muted-foreground")}>
            {summary.length > 0 ? summary.join(" + ") : "Select devices"}
          </span>
          <ChevronsUpDown className="shrink-0 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="max-h-96 w-(--radix-popover-trigger-width) overflow-y-auto p-1">
        <p className="px-2 pb-0.5 pt-1.5 text-xs font-medium text-muted-foreground">Any available</p>
        {anyRow("android", "Any Android")}
        {anyRow("ios", "Any iOS")}
        {groups
          .filter((g) => g.devices.length > 0)
          .map((g) => (
            <div key={g.label}>
              <p className="px-2 pb-0.5 pt-2 text-xs font-medium text-muted-foreground">
                {g.label}
                {g.note && <span className="font-normal"> · {g.note}</span>}
              </p>
              {g.devices.map((d) => {
                const status = deviceStatus(d);
                const checked = targets.serials.some((t) => t.serial === d.serial);
                return (
                  <label
                    key={d.serial}
                    className={cn(
                      "flex items-center gap-2 rounded-sm px-2 py-1.5 hover:bg-accent",
                      d.state === "booting" ? "cursor-not-allowed opacity-60" : "cursor-pointer",
                    )}
                  >
                    <Checkbox
                      checked={checked}
                      disabled={d.state === "booting" || (!checked && atCap)}
                      onCheckedChange={(v) => toggleSerial(d, v === true)}
                    />
                    <span className="min-w-0 flex-1">
                      <DeviceName device={d} className="text-sm" />
                      <span className="block truncate font-mono text-[11px] text-muted-foreground">{deviceSubtitle(d)}</span>
                    </span>
                    <span className="flex shrink-0 flex-wrap justify-end gap-1">
                      <DeviceChip tone={status.tone}>{status.label}</DeviceChip>
                      {artemisAvailable && d.artemisHelper && <DeviceChip>helper on</DeviceChip>}
                      {d.bootedByTapocalypse && <DeviceChip>auto-booted</DeviceChip>}
                    </span>
                  </label>
                );
              })}
            </div>
          ))}
        {devices.length === 0 && <p className="px-2 py-2 text-xs text-muted-foreground">No devices connected. “Any” boots a configured emulator when one is free.</p>}
        {atCap && <p className="px-2 py-1.5 text-xs text-muted-foreground">At most {MAX_TARGETS} devices per batch.</p>}
      </PopoverContent>
    </Popover>
  );
}

/** Harness-native effort levels the server accepts for `thinking`; the first entry of each list is the lowest. */
const EFFORT_LEVELS: Record<HarnessId, string[]> = {
  omp: ["off", "minimal", "low", "medium", "high", "xhigh"],
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["minimal", "low", "medium", "high", "xhigh"],
};
const ALL_EFFORT_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const EFFORT_DEFAULT = "default";

function modelHint(harness: HarnessId | null): string {
  const fallback = "Empty uses the suite, persona or configured default.";
  switch (harness) {
    case "omp":
      return `provider/model, optionally with a :thinking suffix. ${fallback}`;
    case "claude":
      return `A Claude alias (sonnet, opus) or a full model id. ${fallback}`;
    case "codex":
      return `A Codex model id such as gpt-5.5. ${fallback}`;
    case null:
      return fallback;
  }
}

function effortHint(harness: HarnessId | null): string {
  switch (harness) {
    case "omp":
      return "omp thinking level. Empty uses the suite, persona or configured default.";
    case "claude":
      return "Claude Code effort (--effort). Empty uses Claude Code's default.";
    case "codex":
      return "Codex reasoning effort (model_reasoning_effort). Empty uses Codex's default.";
    case null:
      return "Empty uses the configured default.";
  }
}

function EffortField({ harness, value, onChange }: { harness: HarnessId | null; value: string; onChange(next: string): void }) {
  const levels = harness ? EFFORT_LEVELS[harness] : ALL_EFFORT_LEVELS;
  return (
    <div className="space-y-2">
      <Label htmlFor="nr-effort">{harness === "omp" ? "Thinking" : "Effort"}</Label>
      <Select value={value || EFFORT_DEFAULT} onValueChange={(v) => onChange(v === EFFORT_DEFAULT ? "" : v)}>
        <SelectTrigger id="nr-effort" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={EFFORT_DEFAULT}>Default</SelectItem>
          {levels.map((level) => (
            <SelectItem key={level} value={level}>
              {level}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">{effortHint(harness)}</p>
    </div>
  );
}

/** Alert above the Advanced section: a failed runtime lookup, or no installed runtime (Start is disabled then). */
function HarnessNotice({ error, none, unknown }: { error: string | null; none: boolean; unknown: boolean }) {
  if (error) {
    return (
      <Alert variant="destructive">
        <AlertCircle />
        <AlertTitle>Could not load agent runtimes</AlertTitle>
        <AlertDescription>{error}. The run will use the server default.</AlertDescription>
      </Alert>
    );
  }
  if (!none) return null;
  return (
    <Alert variant="destructive">
      <AlertCircle />
      <AlertTitle>No agent runtime installed</AlertTitle>
      <AlertDescription>
        {unknown ? "No agent runtimes are known to the server." : "Install omp, Claude Code or Codex to start runs."}{" "}
        <a href="#/setup" className="underline">
          Open Setup
        </a>
      </AlertDescription>
    </Alert>
  );
}

/** Agent CLI picker: only installed harnesses are offered. `explicit` = the user (or a prefill) chose; otherwise the project or persona decides. */
function HarnessField({
  installed,
  value,
  explicit,
  loading,
  error,
  onChange,
}: {
  installed: HarnessInfo[];
  value: HarnessId | null;
  explicit: boolean;
  loading: boolean;
  error: string | null;
  onChange(next: HarnessId): void;
}) {
  const selected = installed.find((h) => h.id === value) ?? null;
  const none = installed.length === 0;
  return (
    <div className="space-y-2">
      <Label htmlFor="nr-harness">Agent runtime</Label>
      {loading ? (
        <Skeleton className="h-9 w-full" aria-busy aria-label="Loading agent runtimes" />
      ) : (
        <>
          <Select
            value={value ?? ""}
            onValueChange={(v) => {
              const next = installed.find((h) => h.id === v);
              if (next) onChange(next.id);
            }}
            disabled={none}
          >
            <SelectTrigger id="nr-harness" className="w-full">
              <SelectValue placeholder={error ? "Server default" : "No agent runtime installed"} />
            </SelectTrigger>
            <SelectContent>
              {installed.map((h) => (
                <SelectItem key={h.id} value={h.id}>
                  {h.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {!none && !explicit && (
            <p className="text-xs text-muted-foreground">
              Left untouched, the project or persona setting decides; otherwise the server default.
            </p>
          )}
          {selected && !selected.capabilities.steer && (
            <p className="text-xs text-muted-foreground">{selected.label} cannot be steered while a run is in progress.</p>
          )}
        </>
      )}
    </div>
  );
}

function ModelCombobox({
  id,
  value,
  models,
  loading,
  onChange,
}: {
  id: string;
  value: string;
  models: string[];
  loading: boolean;
  onChange(next: string): void;
}) {
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const query = value.trim().toLowerCase();
  const matches = models.filter((m) => m.toLowerCase().includes(query) && m !== value).slice(0, 50);
  return (
    <Popover open={open && matches.length > 0} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <Input
          ref={inputRef}
          id={id}
          className="font-mono"
          placeholder={loading ? "Loading models…" : "default"}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          autoComplete="off"
          role="combobox"
          aria-expanded={open && matches.length > 0}
          aria-autocomplete="list"
        />
      </PopoverAnchor>
      <PopoverContent
        align="start"
        className="max-h-60 w-(--radix-popper-anchor-width) overflow-y-auto p-1"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onInteractOutside={(e) => {
          if (e.target instanceof Node && inputRef.current?.contains(e.target)) e.preventDefault();
        }}
      >
        {matches.map((m) => (
          <button
            key={m}
            type="button"
            className="block w-full truncate rounded-sm px-2 py-1.5 text-left font-mono text-xs hover:bg-accent"
            onClick={() => {
              onChange(m);
              setOpen(false);
            }}
          >
            {m}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

function BackendOption({ value, title, description, disabled }: { value: Backend; title: string; description: string; disabled?: boolean }) {
  const id = `nr-backend-${value}`;
  return (
    <Label
      htmlFor={id}
      className={cn(
        "flex items-start gap-3 rounded-lg border p-3 has-[[data-state=checked]]:border-ring has-[[data-state=checked]]:bg-accent",
        disabled ? "cursor-not-allowed opacity-50" : "strike cursor-pointer",
      )}
    >
      <RadioGroupItem id={id} value={value} disabled={disabled} className="mt-0.5" />
      <span className="space-y-0.5">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs font-normal text-muted-foreground">{description}</span>
      </span>
    </Label>
  );
}
