# Security policy

## Trust model

Tapocalypse is a single-user developer tool that runs on your own machine. It has no accounts and no authentication, and it is designed on these assumptions:

- **Local only.** The server binds `127.0.0.1`. Do not expose its port through tunnels, port forwarding or a reverse proxy: anyone who can reach it can start agent runs.
- **Agents run with your permissions.** Every run starts a headless agent in its no-prompt mode (see the list below). The agent executes shell commands (`adb`, `xcrun`, and whatever else it decides to run) as your user, inside your repository, without asking. A brief, a suite, a persona and a ticket pasted into a brief are effectively programs you run. Review third-party personas and suites before using them, and be careful with briefs that embed untrusted text (for example a pull request description from a stranger).
  Each harness is started without approval prompts, because a headless run cannot answer them:
  - **omp:** `--auto-approve`.
  - **Claude Code:** `--permission-mode bypassPermissions` by default, which Claude Code documents for isolated environments and which it refuses to run as root. Set `agent.harnesses.claude.permissions` to `"allowlist"` to run in `dontAsk` mode instead, with an allowlist for the device-driver and progress tools, `adb`, `xcrun simctl` and file read, write and edit; anything else is denied. Subagents are disabled.
  - **Codex CLI:** `--sandbox danger-full-access` with `approval_policy="never"` by default, because the sandbox's `workspace-write` mode blocks the network and may block the device tooling. `agent.harnesses.codex.sandbox` can be set to `"workspace-write"`. The first `codex exec` in a repository also makes Codex CLI record that path as trusted (`[projects."<path>"] trust_level = "trusted"`) in `~/.codex/config.toml`; this is Codex's own side effect, Tapocalypse does not undo it.
- **Repository configuration executes.** An agent runs inside your repository, so whatever its CLI loads from the repo runs with it: Claude Code runs the repo's `.claude/settings.json` hooks without a trust prompt (Tapocalypse's `--strict-mcp-config` stops only the repo's MCP servers), and the other harnesses load their own project-level configuration too. Treat an untrusted repository like untrusted code.
- **Per-run progress token.** The run-scoped endpoint `POST /mcp/runs/<id>` accepts only a random 32-byte bearer token that exists for that run, reaches its agent in an owner-only file (mode 0600) in the run's data folder: `mcp.json` for Claude Code, `tpc-mcp.json` for Codex CLI, which hands the file's path (not the token) to a small stdio bridge that talks to the endpoint, so the token is never in argv or the environment, and never on the command line, in your repo, or in `run.json`, `events.jsonl` or `stderr.log` (omp uses host tools and needs no token; the file stays until retention removes the run), is compared in constant time, and stops working when the run ends. It lets a process record checks for that one run; it grants no other access.
- **Every local client is trusted.** Any process on the machine, and every MCP client you register, can start runs and therefore has your shell.
- **Request guards** reduce browser-based attacks only: the `Host` header must be `127.0.0.1:<port>` or `localhost:<port>` (DNS rebinding), writes with an `Origin` must come from those origins, and JSON endpoints require `Content-Type: application/json`. They are not a substitute for network isolation.
- **Path safety.** File serving is limited to a project's reports directory and a short extension allowlist. Report, screenshot, persona and `reportsDir` paths reported by clients or agents must resolve inside the repository (symlinks included).
- **Reports are sanitized** before they are rendered in the UI (scripts, styles, frames and event handlers are removed), and transcripts (omp runs) are served sandboxed.

Findings that break these assumptions (reaching files outside the repository, running code without a user-started run, cross-site request forgery, script execution from a report) are vulnerabilities.

## Reporting a vulnerability

Please report privately using a [GitHub security advisory](https://github.com/miles-pudge-halter/tapocalypse/security/advisories/new). Do not open a public issue or pull request for a vulnerability.

Include the affected version or commit, what you did, what you expected, and what happened. You should get a first reply within a few days. Fixes are released as soon as they are ready, with credit in the changelog unless you prefer otherwise.

## Supported versions

Only the latest release and the `main` branch receive security fixes.
