import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import {
  ArrowLeft,
  ArrowDown,
  ChevronsUpDown,
  CircleX,
  Copy,
  ExternalLink,
  FileText,
  ImageOff,
  Info,
  Loader2,
  MessageSquare,
  RotateCcw,
  Send,
  TriangleAlert,
  User,
  Wrench,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { CheckStatusIcon } from "@/components/check-status-icon";
import { DeviceFrame } from "@/components/device-frame";
import { StatusBadge } from "@/components/status-badge";
import { SourceChips } from "@/components/source-chips";
import { VerdictBadge } from "@/components/verdict-badge";
import {
  api,
  isActive,
  reportHash,
  screenshotUrl,
  transcriptUrl,
  type Activity,
  type Check,
  type RunView,
} from "@/lib/api";
import { formatDuration, formatTime } from "@/lib/format";
import { navigate, useNow, useProjects, useRunEvents } from "@/lib/hooks";
import { cn } from "@/lib/utils";

const DONE_CHECK_STATUSES: readonly Check["status"][] = ["pass", "fail", "blocked", "skipped"];
const STICK_THRESHOLD_PX = 60;

const KIND_STYLE: Record<Activity["kind"], { icon: LucideIcon; className: string }> = {
  tool: { icon: Wrench, className: "text-blue-500" },
  say: { icon: MessageSquare, className: "text-foreground" },
  warn: { icon: TriangleAlert, className: "text-amber-500" },
  info: { icon: Info, className: "text-muted-foreground" },
  user: { icon: User, className: "text-violet-500" },
  error: { icon: CircleX, className: "text-red-500" },
};

type ActivityFilter = "all" | "say" | "tool" | "warn";

const FILTERS: { value: ActivityFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "say", label: "Agent" },
  { value: "tool", label: "Tools" },
  { value: "warn", label: "Warnings" },
];

function isActivityFilter(value: string): value is ActivityFilter {
  return FILTERS.some((f) => f.value === value);
}

function matchesFilter(a: Activity, filter: ActivityFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "say":
      return a.kind === "say";
    case "tool":
      return a.kind === "tool";
    case "warn":
      return a.kind === "warn" || a.kind === "error";
  }
}

function clock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour12: false });
}

export function RunDetail({ id }: { id: string }) {
  const { run, activity, error, connected } = useRunEvents(id);

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <a href="#/">
          <ArrowLeft />
          Runs
        </a>
      </Button>

      {!run && error ? (
        <Alert variant="destructive">
          <XCircle />
          <AlertTitle>Could not load run</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : !run ? (
        <RunDetailSkeleton />
      ) : (
        <>
          {error && !connected ? (
            <Alert variant="destructive">
              <XCircle />
              <AlertTitle>Live updates interrupted</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <RunBody run={run} activity={activity} connected={connected} />
        </>
      )}
    </div>
  );
}

function RunDetailSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-48 w-full" />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
        <Skeleton className="h-80 w-full" />
        <Skeleton className="h-[520px] w-full" />
      </div>
    </div>
  );
}

function RunBody({ run, activity, connected }: { run: RunView; activity: Activity[]; connected: boolean }) {
  const active = isActive(run.status);
  const [shot, setShot] = useState<{ url: string; title: string } | null>(null);

  return (
    <>
      <RunHeader run={run} active={active} connected={connected} />

      {run.error ? (
        <Alert variant="destructive">
          <XCircle />
          <AlertTitle>Run error</AlertTitle>
          <AlertDescription className="break-words">{run.error}</AlertDescription>
        </Alert>
      ) : null}

      {run.summary ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Summary</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="whitespace-pre-wrap text-sm leading-relaxed">{run.summary}</p>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
        <div className="space-y-6">
          <ChecksCard run={run} onOpenShot={setShot} />
          {active && run.deviceSerial ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Live device</CardTitle>
              </CardHeader>
              <CardContent className="flex justify-center">
                <DeviceFrame serial={run.deviceSerial} live size="md" />
              </CardContent>
            </Card>
          ) : null}
        </div>
        <ActivityCard runId={run.id} running={run.status === "running"} activity={activity} />
      </div>

      {run.stats !== null && run.stats !== undefined ? (
        <Collapsible>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="-ml-2">
              <ChevronsUpDown />
              Session stats
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <pre className="mt-2 max-h-96 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs">
              {JSON.stringify(run.stats, null, 2)}
            </pre>
          </CollapsibleContent>
        </Collapsible>
      ) : null}

      <Dialog open={shot !== null} onOpenChange={(open) => !open && setShot(null)}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>{shot?.title ?? "Screenshot"}</DialogTitle>
            <DialogDescription className="sr-only">Full-size check screenshot</DialogDescription>
          </DialogHeader>
          {shot ? (
            <img src={shot.url} alt={shot.title} className="mx-auto max-h-[75vh] w-auto rounded-md border" />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

function MetaItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-1">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-sm">{children}</dd>
    </div>
  );
}

function RunHeader({ run, active, connected }: { run: RunView; active: boolean; connected: boolean }) {
  const { projects } = useProjects();
  const now = useNow(active ? 1000 : 60_000);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const projectName = projects.find((p) => p.id === run.projectId)?.name ?? run.projectId;

  async function cancel() {
    setCancelling(true);
    try {
      await api.cancel(run.id);
      toast.success("Cancel requested");
      setConfirmOpen(false);
    } catch (err) {
      toast.error(`Cancel failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setCancelling(false);
    }
  }

  function copyId() {
    navigator.clipboard.writeText(run.id).then(
      () => toast.success("Run id copied"),
      () => toast.error("Could not copy run id"),
    );
  }

  return (
    <Card>
      <CardHeader className="gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <CardTitle className="min-w-0 break-words text-2xl">{run.title}</CardTitle>
          <StatusBadge status={run.status} />
          <VerdictBadge verdict={run.verdict} />
          {active && !connected ? (
            <Badge variant="outline" className="gap-1 text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              reconnecting
            </Badge>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {active ? (
            <Button variant="outline" size="sm" className="text-destructive" onClick={() => setConfirmOpen(true)}>
              <XCircle />
              Cancel run
            </Button>
          ) : null}
          <Button variant="outline" size="sm" onClick={() => navigate(`#/?rerun=${encodeURIComponent(run.id)}`)}>
            <RotateCcw />
            Re-run
          </Button>
          {!active && run.reportPath ? (
            <Button asChild size="sm">
              <a href={reportHash(run.projectId, run.reportPath)}>
                <FileText />
                Open report
              </a>
            </Button>
          ) : null}
          {!active && run.transcriptHtml ? (
            <Button asChild variant="outline" size="sm">
              <a href={transcriptUrl(run.id)} target="_blank" rel="noopener noreferrer">
                <ExternalLink />
                Transcript
              </a>
            </Button>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
          <MetaItem label="Project">{projectName}</MetaItem>
          <MetaItem label="Device">
            {run.deviceSerial ? <span className="font-mono text-xs">{run.deviceSerial}</span> : "—"}
          </MetaItem>
          <MetaItem label="Backend">{run.backend}</MetaItem>
          <MetaItem label="Package">
            <span className="font-mono text-xs">{run.packageId}</span>
          </MetaItem>
          <MetaItem label="Requester">{run.requestedBy}</MetaItem>
          {run.status === "queued" && run.queuePosition !== null ? (
            <MetaItem label="Queue">#{run.queuePosition}</MetaItem>
          ) : null}
          <MetaItem label="Started">{formatTime(run.startedAt ?? run.createdAt)}</MetaItem>
          <MetaItem label="Duration">
            <span className="tabular-nums">{formatDuration(run.startedAt, run.endedAt, now)}</span>
          </MetaItem>
          <MetaItem label="Run id">
            <span className="flex items-center gap-1">
              <span className="min-w-0 break-all font-mono text-xs">{run.id}</span>
              <Button variant="ghost" size="icon" className="size-6 shrink-0" onClick={copyId} aria-label="Copy run id">
                <Copy className="size-3" />
              </Button>
            </span>
          </MetaItem>
        </dl>

        {run.source ? (
          <div className="space-y-2">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Source</div>
            <SourceChips source={run.source} build={run.build} />
            <div className="break-all font-mono text-xs text-muted-foreground">{run.source.path}</div>
            {Object.keys(run.source.labels ?? {}).length > 0 ? (
              <div className="flex flex-wrap items-center gap-1.5">
                {Object.entries(run.source.labels).map(([key, value]) => (
                  <Badge key={key} variant="outline">
                    {key}: {value}
                  </Badge>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        <Collapsible>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="-ml-2">
              <ChevronsUpDown />
              Brief
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-3 text-sm">
              {run.brief}
            </div>
          </CollapsibleContent>
        </Collapsible>
      </CardContent>

      <Dialog open={confirmOpen} onOpenChange={(open) => !cancelling && setConfirmOpen(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel this run?</DialogTitle>
            <DialogDescription>
              {run.status === "queued"
                ? "The run will be removed from the queue."
                : "The agent will be aborted and the device released. This cannot be undone."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={cancelling}>
              Keep running
            </Button>
            <Button variant="destructive" onClick={() => void cancel()} disabled={cancelling}>
              {cancelling ? <Loader2 className="animate-spin" /> : null}
              Cancel run
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function ShotThumb({ url, title, onOpen }: { url: string; title: string; onOpen: () => void }) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div className="mt-2 flex h-24 w-16 flex-col items-center justify-center gap-1 rounded-md border border-dashed text-muted-foreground">
        <ImageOff className="size-4" />
        <span className="text-[10px]">missing</span>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      className="mt-2 block overflow-hidden rounded-md border transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={`Open screenshot: ${title}`}
    >
      <img src={url} alt={title} loading="lazy" onError={() => setFailed(true)} className="h-24 w-auto object-cover" />
    </button>
  );
}

function ChecksCard({ run, onOpenShot }: { run: RunView; onOpenShot: (shot: { url: string; title: string }) => void }) {
  const checks = run.checks;
  const total = checks.length;
  const done = checks.filter((c) => DONE_CHECK_STATUSES.includes(c.status)).length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const failed = checks.some((c) => c.status === "fail" || c.status === "blocked");

  return (
    <Card>
      <CardHeader className="gap-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">Checks</CardTitle>
          <span className="text-xs tabular-nums text-muted-foreground">
            {done}/{total}
          </span>
        </div>
        <Progress value={pct} className={cn("h-2", failed && "[&>*]:bg-red-500")} />
      </CardHeader>
      <CardContent>
        {total === 0 ? (
          <p className="text-sm text-muted-foreground">No checks declared yet.</p>
        ) : (
          <ul className="space-y-4">
            {checks.map((c) => (
              <li key={c.id} className="flex gap-3">
                <CheckStatusIcon status={c.status} className="mt-0.5 size-4 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <Badge variant="outline" className="font-mono text-xs">
                      {c.id}
                    </Badge>
                    <span className="min-w-0 break-words">{c.title}</span>
                  </div>
                  {c.note ? <p className="mt-1 break-words text-sm text-muted-foreground">{c.note}</p> : null}
                  {c.screenshot ? (
                    <ShotThumb
                      url={screenshotUrl(run.projectId, c.screenshot)}
                      title={`${c.id} — ${c.title}`}
                      onOpen={() => onOpenShot({ url: screenshotUrl(run.projectId, c.screenshot ?? ""), title: `${c.id} — ${c.title}` })}
                    />
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function ActivityRow({ a }: { a: Activity }) {
  const { icon: Icon, className } = KIND_STYLE[a.kind] ?? KIND_STYLE.info;
  return (
    <div className="flex items-start gap-2 px-4 py-1">
      <time className="shrink-0 pt-px font-mono text-xs tabular-nums text-muted-foreground">{clock(a.ts)}</time>
      <Icon className={cn("mt-0.5 size-3.5 shrink-0", className)} aria-label={a.kind} />
      <span className={cn("min-w-0 whitespace-pre-wrap break-words font-mono text-xs", className)}>{a.text}</span>
    </div>
  );
}

function ActivityCard({ runId, running, activity }: { runId: string; running: boolean; activity: Activity[] }) {
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const [showJump, setShowJump] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLElement | null>(null);
  const stickRef = useRef(true);

  const filtered = useMemo(() => activity.filter((a) => matchesFilter(a, filter)), [activity, filter]);

  useEffect(() => {
    const viewport = rootRef.current?.querySelector<HTMLElement>("[data-radix-scroll-area-viewport]") ?? null;
    viewportRef.current = viewport;
    if (!viewport) return;
    const onScroll = () => {
      const atBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < STICK_THRESHOLD_PX;
      stickRef.current = atBottom;
      setShowJump(!atBottom);
    };
    viewport.addEventListener("scroll", onScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", onScroll);
  }, []);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (viewport && stickRef.current) viewport.scrollTop = viewport.scrollHeight;
  }, [filtered]);

  function changeFilter(value: string) {
    if (!isActivityFilter(value)) return;
    stickRef.current = true;
    setShowJump(false);
    setFilter(value);
  }

  function jumpToLatest() {
    const viewport = viewportRef.current;
    if (!viewport) return;
    stickRef.current = true;
    setShowJump(false);
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" });
  }

  return (
    <Card>
      <CardHeader className="gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">Activity</CardTitle>
          <Tabs value={filter} onValueChange={changeFilter}>
            <TabsList>
              {FILTERS.map((f) => (
                <TabsTrigger key={f.value} value={f.value}>
                  {f.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 px-0">
        <div className="relative">
          <ScrollArea ref={rootRef} className="h-[max(420px,calc(100vh-16rem))]">
            {filtered.length === 0 ? (
              <p className="px-4 py-2 text-sm text-muted-foreground">No activity yet.</p>
            ) : (
              <div className="py-1">
                {filtered.map((a, i) => (
                  <ActivityRow key={`${i}-${a.ts}`} a={a} />
                ))}
              </div>
            )}
          </ScrollArea>
          {showJump ? (
            <Button
              size="sm"
              variant="secondary"
              className="absolute bottom-3 left-1/2 -translate-x-1/2 shadow-md"
              onClick={jumpToLatest}
            >
              <ArrowDown />
              Jump to latest
            </Button>
          ) : null}
        </div>
        {running ? <SteerBar runId={runId} /> : null}
      </CardContent>
    </Card>
  );
}

function SteerBar({ runId }: { runId: string }) {
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);

  async function send() {
    const text = message.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await api.steer(runId, text);
      setMessage("");
      toast.success("Steering message sent");
    } catch (err) {
      toast.error(`Steer failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex items-end gap-2 border-t px-4 pt-4">
      <Textarea
        rows={2}
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void send();
          }
        }}
        placeholder="Steer the agent… (Cmd/Ctrl+Enter to send)"
        className="min-h-0 resize-none"
      />
      <Button onClick={() => void send()} disabled={sending || !message.trim()}>
        {sending ? <Loader2 className="animate-spin" /> : <Send />}
        Send
      </Button>
    </div>
  );
}
