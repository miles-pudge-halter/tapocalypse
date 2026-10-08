# Security policy

## Trust model

Tapocalypse is a single-user developer tool that runs on your own machine. It has no accounts and no authentication, and it is designed on these assumptions:

- **Local only.** The server binds `127.0.0.1`. Do not expose its port through tunnels, port forwarding or a reverse proxy: anyone who can reach it can start agent runs.
- **Agents run with your permissions.** Every run starts a headless omp agent with `--auto-approve`. The agent executes shell commands (`adb`, `xcrun`, and whatever else it decides to run) as your user, inside your repository, without asking. A brief, a suite, a persona and a ticket pasted into a brief are effectively programs you run. Review third-party personas and suites before using them, and be careful with briefs that embed untrusted text (for example a pull request description from a stranger).
- **Every local client is trusted.** Any process on the machine, and every MCP client you register, can start runs and therefore has your shell.
- **Request guards** reduce browser-based attacks only: the `Host` header must be `127.0.0.1:<port>` or `localhost:<port>` (DNS rebinding), writes with an `Origin` must come from those origins, and JSON endpoints require `Content-Type: application/json`. They are not a substitute for network isolation.
- **Path safety.** File serving is limited to a project's reports directory and a short extension allowlist. Report, screenshot, persona and `reportsDir` paths reported by clients or agents must resolve inside the repository (symlinks included).
- **Reports are sanitized** before they are rendered in the UI (scripts, styles, frames and event handlers are removed), and transcripts are served sandboxed.

Findings that break these assumptions (reaching files outside the repository, running code without a user-started run, cross-site request forgery, script execution from a report) are vulnerabilities.

## Reporting a vulnerability

Please report privately using a [GitHub security advisory](https://github.com/miles-pudge-halter/tapocalypse/security/advisories/new). Do not open a public issue or pull request for a vulnerability.

Include the affected version or commit, what you did, what you expected, and what happened. You should get a first reply within a few days. Fixes are released as soon as they are ready, with credit in the changelog unless you prefer otherwise.

## Supported versions

Only the latest release and the `main` branch receive security fixes.
