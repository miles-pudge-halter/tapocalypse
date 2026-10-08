import { ArrowUp } from "lucide-react";
import { useState, type RefObject } from "react";
import { Button } from "@/components/ui/button";
import type { ReportDoc } from "@/lib/api";
import { cn } from "@/lib/utils";
import { findScroller, useScrollSync } from "./use-scroll";

export type ReportHeading = ReportDoc["headings"][number];

/** A heading counts as "current" once it has scrolled within this many px of the viewport top. */
const ACTIVE_OFFSET_PX = 96;

/** Scrolls a report heading into view. The app uses hash routing, so `#id` anchors must never reach the URL. */
export function scrollToHeading(article: HTMLElement | null, id: string): void {
  const target = document.getElementById(id);
  if (!target || !article?.contains(target)) return;
  target.scrollIntoView({ behavior: "smooth", block: "start" });
}

/** "On this page": the report's H2/H3 outline with a scroll-spy bar on the current section. */
export function ReportToc({
  headings,
  articleRef,
  resetKey,
  className,
}: {
  headings: ReportHeading[];
  articleRef: RefObject<HTMLElement | null>;
  resetKey: unknown;
  className?: string;
}) {
  const [activeId, setActiveId] = useState<string | null>(headings[0]?.id ?? null);

  useScrollSync(
    articleRef,
    ({ viewportTop }) => {
      let current = headings[0]?.id ?? null;
      for (const heading of headings) {
        const el = document.getElementById(heading.id);
        if (!el || !articleRef.current?.contains(el)) continue;
        if (el.getBoundingClientRect().top - viewportTop > ACTIVE_OFFSET_PX) break;
        current = heading.id;
      }
      setActiveId(current);
    },
    resetKey,
  );

  if (headings.length === 0) return null;

  const backToTop = () => {
    const article = articleRef.current;
    if (article) findScroller(article).scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <nav aria-label="On this page" className={cn("space-y-2", className)}>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">On this page</p>
      <ul className="space-y-0.5 border-l">
        {headings.map((heading) => {
          const active = heading.id === activeId;
          return (
            <li key={heading.id}>
              <button
                type="button"
                onClick={() => scrollToHeading(articleRef.current, heading.id)}
                aria-current={active ? "location" : undefined}
                className={cn(
                  "-ml-px block w-full border-l-2 py-1 pr-2 text-left text-sm leading-snug transition-colors",
                  heading.level === 3 ? "pl-6" : "pl-3",
                  active
                    ? "border-ring font-medium text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {heading.text}
              </button>
            </li>
          );
        })}
      </ul>
      <Button variant="ghost" size="sm" onClick={backToTop} className="-ml-2 text-muted-foreground">
        <ArrowUp />
        Back to top
      </Button>
    </nav>
  );
}
