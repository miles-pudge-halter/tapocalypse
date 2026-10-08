import { config } from "./config";
import { type Device, listDevices } from "./devices/devices";
import {
  bootedCount,
  isBootedByTapocalypse,
  isBootingSerial,
  markAssigned,
  markReleased,
  startIdleReaper,
} from "./devices/pool";
import { initProjects } from "./projects/registry";
import { createRunner } from "./runs/runner";
import { Scheduler } from "./runs/scheduler";
import { getRun } from "./runs/store";
import type { Run } from "./runs/types";

export const scheduler: Scheduler = new Scheduler({
  config,
  listDevices,
  bootedCount,
  isBootingSerial,
  markAssigned,
  markReleased,
  startRun: (run, target) => runner.startRun(run, target),
  cancelActive: (id) => runner.cancelActive(id),
});

export const runner = createRunner(scheduler);

export async function devicesView(): Promise<Device[]> {
  return scheduler.overlay(await listDevices(), isBootedByTapocalypse);
}

export function runView(run: Run): Run & { queuePosition: number | null } {
  return { ...run, queuePosition: scheduler.queuePosition(run.id) };
}

export function findRun(id: string): Run | null {
  return scheduler.getLive(id) ?? getRun(id);
}

export function init(): void {
  initProjects();
  scheduler.restore();
  startIdleReaper();
  setInterval(() => void scheduler.schedule(), 10_000);
  void scheduler.schedule();
}
