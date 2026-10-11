import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/toggle";
import { readStorage, writeStorage } from "@/lib/storage";
import { wordDiff, type DiffToken } from "@/lib/regression";
import { cn } from "@/lib/utils";

const HIGHLIGHT_KEY = "tapocalypse-compare-highlight";
const CLAMP_CHARS = 280;
const CLAMP_LINES = 6;

function Tokens({ tokens, tone }: { tokens: DiffToken[]; tone: "removed" | "added" }) {
  return (
    <>
      {tokens.map((t, i) => (
        <span key={i}>
          {i > 0 ? " " : null}
          <span className={cn(t.changed && (tone === "removed" ? "rounded-sm bg-red-500/15 line-through decoration-red-500/60" : "rounded-sm bg-emerald-500/15"))}>
            {t.text}
          </span>
        </span>
      ))}
    </>
  );
}

function NoteBlock({ eyebrow, note, children, missing }: { eyebrow: string; note: string | null; children?: ReactNode; missing: string }) {
  const [expanded, setExpanded] = useState(false);
  const long = note !== null && (note.length > CLAMP_CHARS || note.split("\n").length > CLAMP_LINES);
  return (
    <div className="space-y-1">
      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{eyebrow}</p>
      <div className="rounded-md border bg-muted/30 p-2 text-sm">
        {note === null ? (
          <p className="italic text-muted-foreground">{missing}</p>
        ) : (
          <p className={cn("whitespace-pre-wrap break-words", long && !expanded && "line-clamp-6")}>{children ?? note}</p>
        )}
        {long ? (
          <Button type="button" variant="link" size="xs" className="mt-1 h-auto p-0" onClick={() => setExpanded((v) => !v)}>
            {expanded ? "Show less" : "Show more"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** The two notes of a pair, with changed words marked (JSX spans only; the notes are agent text). */
export function NotesDiff({ baseline, current }: { baseline: string | null; current: string | null }) {
  const [highlight, setHighlight] = useState(() => readStorage(HIGHLIGHT_KEY) !== "0");
  const base = baseline?.trim() ? baseline : null;
  const now = current?.trim() ? current : null;

  if (base === null && now === null) {
    return <p className="text-sm text-muted-foreground">Neither run left a note for this check.</p>;
  }
  if (base !== null && now !== null && base === now) {
    return <NoteBlock eyebrow="Note (same in both runs)" note={now} missing="No note." />;
  }

  const diff = highlight && base !== null && now !== null ? wordDiff(base, now) : null;
  return (
    <div className="space-y-2">
      {base !== null && now !== null ? (
        <div className="flex items-center gap-3">
          <Toggle
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            pressed={highlight}
            onPressedChange={(v) => {
              setHighlight(v);
              writeStorage(HIGHLIGHT_KEY, v ? "1" : "0");
            }}
          >
            Highlight changes
          </Toggle>
          {diff?.truncated ? <span className="text-xs text-muted-foreground">Notes too long to highlight.</span> : null}
        </div>
      ) : null}
      <NoteBlock eyebrow="Baseline note" note={base} missing="No note.">
        {diff && !diff.truncated ? <Tokens tokens={diff.baseline} tone="removed" /> : undefined}
      </NoteBlock>
      <NoteBlock eyebrow="This run's note" note={now} missing="No note.">
        {diff && !diff.truncated ? <Tokens tokens={diff.current} tone="added" /> : undefined}
      </NoteBlock>
    </div>
  );
}
