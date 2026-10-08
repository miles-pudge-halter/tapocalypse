import { Bell, BellOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import notificationIcon from "../logo-192.png";
import { SidebarMenuButton } from "@/components/ui/sidebar";
import { ACTIVE_STATUSES, type RunStatus, type RunView, runHash } from "@/lib/api";
import { listenEvent, navigate, useActiveRuns, useNotifications } from "@/lib/hooks";

const APP_TITLE = "Tapocalypse";
/** A terminal event for a run we never saw active only counts when it ended this recently (fast cancel/error). */
const UNSEEN_TERMINAL_WINDOW_MS = 15_000;
const TOAST_MS = 8000;

function outcomeLabel(run: RunView): string {
  return run.status === "done" && run.verdict ? run.verdict : run.status.toUpperCase();
}

function showToast(run: RunView): void {
  const label = `${outcomeLabel(run)} · ${run.title}`;
  const options = { action: { label: "View run", onClick: () => navigate(runHash(run.id)) }, duration: TOAST_MS };
  if (run.status === "done" && (run.verdict === "PASS")) toast.success(label, options);
  else if (run.status === "done" && run.verdict === "PASS WITH ISSUES") toast.warning(label, options);
  else if (run.status === "cancelled" || run.status === "interrupted") toast.info(label, options);
  else toast.error(label, options);
}

function showDesktopNotification(run: RunView): void {
  const body = run.summary ?? run.error ?? undefined;
  const n = new Notification(`${outcomeLabel(run)} · ${run.title}`, { body, tag: run.id, icon: notificationIcon });
  n.onclick = () => {
    window.focus();
    navigate(runHash(run.id));
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
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const known = useRef(new Map<string, RunStatus>());
  const [unseen, setUnseen] = useState(0);
  const { runs: active } = useActiveRuns();

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
    document.title = unseen > 0 ? `(${unseen}) ${APP_TITLE}` : APP_TITLE;
    return () => {
      document.title = APP_TITLE;
    };
  }, [unseen]);

  return null;
}

/** Sidebar footer toggle for desktop notifications. */
export function NotificationsToggle() {
  const { enabled, permission, setEnabled } = useNotifications();
  const Icon = enabled ? Bell : BellOff;
  return (
    <SidebarMenuButton
      tooltip={enabled ? "Desktop notifications on" : "Notify me when runs finish"}
      disabled={permission === "unsupported"}
      onClick={() => void setEnabled(!enabled)}
    >
      <Icon />
      <span>{enabled ? "Notifications on" : "Notifications off"}</span>
    </SidebarMenuButton>
  );
}
