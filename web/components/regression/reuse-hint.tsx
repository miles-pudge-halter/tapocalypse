import { ListChecks, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { api, type RunView } from "@/lib/api";
import { formatRelative } from "@/lib/format";
import { useNow } from "@/lib/hooks";

export type ReuseSeed = { state: "none" } | { state: "loading" } | { state: "failed" } | { state: "ready"; run: RunView };

/** The run whose checks a new run may reuse: found in `known` (the recent list) or fetched once. */
export function useReuseSeed(runId: string | null, known: readonly RunView[]): ReuseSeed {
  const hit = runId ? known.find((r) => r.id === runId) : undefined;
  const [fetched, setFetched] = useState<{ id: string; run: RunView | null } | null>(null);
  useEffect(() => {
    if (!runId || hit || fetched?.id === runId) return;
    let cancelled = false;
    api.run(runId).then(
      (run) => !cancelled && setFetched({ id: runId, run }),
      () => !cancelled && setFetched({ id: runId, run: null }),
    );
    return () => {
      cancelled = true;
    };
  }, [runId, hit, fetched?.id]);
  if (!runId) return { state: "none" };
  if (hit) return { state: "ready", run: hit };
  if (fetched?.id !== runId) return { state: "loading" };
  return fetched.run ? { state: "ready", run: fetched.run } : { state: "failed" };
}

/**
 * Under the Brief: tells the user that the new run keeps the check titles of the run it was seeded from, so results
 * line up with that run's history, and lets them opt out. Renders nothing without a seed or when the seed has no checks.
 */
export function ReuseHint({
  seed,
  suiteTitle,
  briefEdited,
  reuse,
  onReuseChange,
}: {
  seed: ReuseSeed;
  /** Title of the active suite: its check ids already pin the identity. */
  suiteTitle: string | null;
  briefEdited: boolean;
  reuse: boolean;
  onReuseChange(reuse: boolean): void;
}) {
  const now = useNow(60_000);
  const shell = "flex items-start gap-2 text-xs text-muted-foreground";
  const icon = <ListChecks className="mt-0.5 size-3.5 shrink-0" aria-hidden />;

  if (suiteTitle) {
    return (
      <p className={shell}>
        {icon}
        <span>Check ids come from the suite “{suiteTitle}”, so history stays linked.</span>
      </p>
    );
  }
  if (seed.state === "none") return null;
  if (seed.state === "loading") {
    return (
      <p className={shell} role="status">
        <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin" aria-hidden />
        <span>Loading previous checks…</span>
      </p>
    );
  }
  if (seed.state === "failed") {
    return (
      <p className={shell}>
        {icon}
        <span>Could not load the previous checks; the agent will write a fresh plan.</span>
      </p>
    );
  }
  const { run } = seed;
  const count = run.checks.length;
  if (count === 0) return null;
  const toggle = (label: string, next: boolean) => (
    <Button type="button" variant="link" size="xs" className="h-auto shrink-0 p-0" onClick={() => onReuseChange(next)}>
      {label}
    </Button>
  );
  if (!reuse) {
    return (
      <p className={shell}>
        {icon}
        <span>The agent will write a fresh test plan. History only links checks whose titles match.</span>
        {toggle("Reuse previous checks", true)}
      </p>
    );
  }
  return (
    <p className={shell}>
      {icon}
      <span>
        <span className="font-medium text-foreground">Previous checks will be reused.</span>{" "}
        {briefEdited
          ? `The agent keeps the ${count} titles from “${run.title}” and adds or drops checks to fit your edits.`
          : `The agent gets the ${count} check titles from “${run.title}” (${formatRelative(run.createdAt, now)}) so results line up with that run's history.`}
      </span>
      {toggle("Don't reuse", false)}
    </p>
  );
}
