import { AlertCircle } from "lucide-react";
import type { ReactNode } from "react";

import { CodeBlock } from "@/components/code-block";
import { CopyButton } from "@/components/copy-button";
import { MachineNotes } from "@/components/hub/machine-notes";
import { PageHeader } from "@/components/page-header";
import { RelativeTime } from "@/components/run-row";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useHubInfo, useHubMachines, useNow } from "@/lib/hooks";
import { displayPerson, machinesSummary } from "@/lib/hub";

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{term}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}

/** What a hub is, how big it is, who uploads to it and how to join: the hub's replacement for Setup. */
export function About() {
  const { info, loading, error } = useHubInfo();
  const machines = useHubMachines();
  const now = useNow(30_000);
  const sorted = machinesSummary(machines.machines, now).sorted;
  return (
    <div>
      <PageHeader
        title="About this hub"
        description="A read-only copy of the QA runs your team uploads. Nothing runs here: runs start on teammates' machines and upload when they finish."
      />
      <div className="max-w-4xl space-y-10">
        <section aria-labelledby="about-hub" className="space-y-3">
          <h2 id="about-hub" className="text-base font-semibold">
            This hub
          </h2>
          {loading ? (
            <div className="space-y-2" aria-label="Loading hub details">
              {Array.from({ length: 6 }, (_, i) => (
                <Skeleton key={i} className="h-5 w-full max-w-md" />
              ))}
            </div>
          ) : error || !info ? (
            <Alert variant="destructive">
              <AlertCircle />
              <AlertTitle>Could not load hub details</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : (
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
              <Fact term="Address">
                <span className="inline-flex items-center gap-1">
                  <span className="font-mono text-xs">{location.origin}</span>
                  <CopyButton value={location.origin} label="Copy address" />
                </span>
              </Fact>
              <Fact term="Version">
                {info.version} · protocol {info.protocol}
              </Fact>
              <Fact term="Runs stored">
                {info.runs.toLocaleString()}
                {info.storeWarning && (
                  <span className="block text-orange-700 dark:text-orange-400">
                    Close to the in-memory limit of about 10,000 runs. Plan the move described in docs/hub.md.
                  </span>
                )}
              </Fact>
              <Fact term="Projects">{info.projects}</Fact>
              <Fact term="Retention">{info.retentionDays ? `Removes runs older than ${info.retentionDays} days` : "Keeps every run"}</Fact>
              <Fact term="Uploaded by">
                {info.identityHeader
                  ? "The person from the access proxy, and the machine from its upload token"
                  : "The machine name from its upload token (no person)"}
              </Fact>
            </dl>
          )}
        </section>

        <section aria-labelledby="about-machines" className="space-y-3">
          <h2 id="about-machines" className="text-base font-semibold">
            Machines
          </h2>
          {machines.loading ? (
            <Skeleton className="h-32" aria-label="Loading machines" />
          ) : machines.error ? (
            <Alert variant="destructive">
              <AlertCircle />
              <AlertTitle>Could not load machines</AlertTitle>
              <AlertDescription>{machines.error}</AlertDescription>
            </Alert>
          ) : sorted.length === 0 ? (
            <p className="text-sm text-muted-foreground">No machine has uploaded yet.</p>
          ) : (
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Machine</TableHead>
                    <TableHead>Person</TableHead>
                    <TableHead>Last upload</TableHead>
                    <TableHead className="text-right">Runs (30 days)</TableHead>
                    <TableHead>Notes</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sorted.map((m) => (
                    <TableRow key={m.name}>
                      <TableCell className="font-mono text-xs">{m.name}</TableCell>
                      <TableCell title={m.uploader ?? undefined}>{displayPerson(m.uploader) ?? "—"}</TableCell>
                      <TableCell>{m.lastUploadAt ? <RelativeTime iso={m.lastUploadAt} now={now} /> : <span className="text-muted-foreground">never</span>}</TableCell>
                      <TableCell className="text-right tabular-nums">{m.runs30d}</TableCell>
                      <TableCell>
                        <MachineNotes machine={m} now={now} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </section>

        <section aria-labelledby="about-connect" className="space-y-3">
          <h2 id="about-connect" className="text-base font-semibold">
            Connect your machine
          </h2>
          <ol className="list-decimal space-y-5 pl-5 text-sm">
            <li className="space-y-2">
              <p>Ask your hub admin for an upload token named after your machine:</p>
              <CodeBlock code="tapocalypse hub token create <your-machine>" prompt />
              <p className="text-xs text-muted-foreground">On a container: docker compose exec hub bun src/cli.ts hub token create &lt;your-machine&gt;</p>
            </li>
            <li className="space-y-2">
              <p>On your machine, open Setup → Connect to a team hub and paste this address and the token. Or run:</p>
              <CodeBlock code={`tapocalypse hub login ${location.origin}`} prompt />
            </li>
            <li>Tick “Share with team hub” in each project you want to share. Finished runs upload on their own.</li>
          </ol>
        </section>
      </div>
    </div>
  );
}
