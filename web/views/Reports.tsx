import { AlertCircle, ArrowLeft, FileText, Search } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { ProjectPicker, ReportsTabs, reportsHref } from "@/components/reports-nav";
import { ReadingProgress } from "@/components/report/reading-progress";
import { ReportArticle } from "@/components/report/report-article";
import { ReportGroups, matchesVerdict, type VerdictFilter } from "@/components/report/report-groups";
import { ReportFileCard, ReportRunCard } from "@/components/report/report-meta";
import { ReportToc } from "@/components/report/report-toc";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TooltipProvider } from "@/components/ui/tooltip";
import { VerdictBadge } from "@/components/verdict-badge";
import { formatTime } from "@/lib/format";
import { useNow, useProjectScope, useProjects, useReport, useReports, useRunSummary } from "@/lib/hooks";
import { isActive } from "@/lib/api";
import { ShareButton } from "@/components/run/share-button";

function ErrorAlert({ message }: { message: string }) {
  return (
    <Alert variant="destructive">
      <AlertCircle />
      <AlertTitle>Something went wrong</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

/** Route project, else the sidebar project scope, else the first registered project. */
export function useReportsProject(routeProjectId: string | null | undefined) {
  const { projects, loading, error } = useProjects();
  const { projectId: scopeProjectId } = useProjectScope();
  const projectId = routeProjectId || scopeProjectId || projects[0]?.id || null;
  return { projects, projectId, loading, error };
}

function ReportListBody({ projectId }: { projectId: string }) {
  const { reports, loading, error } = useReports(projectId);
  const now = useNow(30_000);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<VerdictFilter>("all");

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return reports.filter(
      (r) =>
        matchesVerdict(r, filter) &&
        (q === "" ||
          r.title.toLowerCase().includes(q) ||
          r.name.toLowerCase().includes(q) ||
          (r.runId?.toLowerCase().includes(q) ?? false)),
    );
  }, [reports, query, filter]);

  return (
    <TooltipProvider>
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by title, file or run id…"
            aria-label="Search reports"
            className="pl-8"
          />
        </div>
        <Tabs value={filter} onValueChange={(v) => setFilter(v as VerdictFilter)}>
          <TabsList>
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="pass">PASS</TabsTrigger>
            <TabsTrigger value="fail">FAIL</TabsTrigger>
            <TabsTrigger value="issues">Issues</TabsTrigger>
            <TabsTrigger value="other">Other</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {error ? (
        <ErrorAlert message={error} />
      ) : loading ? (
        <Card className="p-4">
          <div className="space-y-3">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        </Card>
      ) : visible.length === 0 ? (
        <EmptyState
          icon={FileText}
          title={reports.length === 0 ? "No reports yet" : "No matching reports"}
          description={
            reports.length === 0
              ? "Reports written by QA runs will appear here."
              : "Try a different search or verdict filter."
          }
        />
      ) : (
        <ReportGroups reports={visible} projectId={projectId} now={now} />
      )}
    </TooltipProvider>
  );
}

export function ReportList({ projectId: routeProjectId }: { projectId?: string | null }) {
  const { projects, projectId, loading, error } = useReportsProject(routeProjectId);
  const projectName = projects.find((p) => p.id === projectId)?.name ?? projectId;

  const picker = <ProjectPicker projects={projects} projectId={projectId} hrefFor={reportsHref} />;

  return (
    <div>
      <PageHeader title="Reports" description={projectName ?? undefined} actions={picker} />
      <ReportsTabs projectId={projectId} value="reports" />
      {error ? (
        <ErrorAlert message={error} />
      ) : loading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : projectId ? (
        <ReportListBody key={projectId} projectId={projectId} />
      ) : (
        <EmptyState
          icon={FileText}
          title="No projects yet"
          description="Add a project to see the QA reports its runs write."
          action={
            <a href="#/projects?new=1" className="text-sm font-medium underline-offset-4 hover:underline">
              Add a project
            </a>
          }
        />
      )}
    </div>
  );
}

/** Share menu for the run behind a report: a skeleton while the run loads, absent when it is gone (nothing left to render). */
function ReportShare({ runId }: { runId: string }) {
  const { run, loading } = useRunSummary(runId, true);
  if (loading) return <Skeleton className="h-8 w-24" />;
  return run ? <ShareButton runId={run.id} disabled={isActive(run.status)} align="start" reportPath={run.reportPath} hubSync={run.hubSync} /> : null;
}

function ReportViewBody({ projectId, name }: { projectId: string; name: string }) {
  const { report, loading, error } = useReport(projectId, name);
  const { reports } = useReports(projectId);
  const articleRef = useRef<HTMLElement | null>(null);

  const entry = reports.find((r) => r.name === name);
  const filePath = entry?.path ?? null;
  const documentKey = `${projectId}/${name}`;

  return (
    <>
      {error ? (
        <ErrorAlert message={error} />
      ) : loading || !report ? (
        <div className="space-y-4">
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : (
        <>
          <ReadingProgress anchor={articleRef} resetKey={documentKey} />
          <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
            <div className="min-w-0 space-y-2">
              <h1 className="text-2xl font-semibold tracking-tight">{report.title || report.name}</h1>
              <div className="flex flex-wrap items-center gap-3">
                <VerdictBadge verdict={report.verdict} />
                <span className="font-mono text-xs text-muted-foreground">{report.name}</span>
                {entry ? <span className="text-xs text-muted-foreground">Modified {formatTime(entry.mtime)}</span> : null}
              </div>
            </div>
            {report.runId ? <ReportShare runId={report.runId} /> : null}
          </div>
          <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_20rem]">
            <div className="min-w-0">
              <ReportArticle html={report.html} title={report.title || report.name} articleRef={articleRef} />
            </div>
            <aside className="space-y-4 xl:sticky xl:top-6 xl:max-h-[calc(100vh-3rem)] xl:self-start xl:overflow-y-auto">
              {report.runId ? <ReportRunCard runId={report.runId} /> : null}
              <ReportFileCard name={report.name} path={filePath} imageCount={report.images.length} />
              <ReportToc
                headings={report.headings}
                articleRef={articleRef}
                resetKey={documentKey}
                className="hidden px-1 xl:block"
              />
            </aside>
          </div>
        </>
      )}
    </>
  );
}

export function ReportView({ projectId: routeProjectId, name }: { projectId?: string | null; name: string }) {
  const { projectId, loading, error } = useReportsProject(routeProjectId);

  return (
    <div className="space-y-6">
      <a
        href={projectId ? reportsHref(projectId) : "#/runs"}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Reports
      </a>
      {error ? (
        <ErrorAlert message={error} />
      ) : loading ? (
        <Skeleton className="h-64 w-full" />
      ) : projectId ? (
        <ReportViewBody key={`${projectId}/${name}`} projectId={projectId} name={name} />
      ) : (
        <EmptyState icon={FileText} title="No project selected" description="Add a project to read its QA reports." />
      )}
    </div>
  );
}
