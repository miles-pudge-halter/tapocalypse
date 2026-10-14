import { useState } from "react";
import { toast } from "sonner";
import { api, runHash, type Check, type RunView } from "@/lib/api";
import { navigate, useNewRun, type NewRunPrefill } from "@/lib/hooks";

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Checks a "re-run failed" would repeat: everything that did not pass or get skipped on purpose. */
export function failedChecks(checks: readonly Check[]): Check[] {
  return checks.filter((c) => c.status !== "pass" && c.status !== "skipped");
}

/** "Re-run with changes…": the New run sheet seeded from `run`, offering to reuse its checks (not for suite runs: their ids come from the suite). */
export function rerunWithChangesPrefill(run: RunView): NewRunPrefill {
  return {
    projectId: run.projectId,
    title: run.title,
    brief: run.brief,
    device: run.deviceRequest,
    packageId: run.packageId,
    harness: run.harness,
    model: run.model ?? undefined,
    effort: run.effort ?? run.thinking ?? undefined,
    ...(run.suiteId ? { suiteId: run.suiteId } : { reuseChecksFrom: run.id }),
  };
}

export interface RunActions {
  busy: boolean;
  rerun(only: "failed" | "all"): Promise<void>;
  rerunWithChanges(): void;
  cancel(): Promise<boolean>;
  remove(): Promise<boolean>;
}

/** Re-run / cancel / delete with toast feedback; a successful re-run navigates to the new run. */
export function useRunActions(run: RunView): RunActions {
  const [busy, setBusy] = useState(false);
  const { openNewRun } = useNewRun();

  async function rerun(only: "failed" | "all") {
    setBusy(true);
    try {
      const next = await api.rerun(run.id, only);
      toast.success(only === "failed" ? "Re-running the checks that did not pass" : "Re-run queued");
      navigate(runHash(next.id));
    } catch (err) {
      toast.error(`Re-run failed: ${message(err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    setBusy(true);
    try {
      await api.cancel(run.id);
      toast.success("Cancel requested");
      return true;
    } catch (err) {
      toast.error(`Cancel failed: ${message(err)}`);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await api.deleteRun(run.id);
      toast.success("Run deleted");
      navigate("#/runs");
      return true;
    } catch (err) {
      toast.error(`Delete failed: ${message(err)}`);
      return false;
    } finally {
      setBusy(false);
    }
  }

  return { busy, rerun, rerunWithChanges: () => openNewRun(rerunWithChangesPrefill(run)), cancel, remove };
}
