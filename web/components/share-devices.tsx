import { KeyRound, Plug } from "lucide-react";
import { CodeBlock } from "@/components/code-block";
import { ToolList } from "@/components/connect-agent";
import { LeaseRing } from "@/components/lease-ring";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useLeases, useMcpStatus } from "@/lib/hooks";
import { LEASE_PROMPT, LEASE_SKILL } from "@/lib/lease-snippets";
import { lentOutLabel } from "@/lib/leases";
import { cn } from "@/lib/utils";

const DEVICE_TOOLS = ["device_acquire", "device_renew", "device_release"] as const;

/** Live count of devices currently lent out, in the shape of the MCP status pill. */
function LentOutStatus() {
  const { leases, loading, error } = useLeases();
  if (error) {
    return (
      <p role="status" className="inline-flex items-center gap-2 rounded-full border border-stone-500/30 bg-stone-500/10 px-3 py-1 text-xs text-stone-700 dark:text-stone-300">
        <span className="inline-flex size-2 shrink-0 rounded-full bg-stone-500" />
        <span>Device status unavailable</span>
      </p>
    );
  }
  if (loading) return <Skeleton className="h-6 w-48 rounded-full" />;
  const label = lentOutLabel(leases);
  const ending = leases
    .filter((l) => l.source === "agent" && l.expiresAt)
    .sort((a, b) => Date.parse(a.expiresAt ?? "") - Date.parse(b.expiresAt ?? ""))[0];
  return (
    <p
      role="status"
      className={cn(
        "inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs",
        label
          ? "border-violet-500/40 bg-violet-50 text-violet-800 dark:bg-violet-950/40 dark:text-violet-300"
          : "border-stone-500/30 bg-stone-500/10 text-stone-700 dark:text-stone-300",
      )}
    >
      {label ? (
        ending && <LeaseRing size={12} lease={ending} />
      ) : (
        <span className="inline-flex size-2 shrink-0 rounded-full bg-stone-500" />
      )}
      <span>{label ?? "No device is lent out right now"}</span>
    </p>
  );
}

/** Setup section: the prompt, skill and tools that make coding agents borrow devices from Tapocalypse instead of grabbing them. */
export function ShareDevices() {
  const { status } = useMcpStatus();
  const notConnected = status !== null && status.lastCallAt === null;

  return (
    <section className="mt-10" aria-labelledby="share-devices">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl space-y-0.5">
          <h2 id="share-devices" className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <KeyRound className="size-5 text-muted-foreground" />
            Share devices with your coding agents
          </h2>
          <p className="text-sm text-muted-foreground">
            Agents that drive a device outside a QA run should borrow it from Tapocalypse first, so two agents never tap the same emulator. QA
            runs already do this. Give each agent the prompt once, or install the skill.
          </p>
        </div>
        <LentOutStatus />
      </div>

      {notConnected && (
        <Alert className="mb-4">
          <Plug />
          <AlertTitle>Connect your agent first</AlertTitle>
          <AlertDescription>
            The prompt below uses Tapocalypse&apos;s MCP tools. Set them up in “Connect your coding agent (MCP)” above.
          </AlertDescription>
        </Alert>
      )}

      <Tabs defaultValue="prompt">
        <TabsList>
          <TabsTrigger value="prompt">Prompt</TabsTrigger>
          <TabsTrigger value="skill">Skill</TabsTrigger>
          <TabsTrigger value="tools">Tools</TabsTrigger>
        </TabsList>
        <TabsContent value="prompt" className="space-y-2">
          <p className="text-sm text-muted-foreground">Paste this into each agent once (or into its project instructions).</p>
          <CodeBlock code={LEASE_PROMPT} className="[&_pre]:whitespace-pre-wrap [&_pre]:break-words" />
        </TabsContent>
        <TabsContent value="skill" className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Save this as <code className="rounded bg-muted px-1 text-xs">SKILL.md</code> in a folder named{" "}
            <code className="rounded bg-muted px-1 text-xs">device-lease</code> in your agent&apos;s skills directory.
          </p>
          <CodeBlock code={LEASE_SKILL} className="[&_pre]:whitespace-pre-wrap [&_pre]:break-words" />
        </TabsContent>
        <TabsContent value="tools" className="space-y-2">
          <ToolList only={DEVICE_TOOLS} />
          <dl className="grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[max-content_1fr]">
            <dt>
              <code className="font-mono text-xs">mobile_* (gated)</code>
            </dt>
            <dd className="text-muted-foreground">
              Tapocalypse&apos;s own copies of mobile-mcp&apos;s device tools. Pass the <code className="rounded bg-muted px-1 text-xs">leaseId</code>{" "}
              instead of a device: they only drive the device the lease holds.
            </dd>
          </dl>
        </TabsContent>
      </Tabs>
    </section>
  );
}
