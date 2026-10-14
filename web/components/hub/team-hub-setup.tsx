import { AlertCircle, CheckCircle2, ChevronRight, CloudOff, FileKey, Loader2, Plug, Plus, RefreshCw, RotateCcw, Trash2, Users } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { CodeBlock } from "@/components/code-block";
import { Field } from "@/components/field";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { api, type HubStatus } from "@/lib/api";
import { formatRelative } from "@/lib/format";
import { useHubStatus, useNow } from "@/lib/hooks";
import { type HeaderRow, headersInput, hubStatusPill, hubTokenError, hubUrlError, type PillTone, syncReason } from "@/lib/hub";
import { cn } from "@/lib/utils";

const DOT: Record<PillTone, string> = {
  muted: "bg-stone-500",
  ok: "bg-emerald-500",
  busy: "bg-blue-500",
  warn: "bg-orange-400",
  error: "bg-red-500",
};

/** Pill shared by the Setup heading and the Projects page chip. */
export function StatusPill({ tone, children, href }: { tone: PillTone; children: string; href?: string }) {
  const body = (
    <>
      <span className={cn("inline-flex size-2 shrink-0 rounded-full", DOT[tone])} />
      <span>{children}</span>
    </>
  );
  const className = "inline-flex items-center gap-2 rounded-full border border-stone-500/30 bg-stone-500/10 px-3 py-1 text-xs text-stone-700 dark:text-stone-300";
  return href ? (
    <a href={href} role="status" className={cn(className, "hover:bg-stone-500/20")}>
      {body}
    </a>
  ) : (
    <p role="status" className={className}>
      {body}
    </p>
  );
}

interface Row extends HeaderRow {
  id: number;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function TestResult({ status, now }: { status: HubStatus; now: number }) {
  const { connection } = status;
  const host = status.url ? new URL(status.url).host : "the hub";
  const checked = connection.checkedAt ? <p className="text-xs text-muted-foreground">Last checked {formatRelative(connection.checkedAt, now)}.</p> : null;
  switch (connection.state) {
    case "unknown":
      return null;
    case "ok":
      return (
        <div className="space-y-1">
          <div role="status" className="flex gap-3 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-500" aria-hidden />
            <div>
              <p className="font-medium">
                Connected to {host} as “{connection.machine ?? "this machine"}”
              </p>
              <p className="text-muted-foreground">
                Hub version {connection.hubVersion ?? "unknown"}. Shared projects upload their finished runs from now on.
              </p>
            </div>
          </div>
          {checked}
        </div>
      );
    case "protocol_unsupported":
      return (
        <div className="space-y-1">
          <div role="alert" className="flex gap-3 rounded-lg border border-orange-500/40 bg-orange-500/5 p-3 text-sm text-orange-700 dark:text-orange-300">
            <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <div>
              <p className="font-medium">This machine is too old for the hub</p>
              <p>The hub needs protocol {connection.minProtocol ?? "a newer"}. Update Tapocalypse on this machine, then test again.</p>
            </div>
          </div>
          {checked}
        </div>
      );
    default: {
      const copy = {
        unauthorized: ["The hub rejected the upload token", "Check that you pasted the whole token (it starts with tpu_) and that your admin has not revoked it."],
        proxy_login: [
          "The access proxy asked for a login",
          "Requests from this machine stop at the proxy before they reach the hub. Add the headers the proxy accepts from machines above, or ask your admin to let /api/hub/v1/ through.",
        ],
        unreachable: ["Could not reach the hub", `${connection.detail ?? "No answer"}. Check the address, and that this machine is on the right network (VPN or tailnet).`],
        not_a_hub: ["This address is not a Tapocalypse hub", "It answered, but not like a hub. Use the hub's own address, for example https://qa.example.com."],
      }[connection.state];
      return (
        <div className="space-y-1">
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle>{copy[0]}</AlertTitle>
            <AlertDescription>{copy[1]}</AlertDescription>
          </Alert>
          {checked}
        </div>
      );
    }
  }
}

function Queue({ status, now }: { status: HubStatus; now: number }) {
  const [busy, setBusy] = useState(false);
  const { queue } = status;
  async function retry() {
    setBusy(true);
    try {
      const { queued } = await api.hubPush({ failed: true });
      toast.success(`Retrying ${queued} uploads`);
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mt-4 space-y-2 text-sm">
      {status.sharedProjects.length > 0 ? (
        <p>
          Shared projects:{" "}
          {status.sharedProjects.map((p, i) => (
            <span key={p.id}>
              {i > 0 && ", "}
              <a href="#/projects" className="underline underline-offset-2" title={p.hubKey}>
                {p.name}
              </a>
            </span>
          ))}
        </p>
      ) : (
        <p className="text-muted-foreground">
          No project is shared yet. Tick “Share with team hub” in a project's settings.{" "}
          <Button asChild variant="link" size="xs" className="h-auto p-0">
            <a href="#/projects">Open Projects</a>
          </Button>
        </p>
      )}
      <p className="flex flex-wrap gap-x-4 text-muted-foreground tabular-nums">
        <span>{queue.uploaded} uploaded</span>
        <span>{queue.waiting} waiting</span>
        <span className={cn(queue.failed > 0 && "text-orange-700 dark:text-orange-400")}>{queue.failed} failed</span>
        {queue.parked > 0 && <span>{queue.parked} not uploaded (id conflict)</span>}
        {status.lastUploadAt && <span>last upload {formatRelative(status.lastUploadAt, now)}</span>}
      </p>
      {queue.failed > 0 && (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void retry()}>
          {busy ? <Loader2 className="animate-spin" /> : <RotateCcw />}
          Retry failed uploads
        </Button>
      )}
      {queue.backfill && (
        <div className="space-y-1">
          <Progress value={queue.backfill.total > 0 ? (queue.backfill.done / queue.backfill.total) * 100 : 0} className="h-1.5" />
          <p className="text-xs text-muted-foreground">
            Uploading existing runs: {queue.backfill.done} of {queue.backfill.total}
          </p>
        </div>
      )}
    </div>
  );
}

/** Setup section: connect this machine to a team hub (address, upload token, optional proxy headers), see the queue, fix problems. */
export function TeamHubSetup({ autoScroll }: { autoScroll: boolean }) {
  const { status, loading, error, set } = useHubStatus();
  const now = useNow(30_000);
  const section = useRef<HTMLElement>(null);
  const nextId = useRef(0);
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [original, setOriginal] = useState(false);
  const [headersOpen, setHeadersOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [seeded, setSeeded] = useState(false);
  const [touched, setTouched] = useState(false);

  // Fill the form from the first status; later status frames (queue counters) must not overwrite what the user is typing.
  useEffect(() => {
    if (!status || seeded) return;
    setUrl(status.url ?? "");
    setOriginal(status.screenshots === "original");
    setRows(status.credentials.headers.names.map((name) => ({ id: nextId.current++, name, value: "", saved: true })));
    setHeadersOpen(status.credentials.headers.names.length > 0);
    setSeeded(true);
  }, [status, seeded]);

  useEffect(() => {
    if (autoScroll && status) section.current?.scrollIntoView({ block: "start" });
    // once, when the section first has content
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoScroll, status === null]);

  const urlError = url.trim() === "" ? null : hubUrlError(url);
  const tokenError = hubTokenError(token);
  const tokenLocked = status?.credentials.token === "env";
  const headersLocked = status?.credentials.headers.source === "env";
  const savedHeaders = status?.credentials.headers.names.length ?? 0;
  const changed =
    touched ||
    url.trim() !== (status?.url ?? "") ||
    token !== "" ||
    original !== (status?.screenshots === "original");
  const canSave = hubUrlError(url) === null && tokenError === null && changed && !saving;
  const host = status?.url ? (() => { try { return new URL(status.url).host; } catch { return null; } })() : null;

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaveError(null);
    const parsed = headersLocked ? ({ ok: true, headers: undefined } as const) : headersInput(rows, savedHeaders > 0);
    if (!parsed.ok) {
      setSaveError(parsed.error);
      setHeadersOpen(true);
      return;
    }
    setSaving(true);
    try {
      const next = await api.hubConnect({
        url: url.trim(),
        ...(token && !tokenLocked ? { token } : {}),
        ...(parsed.headers !== undefined ? { headers: parsed.headers } : {}),
        screenshots: original ? "original" : "webp",
      });
      set(next);
      setToken("");
      setTouched(false);
      setSeeded(false);
    } catch (err) {
      setSaveError(errorText(err));
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    setTesting(true);
    try {
      set(await api.hubTest());
    } catch (err) {
      setSaveError(errorText(err));
    } finally {
      setTesting(false);
    }
  }

  async function disconnect() {
    try {
      set(await api.hubDisconnect());
      setConfirmDisconnect(false);
      setUrl("");
      setToken("");
      setRows([]);
      setTouched(false);
      setSeeded(false);
    } catch (err) {
      toast.error(errorText(err));
    }
  }

  const pill = status ? hubStatusPill(status) : null;
  const patchRow = (id: number, patch: Partial<Row>) => {
    setTouched(true);
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };

  return (
    <section ref={section} id="team-hub" className="mt-10 scroll-mt-4" aria-labelledby="team-hub-title">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl space-y-0.5">
          <h2 id="team-hub-title" className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <Users className="size-5 text-muted-foreground" />
            Connect to a team hub
          </h2>
          <p className="text-sm text-muted-foreground">
            Upload finished runs of the projects you choose to your team's hub, so teammates and stakeholders can see them without running Tapocalypse. Nothing uploads until you turn on sharing for a project.
          </p>
        </div>
        {loading && !status ? <Skeleton className="h-6 w-40 rounded-full" /> : pill ? <StatusPill tone={pill.tone}>{pill.text}</StatusPill> : null}
      </div>

      {loading && !status ? (
        <Skeleton className="h-64" aria-label="Loading the team hub settings" />
      ) : error && !status ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Could not read the team hub settings</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : status ? (
        <>
          {status.paused && (
            <Alert className="mb-4 border-orange-500/40 bg-orange-500/5 text-orange-700 dark:text-orange-300">
              <CloudOff />
              <AlertTitle>Uploads are paused</AlertTitle>
              <AlertDescription className="text-orange-700/90 dark:text-orange-300/90">
                {syncReason({ code: status.paused.reason, detail: status.paused.detail }, host)}{" "}
                {status.queue.waiting === 1 ? "1 run is waiting" : `${status.queue.waiting} runs are waiting`} and will upload once this is fixed.
              </AlertDescription>
            </Alert>
          )}
          <Card className="gap-4 p-4">
            <form className="space-y-4" onSubmit={(e) => void save(e)} noValidate>
              <Field id="hub-url" label="Hub address" hint="The address you open in the browser to see the hub." error={urlError ? "Use the hub's https:// address." : undefined}>
                <Input
                  id="hub-url"
                  type="url"
                  placeholder="https://qa.example.com"
                  autoComplete="off"
                  spellCheck={false}
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  aria-describedby="hub-url-hint"
                  aria-invalid={urlError !== null}
                />
              </Field>
              <Field
                id="hub-token"
                label="Upload token"
                hint={
                  tokenLocked
                    ? "Remove the environment variable to manage the token here."
                    : "Ask your hub admin to run tapocalypse hub token create <machine-name>. The token's name becomes this machine's name on the hub."
                }
                error={tokenError ?? undefined}
              >
                <Input
                  id="hub-token"
                  type="password"
                  autoComplete="off"
                  className="font-mono"
                  disabled={tokenLocked}
                  value={tokenLocked ? "Set by TAPOCALYPSE_HUB_TOKEN" : token}
                  placeholder={status.credentials.tokenHint ? `Saved, ends in ${status.credentials.tokenHint}. Paste a new one to replace it` : "tpu_…"}
                  onChange={(e) => setToken(e.target.value)}
                  aria-describedby="hub-token-hint"
                />
              </Field>

              <Collapsible open={headersOpen} onOpenChange={setHeadersOpen} className="rounded-lg border p-3">
                <CollapsibleTrigger className="group flex w-full items-center gap-2 text-left text-sm font-medium">
                  <ChevronRight className="size-4 transition-transform group-data-[state=open]:rotate-90" aria-hidden />
                  Extra request headers (optional)
                  <span className="ml-auto text-xs font-normal text-muted-foreground">
                    {headersLocked ? "Set by environment variables" : savedHeaders > 0 ? `${savedHeaders} saved` : "Not set"}
                  </span>
                </CollapsibleTrigger>
                <CollapsibleContent className="mt-3 space-y-3">
                  {headersLocked ? (
                    <p className="text-xs text-muted-foreground">Set by TAPOCALYPSE_HUB_HEADERS. Remove the environment variable to manage the headers here.</p>
                  ) : (
                    <>
                      {rows.map((row) => (
                        <div key={row.id} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto] items-center gap-2">
                          <Input
                            aria-label="Header name"
                            className="font-mono"
                            placeholder="Header name"
                            autoComplete="off"
                            spellCheck={false}
                            value={row.name}
                            disabled={row.saved}
                            onChange={(e) => patchRow(row.id, { name: e.target.value })}
                          />
                          <Input
                            aria-label={`Value of ${row.name || "the header"}`}
                            type="password"
                            className="font-mono"
                            autoComplete="off"
                            placeholder={row.saved ? "Saved. Paste a new value to replace it" : "Value"}
                            value={row.value}
                            onChange={(e) => patchRow(row.id, { value: e.target.value })}
                          />
                          <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove header ${row.name || ""}`} onClick={() => { setTouched(true); setRows((rs) => rs.filter((r) => r.id !== row.id)); }}>
                            <Trash2 />
                          </Button>
                        </div>
                      ))}
                      <Button type="button" variant="outline" size="xs" onClick={() => { setTouched(true); setRows((rs) => [...rs, { id: nextId.current++, name: "", value: "", saved: false }]); }}>
                        <Plus />
                        Add header
                      </Button>
                    </>
                  )}
                  <p className="text-xs text-muted-foreground">
                    For an access proxy that lets machines through with a static header (for example a service token). Not needed when the proxy lets /api/hub/v1/ through, or on a VPN. Values are never shown again.
                  </p>
                </CollapsibleContent>
              </Collapsible>

              <div className="flex items-start gap-3">
                <Checkbox
                  id="hub-original"
                  className="mt-0.5"
                  checked={original}
                  onCheckedChange={(v) => {
                    setOriginal(v === true);
                  }}
                  aria-describedby="hub-original-hint"
                />
                <div className="space-y-0.5">
                  <Label htmlFor="hub-original">Upload original screenshots</Label>
                  <p id="hub-original-hint" className="text-xs text-muted-foreground">
                    By default screenshots are converted to WebP before upload (about ten times smaller). Original PNGs are pixel-exact but much larger.
                  </p>
                </div>
              </div>

              <p className="flex items-start gap-2 text-xs text-muted-foreground">
                <FileKey className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                <span>
                  Secrets are saved to <span className="break-all font-mono">{status.credentials.file}</span>, readable only by you, and never shown again. Environment variables take precedence.
                </span>
              </p>

              {saveError && (
                <Alert variant="destructive">
                  <AlertCircle />
                  <AlertTitle>Could not save: {saveError}</AlertTitle>
                </Alert>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <Button type="submit" disabled={!canSave}>
                  {saving ? <Loader2 className="animate-spin" /> : <Plug />}
                  {saving ? "Saving…" : "Save and test"}
                </Button>
                {status.configured && (
                  <Button type="button" variant="outline" disabled={testing} onClick={() => void test()}>
                    <RefreshCw className={cn(testing && "animate-spin")} />
                    Test again
                  </Button>
                )}
                {status.configured && (
                  <Button type="button" variant="ghost" className="ml-auto text-destructive" onClick={() => setConfirmDisconnect(true)}>
                    Disconnect…
                  </Button>
                )}
              </div>
            </form>
          </Card>

          {status.configured && (
            <div className="mt-4">
              <TestResult status={status} now={now} />
            </div>
          )}
          {status.configured && <Queue status={status} now={now} />}

          <div className="mt-4 space-y-2 text-sm text-muted-foreground">
            <p>Prefer the terminal?</p>
            <CodeBlock code={`tapocalypse hub login ${status.url ?? "https://qa.example.com"}`} prompt />
            <p>tapocalypse hub status shows the same queue.</p>
          </div>

          <Dialog open={confirmDisconnect} onOpenChange={setConfirmDisconnect}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Disconnect from the team hub?</DialogTitle>
                <DialogDescription>Uploads stop and the saved token is deleted from this machine. Runs already on the hub stay there.</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={() => setConfirmDisconnect(false)}>
                  Keep connected
                </Button>
                <Button variant="destructive" onClick={() => void disconnect()}>
                  Disconnect
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      ) : null}
    </section>
  );
}
