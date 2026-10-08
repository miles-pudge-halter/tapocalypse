import { Apple, Bot, Tablet, Tv, Watch, type LucideIcon } from "lucide-react";
import type { Device } from "@/lib/api";
import { deviceDisplayName } from "@/lib/format";
import { cn } from "@/lib/utils";

type DeviceNameInput = Pick<Device, "serial" | "model" | "name" | "platform"> & Partial<Pick<Device, "deviceType">>;

function deviceIcon(d: DeviceNameInput): LucideIcon {
  if (d.deviceType === "tablet") return Tablet;
  if (d.deviceType === "watch") return Watch;
  if (d.deviceType === "tv") return Tv;
  return d.platform === "ios" ? Apple : Bot;
}

/** Platform/form-factor glyph + friendly name (AVD/simulator/model); the serial stays in the tooltip. */
export function DeviceName({ device, className }: { device: DeviceNameInput; className?: string }) {
  const Icon = deviceIcon(device);
  const name = deviceDisplayName(device);
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)} title={`${name} (${device.serial})`}>
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{name}</span>
    </span>
  );
}
