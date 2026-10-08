import { useState } from "react";
import { Loader2, Send } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";

/** Chat-style composer pinned under the timeline while the agent is running; ⌘/Ctrl+Enter sends. */
export function SteerComposer({ runId }: { runId: string }) {
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
