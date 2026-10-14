import { formatRelative } from "@/lib/format";
import { useNow } from "@/lib/hooks";

/** "Updated 3m ago" under the header of the live hub pages. */
export function Freshness({ fetchedAt }: { fetchedAt: number | null }) {
  const now = useNow(15_000);
  if (fetchedAt === null) return null;
  return <span className="block text-xs text-muted-foreground">Updated {formatRelative(new Date(fetchedAt).toISOString(), now)}</span>;
}
