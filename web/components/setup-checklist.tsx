import { AlertTriangle, CheckCircle2, ChevronDown, MinusCircle, RefreshCw, X, XCircle, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { DoctorCheck } from "@/lib/api";
import { useDoctor } from "@/lib/hooks";
import { cn } from "@/lib/utils";

const STATUS: Record<DoctorCheck["status"], { icon: LucideIcon; className: string }> = {
  ok: { icon: CheckCircle2, className: "text-emerald-500" },
  warn: { icon: AlertTriangle, className: "text-amber-500" },
  error: { icon: XCircle, className: "text-red-500" },
  skip: { icon: MinusCircle, className: "text-muted-foreground" },
};

const DISMISS_KEY = "tapocalypse.setupDismissed";

function CheckRow({ check }: { check: DoctorCheck }) {
  const { icon: Icon, className } = STATUS[check.status];
  return (
    <li className="flex gap-3 py-2">
      <Icon aria-label={check.status} className={cn("mt-0.5 size-4 shrink-0", className)} />
      <div className="min-w-0 space-y-1">
        <p className="text-sm font-medium">
          {check.label}
          {!check.required && <span className="ml-2 text-xs font-normal text-muted-foreground">optional</span>}
        </p>
        <p className="break-words text-sm text-muted-foreground">{check.detail}</p>
        {check.fix && check.status !== "ok" && check.status !== "skip" && (
          <p className="break-words rounded bg-muted px-2 py-1 font-mono text-xs">{check.fix}</p>
        )}
      </div>
    </li>
  );
}

/**
 * Prerequisite checklist from `/api/doctor`. `dismissible` renders the Dashboard banner form:
 * only the items needing attention, collapsible, hidden for the rest of the browser session once dismissed.
 */
export function SetupChecklist({ dismissible = false }: { dismissible?: boolean }) {
  const { report, loading, error, recheck, blocked } = useDoctor();
  const [dismissed, setDismissed] = useState(() => dismissible && sessionStorage.getItem(DISMISS_KEY) === "1");
  const [open, setOpen] = useState(true);
  if (dismissed) return null;

  const problemChecks = report?.checks.filter((c) => c.status === "error" || c.status === "warn") ?? [];
  const problems = problemChecks.length;
  const title = dismissible ? (blocked ? "Finish setup" : "Setup") : "Setup";
  const summary = !report
    ? error ?? "Checking prerequisites…"
    : problems === 0
      ? "Everything Tapocalypse needs is in place."
      : `${problems} item${problems === 1 ? " needs" : "s need"} attention.`;

  const list = report ? (
    <ul className="divide-y">
      {(dismissible ? problemChecks : report.checks).map((c) => (
        <CheckRow key={c.id} check={c} />
      ))}
    </ul>
  ) : (
    error && <p className="text-sm text-red-500">{error}</p>
  );

  return (
    <Collapsible open={dismissible ? open : true} onOpenChange={setOpen}>
      <Card className={cn("gap-4 py-4", dismissible && blocked && "border-red-500/40")}>
        <CardHeader className="px-4">
          <CardTitle>{title}</CardTitle>
          <CardDescription>{summary}</CardDescription>
          <CardAction className="flex items-center gap-1">
            <Button variant="outline" size="sm" onClick={recheck} disabled={loading}>
              <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
              Re-check
            </Button>
            {dismissible && (
              <>
                <CollapsibleTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label={open ? "Collapse setup" : "Expand setup"}>
                    <ChevronDown className={cn("size-4 transition-transform", !open && "-rotate-90")} />
                  </Button>
                </CollapsibleTrigger>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Dismiss setup"
                  onClick={() => {
                    sessionStorage.setItem(DISMISS_KEY, "1");
                    setDismissed(true);
                  }}
                >
                  <X className="size-4" />
                </Button>
              </>
            )}
          </CardAction>
        </CardHeader>
        <CollapsibleContent>
          <CardContent className="px-4">{list}</CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}
