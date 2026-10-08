import { useMemo, useState, type MouseEvent } from "react";
import { AlertCircle, ArrowLeft, FileText, Search } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { VerdictBadge } from "@/components/verdict-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { ReportEntry } from "@/lib/api";
import { formatRelative, formatTime } from "@/lib/format";
import { useNow, useProjects, useReport, useReports } from "@/lib/hooks";

type VerdictFilter = "all" | "pass" | "fail" | "issues" | "other";

function matchesVerdict(report: ReportEntry, filter: VerdictFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "pass":
      return report.verdict === "PASS";
    case "fail":
      return report.verdict === "FAIL";
    case "issues":
      return report.verdict === "PASS WITH ISSUES";
    case "other":
      return report.verdict !== "PASS" && report.verdict !== "FAIL" && report.verdict !== "PASS WITH ISSUES";
  }
}

function ErrorAlert({ message }: { message: string }) {
  return (
    <Alert variant="destructive">
      <AlertCircle />
      <AlertTitle>Something went wrong</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

export function ReportList({ projectId }: { projectId: string }) {
  const { projects } = useProjects();
  const { reports, loading, error } = useReports(projectId);
  const now = useNow(30_000);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<VerdictFilter>("all");

  const projectName = projects.find((p) => p.id === projectId)?.name ?? projectId;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return reports.filter(
      (r) => matchesVerdict(r, filter) && (q === "" || r.title.toLowerCase().includes(q) || r.name.toLowerCase().includes(q)),
    );
  }, [reports, query, filter]);

  const description = loading
    ? projectName
    : `${projectName} · ${reports.length} ${reports.length === 1 ? "report" : "reports"}`;

  return (
    <div className="space-y-6">
      <PageHeader title="Reports" description={description} />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search reports…"
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
        <Card className="py-0">
          <TooltipProvider>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Report</TableHead>
                  <TableHead>Verdict</TableHead>
                  <TableHead className="text-right">Modified</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((r) => (
                  <TableRow key={r.name}>
                    <TableCell className="whitespace-normal">
                      <a
                        href={`#/p/${encodeURIComponent(projectId)}/reports/${encodeURIComponent(r.name)}`}
                        className="font-medium hover:underline"
                      >
                        {r.title || r.name}
                      </a>
                      <div className="font-mono text-xs text-muted-foreground">{r.name}</div>
                    </TableCell>
                    <TableCell>
                      <VerdictBadge verdict={r.verdict} />
                    </TableCell>
                    <TableCell className="text-right text-sm tabular-nums text-muted-foreground">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span>{formatRelative(r.mtime, now)}</span>
                        </TooltipTrigger>
                        <TooltipContent>{formatTime(r.mtime)}</TooltipContent>
                      </Tooltip>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TooltipProvider>
        </Card>
      )}
    </div>
  );
}

export function ReportView({ projectId, name }: { projectId: string; name: string }) {
  const { report, loading, error } = useReport(projectId, name);
  const [zoom, setZoom] = useState<{ src: string; alt: string } | null>(null);

  const listHref = `#/p/${encodeURIComponent(projectId)}/reports`;

  // Event delegation: the article content is server-rendered HTML, so images carry no React handlers.
  const onArticleClick = (e: MouseEvent<HTMLElement>) => {
    const target = e.target;
    if (!(target instanceof HTMLImageElement)) return;
    e.preventDefault();
    setZoom({ src: target.currentSrc || target.src, alt: target.alt });
  };

  return (
    <div className="space-y-6">
      <a
        href={listHref}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Reports
      </a>

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
          <div className="space-y-2">
            <h1 className="text-2xl font-semibold tracking-tight">{report.title || report.name}</h1>
            <div className="flex flex-wrap items-center gap-3">
              <VerdictBadge verdict={report.verdict} />
              <span className="font-mono text-xs text-muted-foreground">{report.name}</span>
            </div>
          </div>
          <Card className="p-6">
            {/* Server-rendered markdown from the project's own report files; paths are rewritten server-side. */}
            <article
              onClick={onArticleClick}
              className="prose prose-zinc dark:prose-invert max-w-none [&_table]:block [&_table]:overflow-x-auto [&_img]:max-h-[420px] [&_img]:w-auto [&_img]:max-w-full [&_img]:cursor-zoom-in [&_img]:rounded-md [&_img]:border"
              dangerouslySetInnerHTML={{ __html: report.html }}
            />
          </Card>
        </>
      )}

      <Dialog open={zoom !== null} onOpenChange={(open) => !open && setZoom(null)}>
        <DialogContent className="max-h-[95vh] w-fit max-w-[95vw] overflow-auto p-2 sm:max-w-[95vw]">
          <DialogTitle className="sr-only">{zoom?.alt || "Report image"}</DialogTitle>
          <DialogDescription className="sr-only">Full-size report image</DialogDescription>
          {zoom && <img src={zoom.src} alt={zoom.alt} className="mx-auto max-h-[88vh] w-auto max-w-full rounded-md" />}
        </DialogContent>
      </Dialog>
    </div>
  );
}
