import { useSyncExternalStore } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { useShortcut } from "@/lib/hooks";
import { isHub } from "@/lib/mode";

const listeners = new Set<() => void>();
let isOpen = false;

function setOpen(next: boolean): void {
  isOpen = next;
  for (const l of listeners) l();
}

export function openShortcutsDialog(): void {
  setOpen(true);
}

/** ⌘ on macOS, Ctrl elsewhere. */
export const MOD_KEY_LABEL = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";

interface ShortcutRow {
  keys: string[];
  label: string;
}

interface Group {
  title: string;
  rows: ShortcutRow[];
}

/** The General and Go to groups differ between a laptop and the read-only hub. */
function leadingGroups(): Group[] {
  const common: ShortcutRow[] = [
    { keys: [MOD_KEY_LABEL, "K"], label: "Open the command palette" },
    { keys: ["/"], label: "Focus search or the filter on the current page" },
    { keys: [MOD_KEY_LABEL, "B"], label: "Collapse or expand the sidebar" },
    { keys: ["?"], label: "Show this list" },
  ];
  if (isHub()) {
    return [
      { title: "General", rows: common },
      {
        title: "Team hub",
        rows: [
          { keys: ["g", "o"], label: "Overview" },
          { keys: ["g", "e"], label: "Releases" },
          { keys: ["g", "r"], label: "Runs" },
          { keys: ["g", "p"], label: "Projects" },
          { keys: ["g", "a"], label: "About this hub" },
        ],
      },
    ];
  }
  return [
    { title: "General", rows: [common[0] as ShortcutRow, { keys: ["n"], label: "New run" }, ...common.slice(1)] },
    {
      title: "Go to",
      rows: [
        { keys: ["g", "o"], label: "Overview" },
        { keys: ["g", "e"], label: "Releases" },
        { keys: ["g", "r"], label: "Runs" },
        { keys: ["g", "d"], label: "Devices" },
        { keys: ["g", "p"], label: "Projects" },
        { keys: ["g", "s"], label: "Setup" },
      ],
    },
  ];
}

const SHARED_GROUPS: Group[] = [
  {
    title: "Run",
    rows: [
      { keys: ["j", "k"], label: "Next / previous check" },
      { keys: ["Esc"], label: "Clear the selection" },
      { keys: ["c"], label: "Open the comparison" },
      { keys: ["b"], label: "Change the baseline" },
      { keys: ["h"], label: "History of the selected check" },
    ],
  },
  {
    title: "Compare",
    rows: [
      { keys: ["j", "k"], label: "Next / previous check" },
      { keys: ["1", "2", "3"], label: "Side by side / Swipe / Onion skin" },
      { keys: ["[", "]"], label: "Move the swipe or fade" },
      { keys: ["h"], label: "History of the selected check" },
    ],
  },
  {
    title: "Image viewer",
    rows: [
      { keys: ["←", "→"], label: "Previous / next image" },
      { keys: ["Esc"], label: "Close" },
    ],
  },
];


export function ShortcutsDialog() {
  const open = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    () => isOpen,
  );
  useShortcut("?", () => setOpen(!isOpen));
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Single-key shortcuts are ignored while you type in a field.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {[...leadingGroups(), ...SHARED_GROUPS].map((group) => (
            <section key={group.title}>
              <h3 className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">{group.title}</h3>
              <ul className="divide-y rounded-md border">
                {group.rows.map((row) => (
                  <li key={row.label} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                    <span>{row.label}</span>
                    <KbdGroup>
                      {row.keys.map((k) => (
                        <Kbd key={k}>{k}</Kbd>
                      ))}
                    </KbdGroup>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
