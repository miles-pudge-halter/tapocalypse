import { flakyHash } from "@/lib/api";
import { navigate } from "@/lib/hooks";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export function reportsHref(projectId: string): string {
  return `#/p/${encodeURIComponent(projectId)}/reports`;
}

/** Project switcher in the header of the project-scoped pages (Reports, Flaky checks); hidden with a single project. */
export function ProjectPicker({
  projects,
  projectId,
  hrefFor,
}: {
  projects: { id: string; name: string }[];
  projectId: string | null;
  hrefFor(projectId: string): string;
}) {
  if (projects.length <= 1 || !projectId) return null;
  return (
    <Select value={projectId} onValueChange={(id) => navigate(hrefFor(id))}>
      <SelectTrigger className="w-48" aria-label="Project">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {projects.map((p) => (
          <SelectItem key={p.id} value={p.id}>
            {p.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** "Reports · Flaky checks" switch under the page header of both pages. */
export function ReportsTabs({ projectId, value }: { projectId: string | null; value: "reports" | "flaky" }) {
  if (!projectId) return null;
  return (
    <Tabs value={value} onValueChange={(v) => navigate(v === "flaky" ? flakyHash(projectId) : reportsHref(projectId))} className="mb-4">
      <TabsList>
        <TabsTrigger value="reports">Reports</TabsTrigger>
        <TabsTrigger value="flaky">Flaky checks</TabsTrigger>
      </TabsList>
    </Tabs>
  );
}
