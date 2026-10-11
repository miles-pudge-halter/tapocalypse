import { AlertCircle, FileText, Search, Snowflake } from "lucide-react";
import { useMemo, useState } from "react";

import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { StatusStrip } from "@/components/regression/status-strip";
import { FLAKY_TEXT, SUSPECT_CHIP, TransitionChip } from "@/components/regression/transition";
import { ProjectPicker, ReportsTabs } from "@/components/reports-nav";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { flakyHash, type FlakyCheck, type KeyKind, type Platform } from "@/lib/api";
import { formatRelative } from "@/lib/format";
import { useCheckHistorySheet, useFlakyChecks, useNow } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { useReportsProject } from "@/views/Reports";

type PlatformFilter = "all" | Platform;
type ConfidenceFilter = "flaky" | "suspect" | "both";

const KEY_KIND_WORD: Record<KeyKind, string> = {
  suite: "suite id",
  lineage: "re-run lineage",
  carried: "same test",
  title: "title",
  inferred: "similar title",
  manual: "linked",
};

/** Confirmed flaky checks first, then suspects; within a group by flips, then the most recent flip. */
function bySeverity(a: FlakyCheck, b: FlakyCheck): number {
  return b.flips - a.flips || Date.parse(b.lastFlipAt) - Date.parse(a.lastFlipAt);
}

function ConfidenceChip({ check }: { check: FlakyCheck }) {
  return check.confidence === "flaky" ? (
    <TransitionChip transition="flaky">flaky</TransitionChip>
  ) : (
    <span className={cn("inline-flex items-center gap-1 rounded-md border px-1.5 text-xs font-medium leading-5", SUSPECT_CHIP)}>
      <Snowflake className="size-3" aria-hidden />
      suspect
    </span>
  );
}

function FlakyTable({ checks, now, onOpen }: { checks: FlakyCheck[]; now: number; onOpen(check: FlakyCheck): void }) {
  return (
    <>
      <div className="hidden md:block">
        {/* Fixed layout with set widths so the Flaky and Suspect tables line up column for column. */}
        <Table className="table-fixed">
          <TableHeader>
            <TableRow>
              <TableHead>Check</TableHead>
              <TableHead className="w-44">Recent</TableHead>
              <TableHead className="w-52">Flips</TableHead>
              <TableHead className="w-24">Pass rate</TableHead>
              <TableHead className="w-40">Last flip</TableHead>
              <TableHead className="w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {checks.map((c) => (
              <TableRow key={c.checkKey} className="cursor-pointer" onClick={() => onOpen(c)}>
                <TableCell className="whitespace-normal">
                  <span className="line-clamp-2 break-words text-sm">{c.title}</span>
                  <span className="block text-xs text-muted-foreground">{KEY_KIND_WORD[c.keyKind]}</span>
                </TableCell>
                <TableCell>
                  <StatusStrip statuses={c.recent} size="sm" />
                </TableCell>
                <TableCell>
                  <span className="flex flex-wrap items-center gap-2">
                    <ConfidenceChip check={c} />
                    <span className={cn("text-xs tabular-nums", FLAKY_TEXT)}>
                      {c.flips} in last {c.window}
                    </span>
                  </span>
                </TableCell>
                <TableCell className="tabular-nums">{c.passRate === null ? "—" : `${Math.round(c.passRate * 100)}%`}</TableCell>
                <TableCell className="whitespace-normal">
                  <span className="block text-sm">{formatRelative(c.lastFlipAt, now)}</span>
                  {c.lastFlipBranch ? <span className="block text-xs text-muted-foreground">{c.lastFlipBranch}</span> : null}
                </TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpen(c);
                    }}
                  >
                    History
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <ul className="divide-y md:hidden">
        {checks.map((c) => (
          <li key={c.checkKey}>
            <button type="button" onClick={() => onOpen(c)} className="w-full space-y-1.5 px-3 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
              <span className="line-clamp-2 block break-words text-sm">{c.title}</span>
              <span className="flex items-center gap-2">
                <ConfidenceChip check={c} />
                <StatusStrip statuses={c.recent} size="sm" />
              </span>
              <span className="block text-xs text-muted-foreground">
                {c.flips} flips · {c.passRate === null ? "—" : `${Math.round(c.passRate * 100)}%`} pass · {formatRelative(c.lastFlipAt, now)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

function FlakyBody({ projectId }: { projectId: string }) {
  const [platform, setPlatform] = useState<PlatformFilter>("all");
  const [confidence, setConfidence] = useState<ConfidenceFilter>("both");
  const [query, setQuery] = useState("");
  const { data, loading, error } = useFlakyChecks(projectId, platform === "all" ? null : platform);
  const { openHistory } = useCheckHistorySheet();
  const now = useNow(30_000);

  const q = query.trim().toLowerCase();
  const visible = useMemo(
    () => (data?.checks ?? []).filter((c) => (confidence === "both" || c.confidence === confidence) && (q === "" || c.title.toLowerCase().includes(q))),
    [data, confidence, q],
  );
  const flaky = visible.filter((c) => c.confidence === "flaky").sort(bySeverity);
  const suspects = visible.filter((c) => c.confidence === "suspect").sort(bySeverity);

  function open(c: FlakyCheck) {
    openHistory({ projectId, checkKey: c.checkKey, title: c.title });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-8" placeholder="Search checks…" aria-label="Search checks" value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" />
        </div>
        <Tabs value={platform} onValueChange={(v) => setPlatform(v === "android" || v === "ios" ? v : "all")}>
          <TabsList>
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="android">Android</TabsTrigger>
            <TabsTrigger value="ios">iOS</TabsTrigger>
          </TabsList>
        </Tabs>
        <Tabs value={confidence} onValueChange={(v) => setConfidence(v === "flaky" || v === "suspect" ? v : "both")}>
          <TabsList>
            <TabsTrigger value="flaky">Flaky</TabsTrigger>
            <TabsTrigger value="suspect">Suspect</TabsTrigger>
            <TabsTrigger value="both">Both</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      <p className="text-xs text-muted-foreground">
        A check is flaky when it flips between pass and fail at least twice in its last 20 results on the same code and device. One flip makes it a suspect.
        {data ? ` Tracking ${data.trackedKeys} checks; ${data.repeatedKeys} have run more than once.` : ""}
      </p>

      {error ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Could not load flaky checks</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : loading || !data ? (
        <Card className="p-4" aria-busy="true" aria-label="Loading flaky checks">
          <div className="space-y-3">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        </Card>
      ) : data.checks.length === 0 ? (
        <EmptyState
          icon={Snowflake}
          title={data.repeatedKeys === 0 ? "Not enough history yet" : "No flaky checks"}
          description={
            data.repeatedKeys === 0
              ? "No check has run more than once in this project. Re-run a run or save a brief as a suite so the same checks come back."
              : `${data.repeatedKeys} checks have run more than once, and none flipped between pass and fail on the same code and device. Blocked results are not counted: they usually mean the device or network, not the app.`
          }
        />
      ) : visible.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          {q ? `No flaky checks match “${query.trim()}”.` : "No checks in this group."}
        </p>
      ) : (
        <>
          {flaky.length > 0 ? (
            <section aria-label="Flaky" className="space-y-2">
              <h2 className="text-sm font-semibold">
                Flaky <span className="font-normal text-muted-foreground">{flaky.length}</span>
              </h2>
              <Card className="gap-0 overflow-hidden p-0">
                <FlakyTable checks={flaky} now={now} onOpen={open} />
              </Card>
            </section>
          ) : null}
          {suspects.length > 0 ? (
            <section aria-label="Suspect" className="space-y-2">
              <h2 className="text-sm font-semibold">
                Suspect <span className="font-normal text-muted-foreground">{suspects.length}</span>
              </h2>
              <Card className="gap-0 overflow-hidden p-0">
                <FlakyTable checks={suspects} now={now} onOpen={open} />
              </Card>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}

/** Project-level list of checks that flip between pass and fail on the same code and device. */
export function FlakyChecks({ projectId: routeProjectId }: { projectId: string }) {
  const { projects, projectId, loading, error } = useReportsProject(routeProjectId);
  const projectName = projects.find((p) => p.id === projectId)?.name ?? projectId;
  return (
    <div>
      <PageHeader
        title="Flaky checks"
        description={projectName ?? undefined}
        actions={<ProjectPicker projects={projects} projectId={projectId} hrefFor={flakyHash} />}
      />
      <ReportsTabs projectId={projectId} value="flaky" />
      {error ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Something went wrong</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : loading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : projectId ? (
        <FlakyBody key={projectId} projectId={projectId} />
      ) : (
        <EmptyState
          icon={FileText}
          title="No projects yet"
          description="Add a project to see which of its checks are flaky."
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
