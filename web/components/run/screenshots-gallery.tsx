import { useState } from "react";
import { Image as ImageIcon, ImageOff, XCircle } from "lucide-react";

import { CheckStatusIcon } from "@/components/check-status-icon";
import { EmptyState } from "@/components/empty-state";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import type { Check } from "@/lib/api";
import { groupGallery, type GalleryItem } from "./evidence";

function Tile({ item, onOpen }: { item: GalleryItem; onOpen: () => void }) {
  const [failed, setFailed] = useState(false);
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={failed}
      title={item.name}
      className="group block w-full overflow-hidden rounded-lg border bg-muted/30 text-left outline-none transition-shadow hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring"
    >
      {failed ? (
        <div className="flex aspect-[9/16] flex-col items-center justify-center gap-1 text-muted-foreground">
          <ImageOff className="size-5" />
          <span className="text-xs">missing</span>
        </div>
      ) : (
        <img
          src={item.url}
          alt={item.name}
          loading="lazy"
          onError={() => setFailed(true)}
          className="aspect-[9/16] w-full object-cover object-top"
        />
      )}
      <div className="truncate border-t px-2 py-1 text-xs text-muted-foreground group-hover:text-foreground">{item.name}</div>
    </button>
  );
}

/** Every screenshot of the run as a grid, grouped by the check it proves. */
export function ScreenshotsGallery({
  items,
  checks,
  loading,
  error,
  onOpenImage,
}: {
  items: GalleryItem[];
  checks: Check[];
  loading: boolean;
  error: string | null;
  onOpenImage: (item: GalleryItem) => void;
}) {
  if (loading && items.length === 0) {
    return (
      <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="aspect-[9/16] w-full" />
        ))}
      </div>
    );
  }
  if (error && items.length === 0) {
    return (
      <div className="p-4">
        <Alert variant="destructive">
          <XCircle />
          <AlertTitle>Could not load screenshots</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <div className="p-4">
        <EmptyState icon={ImageIcon} title="No screenshots" description="This run did not save any screenshots." />
      </div>
    );
  }
  const groups = groupGallery(items, checks);
  return (
    <div className="space-y-6 p-4">
      {groups.map((g) => (
        <section key={g.checkId ?? "other"} className="space-y-2">
          <h3 className="flex items-center gap-2 text-sm font-medium">
            {g.check ? (
              <>
                <CheckStatusIcon status={g.check.status} />
                <span className="font-mono text-xs text-muted-foreground">{g.check.id}</span>
                <span className="min-w-0 truncate">{g.check.title}</span>
              </>
            ) : (
              <span className="text-muted-foreground">Other screenshots</span>
            )}
            <span className="ml-auto text-xs font-normal text-muted-foreground">{g.items.length}</span>
          </h3>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
            {g.items.map((item) => (
              <Tile key={item.key} item={item} onOpen={() => onOpenImage(item)} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
