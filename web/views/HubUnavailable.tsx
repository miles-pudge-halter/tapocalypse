import { Lock } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";

/** Devices and Setup do not exist on the hub; old bookmarks and pasted links land here. */
export function HubUnavailable() {
  return (
    <EmptyState
      icon={Lock}
      title="Not available on the team hub"
      description="Devices and setup live on each teammate's machine. The hub only shows the runs they upload."
      action={
        <Button asChild variant="outline">
          <a href="#/">Go to the overview</a>
        </Button>
      }
    />
  );
}
