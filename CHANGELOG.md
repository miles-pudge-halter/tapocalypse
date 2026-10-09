# Changelog

All notable changes to this project are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/).

## [0.1.0] - Unreleased

First public release.

### Added

- **Brand.** The "Charged T" logo (favicon, sidebar, mobile header, desktop notifications, first-run hero, README) with a warm amber/near-black theme in light and dark mode, JetBrains Mono for ids and code, and small lightning touches: a flickering bolt for running runs, a lightning bolt that runs along the running progress segment, a one-shot flash when a run you are watching reaches its verdict, and a lightning arc that crosses buttons, sidebar items and option cards when you activate them. Warning states moved from amber to orange so they never look like the brand accent. Device frames follow the real device: phone, tablet, watch and TV bodies with the screen's true aspect ratio.
- **Agent harnesses.** The QA agent is no longer tied to omp: a run can use omp, Claude Code (`claude -p`, stream-json) or Codex CLI (`codex exec --json`). Choose one per run (New run picker, `--harness`, `harness` in `POST /api/runs`, `POST /api/batches`, `qa_start_run`, `qa_start_batch` and `qa_rerun`), per project (`agent.harness`), in a persona (`harness:` frontmatter) or in the config (`agent.harness`, `agent.harnesses.<id>` with `bin`, `model`, `effort`, `permissions`, `sandbox`; `agent.maxTurns` and `agent.maxBudgetUsd` for Claude Code); `CLAUDE_BIN` and `CODEX_BIN` join `OMP_BIN`. Without a choice the first harness that is installed and signed in is used, else the first installed, else omp, and runs and `run.json` files from before this change count as omp. Model and effort strings are harness-native, and a persona's `model:` applies only to its own harness. Doctor reports every installed harness (install and sign-in) plus an `agent-runtime` check that needs at least one; `GET /api/harnesses` lists them with their capabilities and `GET /api/models?harness=` lists models per harness. The run page shows the harness, hides the steer box and Transcript button when it cannot steer or export one (Codex CLI cannot steer; transcripts and the Artemis backend are omp-only). Turn and budget limits end a run as `errorKind: timeout` with the limit named, and the verdict is derived as for a time-out.
- **Run progress endpoint.** Agents report `qa_plan`, `qa_check` and `qa_finish` to `POST /mcp/runs/<id>` (server `tpc`, a random bearer token per run, passed to Claude Code in an owner-only `mcp.json` and to Codex CLI as an owner-only `tpc-mcp.json` read by a stdio bridge (`src/mcp/stdio-bridge.ts`, so it works on every Codex version, including those without HTTP MCP support), both in the run's data folder, never on the command line or in the environment); omp keeps its native host tools and needs no token. Both feed one recorder.
- **Runs.** Start parallel QA runs from the web UI, the CLI, plain HTTP or MCP: a project, a free-text brief and a platform or device. Runs queue when every device is busy; configured AVDs and simulators are booted on demand and shut down when idle.
- **Live monitoring.** Per-check progress, live device screen, a rich activity feed (tool calls paired with their results), steering and cancelling mid-run, and a summary of cost, tokens and tool calls per run.
- **Batches.** Fan one brief out to several devices (`POST /api/batches`, `qa_start_batch`, `tapocalypse run --devices N`); a batch rolls its runs up into one verdict and cost.
- **Re-run failed or all checks** of a run, with the previous status and notes passed to the agent.
- **Suites.** Saved, repeatable briefs with fixed check ids in `<repo>/.tapocalypse/suites/`, and built-in brief templates (smoke, regression, ticket verification, accessibility, offline and poor network, first run).
- **Reliability.** Time budget given to the agent (`runMaxTime` must be a valid duration, checked at startup) and a reminder at 80% of it; a hard kill at the budget for Claude Code and Codex CLI and 5 minutes after it for omp, which enforces `--max-time` itself; a derived verdict when the agent stops without reporting one; classified errors (infra, agent, timeout, cancelled); one automatic retry for infrastructure failures; installing an APK or app bundle before a run.
- **CLI and CI.** `tapocalypse serve | doctor | run | status`, with `--wait`, JSON output, JUnit XML and verdict-based exit codes for CI.
- **MCP.** Tools to list projects, devices and suites, start single runs and batches, wait on one or many runs, steer, cancel, re-run, and read reports.
- **Run metadata.** Branch, commit, pull request, tickets, labels and app build recorded per run and searchable.
- **Reports.** Per-project markdown reports with a table of contents, a link back to the run and a screenshot gallery; report HTML is sanitized.
- **Projects.** Detection of Flutter, React Native / Expo, native Android and iOS and Kotlin Multiplatform repositories; folder suggestions when adding a project.
- **Web UI.** Rebuilt as a React 19, Tailwind v4 and shadcn/ui app with a sidebar shell, command palette, dashboard with live strip and filters, run workbench, devices page, setup guide, notifications, and light and dark themes.
- **Platform.** Doctor checks for the agent runtime's install and sign-in and for operating-system support, XDG config and data locations, optional retention of old runs, macOS and Linux support.
- **Devices and queue.** A Devices page with run slots, live thumbnails and per-device state, manual boot and shutdown of configured AVDs and simulators, and a plain-language reason on every queued run. Watches and TVs are never used for QA.
- **Run history.** Delete a finished run from the UI or `DELETE /api/runs/:id`; `retention.days` / `retention.maxRuns` clean up old runs automatically.
- **Security notes per harness.** SECURITY.md lists each harness's no-prompt mode (omp `--auto-approve`, Claude Code `bypassPermissions` or an allowlist, Codex CLI `danger-full-access` with `approval_policy="never"`) and Codex CLI's own trusted-project entry in `~/.codex/config.toml`.
- **Security hardening.** Sanitized report HTML with external images dropped, a Content-Security-Policy and frame protection for the UI, `X-Frame-Options` / `frame-ancestors` on API responses, a 1 MiB request body limit, and Host, Origin and content-type guards.
- **CLI.** `tapocalypse serve --dev` starts Bun's development server with hot reloading.
- **Documentation.** Configuration and HTTP API / MCP references under `docs/`.
- **Open source project files.** Continuous integration, issue and pull request templates, contributing guide and security policy.

[0.1.0]: https://github.com/miles-pudge-halter/tapocalypse/commits/main
