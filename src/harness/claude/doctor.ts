import { z } from "zod";
import type { DoctorCheck } from "../../doctor";
import type { HarnessDoctorEnv } from "../types";

const INSTALL_URL = "https://code.claude.com/docs/en/quickstart";
/** Claude Code waits for MCP servers before the first turn from this version on (research §5.9). */
const MIN_VERSION = [2, 1, 221] as const;

const authStatus = z.object({ loggedIn: z.boolean(), authMethod: z.string().optional() });

const firstLine = (s: string) => s.split(/\r?\n/).find((l) => l.trim())?.trim() ?? "";

function olderThan(version: string, min: readonly number[]): boolean {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) return false;
  const parts = m.slice(1).map(Number);
  for (let i = 0; i < min.length; i++) {
    if (parts[i] !== min[i]) return parts[i] < min[i];
  }
  return false;
}

/** `claude` / `claude-auth` rows. Only `--version` and `auth status --json` run: neither makes a model call. */
export async function claudeDoctor(env: HarnessDoctorEnv): Promise<DoctorCheck[]> {
  const id = "claude";
  const missing = env.selected ? "error" : "warn";
  const version = await env.run([env.bin, "--version"]);
  const installed: DoctorCheck =
    version.code === 0
      ? { id, label: "Claude Code", status: "ok", detail: firstLine(version.text) || "installed", required: env.selected }
      : {
          id,
          label: "Claude Code",
          status: missing,
          detail: version.code === 127 ? `\`${env.bin}\` not found on PATH` : `\`${env.bin} --version\` failed: ${firstLine(version.stderr || version.text)}`,
          fix: `Install Claude Code (${INSTALL_URL}), make sure \`claude\` is on your PATH (or set CLAUDE_BIN)`,
          required: env.selected,
        };
  if (installed.status === "ok" && olderThan(installed.detail, MIN_VERSION)) {
    installed.status = "warn";
    installed.detail = `${installed.detail} is older than ${MIN_VERSION.join(".")}`;
    installed.fix = "Update with `claude update`";
  }
  const authBase = { id: `${id}-auth`, label: "Claude Code signed in", required: env.selected };
  if (version.code !== 0) return [installed, { ...authBase, status: "skip", detail: "Needs Claude Code installed first" }];

  const auth = await env.run([env.bin, "auth", "status", "--json"]);
  let parsed: z.infer<typeof authStatus> | null = null;
  try {
    const p = authStatus.safeParse(JSON.parse(auth.text));
    if (p.success) parsed = p.data;
  } catch {
    // Unreadable output is reported below.
  }
  const fix = "Run `claude auth login` (or export ANTHROPIC_API_KEY), then re-check";
  if (parsed?.loggedIn) {
    return [installed, { ...authBase, status: "ok", detail: `Signed in${parsed.authMethod ? ` (${parsed.authMethod})` : ""}` }];
  }
  if (parsed) return [installed, { ...authBase, status: missing, detail: "Claude Code is not signed in", fix }];
  return [
    installed,
    { ...authBase, status: "warn", detail: `Could not read \`claude auth status\` (exit ${auth.code}); cannot confirm you are signed in`, fix },
  ];
}

/** Aliases Claude Code resolves to the current model of each family; a full model id stays valid as free text. */
export const CLAUDE_MODEL_ALIASES: readonly string[] = ["opus", "sonnet", "haiku"];
