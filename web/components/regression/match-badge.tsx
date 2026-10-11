import { useMemo, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { api, type ComparePair, type RunComparison } from "@/lib/api";
import { DISMISSED_KEY, addDismissed, linkTarget, readDismissed, suggestionKey } from "@/lib/regression";
import { readStorage, writeStorage } from "@/lib/storage";

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface LinkActions {
  busy: boolean;
  /** Confirm an inferred match, or link a suggestion; persisted on the server. */
  link(pair: ComparePair): Promise<void>;
  /** Split an inferred match into two checks of their own; persisted on the server. */
  unlink(pair: ComparePair): Promise<void>;
  /** "Not the same" on a suggestion: hides it on both rows. Kept in this browser (localStorage), never written to a run. */
  dismiss(pair: ComparePair): void;
  /** Link two arbitrary checks (link mode). */
  linkChecks(a: { runId: string; checkId: string }, b: { runId: string; checkId: string }): Promise<void>;
  /** `suggestionKey`s the user dismissed in this project. */
  dismissed: ReadonlySet<string>;
}

/** Link / unlink calls for a comparison's rows, with toast feedback and a refetch afterwards. */
export function useLinkActions(comparison: RunComparison | null, refresh: () => void): LinkActions {
  const [busy, setBusy] = useState(false);
  const projectId = comparison?.current.projectId ?? "";
  const [stored, setStored] = useState(() => readStorage(DISMISSED_KEY));
  const dismissed = useMemo(() => readDismissed(stored, projectId), [stored, projectId]);

  async function run(action: () => Promise<void>, success: string) {
    setBusy(true);
    try {
      await action();
      toast.success(success);
      refresh();
    } catch (err) {
      toast.error(message(err));
    } finally {
      setBusy(false);
    }
  }

  async function link(pair: ComparePair) {
    const target = linkTarget(pair);
    if (!comparison || !target) return;
    await run(
      () => api.linkChecks(projectId, target.a, target.b),
      `Linked ${target.a.checkId} and ${target.b.checkId}. Future comparisons and history use this link.`,
    );
  }

  async function unlink(pair: ComparePair) {
    const target = linkTarget(pair);
    if (!comparison || !target) return;
    await run(() => api.unlinkChecks(projectId, target.a, target.b), `Unlinked ${target.a.checkId} and ${target.b.checkId}.`);
  }

  function dismiss(pair: ComparePair) {
    const key = suggestionKey(pair);
    if (!key) return;
    const next = addDismissed(readStorage(DISMISSED_KEY), projectId, key);
    writeStorage(DISMISSED_KEY, next);
    setStored(next);
  }

  async function linkChecks(a: { runId: string; checkId: string }, b: { runId: string; checkId: string }) {
    await run(() => api.linkChecks(projectId, a, b), `Linked ${a.checkId} and ${b.checkId}. Future comparisons and history use this link.`);
  }

  return { busy, link, unlink, dismiss, linkChecks, dismissed };
}

/** `≈ likely match` on fuzzy-title pairs only; exact matches show nothing. Hover for the evidence plus Confirm / Unlink. */
export function MatchBadge({ pair, actions }: { pair: ComparePair; actions: LinkActions }) {
  if (pair.confidence !== "inferred") return null;
  return (
    <HoverCard openDelay={200}>
      <HoverCardTrigger asChild>
        <Badge variant="outline" tabIndex={0} className="h-4 shrink-0 border-dashed px-1 text-[10px] text-muted-foreground">
          ≈ likely match
        </Badge>
      </HoverCardTrigger>
      <HoverCardContent className="w-80 space-y-2 text-sm">
        <p className="font-medium">Matched by similar title</p>
        <p className="break-words text-xs text-muted-foreground">Baseline: “{pair.baseline?.title ?? "—"}”</p>
        <p className="break-words text-xs text-muted-foreground">This run: “{pair.current?.title ?? "—"}”</p>
        <div className="flex gap-2">
          <Button size="xs" disabled={actions.busy} onClick={() => void actions.link(pair)}>
            Confirm
          </Button>
          <Button size="xs" variant="ghost" disabled={actions.busy} onClick={() => void actions.unlink(pair)}>
            Unlink
          </Button>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}
