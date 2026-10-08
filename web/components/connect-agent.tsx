import { ChevronDown, Plug } from "lucide-react";
import { useState } from "react";
import { CodeBlock } from "@/components/code-block";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatRelative } from "@/lib/format";
import { useMcpStatus, useNow } from "@/lib/hooks";
import { cn } from "@/lib/utils";

const TOOLS: { name: string; purpose: string }[] = [
  { name: "qa_list_projects", purpose: "Registered projects and whether each is ready" },
  { name: "qa_list_devices", purpose: "Emulators, simulators and devices, with busy / booting flags" },
  { name: "qa_start_run", purpose: "Queue one QA run from a free-text brief or a saved suite" },
  { name: "qa_start_batch", purpose: "Fan the same brief out across several devices in parallel" },
  { name: "qa_wait_run", purpose: "Block until a run finishes (or a timeout), then read its checks and verdict" },
  { name: "qa_wait_runs", purpose: "Wait for several runs or a whole batch, all or any" },
  { name: "qa_get_run", purpose: "Status, checks, verdict, summary, report path and cost of a run" },
  { name: "qa_get_report", purpose: "The markdown report of a finished run" },
  { name: "qa_rerun", purpose: "Re-run only the failed checks (or everything) of a previous run" },
  { name: "qa_steer_run", purpose: "Send a message to a running agent" },
  { name: "qa_cancel_run", purpose: "Cancel a queued or active run" },
  { name: "qa_list_runs", purpose: "Recent runs, filterable by branch, PR, ticket or commit" },
  { name: "qa_list_suites", purpose: "Saved test suites of a project" },
  { name: "qa_doctor", purpose: "Prerequisite report, with a fix for anything missing" },
];

const EXAMPLE_PROMPT =
  "Use the tapocalypse MCP tools to QA what you just built on Android: start a run with qa_start_run for this project, wait for it with qa_wait_run, then tell me the verdict and fix whatever failed.";

function McpLiveStatus() {
  const { status } = useMcpStatus(5_000);
  const now = useNow(10_000);
  const connected = status?.lastCallAt != null;
  return (
    <p
      role="status"
      className={cn(
        "inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs",
        connected
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
          : "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
      )}
    >
      <span className="relative flex size-2">
        {!connected && <span className="absolute inline-flex size-full animate-ping rounded-full bg-amber-500 opacity-60" />}
        <span className={cn("relative inline-flex size-2 rounded-full", connected ? "bg-emerald-500" : "bg-amber-500")} />
      </span>
      {connected && status?.lastCallAt ? (
        <span>
          Connected · last call {formatRelative(status.lastCallAt, now)}
          {status.lastTool && (
            <>
              {" "}
              (<code className="font-mono">{status.lastTool}</code>
              {status.lastRequester && <> by {status.lastRequester}</>})
            </>
          )}
        </span>
      ) : (
        <span>Waiting for first MCP call…</span>
      )}
    </p>
  );
}

/** Copy-paste setup for every common MCP client, with a live indicator that flips once an agent actually calls in. */
export function ConnectAgent({ className }: { className?: string }) {
  const { status } = useMcpStatus(5_000);
  const [toolsOpen, setToolsOpen] = useState(false);
  const url = status?.url ?? `${window.location.origin}/mcp`;

  const ompConfig = JSON.stringify({ mcpServers: { tapocalypse: { type: "http", url, timeout: 120000 } } }, null, 2);
  const cursorConfig = JSON.stringify({ mcpServers: { tapocalypse: { url } } }, null, 2);

  return (
    <div className={cn("space-y-4", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Plug className="size-4" />
          Let your coding agent start QA runs and read the results. Keep Tapocalypse running while it works.
        </p>
        <McpLiveStatus />
      </div>

      <Tabs defaultValue="omp">
        <TabsList>
          <TabsTrigger value="omp">omp</TabsTrigger>
          <TabsTrigger value="claude">Claude Code</TabsTrigger>
          <TabsTrigger value="cursor">Cursor</TabsTrigger>
          <TabsTrigger value="other">Any MCP client</TabsTrigger>
        </TabsList>
        <TabsContent value="omp" className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Merge this into <code className="rounded bg-muted px-1 text-xs">~/.omp/agent/mcp.json</code>. User level means every git worktree of
            your project sees it.
          </p>
          <CodeBlock code={ompConfig} />
        </TabsContent>
        <TabsContent value="claude" className="space-y-2">
          <p className="text-sm text-muted-foreground">Run this once in any terminal:</p>
          <CodeBlock code={`claude mcp add --transport http --scope user tapocalypse ${url}`} prompt />
        </TabsContent>
        <TabsContent value="cursor" className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Merge this into <code className="rounded bg-muted px-1 text-xs">~/.cursor/mcp.json</code>, then reload Cursor.
          </p>
          <CodeBlock code={cursorConfig} />
        </TabsContent>
        <TabsContent value="other" className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Any client that speaks streamable HTTP MCP works. Point it at this URL (stateless, no auth). Requests that don't use{" "}
            <code className="rounded bg-muted px-1 text-xs">127.0.0.1</code> or <code className="rounded bg-muted px-1 text-xs">localhost</code>{" "}
            are refused, and if you change the port you must update the URL.
          </p>
          <CodeBlock code={url} />
        </TabsContent>
      </Tabs>

      <div className="space-y-2">
        <p className="text-sm font-medium">Then ask your agent</p>
        <CodeBlock code={EXAMPLE_PROMPT} />
      </div>

      <Collapsible open={toolsOpen} onOpenChange={setToolsOpen}>
        <CollapsibleTrigger className="flex items-center gap-1.5 text-sm font-medium outline-none hover:underline focus-visible:underline">
          <ChevronDown className={cn("size-4 transition-transform", !toolsOpen && "-rotate-90")} />
          Tools your agent gets ({TOOLS.length})
        </CollapsibleTrigger>
        <CollapsibleContent>
          <dl className="mt-2 grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[max-content_1fr]">
            {TOOLS.map((t) => (
              <div key={t.name} className="contents">
                <dt>
                  <code className="font-mono text-xs">{t.name}</code>
                </dt>
                <dd className="text-muted-foreground">{t.purpose}</dd>
              </div>
            ))}
          </dl>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
