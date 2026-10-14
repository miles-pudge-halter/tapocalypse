import { ExternalLink, FileDown, FileText, Layers, Search, Smartphone } from "lucide-react";
import { useRef, useState } from "react";

import { UploadedByBrief } from "@/components/hub/uploaded-by";
import { VerdictBadge } from "@/components/verdict-badge";
import { VerdictCell } from "@/components/hub/verdict-cell";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { compareHash, reportHash, reportHtmlUrl, type ReleaseCell, type ReleaseView, runHash, type RunBrief } from "@/lib/api";
import { formatRelative, PLATFORM_ICON, PLATFORM_LABEL } from "@/lib/format";
import { useNow, useShortcut } from "@/lib/hooks";
import { matrixRows, PLATFORM_ORDER } from "@/lib/hub";
import { cn } from "@/lib/utils";

type Test = ReleaseView["tests"][number];

function AttemptLinks({ projectId, run }: { projectId: string; run: RunBrief }) {
  return (
    <span className="ml-auto flex gap-0.5">
      <Button asChild variant="ghost" size="xs">
        <a href={runHash(run.id)}>
          <ExternalLink />
          Run
        </a>
      </Button>
      {run.reportPath && (
        <>
          <Button asChild variant="ghost" size="xs">
            <a href={reportHash(projectId, { id: run.id, storage: "data", reportPath: run.reportPath })}>
              <FileText />
              Report
            </a>
          </Button>
          <Button asChild variant="ghost" size="xs">
            <a href={reportHtmlUrl(run.id, { download: true })} download>
              <FileDown />
              HTML
            </a>
          </Button>
        </>
      )}
    </span>
  );
}

/** Every attempt of one test on one device (or platform) in this release, newest first. */
function AttemptsPopover({
  projectId,
  test,
  cell,
  device,
  showDevice,
  children,
}: {
  projectId: string;
  test: Test;
  cell: ReleaseCell;
  device: string;
  showDevice: boolean;
  children: React.ReactNode;
}) {
  const now = useNow(30_000);
  const [latest, previous] = cell.attempts;
  const canCompare = latest && previous && latest.verdict !== null && previous.verdict !== null;
  return (
    <Popover>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-80 p-0">
        <div className="border-b px-3 py-2">
          <p className="line-clamp-2 text-sm font-medium">{test.title}</p>
          <p className="text-xs text-muted-foreground">
            {device} · {cell.attempts.length} {cell.attempts.length === 1 ? "run" : "runs"} in this release
          </p>
        </div>
        <ul className="max-h-72 divide-y overflow-y-auto">
          {cell.attempts.map((a, i) => (
            <li key={a.id} className="space-y-1 px-3 py-2">
              <div className="flex items-center gap-2">
                <VerdictBadge verdict={a.verdict} className="h-5 px-1.5 text-[10px]" />
                {!a.verdict && <span className="text-xs text-muted-foreground">No verdict</span>}
                <span className="text-xs text-muted-foreground">{formatRelative(a.endedAt ?? a.createdAt, now)}</span>
                <UploadedByBrief machine={a.machine} uploader={a.uploader} className="ml-auto truncate text-xs text-muted-foreground" />
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="min-w-0 truncate">
                  {[showDevice ? a.deviceName : null, a.branch ?? a.versionName].filter(Boolean).join(" · ")}
                  {a.commit && <span className="font-mono"> {a.commit.slice(0, 7)}</span>}
                </span>
                {i === 0 && <span className="rounded-md border px-1 text-[10px]">latest</span>}
              </div>
              <div className="flex">
                <AttemptLinks projectId={projectId} run={a} />
              </div>
            </li>
          ))}
        </ul>
        {canCompare && (
          <div className="border-t px-3 py-2">
            <Button asChild variant="link" size="xs" className="h-auto p-0">
              <a href={compareHash(latest.id, previous.id)}>Compare latest with previous attempt</a>
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** Tests × devices (or platforms) with rounds folded into one cell; the first column and the header stay put while scrolling. */
export function ReleaseMatrix({
  view,
  group,
  onGroupChange,
}: {
  view: ReleaseView;
  group: "device" | "platform";
  onGroupChange(group: "device" | "platform"): void;
}) {
  const now = useNow(30_000);
  const [q, setQ] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useShortcut("/", () => input.current?.focus());
  const columns =
    group === "device"
      ? view.devices.map((d) => ({ key: d.key, name: d.name, platform: d.platform }))
      : PLATFORM_ORDER.filter((p) => view.devices.some((d) => d.platform === p)).map((p) => ({ key: p, name: PLATFORM_LABEL[p], platform: p }));
  const rows = matrixRows(view.tests, q, group);
  const cellOf = (t: Test, key: string): ReleaseCell | null => (group === "device" ? (t.cells[key] ?? null) : (t.platforms[key as "android" | "ios"] ?? null));
  const aria = (t: Test, name: string, c: ReleaseCell) =>
    `${t.title} on ${name}: ${c.latest.verdict ?? "no verdict"}${c.attempts.length > 1 ? `, ${c.attempts.length} runs` : ""}, latest ${formatRelative(c.latest.endedAt ?? c.latest.createdAt, now)}`;
  return (
    <Card className="gap-0 overflow-hidden p-0" id="matrix">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <h2 className="text-sm font-medium">{group === "platform" ? "Tests × platforms" : "Tests × devices"}</h2>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter tests…" aria-label="Filter tests" className="h-8 w-56 pl-7" />
        </div>
        {view.devices.length > 1 && (
          <ToggleGroup type="single" variant="outline" size="sm" value={group} onValueChange={(v) => v && onGroupChange(v as "device" | "platform")} aria-label="Group columns by">
            <ToggleGroupItem value="device">
              <Smartphone /> Devices
            </ToggleGroupItem>
            <ToggleGroupItem value="platform">
              <Layers /> Platforms
            </ToggleGroupItem>
          </ToggleGroup>
        )}
      </div>
      {rows.length === 0 ? (
        <div className="flex items-center justify-center gap-2 px-3 py-6 text-sm text-muted-foreground">
          No tests match.
          <Button variant="link" size="xs" onClick={() => setQ("")}>
            Clear filter
          </Button>
        </div>
      ) : (
        <>
          <div className="relative hidden md:block">
            <div className="max-h-[70vh] overflow-auto">
              <table className="w-full caption-bottom border-separate border-spacing-0 text-sm">
                <thead>
                  <tr>
                    <th scope="col" className="sticky left-0 top-0 z-30 min-w-56 border-b bg-muted px-3 py-2 text-left text-xs font-medium">
                      Test
                    </th>
                    {columns.map((c) => {
                      const Icon = PLATFORM_ICON[c.platform];
                      return (
                        <th key={c.key} scope="col" className="sticky top-0 z-20 min-w-28 border-b bg-muted/90 px-2 py-2 text-left text-xs font-medium backdrop-blur">
                          <span className="inline-flex max-w-32 items-center gap-1.5 truncate" title={c.name}>
                            <Icon className="size-3.5 shrink-0" aria-hidden />
                            <span className="truncate">{c.name}</span>
                          </span>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((t) => (
                    <tr key={t.testKey} className="hover:bg-muted/30">
                      <th scope="row" className="sticky left-0 z-10 min-w-56 max-w-80 border-b bg-card px-3 py-2 text-left font-normal">
                        <div className="line-clamp-2 font-medium" title={t.title}>
                          {t.title}
                        </div>
                      </th>
                      {columns.map((c) => {
                        const cell = cellOf(t, c.key);
                        return (
                          <td key={c.key} className="border-b px-2 py-1.5">
                            {cell ? (
                              <AttemptsPopover projectId={view.project.id} test={t} cell={cell} device={c.name} showDevice={group === "platform"}>
                                <VerdictCell as="button" verdict={cell.latest.verdict} attempts={cell.attempts.length} size="md" aria-label={aria(t, c.name, cell)} />
                              </AttemptsPopover>
                            ) : (
                              <span className="text-xs text-muted-foreground" aria-label={`Not run on ${c.name}`}>
                                —
                              </span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {columns.length > 8 && <div aria-hidden className="pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-card" />}
          </div>
          <ul className="divide-y md:hidden">
            {rows.map((t) => (
              <li key={t.testKey} className="space-y-2 px-3 py-3">
                <div className="line-clamp-2 text-sm font-medium">{t.title}</div>
                <div className="flex flex-wrap gap-1.5">
                  {columns.map((c) => {
                    const cell = cellOf(t, c.key);
                    return cell ? (
                      <AttemptsPopover key={c.key} projectId={view.project.id} test={t} cell={cell} device={c.name} showDevice={group === "platform"}>
                        <VerdictCell as="button" verdict={cell.latest.verdict} attempts={cell.attempts.length} size="sm" label={c.name} aria-label={aria(t, c.name, cell)} />
                      </AttemptsPopover>
                    ) : (
                      <span key={c.key} className={cn("inline-flex h-5 items-center rounded-md border border-dashed px-1.5 text-[11px] text-muted-foreground")} aria-label={`Not run on ${c.name}`}>
                        {c.name} · —
                      </span>
                    );
                  })}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}
