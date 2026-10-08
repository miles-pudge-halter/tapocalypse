# Changelog

All notable changes to this project are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/).

## [0.1.0] - Unreleased

First public release.

### Added

- **Runs.** Start parallel QA runs from the web UI, the CLI, plain HTTP or MCP: a project, a free-text brief and a platform or device. Runs queue when every device is busy; configured AVDs and simulators are booted on demand and shut down when idle.
- **Live monitoring.** Per-check progress, live device screen, a rich activity feed (tool calls paired with their results), steering and cancelling mid-run, and a summary of cost, tokens and tool calls per run.
- **Batches.** Fan one brief out to several devices (`POST /api/batches`, `qa_start_batch`, `tapocalypse run --devices N`); a batch rolls its runs up into one verdict and cost.
- **Re-run failed or all checks** of a run, with the previous status and notes passed to the agent.
- **Suites.** Saved, repeatable briefs with fixed check ids in `<repo>/.tapocalypse/suites/`, and built-in brief templates (smoke, regression, ticket verification, accessibility, offline and poor network, first run).
- **Reliability.** Time budget given to the agent and a reminder at 80% of it; a derived verdict when the agent stops without reporting one; classified errors (infra, agent, timeout, cancelled); one automatic retry for infrastructure failures; installing an APK or app bundle before a run.
- **CLI and CI.** `tapocalypse serve | doctor | run | status`, with `--wait`, JSON output, JUnit XML and verdict-based exit codes for CI.
- **MCP.** Tools to list projects, devices and suites, start single runs and batches, wait on one or many runs, steer, cancel, re-run, and read reports.
- **Run metadata.** Branch, commit, pull request, tickets, labels and app build recorded per run and searchable.
- **Reports.** Per-project markdown reports with a table of contents, a link back to the run and a screenshot gallery; report HTML is sanitized.
- **Projects.** Detection of Flutter, React Native / Expo, native Android and iOS and Kotlin Multiplatform repositories; folder suggestions when adding a project.
- **Web UI.** Rebuilt as a React 19, Tailwind v4 and shadcn/ui app with a sidebar shell, command palette, dashboard with live strip and filters, run workbench, devices page, setup guide, notifications, and light and dark themes.
- **Platform.** Doctor checks for omp sign-in and operating-system support, XDG config and data locations, optional retention of old runs, macOS and Linux support.
- **Devices and queue.** A Devices page with run slots, live thumbnails and per-device state, manual boot and shutdown of configured AVDs and simulators, and a plain-language reason on every queued run. Watches and TVs are never used for QA.
- **Run history.** Delete a finished run from the UI or `DELETE /api/runs/:id`; `retention.days` / `retention.maxRuns` clean up old runs automatically.
- **Security hardening.** Sanitized report HTML with external images dropped, a Content-Security-Policy and frame protection for the UI, `X-Frame-Options` / `frame-ancestors` on API responses, a 1 MiB request body limit, and Host, Origin and content-type guards.
- **CLI.** `tapocalypse serve --dev` starts Bun's development server with hot reloading.
- **Documentation.** Configuration and HTTP API / MCP references under `docs/`.
- **Open source project files.** Continuous integration, issue and pull request templates, contributing guide and security policy.

[0.1.0]: https://github.com/miles-pudge-halter/tapocalypse/commits/main
