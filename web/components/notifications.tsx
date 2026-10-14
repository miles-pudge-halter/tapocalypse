import { Bell, BellOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import notificationIcon from "../logo-192.png";
import { SidebarMenuButton } from "@/components/ui/sidebar";
import { ACTIVE_STATUSES, type RunStatus, type RunView, runHash } from "@/lib/api";
import { alertCoalesce, attribution, syncReason, uploadAlert } from "@/lib/hub";
import { isHub } from "@/lib/mode";
import {
  isWatched,
  lastOwnRelease,
  listenEvent,
  listenLeaseEvent,
  navigate,
  useActiveRuns,
  useHubStatus,
  useLeases,
  useNewRun,
  useNotifications,
  useWatchedDevices,
} from "@/lib/hooks";
import { leaseToast } from "@/lib/leases";

/** Read lazily: the mode is only known once the boot gate has passed. */
const appTitle = () => (isHub() ? "Team hub · Tapocalypse" : "Tapocalypse");
/** A terminal event for a run we never saw active only counts when it ended this recently (fast cancel/error). */
const UNSEEN_TERMINAL_WINDOW_MS = 15_000;
const TOAST_MS = 8000;

function outcomeLabel(run: RunView): string {
  return run.status === "done" && run.verdict ? run.verdict : run.status.toUpperCase();
}

/** "2 newly failing vs main": set only when the finished run regressed against its baseline. */
function regressionLine(run: RunView): string | null {
  const reg = run.regression;
  if (!reg || reg.newlyFailing <= 0) return null;
  return `${reg.newlyFailing} newly failing vs ${reg.baselineBranch ?? "the baseline"}`;
}

function showToast(run: RunView): void {
  const label = `${outcomeLabel(run)} · ${run.title}`;
  const description = regressionLine(run) ?? undefined;
  const options = { action: { label: "View run", onClick: () => navigate(runHash(run.id)) }, duration: TOAST_MS, description };
  if (run.status === "done" && (run.verdict === "PASS")) toast.success(label, options);
  else if (run.status === "done" && run.verdict === "PASS WITH ISSUES") toast.warning(label, options);
  else if (run.status === "cancelled" || run.status === "interrupted") toast.info(label, options);
  else toast.error(label, options);
}

function showDesktopNotification(run: RunView): void {
  const body = [regressionLine(run), run.summary ?? run.error].filter(Boolean).join("\n") || undefined;
  const n = new Notification(`${outcomeLabel(run)} · ${run.title}`, { body, tag: run.id, icon: notificationIcon });
  n.onclick = () => {
    window.focus();
    navigate(runHash(run.id));
    n.close();
  };
}

/** One failing or regressed upload: a toast (and a desktop notification while the tab is hidden). */
function showUploadAlert(run: RunView, alert: NonNullable<ReturnType<typeof uploadAlert>>, desktop: boolean): void {
  const options = { description: alert.description, duration: TOAST_MS, action: { label: "Open", onClick: () => navigate(runHash(run.id)) } };
  if (alert.severity === "warning") toast.warning(alert.title, options);
  else toast.error(alert.title, options);
  if (desktop) {
    const n = new Notification(alert.title, { body: alert.description, tag: run.id, icon: notificationIcon });
    n.onclick = () => {
      window.focus();
      navigate(runHash(run.id));
      n.close();
    };
  }
}

function showLeaseNotification(serial: string, title: string, body: string): void {
  const n = new Notification(title, { body, tag: `lease:${serial}`, icon: notificationIcon });
  n.onclick = () => {
    window.focus();
    navigate("#/devices");
    n.close();
  };
}

/**
 * Headless watcher mounted once in the app shell: toast on every run reaching a terminal status, a desktop
 * notification when enabled and the tab is hidden, and a `(n) Tapocalypse` title badge for runs that finished
 * while the tab was hidden.
 */
export function Notifications() {
  const { enabled } = useNotifications();
  const { unwatch } = useWatchedDevices();
  const { openNewRun } = useNewRun();
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const known = useRef(new Map<string, RunStatus>());
  const alerts = useRef<number[]>([]);
  const [unseen, setUnseen] = useState(0);
  const { runs: active } = useActiveRuns();
  // Keeps the last known lease per device fresh: the ending events themselves carry none.
  useLeases();

  // Seed from the active list so a run that was already in flight when the page loaded is recognised as "was active".
  useEffect(() => {
    for (const r of active) known.current.set(r.id, r.status);
  }, [active]);

  useEffect(
    () =>
      listenEvent("run", (e) => {
        let run: RunView;
        try {
          run = JSON.parse((e as MessageEvent<string>).data) as RunView;
        } catch {
          return;
        }
        if (isHub()) {
          const alert = uploadAlert(run, Date.now());
          if (!alert) return;
          const next = alertCoalesce(alerts.current, Date.now());
          alerts.current = next.history;
          const desktop = document.hidden && enabledRef.current;
          if (document.hidden) setUnseen((n) => n + 1);
          if (next.collapse) {
            // A burst (a teammate's backfill that went wrong, a whole batch failing) is one toast, not a wall of them.
            toast.dismiss();
            toast.error(`${next.history.length} new failing runs`, {
              description: `${run.hub ? attribution(run.hub).short : "A teammate"} and others`,
              duration: TOAST_MS,
              action: { label: "Show", onClick: () => navigate("#/runs?verdict=FAIL,BLOCKED") },
            });
          } else {
            showUploadAlert(run, alert, desktop);
          }
          return;
        }
        const prev = known.current.get(run.id);
        known.current.set(run.id, run.status);
        if (ACTIVE_STATUSES.includes(run.status)) return;
        const wasActive = prev
          ? ACTIVE_STATUSES.includes(prev)
          : run.endedAt !== null && Date.now() - Date.parse(run.endedAt) < UNSEEN_TERMINAL_WINDOW_MS;
        if (!wasActive) return;
        showToast(run);
        if (document.hidden) {
          setUnseen((n) => n + 1);
          if (enabledRef.current) showDesktopNotification(run);
        }
      }),
    [],
  );

  // A laptop whose upload queue is paused says so once per page load; backfills announce their end.
  const { status: hubStatus } = useHubStatus();
  const pausedToasted = useRef(false);
  const backfillTotal = useRef<number | null>(null);
  useEffect(() => {
    const paused = hubStatus?.paused;
    if (paused && !pausedToasted.current) {
      pausedToasted.current = true;
      toast.warning("Team hub uploads paused", {
        description: syncReason({ code: paused.reason, detail: paused.detail }, null),
        duration: TOAST_MS,
        action: { label: "Fix", onClick: () => navigate("#/setup?section=team-hub") },
      });
    }
    if (!paused) pausedToasted.current = false;
    const backfill = hubStatus?.queue.backfill ?? null;
    if (backfill) backfillTotal.current = backfill.total;
    else if (hubStatus && backfillTotal.current !== null) {
      toast.success(`Uploaded ${backfillTotal.current} runs to the team hub`);
      backfillTotal.current = null;
    }
  }, [hubStatus]);

  // Devices the user watches (bell on a held card): a toast when one frees up, plus a desktop notification while the tab is hidden.
  useEffect(
    () =>
      listenLeaseEvent((event, ended) => {
        const lease = leaseToast(event, { watching: isWatched(event.serial), ownRelease: lastOwnRelease(), lease: ended });
        if (!lease) return;
        if (lease.unwatch) unwatch(event.serial);
        const target = lease.action?.to;
        const action =
          lease.action && target
            ? {
                label: lease.action.label,
                onClick: () => {
                  if (target.type === "run") navigate(runHash(target.runId));
                  else openNewRun({ device: { platform: target.platform, serial: target.serial } });
                },
              }
            : undefined;
        toast[lease.kind](lease.title, { description: lease.description, duration: TOAST_MS, ...(action && { action }) });
        if (document.hidden && enabledRef.current) showLeaseNotification(event.serial, lease.title, lease.description);
      }),
    [unwatch, openNewRun],
  );

  useEffect(() => {
    const clear = () => {
      if (!document.hidden) setUnseen(0);
    };
    document.addEventListener("visibilitychange", clear);
    window.addEventListener("focus", clear);
    return () => {
      document.removeEventListener("visibilitychange", clear);
      window.removeEventListener("focus", clear);
    };
  }, []);

  useEffect(() => {
    document.title = unseen > 0 ? `(${unseen}) ${appTitle()}` : appTitle();
    return () => {
      document.title = appTitle();
    };
  }, [unseen]);

  return null;
}

/** Sidebar footer toggle for desktop notifications. */
export function NotificationsToggle() {
  const { enabled, permission, setEnabled } = useNotifications();
  const Icon = enabled ? Bell : BellOff;
  const hub = isHub();
  return (
    <SidebarMenuButton
      tooltip={
        hub
          ? enabled
            ? "Desktop alerts for new failing uploads"
            : "Alert me when a teammate uploads a failing run"
          : enabled
            ? "Desktop notifications on"
            : "Notify me when runs finish"
      }
      disabled={permission === "unsupported"}
      onClick={() => void setEnabled(!enabled)}
    >
      <Icon />
      <span>{hub ? (enabled ? "Failure alerts on" : "Failure alerts off") : enabled ? "Notifications on" : "Notifications off"}</span>
    </SidebarMenuButton>
  );
}
