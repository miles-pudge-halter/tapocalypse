# HTTP API and MCP tools

Back to the [README](../README.md). Everything the web UI does goes through this API, so anything you can click you can script. The server binds `127.0.0.1` only; see the [security model](guide.md#security-model) for the request guards that apply to every route below.

## Conventions

- Errors are JSON `{ "error": "<message>" }` with the matching status (400 invalid input, 403 forbidden host or origin, 404 unknown id, 409 conflict, 415 wrong content type).
- `POST`/`PUT` routes that take a body need `Content-Type: application/json`. Request bodies are limited to 1 MiB.
- A `Run` in responses carries everything in `run.json` (status, checks, verdict, `verdictSource`, `errorKind`, `usage`, `source`, `build`, `attempt`, `retryOf`/`retriedBy`, `harness`, `model`, `effort`, `storage`, …) plus `queuePosition`, `queueReason` (why a queued run is still waiting), `durationMs` and `reportFile` (the absolute path of the report, or `null`). `storage` is `"data"` for runs whose report and screenshots live in Tapocalypse's data folder (`<data dir>/runs/<id>/report.md`, `screenshots/`) and `"repo"` for runs from before that change, whose repo-relative paths keep working.
- `harness` is `omp`, `claude` or `codex` (see [Agent runtimes](guide.md#agent-runtimes)); an unknown value is a 400. `model` is a harness-native string and `thinking` carries the reasoning level in that harness's terms (omp thinking, Claude Code `--effort`, Codex CLI `model_reasoning_effort`). A run records the `harness` it used, `effort` (the same level; omp runs also keep `thinking`), and runs from before harnesses existed read as `omp`.
- Run ids look like `20260101-093015-a1b2-dark-mode-toggle`, batch ids like `b-20260101-093015-a1b2`.

## HTTP routes

### Runs and batches

| Route | Purpose |
| --- | --- |
| `POST /api/runs` | Queue a run. Body: `{ projectId, title?, brief?, suiteId?, device?: { platform?, serial? }, harness?, backend?, packageId?, model?, thinking?, effort?, install?: { path }, source?, requestedBy? }`. Give a `brief` or a `suiteId`. Without `harness` the default is resolved (project, persona, config, first installed and signed in, else first installed, else omp). `backend: "artemis"` with a harness other than `omp` is a 400. Title ≤ 200 chars, brief ≤ 20 000. Returns 201 and the run |
| `GET /api/runs` | Newest-first page `{ runs, hasMore }`. Query: `project`, `status` (comma list), `verdict` (comma list; `none` matches runs without one), `q` (title, branch, PR, ticket, commit), `batch`, `branch`, `pr`, `ticket`, `commit` (sha prefix), `limit` (default 100, max 500), `before` (a `createdAt` cursor) |
| `GET /api/runs/:id` | One run |
| `DELETE /api/runs/:id` | Delete a finished run and its folder (409 while it is queued or active) |
| `POST /api/runs/:id/cancel` | Cancel a queued or active run |
| `POST /api/runs/:id/steer` | `{ message }` (≤ 4000 chars) to a running agent. 409 `steering is not supported by <harness>` when the run's harness cannot be steered (`capabilities.steer` in `GET /api/harnesses`) |
| `POST /api/runs/:id/rerun` | `{ only: "failed" \| "all", device?, harness? }` queues a new run from a finished one, on the original run's harness unless you name another; 400 when nothing failed |
| `GET /api/runs/:id/events` | Server-sent events: `snapshot` (`{ run, activity, hasMoreActivity }`), then `run` and `activity` updates |
| `GET /api/runs/:id/activity?before=&limit=` | Activity feed page (`seq` cursor; default 200, max 500) |
| `GET /api/runs/:id/stderr?tail=` | Last lines of the agent's stderr as text (default 200, max 5000; 404 if none) |
| `GET /api/runs/:id/screenshots` | Screenshots of the run, with the check each belongs to and a `url` for each |
| `GET /api/runs/:id/files/<path>` | A screenshot of the run (`screenshots/<name>`): only files inside the run's own folder with extension `png`, `jpg`, `jpeg`, `webp` or `gif` and real image content (checked by magic bytes); 404 otherwise. Served with `X-Content-Type-Options: nosniff`. Runs from before the data-folder storage serve their images from `/files/:projectId/<path>` below |
| `GET /api/runs/:id/report` | `{ markdown }`, the report as the agent wrote it (404 when the run has none) |
| `POST /api/runs/:id/export` | `{ dir }` (absolute path, no NUL byte) copies the report as `QA-REPORT-<id>.md` and the screenshots as `screenshots/<name>` into `dir`, creating it. `dir` is as trusted as any local client, but never inside Tapocalypse's data folder or a `.git` folder (400). Returns `{ report, screenshots }`: the absolute paths written |
| `GET /api/runs/:id/transcript` | The full agent transcript as HTML, served sandboxed (404 until exported; only harnesses with `capabilities.transcriptExport`, today omp, write one) |
| `POST /api/batches` | `{ projectId, title?, brief?, suiteId?, devices: [{ platform?, serial? }] (1-8), harness?, backend?, packageId?, model?, thinking?, effort?, install?, source?, requestedBy? }`. Returns 201 `{ batchId, runs }` |
| `GET /api/batches/:id` | `{ id, projectId, title, runs, status: "active" \| "done", verdict, cost, startedAt, endedAt }` |
| `GET /api/events` | Global server-sent events: every `run` update and `projects` changes; drives the live lists |
| `GET /api/stats?project=&days=7` | Totals for the last 1-90 days: runs, pass/fail/issues/other, cost, median duration, per-day buckets |

### Projects, reports and suites

| Route | Purpose |
| --- | --- |
| `GET /api/projects` | Projects with `status` (`ok`/`invalid`) and problems |
| `POST /api/projects` | Create a project (201). Body as in [Projects](guide.md#projects) |
| `PUT /api/projects/:id` | Change fields of a project |
| `DELETE /api/projects/:id` | Remove a project (409 while it has queued or active runs; the repo is untouched) |
| `POST /api/projects/validate` | `{ input, mode: "create" \| "update", existingId? }` checks a project without saving |
| `POST /api/projects/detect` | `{ repoPath }` suggests every project field from the repo |
| `GET /api/projects/suggestions` | Likely app folders found under common code directories |
| `GET /api/projects/:id/reports` | Reports of the project's runs plus, for old runs, the reports found in the project's legacy `reportsDir`, newest first (title, verdict, run id) |
| `GET /api/projects/:id/reports/:name` | `{ name, title, verdict, html, runId, headings, images }` with sanitized HTML. `name` is a run id, or the file name of a legacy report |
| `GET /api/projects/:id/suites` | Saved suites of the project |
| `POST /api/projects/:id/suites` | Save a suite `{ title, brief, id?, checks?, platforms?, model?, overwrite? }` (201; 409 if it exists without `overwrite`) |
| `GET /files/:projectId/<path>` | Legacy report assets, for runs from before the data-folder storage: only files inside the project's `reportsDir` with extension `png`, `jpg`, `jpeg`, `webp`, `gif`, `txt` or `json`; served with `X-Content-Type-Options: nosniff` |

### Devices, environment and misc

| Route | Purpose |
| --- | --- |
| `GET /api/devices` | Connected devices with busy, booting and Artemis flags, friendly name, OS version, screen and device type |
| `GET /api/devices/pool` | Run slots in use, emulators booted vs `maxBooted`, bootable AVDs/simulators, idle shutdown times |
| `POST /api/devices/boot` | `{ platform, target }` boots a configured AVD or simulator (202) |
| `POST /api/devices/:serial/shutdown` | Shut down a device Tapocalypse booted (409 if it is in use or was not booted by Tapocalypse) |
| `GET /api/devices/:serial/screen.png` | Current screenshot (`Cache-Control: no-store`; 404 when not connected) |
| `GET /api/doctor?fresh=1` | The prerequisite report behind `bun run doctor` and the Setup page |
| `GET /api/harnesses` | `{ default, harnesses: [{ id, label, installed, capabilities }] }`: the three agent runtimes, which are installed, and the resolved default. `capabilities` is `{ steer, interrupt, appendSystemPrompt, nativeProgressTools, costReported, limits: { maxTime, maxTurns, maxBudgetUsd }, transcriptExport, backends }`; the UI uses it for the harness picker, the steer box and the Transcript button |
| `GET /api/models?harness=` | `{ models }`: model ids to offer for a harness (recently used, configured and persona models first, then what the harness itself lists; any string is still accepted). Defaults to the default harness; unknown `harness` is a 400 |
| `GET /api/templates` | Built-in brief templates |
| `GET /api/mcp/status` | MCP URL and the last tool call received (used by the Setup page) |
| `POST /mcp` | The MCP endpoint (streamable HTTP, stateless; other methods get 405) |
| `POST /mcp/runs/:id` | The run-scoped progress endpoint, called by the agent a run starts; see [Run progress endpoint](#run-progress-endpoint) |

## MCP tools

Register `http://127.0.0.1:<port>/mcp` in your agent; see [Dispatching runs from your coding agent](guide.md#dispatching-runs-from-your-coding-agent-mcp). Results are JSON text; failures are returned as MCP errors with the message.

`source` is `{ path?, branch?, commit?, prNumber?, prTitle?, prUrl?, tickets?, labels? }`. Pass `source.path` = your working directory when you work in a git worktree, so the run records your branch, commit and PR.

### Projects and environment

| Tool | Purpose |
| --- | --- |
| `qa_list_projects` | Registered projects with `status` and problems. Only `ok` projects can start runs |
| `qa_detect_project { repoPath }` | Inspect a repo and suggest project settings |
| `qa_create_project { repoPath, id?, name?, defaultPackage?, defaultPlatform?, personaFile? }` | Register a project; omitted fields come from detection |
| `qa_update_project { id, repoPath?, name?, defaultPackage?, defaultPlatform?, personaFile? }` | Change only the fields you pass |
| `qa_delete_project { id }` | Remove a project (fails while it has queued or active runs) |
| `qa_list_devices` | Connected devices with `busyRunId`, booting and Artemis flags |
| `qa_doctor` | Prerequisite report with a fix for anything missing, including which agent harnesses are installed and signed in |
| `qa_list_suites { projectId }` | Saved suites (reusable briefs with fixed check ids) |

### Starting and steering runs

| Tool | Purpose |
| --- | --- |
| `qa_start_run { projectId, title?, brief?, suiteId?, platform?, serial?, harness?, backend?, packageId?, model?, thinking?, install?, requester?, source? }` | Queue a run; returns `runId`, `status`, `queuePosition`, a UI `url` and the recorded `source`. `install` is an absolute `.apk` / `.app` / `.ipa` path installed before the run |
| `qa_start_batch { projectId, title?, brief?, suiteId?, devices: [{ platform?, serial? }] (1-8), harness?, backend?, packageId?, model?, thinking?, install?, requester?, source? }` | One run per device entry; returns `batchId`, a `url` and the runs |
| `qa_rerun { runId, only: "failed" \| "all", platform?, serial?, harness?, requester? }` | New run from a finished one, on the same harness unless you pass another |
| `qa_steer_run { runId, message }` | Send an instruction to a running agent; fails when the run's harness cannot be steered |
| `qa_cancel_run { runId }` | Cancel a queued or active run |

### Reading results

| Tool | Purpose |
| --- | --- |
| `qa_get_run { runId }` | Status, checks, verdict, summary, error and `errorKind`, `verdictSource`, usage and duration, absolute `reportPath` and `screenshotsDir` (in Tapocalypse's data folder), source, build, batch and attempt info |
| `qa_wait_run { runId, timeoutSec? }` | Block until the run finishes or `timeoutSec` (default 90, clamped to 5-110) passes; check `timedOut` and call again. An infrastructure failure that was retried automatically is followed to the newest attempt |
| `qa_wait_runs { runIds?, batchId?, mode?: "all" \| "any", timeoutSec? }` | Same for several runs or a whole batch; returns every run's summary and the batch rollup |
| `qa_list_runs { projectId?, branch?, prNumber?, ticket?, commit?, status?, limit? }` | Recent runs, newest first (default 20, max 100) |
| `qa_get_report { runId }` | The markdown report the agent wrote, read from Tapocalypse's data folder (error if the run has none) |
| `qa_get_screenshots { runId }` | `[{ checkId, name, path, url }]`: every screenshot of the run, `path` absolute in the data folder, `url` served by Tapocalypse. Read the images from `path` |
| `qa_export { runId, dir }` | Copy the report (`QA-REPORT-<id>.md`) and the screenshots (`screenshots/<name>`) into the absolute folder `dir`, for example inside your repo or a CI artefact folder (never inside Tapocalypse's data folder or a `.git` folder). Returns `{ report, screenshots }`. Nothing is exported unless you call this |

Runs launched by Tapocalypse are told never to call `tapocalypse` tools, so registering the server at user level cannot cause recursion.

## Run progress endpoint

Agents report their checks to Tapocalypse through a second MCP endpoint that exists once per run: `POST /mcp/runs/<runId>`. It is not for your own tools; Tapocalypse starts every harness with this endpoint (server name `tpc`) mounted, so a harness only needs MCP support to drive the UI's live checks. omp also registers the same three tools natively as host tools, and both paths feed one recorder. The recorder stores the screenshots and the report in the run's folder in the data directory, so the agent never writes into your repo.

- **Transport.** Streamable HTTP, stateless, `POST` only, like `/mcp`. The request guards from the [security model](guide.md#security-model) apply, and the `/mcp/runs/:id` route needs `Content-Type: application/json`.
- **Auth.** `Authorization: Bearer <token>`. The token is 32 random bytes (hex), created when the run's agent is spawned and handed to it through an owner-only file (mode 0600) in the run's data folder: `mcp.json` for Claude Code, `tpc-mcp.json` read by the stdio bridge for Codex CLI (the file stays until retention removes the run), never on the command line, in your repo, or in `run.json`, `events.jsonl` or `stderr.log`. omp uses host tools and needs no token. It is compared in constant time and stops working when the run ends. A missing or wrong token, an unknown run and a finished run all get the same JSON-RPC "Unauthorized" error with HTTP 401, so a caller cannot probe which run ids exist.
- **Tools.**

| Tool | Arguments | Effect |
| --- | --- | --- |
| `qa_plan` | `{ checks: [{ id, title }] }` (at least one) | Declares every check before the first device action; they show as pending |
| `qa_check` | `{ id, status, note?, screenshot? }`; `status` is `running`, `pass`, `fail`, `blocked` or `skipped`; `screenshot` is an absolute path, or a path relative to the agent's working directory (the repo), of an image file (`png`, `jpg`, `jpeg`, `webp` or `gif`, checked by its first bytes, at most 25 MB) that lies inside the repo, the run's folder or the OS temp directory | Sets a check's status and copies the image into the run's `screenshots/` folder (unless it is already there; the reply names the stored file, for example `screenshots/01-home.png`); also writes the `check` line into the activity feed |
| `qa_finish` | `{ verdict, summary, reportMarkdown?, reportPath? }`; `verdict` is `PASS`, `FAIL`, `PASS WITH ISSUES`, `BLOCKED` or `PARTIAL`; give exactly one of `reportMarkdown` (the report text, up to 2 MB) or `reportPath` (a `.md`, `.markdown` or `.txt` file of at most 2 MB the agent wrote, absolute or relative to its working directory, inside the repo, the run's folder or the OS temp directory) | Called exactly once. The report is stored as the run's `report.md`; the source file of a `reportPath` is left untouched. Images are linked in the report as `screenshots/<name>`, the names returned by `qa_check` |

Screenshot and report files named by the agent are read from the filesystem, copied into the run's folder and never served from where they were. They must resolve (symlinks followed) inside the repo, the run's folder or the OS temp directory; anything else is refused. Invalid input (a missing file, a file outside those roots, a file that is not an image, a screenshot over 25 MB, a report over 2 MB, both or neither of `reportMarkdown` and `reportPath`) is returned to the agent as a tool error so it can correct itself. Tool names as the model sees them depend on the harness (`mcp__tpc__qa_plan` in Claude Code, `qa_plan` for omp's host tools); Tapocalypse spells them correctly in each run's prompt.
