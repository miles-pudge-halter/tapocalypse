import { useState } from "react";
import { Loader2, Send } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { api, type HarnessId } from "@/lib/api";
import { useHarness } from "@/lib/hooks";

/**
 * Chat-style composer pinned under the timeline while the agent is running; ⌘/Ctrl+Enter sends.
 * Harnesses that cannot take a message mid-turn get a one-line note instead (looked up by the run's harness).
 */
export function SteerComposer({ runId, harness }: { runId: string; harness: HarnessId }) {
  const { info, label, loading } = useHarness(harness);
  if (loading) return <Skeleton className="m-2 h-14" aria-busy aria-label="Loading steer composer" />;
  if (info && !info.capabilities.steer) {
    return (
      <p className="border-t bg-background px-3 py-2 text-xs text-muted-foreground">
        {label} runs cannot be steered mid-run. Cancel and re-run to change course.
      </p>
    );
  }
  return <SteerForm runId={runId} />;
}

function SteerForm({ runId }: { runId: string }) {
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);

  async function send() {
    const text = message.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await api.steer(runId, text);
      setMessage("");
    } catch (err) {
      toast.error(`Steer failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex items-end gap-2 border-t bg-background p-2">
      <Textarea
        rows={2}
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void send();
          }
        }}
        aria-label="Message to the agent"
        placeholder="Tell the agent something — e.g. “skip C4, the backend is down” (⌘/Ctrl+Enter to send)"
        className="min-h-0 resize-none text-sm"
      />
      <Button size="sm" onClick={() => void send()} disabled={sending || !message.trim()}>
        {sending ? <Loader2 className="animate-spin" /> : <Send />}
        Send
      </Button>
    </div>
  );
}
