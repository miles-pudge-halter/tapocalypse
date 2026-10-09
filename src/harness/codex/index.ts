import type { DoctorCheck } from "../../doctor";
import type { Harness, HarnessDoctorEnv } from "../types";
import { frameToActivity } from "./events";
import { type CodexSpawn, type CodexTiming, DEFAULT_TIMING, startSession } from "./session";

export type { CodexProcess, CodexSpawn } from "./session";

/** Static picker entries (free text stays allowed); `codex` has no offline model listing command. */
const MODELS: readonly string[] = ["gpt-5.5"];

const INSTALL_FIX = "Install Codex CLI (`npm install -g @openai/codex`), make sure `codex` is on your PATH (or set CODEX_BIN), then re-check";

function firstLine(s: string): string {
  return s.trim().split("\n")[0]?.trim() ?? "";
}

/** `codex --version` and `codex login status` (exit 0 = signed in); neither makes a model call. */
async function doctor(env: HarnessDoctorEnv): Promise<DoctorCheck[]> {
  const required = env.selected;
  // A missing or signed-out runtime only blocks runs when it is the one in use.
  const missing = required ? "error" : "warn";
  const install: DoctorCheck = { id: "codex", label: "Codex CLI (agent runtime)", status: "ok", detail: "", required };
  const auth: DoctorCheck = { id: "codex-auth", label: "Codex CLI signed in", status: "ok", detail: "", required };

  const version = await env.run([env.bin, "--version"]);
  if (version.code === 127) {
    Object.assign(install, { status: missing, detail: `\`${env.bin}\` not found on PATH`, fix: INSTALL_FIX });
  } else if (version.code !== 0) {
    const why = firstLine(version.stderr || version.text) || `exit ${version.code}`;
    Object.assign(install, { status: missing, detail: `\`${env.bin} --version\` failed: ${why}`, fix: INSTALL_FIX });
  } else {
    install.detail = firstLine(version.text) || "installed";
  }
  if (install.status !== "ok") {
    Object.assign(auth, { status: "skip", detail: "Needs Codex CLI installed first" });
    return [install, auth];
  }

  const fix = "Run `codex login` (or set an API key as documented by Codex CLI), then re-check";
  const login = await env.run([env.bin, "login", "status"]);
  if (login.code === 0) {
    auth.detail = firstLine(login.text || login.stderr) || "signed in";
  } else if (login.code === 124 || login.code === 143) {
    Object.assign(auth, { status: "warn", detail: "`codex login status` timed out; cannot confirm you are signed in", fix });
  } else {
    const why = firstLine(login.text || login.stderr) || `exit ${login.code}`;
    Object.assign(auth, { status: missing, detail: `Codex CLI is not signed in (${why})`, fix });
  }
  return [install, auth];
}

export function createCodexHarness(deps: { spawn?: CodexSpawn } & Partial<CodexTiming> = {}): Harness {
  const timing: CodexTiming = {
    sigintGraceMs: deps.sigintGraceMs ?? DEFAULT_TIMING.sigintGraceMs,
    termGraceMs: deps.termGraceMs ?? DEFAULT_TIMING.termGraceMs,
  };
  const spawn: CodexSpawn =
    deps.spawn ?? ((cmd, opts) => Bun.spawn(cmd, { cwd: opts.cwd, env: opts.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" }));
  return {
    id: "codex",
    label: "Codex CLI",
    capabilities: {
      steer: false,
      interrupt: false,
      appendSystemPrompt: true,
      nativeProgressTools: false,
      costReported: false,
      limits: { maxTime: false, maxTurns: false, maxBudgetUsd: false },
      transcriptExport: false,
      backends: ["mobile-mcp"],
    },
    spawn: (opts) => startSession(spawn, opts, timing),
    toActivity: frameToActivity,
    doctor,
    listModels: async () => [...MODELS],
  };
}

export const harness: Harness = createCodexHarness();
