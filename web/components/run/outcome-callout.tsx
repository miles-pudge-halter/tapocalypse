import { useState } from "react";
import {
  AlertOctagon,
  AlertTriangle,
  Ban,
  CheckCircle2,
  ChevronRight,
  ExternalLink,
  Loader2,
  Octagon,
  Power,
  RotateCcw,
  XCircle,
  type LucideIcon,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { CodeBlock } from "@/components/code-block";
import { api, isActive, runHash, transcriptUrl, type RunView, type Verdict } from "@/lib/api";
import { cn } from "@/lib/utils";
import { failedChecks, type RunActions } from "./use-run-actions";

const STDERR_LINES = 20;
const SUMMARY_CLAMP_CHARS = 280;

const VERDICT_STYLE: Record<Verdict, { icon: LucideIcon; className: string }> = {
  PASS: { icon: CheckCircle2, className: "border-emerald-500/40 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300" },
  "PASS WITH ISSUES": { icon: AlertTriangle, className: "border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-300" },
  FAIL: { icon: XCircle, className: "border-red-500/40 bg-red-500/5 text-red-700 dark:text-red-300" },
  BLOCKED: { icon: Octagon, className: "border-rose-700/50 bg-rose-700/5 text-rose-800 dark:text-rose-300" },
  PARTIAL: { icon: AlertTriangle, className: "border-amber-500/40 bg-transparent text-amber-700 dark:text-amber-300" },
};

interface Problem {
  icon: LucideIcon;
  className: string;
  title: string;
  explanation: string;
  showStderr: boolean;
}

function describeProblem(run: RunView, resolved: number): Problem | null {
  const noChecks = resolved === 0;
  if (run.status === "interrupted") {
    return {
      icon: Power,
      className: "border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-300",
      title: "Tapocalypse restarted while this run was active",
      explanation: "The agent session was lost with it, so nothing more will be recorded for this run.",
      showStderr: true,
    };
  }
  // Runs recorded before errorKind existed: recover the kind from the legacy message.
  const legacy = run.error && /without qa_finish/.test(run.error) ? "agent" : null;
  const kind = run.errorKind ?? (run.status === "cancelled" ? "cancelled" : legacy);
  switch (kind) {
    case "cancelled":
      return {
        icon: Ban,
        className: "border-zinc-500/40 bg-zinc-500/5 text-zinc-700 dark:text-zinc-300",
        title: "Run cancelled",
        explanation: "The run was stopped before it finished. Checks already resolved are kept below.",
        showStderr: false,
      };
    case "infra":
      return {
        icon: AlertOctagon,
        className: "border-red-500/40 bg-red-500/5 text-red-700 dark:text-red-300",
        title: "Infrastructure problem",
        explanation: noChecks
          ? "Tapocalypse could not get the device or the agent ready, so your app was never tested."
          : "The agent session broke partway through. Checks resolved before the break are kept below.",
        showStderr: true,
      };
    case "timeout":
      return {
        icon: AlertOctagon,
        className: "border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-300",
        title: "The run hit its time budget",
        explanation: "The agent was still testing when time ran out, so the report may be missing or incomplete.",
        showStderr: true,
      };
    case "agent":
      return {
        icon: AlertOctagon,
        className: "border-red-500/40 bg-red-500/5 text-red-700 dark:text-red-300",
        title: "The agent stopped before reporting a verdict",
        explanation: noChecks
          ? "It ended without declaring or resolving any check."
          : `It resolved ${resolved} check${resolved === 1 ? "" : "s"} but never wrote the final report.`,
        showStderr: true,
      };
    case null:
      return run.status === "error"
        ? {
            icon: AlertOctagon,
            className: "border-red-500/40 bg-red-500/5 text-red-700 dark:text-red-300",
            title: "The run failed",
            explanation: "Tapocalypse recorded an error for this run.",
            showStderr: true,
          }
        : null;
  }
}

function StderrTail({ runId }: { runId: string }) {
  const [state, setState] = useState<{ status: "idle" | "loading" | "ready" | "error"; text: string }>({
    status: "idle",
    text: "",
  });

  function onOpenChange(open: boolean) {
    if (!open || state.status !== "idle") return;
    setState({ status: "loading", text: "" });
    api.stderr(runId, 200).then(
      (text) => setState({ status: "ready", text: text.trimEnd().split("\n").slice(-STDERR_LINES).join("\n") }),
      (err: unknown) => setState({ status: "error", text: err instanceof Error ? err.message : String(err) }),
    );
  }

  return (
    <Collapsible onOpenChange={onOpenChange} className="group/stderr">
      <CollapsibleTrigger asChild>
        <Button variant="ghost" size="xs" className="-ml-1.5 text-muted-foreground">
          <ChevronRight className="transition-transform group-data-[state=open]/stderr:rotate-90" />
          stderr (last {STDERR_LINES} lines)
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1.5">
        {state.status === "loading" ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" /> Loading stderr…
          </p>
        ) : state.status === "error" ? (
          <p className="text-xs text-muted-foreground">No stderr was recorded for this run ({state.text}).</p>
        ) : state.text.length === 0 ? (
          <p className="text-xs text-muted-foreground">stderr is empty.</p>
        ) : (
          <CodeBlock code={state.text} className="text-foreground [&_pre]:max-h-64" />
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

function VerdictCallout({ run }: { run: RunView }) {
  const [expanded, setExpanded] = useState(false);
  if (!run.verdict) return null;
  const style = VERDICT_STYLE[run.verdict];
  const Icon = style.icon;
  const total = run.checks.length;
  const notPassed = failedChecks(run.checks).length;
  const detail =
    total === 0
      ? null
      : notPassed === 0
        ? `all ${total} check${total === 1 ? "" : "s"} passed`
        : `${notPassed} of ${total} check${total === 1 ? "" : "s"} did not pass`;
  const summary = run.summary?.trim() ?? "";
  const long = summary.length > SUMMARY_CLAMP_CHARS || summary.split("\n").length > 4;

  return (
    <Alert className={style.className}>
      <Icon />
      <AlertTitle className="font-semibold">
        {run.verdict}
        {detail ? <span className="font-normal"> · {detail}</span> : null}
        {run.verdictSource === "derived" ? <span className="font-normal opacity-80"> · derived from the checks</span> : null}
      </AlertTitle>
      {summary ? (
        <AlertDescription className="text-foreground/90">
          <p className={cn("whitespace-pre-wrap break-words", long && !expanded && "line-clamp-3")}>{summary}</p>
          {long ? (
            <Button variant="link" size="xs" className="h-auto p-0 text-xs" onClick={() => setExpanded((v) => !v)}>
              {expanded ? "Show less" : "Show more"}
            </Button>
          ) : null}
        </AlertDescription>
      ) : null}
    </Alert>
  );
}

/**
 * What happened, once the run is over: the verdict (with the agent's summary) and, when something went wrong,
 * a plain-language explanation of the cause with the stderr tail and the next step.
 */
export function OutcomeCallout({ run, actions }: { run: RunView; actions: RunActions }) {
  if (isActive(run.status)) return null;
  const resolved = run.checks.filter((c) => c.status !== "pending" && c.status !== "running").length;
  const problem = describeProblem(run, resolved);
  const canRerunFailed = resolved > 0 && failedChecks(run.checks).length > 0;

  return (
    <div className="space-y-2">
      <VerdictCallout run={run} />
      {problem ? (
        <Alert className={problem.className}>
          <problem.icon />
          <AlertTitle className="font-semibold">{problem.title}</AlertTitle>
          <AlertDescription className="space-y-2 text-foreground/90">
            <p>{problem.explanation}</p>
            {run.error ? (
              <p className="break-words rounded-md border bg-background/60 px-2 py-1 font-mono text-xs">{run.error}</p>
            ) : null}
            {run.retriedBy ? (
              <p className="text-xs">
                Retried automatically as{" "}
                <a href={runHash(run.retriedBy)} className="font-mono underline underline-offset-2">
                  {run.retriedBy}
                </a>
                .
              </p>
            ) : null}
            {problem.showStderr ? <StderrTail runId={run.id} /> : null}
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button size="sm" variant="outline" disabled={actions.busy} onClick={() => void actions.rerun("all")}>
                {actions.busy ? <Loader2 className="animate-spin" /> : <RotateCcw />}
                Retry
              </Button>
              {canRerunFailed ? (
                <Button size="sm" variant="outline" disabled={actions.busy} onClick={() => void actions.rerun("failed")}>
                  Re-run failed
                </Button>
              ) : null}
              {run.transcriptHtml ? (
                <Button asChild size="sm" variant="ghost">
                  <a href={transcriptUrl(run.id)} target="_blank" rel="noopener noreferrer">
                    <ExternalLink />
                    Transcript
                  </a>
                </Button>
              ) : null}
            </div>
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
