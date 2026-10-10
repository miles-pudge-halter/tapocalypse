import type { Harness, HarnessCapabilities, SpawnOptions } from "../types";
import { CLAUDE_MODEL_ALIASES, claudeDoctor } from "./doctor";
import { toActivity } from "./events";
import { type ClaudeDeps, DEFAULT_DEPS, startSession } from "./session";

const capabilities: HarnessCapabilities = {
  steer: true,
  interrupt: true,
  appendSystemPrompt: true,
  nativeProgressTools: false,
  costReported: true,
  limits: { maxTime: false, maxTurns: true, maxBudgetUsd: true },
  transcriptExport: false,
};

export function createClaudeHarness(overrides: Partial<ClaudeDeps> = {}): Harness {
  const deps: ClaudeDeps = { ...DEFAULT_DEPS, ...overrides };
  return {
    id: "claude",
    label: "Claude Code",
    capabilities,
    spawn: (opts: SpawnOptions) => startSession(opts, deps),
    toActivity,
    doctor: claudeDoctor,
    listModels: async () => [...CLAUDE_MODEL_ALIASES],
  };
}

export const harness: Harness = createClaudeHarness();
