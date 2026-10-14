import { AlertCircle, ListChecks, RefreshCw } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { TeamHubSetup } from "@/components/hub/team-hub-setup";
import { ShareDevices } from "@/components/share-devices";
import { DoctorList, SetupChecklist } from "@/components/setup-checklist";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useDoctor } from "@/lib/hooks";
import { cn } from "@/lib/utils";

export function Setup({ section }: { section?: string }) {
  const { report, loading, error, recheck } = useDoctor();
  const problems = report?.checks.filter((c) => c.status === "error" || c.status === "warn").length ?? 0;

  return (
    <div className="max-w-4xl">
      <PageHeader
        title="Setup"
        description="Everything between a fresh install and your first QA run, and how to let your coding agent drive it."
      />

      <SetupChecklist />

      <ShareDevices />

      <TeamHubSetup autoScroll={section === "team-hub"} />

      <section className="mt-10" aria-labelledby="all-checks">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-0.5">
            <h2 id="all-checks" className="flex items-center gap-2 text-lg font-semibold tracking-tight">
              <ListChecks className="size-5 text-muted-foreground" />
              All checks
            </h2>
            <p className="text-sm text-muted-foreground">
              {report
                ? problems === 0
                  ? "Everything Tapocalypse needs is in place."
                  : `${problems} item${problems === 1 ? " needs" : "s need"} attention.`
                : "Looking at this machine…"}
            </p>
          </div>
          <Button variant="outline" size="sm" className="strike" onClick={recheck} disabled={loading}>
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
            Re-check
          </Button>
        </div>

        {error && (
          <Alert variant="destructive" className="mb-4">
            <AlertCircle />
            <AlertTitle>Could not run the checks</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {report ? (
          <DoctorList checks={report.checks} />
        ) : (
          !error && (
            <div className="space-y-3" aria-busy>
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          )
        )}
      </section>
    </div>
  );
}
