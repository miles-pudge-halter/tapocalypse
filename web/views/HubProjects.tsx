import { AlertCircle, FolderKanban } from "lucide-react";

import { CopyButton } from "@/components/copy-button";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { RelativeTime } from "@/components/run-row";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { overviewHash, type ProjectView } from "@/lib/api";
import { formatRelative, PLATFORM_ICON, PLATFORM_LABEL } from "@/lib/format";
import { useNow, useProjects } from "@/lib/hooks";
import { briefAttribution } from "@/lib/hub";

function Machines({ project }: { project: ProjectView }) {
  const machines = project.hub?.machines ?? [];
  if (machines.length === 0) return <span className="text-muted-foreground">—</span>;
  const shown = machines.slice(0, 2).map((m) => m.name);
  const rest = machines.length - shown.length;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="font-mono text-xs">
          {shown.join(", ")}
          {rest > 0 ? ` +${rest}` : ""}
        </span>
      </TooltipTrigger>
      <TooltipContent>{machines.map((m) => m.name).join(", ")}</TooltipContent>
    </Tooltip>
  );
}

function LastUpload({ project, now }: { project: ProjectView; now: number }) {
  const at = project.hub?.lastUploadAt;
  if (!at) return <span className="text-muted-foreground">—</span>;
  const by = project.hub?.lastUploadBy ? briefAttribution(project.hub.lastUploadBy.machine, project.hub.lastUploadBy.uploader) : null;
  return (
    <span>
      <RelativeTime iso={at} now={now} />
      {by && (
        <span className="ml-1.5 text-xs text-muted-foreground" title={by.title}>
          {by.text}
        </span>
      )}
    </span>
  );
}

/** The hub's project list: read-only; projects appear when a teammate uploads their first run. */
export function HubProjects() {
  const { projects, loading, error } = useProjects();
  const now = useNow(30_000);
  const header = (
    <PageHeader title="Projects" description="Projects appear when a teammate uploads their first run. Names and keys come from the uploading machine." />
  );
  if (loading && projects.length === 0) {
    return (
      <div>
        {header}
        <Skeleton className="h-40" aria-label="Loading projects" />
      </div>
    );
  }
  if (error && projects.length === 0) {
    return (
      <div>
        {header}
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Could not load projects</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      </div>
    );
  }
  if (projects.length === 0) {
    return (
      <div>
        {header}
        <EmptyState
          icon={FolderKanban}
          title="No projects shared yet"
          description="Runs show up here once a teammate connects their Tapocalypse to this hub and turns on “Share with team hub” for a project."
          action={
            <Button asChild variant="outline">
              <a href="#/about">How to connect a machine</a>
            </Button>
          }
        />
      </div>
    );
  }
  return (
    <div>
      {header}
      <Card className="hidden gap-0 overflow-hidden p-0 md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Project</TableHead>
              <TableHead>Default branch</TableHead>
              <TableHead>Platform</TableHead>
              <TableHead className="text-right">Runs</TableHead>
              <TableHead>Machines</TableHead>
              <TableHead>Last upload</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {projects.map((p) => {
              const Icon = PLATFORM_ICON[p.defaultPlatform];
              return (
                <TableRow key={p.id} className="relative hover:bg-muted/40">
                  <TableCell className="max-w-72">
                    <a href={overviewHash(p.id)} className="font-medium after:absolute after:inset-0 hover:underline focus-visible:outline-none">
                      {p.name}
                    </a>
                    {p.hub?.hubKey && (
                      <span className="flex items-center gap-1">
                        <span className="truncate font-mono text-xs text-muted-foreground" title={p.hub.hubKey}>
                          {p.hub.hubKey}
                        </span>
                        <span className="relative z-10">
                          <CopyButton value={p.hub.hubKey} label={undefined} />
                        </span>
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{p.defaultBranch ?? "—"}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className="gap-1">
                      <Icon />
                      {PLATFORM_LABEL[p.defaultPlatform]}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{p.hub?.runs ?? "—"}</TableCell>
                  <TableCell>
                    <Machines project={p} />
                  </TableCell>
                  <TableCell>
                    <LastUpload project={p} now={now} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Button asChild variant="ghost" size="sm" className="relative z-10">
                      <a href={overviewHash(p.id)}>Overview</a>
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Card>
      <ul className="space-y-3 md:hidden">
        {projects.map((p) => (
          <li key={p.id}>
            <Card className="relative gap-1 p-4">
              <a href={overviewHash(p.id)} className="font-medium after:absolute after:inset-0">
                {p.name}
              </a>
              {p.hub?.hubKey && <p className="truncate font-mono text-xs text-muted-foreground">{p.hub.hubKey}</p>}
              <p className="text-xs text-muted-foreground">
                {p.hub?.runs ?? 0} runs · {p.hub?.machines.length ?? 0} machines
                {p.hub?.lastUploadAt ? ` · last upload ${formatRelative(p.hub.lastUploadAt, now)}` : ""}
              </p>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}
