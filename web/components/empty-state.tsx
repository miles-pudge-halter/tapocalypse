import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

type EmptyStateProps = {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
} & ({ icon: LucideIcon; media?: never } | { media: ReactNode; icon?: never });

export function EmptyState({ icon: Icon, media, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-6 py-12 text-center">
      {Icon ? (
        <div className="flex size-11 items-center justify-center rounded-full bg-muted">
          <Icon className="size-5 text-muted-foreground" />
        </div>
      ) : (
        <div className="mb-2">{media}</div>
      )}
      <div className="space-y-1">
        <p className="text-sm font-medium">{title}</p>
        {description && <p className="max-w-sm text-sm text-muted-foreground">{description}</p>}
      </div>
      {action}
    </div>
  );
}
