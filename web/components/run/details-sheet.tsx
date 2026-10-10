import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { CodeBlock } from "@/components/code-block";
import { CopyButton } from "@/components/copy-button";
import { runHash, type Device, type RunView } from "@/lib/api";
import { deviceDisplayName, formatTime } from "@/lib/format";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-baseline gap-3 text-sm">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

function RunLink({ id }: { id: string }) {
  return (
    <a href={runHash(id)} className="font-mono text-xs underline underline-offset-2 hover:decoration-primary hover:decoration-2">
      {id}
    </a>
  );
}

/** Everything the header strip leaves out: ids, paths, labels, the brief and the raw session stats. */
export function DetailsSheet({
  run,
  device,
  projectName,
  harnessLabel,
  open,
  onOpenChange,
}: {
  run: RunView;
  device: Device | null;
  projectName: string;
  /** Display name of the run's agent CLI (undefined while the harness list loads). */
  harnessLabel: string | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const labels = Object.entries(run.source?.labels ?? {});
  const model = run.usage?.model ?? run.model;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 sm:max-w-xl">
        <SheetHeader className="border-b">
          <SheetTitle className="pr-8 break-words">{run.title}</SheetTitle>
          <SheetDescription>Run details</SheetDescription>
        </SheetHeader>
        <div className="flex-1 space-y-6 overflow-y-auto p-4">
          <dl className="space-y-3">
            <Field label="Run id">
              <span className="flex items-center gap-1">
                <span className="min-w-0 break-all font-mono text-xs">{run.id}</span>
                <CopyButton value={run.id} label="Copy run id" />
              </span>
            </Field>
            {run.storage === "data" ? (
              <Field label="Artefacts">
                <span className="flex items-center gap-1">
                  <span className="min-w-0 break-all font-mono text-xs">{run.runDir}</span>
                  <CopyButton value={run.runDir} label="Copy artefact folder" />
                </span>
              </Field>
            ) : null}
            {run.reportFile ? (
              <Field label="Report file">
                <span className="flex items-center gap-1">
                  <span className="min-w-0 break-all font-mono text-xs">{run.reportFile}</span>
                  <CopyButton value={run.reportFile} label="Copy report path" />
                </span>
              </Field>
            ) : null}
            <Field label="Project">{projectName}</Field>
            <Field label="Package">
              <span className="font-mono text-xs">{run.packageId}</span>
            </Field>
            <Field label="Device">
              {run.deviceSerial ? (
                <>
                  {run.deviceName ?? (device ? `${deviceDisplayName(device)} · ` : null)}
                  {run.deviceName ? " · " : null}
                  <span className="font-mono text-xs">{run.deviceSerial}</span>
                </>
              ) : (
                "—"
              )}
            </Field>
            <Field label="Agent runtime">{harnessLabel ?? run.harness}</Field>
            <Field label="Model">
              {model ?? "—"}
              {run.effort ?? run.thinking ? (
                <span className="text-muted-foreground"> · {run.harness === "omp" ? "thinking" : "effort"} {run.effort ?? run.thinking}</span>
              ) : null}
            </Field>
            <Field label="Requested by">{run.requestedBy}</Field>
            <Field label="Created">{formatTime(run.createdAt)}</Field>
            <Field label="Started">{formatTime(run.startedAt)}</Field>
            <Field label="Ended">{formatTime(run.endedAt)}</Field>
            {run.attempt > 1 || run.retryOf || run.retriedBy ? (
              <Field label="Attempt">
                <span>{run.attempt}</span>
                {run.retryOf ? (
                  <span className="ml-2 text-muted-foreground">
                    retry of <RunLink id={run.retryOf} />
                  </span>
                ) : null}
                {run.retriedBy ? (
                  <span className="ml-2 text-muted-foreground">
                    retried as <RunLink id={run.retriedBy} />
                  </span>
                ) : null}
              </Field>
            ) : null}
            {run.rerunOf ? (
              <Field label="Re-run of">
                <RunLink id={run.rerunOf} />
              </Field>
            ) : null}
            {run.batchId ? (
              <Field label="Batch">
                <a href={`#/batches/${encodeURIComponent(run.batchId)}`} className="font-mono text-xs underline underline-offset-2">
                  {run.batchId}
                </a>
              </Field>
            ) : null}
            {run.suiteId ? (
              <Field label="Suite">
                <span className="font-mono text-xs">{run.suiteId}</span>
              </Field>
            ) : null}
            {run.install ? (
              <Field label="Installed from">
                <span className="break-all font-mono text-xs">{run.install.path}</span>
              </Field>
            ) : null}
            {run.source ? (
              <Field label="Worktree">
                <span className="flex items-center gap-1">
                  <span className="min-w-0 break-all font-mono text-xs">{run.source.path}</span>
                  <CopyButton value={run.source.path} label="Copy worktree path" />
                </span>
              </Field>
            ) : null}
            {labels.length > 0 ? (
              <Field label="Labels">
                <span className="flex flex-wrap gap-1.5">
                  {labels.map(([key, value]) => (
                    <Badge key={key} variant="outline">
                      {key}: {value}
                    </Badge>
                  ))}
                </span>
              </Field>
            ) : null}
          </dl>

          <section className="space-y-2">
            <h3 className="text-sm font-semibold">Brief</h3>
            <div className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-3 text-sm">
              {run.brief}
            </div>
          </section>

          {run.stats !== null && run.stats !== undefined ? (
            <section className="space-y-2">
              <h3 className="text-sm font-semibold">Raw session stats</h3>
              <CodeBlock code={JSON.stringify(run.stats, null, 2)} className="[&_pre]:max-h-96" />
            </section>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
