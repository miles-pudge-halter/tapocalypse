import { StatusPill } from "@/components/hub/team-hub-setup";
import { useHubStatus } from "@/lib/hooks";
import { hubQueueChip } from "@/lib/hub";

/** "Team hub: 3 waiting" pill on the Projects page, linking to the Setup section. Nothing while no hub is configured. */
export function HubQueueChip() {
  const { status } = useHubStatus();
  const chip = status ? hubQueueChip(status) : null;
  if (!chip) return null;
  return (
    <StatusPill tone={chip.tone} href="#/setup?section=team-hub">
      {chip.text}
    </StatusPill>
  );
}
