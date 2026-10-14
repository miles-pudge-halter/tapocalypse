# AGENTS.md

Guidance for coding agents (omp, Claude Code, Cursor, …) working in this repository. `CLAUDE.md` is a symlink to this file.

## What this is

Tapocalypse: a local Bun server + React UI + MCP endpoint that runs parallel, agent-driven mobile QA. A run = project + brief + device; its report and screenshots are stored in `<data dir>/runs/<id>/` (`report.md`, `screenshots/`), never in the repo; the server spawns a headless agent in the app's repo through a *harness* adapter (`omp --mode rpc`, `claude -p` stream-json or `codex exec --json`), which drives an Android emulator / iOS simulator through mobile-mcp and reports checks back through the progress tools (`qa_plan`, `qa_check`, `qa_finish`): the run-scoped MCP endpoint `POST /mcp/runs/<id>` for every harness, plus omp host tools. User docs: `README.md`, `docs/guide.md`, `docs/configuration.md`, `docs/api.md`, `docs/agent-setup.md`, `docs/hub.md` (team hub: deploy, access proxy, tokens, laptop sync).

If `.agent-memory/MEMORY.md` exists (gitignored, maintainer-local), read it first: it holds project history, decisions, research and the next steps.

## Commands

| Task | Command |
|---|---|
| Install | `bun install` (never let a `node_modules/.bin/bun` appear — `bunfig.toml` sets `peer = false`) |
| Run (prod bundle) | `bun start` → http://127.0.0.1:4310 |
| Run (HMR) | `bun run dev` |
| Tests | `bun test` (also run `bun test --randomize` a few times; tests must be order-independent) |
| Types | `bun run typecheck` |
| Setup check | `bun run doctor` |
| CLI | `bun src/cli.ts --help` (`serve`, `service`, `doctor`, `run`, `status`, `report`, `compare`, `share`, `hub`) |
| Frontend bundle check | `NODE_ENV=production bun -e 'await Bun.build({entrypoints:["./web/index.html"],outdir:"/tmp/tb",plugins:[(await import("bun-plugin-tailwind")).default]})'` |

Smoke a second instance without touching real data: `TAPOCALYPSE_PORT=43xx TAPOCALYPSE_CONFIG=$(mktemp -d)/c.json TAPOCALYPSE_DATA_DIR=$(mktemp -d) bun start`. Never restart or kill someone else's server on 4310; never `pkill` by pattern.

## Layout

| Path | Role |
|---|---|
| `src/server.ts`, `src/api.ts` | `Bun.serve` + routing (`fetchHandler`), Host/Origin/content-type guards, security headers, SSE |
| `src/app.ts` | composition root: scheduler + runner + views (`runView`, `queryRuns`, `batchView`) |
| `src/regression/` | Regression intelligence: `keys.ts` (pure: `canonicalTitle`, fingerprints, `matchScore`, `assignTestKey`, `assignCheckKeys`), `index.ts` (derived in-memory index over the store: `backfill`, `runsOfTest`, `checkEntries`, `hintsFor`, `relink`, `unlink`), `types.ts` (wire shapes), `baseline.ts` (`resolveBaseline` tiers, `defaultBranch`), `compare.ts` (pairing, transitions), `flaky.ts` (flip counting); the views (`compareView`, `historyView`, `flakyView`, `findRegressions`) live in `app.ts` |
| `src/runs/` | `types.ts` (Run model), `store.ts` (run dirs + in-memory index), `scheduler.ts` (queue, devices, batches, rerun, retry), `runner.ts` (lifecycle), `outcome.ts` (pure: derived verdict, exit classification incl. harness limits, usage), `prompt.ts` (persona, prompt built with the harness's `toolName`, progress tool schemas), `progress.ts` (`ProgressRecorder`: records `qa_plan`/`qa_check`/`qa_finish` for both transports, copies screenshots and the report into the run dir, writes the `check` activity), `artefacts.ts` (`runArtefactDir`, `screenshotsDir`, `reportFile`, `screenshotFile`, `exportRun`: where a run's artefacts live for both `storage: "data"` and legacy `"repo"` runs, with the path guards), `source.ts` (git/PR metadata) |
| `src/service/` | `tapocalypse service`: launchd agent (macOS) / systemd user unit (Linux) that runs `serve` in the background; `serviceCommand` with injectable deps, only ever addresses its own label/unit |
| `src/harness/` | `types.ts` (the `Harness` interface, `HarnessId`, capabilities, `HarnessEvent`, canonical tool names; change it only deliberately), `index.ts` (registry, `getHarness`, `resolveHarnessId` precedence, cached `detectInstalled`), `bridge.ts` (stdio-bridge launch helper shared by Codex and omp), `omp/` (`rpc.ts` JSONL RPC client, `provision.ts` per-run `--plugin-dir` mounting the stdio bridge + tool-prefix discovery, frame mapping), `claude/` (`claude -p` stream-json), `codex/` (`codex exec --json`) |
| `src/devices/` | discovery, screencap, app version, boot/idle pool; `leases.ts` is the single ownership store (`deviceOwner(serial)`): agent leases from `device_acquire` and the implicit lease of every QA run; `gateway.ts` is the lease-gated mobile-mcp proxy (child per leased device, tool cache, device pinning on every call (top-level and batch steps)) |
| `src/projects/` | registry (config-backed CRUD incl. `share`/`hubKey`), detection, folder suggestions |
| `src/hub/` | Team hub. Shared: `protocol.ts` (zod wire shapes, `HUB_PROTOCOL`), `redact.ts`, `package.ts` (`packageRun`: what a run uploads), `identity.ts` (`hubKeyFor`). Hub side (`mode.ts` `isHub()`, `tokens.ts`, `projects.ts` registry, `ingest.ts`). Laptop side (`sync.ts` outbox + worker, `credentials.ts`, `laptop-routes.ts`, `laptop-cli.ts`, `laptop-doctor.ts`). Deployment: `Dockerfile`, `compose.hub.yml`; guide `docs/hub.md` |
| `src/overview.ts` | Project overview + releases views and routes (`projectRefs`, `projectOverview`, `releaseView`, `overviewRoute`), mode-agnostic |
| `src/mcp/server.ts`, `src/mcp/run-server.ts` | MCP tools (stateless streamable HTTP); `run-server.ts` is the run-scoped progress endpoint (`handleRunMcp`, bearer token per run) |
| `src/reports/`, `src/suites.ts`, `src/batches.ts`, `src/stats.ts`, `src/retention.ts`, `src/doctor.ts`, `src/cli.ts` | as named |
| `web/` | React 19 + Tailwind v4 + shadcn/ui (new-york, zinc). `lib/api.ts` (client + wire types), `lib/hooks.ts` (routes, SSE stores, shortcuts), `views/*`, `components/{run,report}/*`, `components/ui/*` (shadcn, generated) |
| `personas/default-mobile-qa.md` | built-in QA persona |
| `templates/briefs/*.md` | generic brief templates |
| `test/` | `bun:test`; `test/preload.ts` sets a temp config + data dir before any `src` import |

## Conventions (enforced in review)

- TypeScript strict. No `any`/`as any` — use `unknown` + zod or narrowing. `Promise.withResolvers()` instead of `new Promise(executor)`. `Bun.sleep` for delays. No one-expression helper wrappers unless exported or reused 3+ times. `Record` for static lookup tables.
- External input (HTTP bodies, MCP args, config, run.json) is parsed with zod once. Mutating routes go through the existing guards; new JSON routes must be added to the JSON-body check.
- Persisted run fields are additive: `store.getRun` normalizes old `run.json` files to defaults (`harness` defaults to `"omp"`, `storage` to `"repo"`: old runs keep repo-relative report/screenshot paths and must keep rendering; `Project.reportsDir` is legacy and read-only). Never break old data: `events.jsonl` keeps raw harness frames and replays them through `harnesses[run.harness].toActivity`.
- Harness code lives behind `src/harness/types.ts`: the runner never branches on a harness id, it reads `capabilities`. Adapters write temp config under the run dir (never the repo or the user's home), pass secrets by env, and map tool names to the canonical form (`mcp__<server>_<tool>`, `bash`, `read`, `write`, `edit`, `search`). Progress tool calls are recorded server-side; `toActivity` returns null for them so they are not shown twice.
- Shell commands use argument arrays, never strings; package ids must match `PACKAGE_RE` before reaching `adb shell`.
- UI: every state has loading (Skeleton), error (Alert) and empty (EmptyState) handling and works in light + dark. Render agent text via JSX only; the single allowed `dangerouslySetInnerHTML` is the server-sanitized report HTML. Add shadcn components with `bunx --bun shadcn@latest add <name>` and then remove any bogus `cn` dependency / `import … from "cn"` the CLI injects.
- Tests are hermetic: temp dirs, fake command runners, no real adb/emulator/gh/omp/claude/codex. The data dir is shared across test files — assert only on ids your test created. Write a failing-before/passing-after test for bug fixes.
- No personal paths or third-party app/project names in tracked files (this repo is public).

## Hard-won facts (don't rediscover)

### omp

- **RPC**: first frame `ready`; `prompt`'s `response` returns immediately — completion is `session_settled` / `prompt_result{sessionSettled:true}`. Never send `negotiate_protocol` v2. Host tools via `set_host_tools`; calls arrive as `host_tool_call`.
- **MCP tools in omp are mounted as `xd://` devices**: a call shows as tool `write` with `args.path = "xd://mcp__<server>_<tool>"`; `read xd://…` only fetches docs. They are NOT in `get_state.dumpTools`; they appear ~1–3.5 s after `ready` under "MCP Tool Routes" in `get_state.systemPrompt`. Prompting earlier fails with "No such tool".
- **Provisioning**: omp has no per-session MCP flag; `--plugin-dir <dir>` with a `.mcp.json` works (servers namespaced `mcp__<plugin>_<server>_*`; names >64 chars get hash-truncated → plugin is named `tpc`). The adapter writes `<runDir>/plugin/tpc/.mcp.json` (server key `qa`, command = the Bun binary running `src/mcp/stdio-bridge.ts <runDir>/tpc-mcp.json`), so the gateway's device tools appear as `mcp__tpc_qa_mobile_*`; `qa_*` stay omp host tools. There is no per-session mobile-mcp for any harness anymore. Prefix discovery matches only `mcp__tpc_*` names: a mobile-mcp the user configured themselves is never adopted.

### Claude Code (`claude -p`)

- **Classify on `is_error` + `terminal_reason`, never on `result.subtype`**: a failed API call (connection refused) still has `subtype:"success"`, with `is_error:true`, `terminal_reason:"api_error"`, exit 1. Limits are `error_max_turns` / `max_turns` and `error_max_budget_usd` / `budget_exhausted`; Tapocalypse maps them to `errorKind: "timeout"`.
- **One `result` per turn, not per process.** With `--input-format stream-json` every queued stdin message produces its own `system/init` → `assistant` → `result`. The process stays alive until **stdin is closed**: close it after the final `result` or the run hangs until the hard kill.
- **Steer and interrupt over stdin**: steer = another `user` message written mid-turn (read once the running tool calls finish); interrupt = `control_request{subtype:"interrupt"}` → `control_response`. SIGINT ends the turn cleanly, SIGTERM exits 143 with the turn unfinished.
- **`--strict-mcp-config` is not optional.** Without `--bare` (which refuses OAuth), `-p` loads the repo's `.mcp.json` and `.claude/settings.json` hooks with no trust prompt, plus the user's global MCP servers (including the Tapocalypse one). Strict mode drops all MCP config except `--mcp-config <runDir>/mcp.json`.
- **Tool names**: MCP tools are `mcp__<server>__<tool>` (double underscore, hyphens kept); canonical form is `mcp__<server>_<tool>`. Built-ins: `Bash`→`bash` {command}, `Read`→`read` {path}, `Write`→`write`, `Edit`/`MultiEdit`→`edit`, `WebSearch`→`search`. `--disallowedTools Agent` blocks subagents. `alwaysLoad:true` on the `tpc` entry keeps `qa_*` out of tool-search deferral.
- `-p` waits for MCP servers before turn 1 (up to `MCP_TIMEOUT`, 30 s). `total_cost_usd` is a client-side estimate. `bypassPermissions` refuses to run as root.

### Codex CLI (`codex exec --json`)

- **`codex exec` waits on stdin** ("Reading additional input from stdin…") unless it is closed: pass `-`, write the prompt, close stdin. It needs `--skip-git-repo-check` outside a git repo and `-C <cwd>`.
- **Side effect**: the first run in a directory appends `[projects."<cwd>"] trust_level = "trusted"` to `~/.codex/config.toml`. Accepted and documented (SECURITY.md); do not "fix" it with a different `CODEX_HOME` (auth lives there).
- **Everything goes through `-c key=value` (TOML)**: persona = `developer_instructions=<JSON string>` (a JSON string is a valid TOML basic string; it appears in argv); MCP = `mcp_servers.<name>.command` + `.args` only (older Codex versions reject `.url`, so the progress server is reached through `src/mcp/stdio-bridge.ts` with an owner-only `{url, token}` file under the run dir; token never in argv or env), `.required=true` (fails startup if the server cannot initialise), `.default_tools_approval_mode="auto"`, `.tool_timeout_sec=300` and `.startup_timeout_sec=60` (defaults 60 s / 10 s are too short for mobile-mcp: element lists take 5–25 s, a cold `npx` ~3.5 s). Unknown `-c` keys surface as `item.completed{type:"error"}` items, so treat those as notices, not failures.
- **Events**: `thread.started`, `turn.started`, `item.started|updated|completed` (`agent_message`, `reasoning`, `command_execution`, `file_change`, `mcp_tool_call{server,tool,arguments,result,error,status}`, `web_search`, `todo_list`, `error`), `turn.completed{usage}`, `turn.failed`, `error`. Tokens only (`input`, `cached_input`, `output`, `reasoning_output`), no cost, no steering, no turn/time limit.
- **Sandbox**: exec defaults to `read-only`; `workspace-write` blocks the network and `adb` needs its localhost server, so device QA runs `danger-full-access` + `approval_policy="never"`. MCP servers are not sandboxed. `codex login status` exits 1 when signed out. Parallel runs share one sqlite state under `CODEX_HOME`; concurrency safety is not verified.

### Harness-agnostic

- **Run MCP server name is `tpc`**, never `tapocalypse` (that is the user's global run-management server, and `backendViolation` flags `mcp__tapocalypse_*`). Keep server names short and free of `_`/hyphen surprises: omp hash-truncates long tool names.
- **Gateway tool names**: adapters canonicalise only tpc-origin device tools (omp `mcp__tpc_qa_mobile_x`, Claude `mcp__tpc__mobile_x`, Codex server `tpc`) to `mcp__mobile_mcp_mobile_x`; on a gated run any other `mobile_mcp` server keeps its raw name, and `backendViolation` is called on the normalised raw name (`mcp__<server>__<tool>`, plugin namespace stripped) so an agent's own mobile-mcp is flagged. (omp cannot tell a user-configured `mobile-mcp` apart from the canonical name: both are `mcp__mobile_mcp_mobile_x`; strict MCP config isolation is what prevents it for Claude/Codex.) Run children are keyed by run id and stopped when the run lease ends.
- **The runner warms and checks the gateway before spawning the agent** (`gateway.tools()` before `harness.spawn`): omp drops an MCP server whose first `tools/list` takes a few seconds and never retries within the session (measured: a 4 s first listing through the bridge never appears), and a cold mobile-mcp probe takes ~3.4 s, so the run endpoint must answer from memory. An empty list (probe failed or timed out; `gateway.probeError()` carries the reason) ends the run `infra` ("device tools unavailable: …") before any agent starts, and it is retried. The server also warms the gateway at boot. omp has no host-initiated tool call to verify a bridge with, so when its prompt bounds the route list ("mappings omitted") and the bridge is not listed within the wait, it counts as not connected (never "trust the plan"). `Run.gated` (set at spawn, `false` default for old `run.json`) travels in `ReplayContext`: `backendViolation(raw, gated)` flags `mobile_mcp` names only on gated runs, and adapters give a pre-gateway run's own `mobile_mcp` calls the canonical name; the `mcp__tapocalypse_` rule applies always.
- **Tool-name prefixes differ per harness** (omp `xd://` writes, Claude `mcp__s__t`, Codex `server`+`tool` fields), so prompts and activity matching must use `session.toolName(server, tool)` and canonical names, never hard-coded prefixes.
- **Persona `model:` is harness-native**: it applies only when the persona's `harness:` equals the run's harness (no `harness:` = omp). Effort/thinking strings are harness-native too; `splitThinking` is omp-only.

### Devices and tooling

- **mobile-mcp** addresses emulators by AVD name (not adb serial), iOS simulators by UDID. Its own UiAutomation session already exposes Flutter semantics; element listing on large Flutter trees can take 5–25 s.
- `simctl appinfo` often omits `CFBundleShortVersionString`; read the bundle's `Info.plist`.
- Bun HTML-import routes (`"/": index`) can't carry response headers → CSP is a `<meta>` in `web/index.html` plus `web/frame-guard.ts`.
- `bun-plugin-tailwind` peer-depends on `bun`; auto-installing peers shadows the user's Bun binary.

### Device leases

- **One ownership store, `src/devices/leases.ts`.** Every claim on a device is a lease: an agent's (`device_acquire`) or the implicit one a QA run holds from assignment to release. `deviceOwner(serial)` is the only *ownership* check (scheduler `usable`, the shutdown route, the Devices overlay); the idle reaper and `shutdownDevice` also read `booted.lastReleasedAt`, which the store keeps current through `markAssigned`/`markReleased`; `Scheduler.assigned` no longer exists. The store calls `pool.markAssigned`/`markReleased` on every grant and end, so a leased booted device is never idle-reaped. Run leases are not persisted (runs become `interrupted` on restart); agent leases are, in `<data dir>/leases.json` (0600, atomic) with their wall-clock `expiresAt`.
- **`leaseId` is a secret capability** (16 random bytes, base64url): returned once by `device_acquire`, looked up by SHA-256 digest and compared with `timingSafeEqual`, never in a list, event, view or log. The UI and SSE use the public `ref` (8 hex), which guards the force-release route against stale pages. Wrong, unknown, expired and released ids all give `lease_not_found`; only an id that matches a tombstone (last 100 ended leases) also gets the reason.
- **One FIFO across runs and agent tickets** with backfill. `maxConcurrentRuns` gates run entries only and *skips* them at the cap (it must not `break` the pass, or agents behind a capped run starve). A ticket outlives its call by 60 s; a grant made while detached is a claim-pending lease with a 60 s deadline. Tickets are not persisted, capped at 32.
- **Expiry** is lazy (`deviceOwner` treats `expiresAt <= now` as absent) plus a 15 s sweep in `app.ts` that also ends a lease whose serial was absent for 2 min or came back as a different AVD (emulator ports are reused), then calls `scheduler.schedule()`. Excluded serials and watch/TV cannot be leased; physical devices only by explicit serial.
- **Leases are enforced only through the gateway; everything else is cooperative.** Raw `adb`, `xcrun simctl`, an agent's own mobile-mcp, Appium and IDE deploys bypass them; do not claim otherwise in docs or UI copy.
- **The gateway (`src/devices/gateway.ts`, registered in `src/mcp/server.ts`)** hosts one mobile-mcp stdio child per leased device and serves its device tools on `/mcp` as the same names with `device` swapped for a required `leaseId`: 28 gated tools on mobile-mcp 1.0.9 (33 minus `mobile_list_available_devices` and the four remote-cloud tools). Schemas come from the child, never hand-written, and are cached in memory and in `<data dir>/gateway-tools.json` (keyed by mobile-mcp version). With no cache the first `tools/list` (or `mobile_*` call) on `/mcp` runs a cold-start probe child and waits for it (≤ 15 s), because clients list tools once at connect and stateless HTTP cannot send `list_changed`; other `/mcp` requests never wait for it, and `GET /api/mcp/status` (`gateway: { tools, mobileMcpVersion }`) only reads the cache. The handler's only identity is `leaseId` (via `touch`, which renews and marks the lease `gated`): `device` is always set server-side, in every `mobile_batch_commands` step too. The child's `cwd` is the lease's `cwd` (mobile-mcp only writes under its cwd or the temp dir). `MOBILE_MCP_BIN` (split on spaces) replaces the `npx` command, which is how `test/api-leases-e2e.test.ts` runs `test/support/fake-mobile-mcp.ts` instead of the real thing.
- **No external lock files, no `backend` request field.** The only ownership source is the lease store. Old `run.json` files may still carry a `backend` key; `normalizeRun` drops it, and `web/components/run/humanise.ts` keeps a legacy tool-label regex so old activity feeds still read well. Config keys of removed features are ignored (the schema is non-strict).

### Team hub

- **Same app, two modes.** `TAPOCALYPSE_MODE=hub` (`isHub()`) swaps `init()` for `initHub()`: no devices, leases, scheduler, harnesses, MCP or repo access, a route allowlist of GETs plus `/api/hub/v1/*`, and 404 `not available on the team hub` for everything else (`hubRouteAllowed`). `GET /api/health` returns `mode` in both modes and is what the UI boots on.
- **Never upload raw `events.jsonl`, transcripts, `session/`, `stderr.log`, `tpc-mcp.json`/`mcp.json`, `plugin/` or device serials.** The upload is the *mapped activity feed* (`readActivity`), the report, the run document and screenshots (WebP q80 unless `share.hub.screenshots: "original"`). Real data showed raw events are 79 % base64 images and held every token found; the activity export held none. `redact.ts` (paths first, longest prefix first, then secret patterns) runs on every string; briefs, notes and reports keep emails on purpose.
- **The hub recomputes regression keys.** Title keys are salted with the per-machine `projectId`, so machine-local keys diverge. The hub keeps a laptop's keys under `origin.keys`, clears them, and re-runs `keyRun` against the hub store after translating `checkHints` and manual links. Arrival order is not creation order, so an older run arriving later schedules a debounced oldest-first project re-key (`hub rekey` forces it). Laptops keep their local keys unchanged.
- **Projects merge by `hubKey`** (`github.com/acme/app[#subpath]`, from `git remote get-url origin` through `normalizeRemoteUrl`, credentials dropped; `local/<id>` only by explicit choice). The hub assigns its own project id and rewrites `projectId` on uploaded runs; the laptop's id is kept as `origin.localProjectId`. Run ids are owned by the first uploading machine (`409 id_conflict`, parked, never overwritten).
- **Upload tokens** are `tpu_` + 32 random bytes, stored as SHA-256 digests in `<data>/hub/tokens.json` (0600), compared with `timingSafeEqual`, never logged. They authorize only the upload routes. Viewers are authenticated by the access proxy only; `TAPOCALYPSE_HUB_IDENTITY_HEADER` is trusted only when the hub port is reachable solely through the proxy.
- **Laptop sync is an outbox.** `<data>/hub-outbox.json` holds the queue and `uploaded[runId] = contentHash`; a `subscribeRuns` subscriber enqueues terminal runs of `share: true` projects when the packaged hash changes (so relinks and PR updates re-upload). One upload at a time, back-off 30 s × 2ⁿ capped at 1 h, blobs checked then uploaded per file (the resume unit), then the run document. 401 and 426 pause the queue; 409 parks one run. Secrets live in `hub-credentials.json` next to the config (0600 enforced) or `TAPOCALYPSE_HUB_TOKEN` / `TAPOCALYPSE_HUB_HEADERS`, never in the config file, because the service unit carries no shell secrets. Deleting a run locally never deletes it from the hub.
- **Hub store is the in-memory store on a volume.** `ensureBuilt` must iterate oldest first (newest first made it O(n²): 16 s → 2 s at 50k runs). The hub doctor warns from 8,000 runs; the SQLite summary store is the planned answer, not a bigger heap. Hub retention defaults to 365 days (`TAPOCALYPSE_HUB_RETENTION_DAYS`, `0` keeps all).
- **`Bun.Image` needs Bun ≥ 1.3.14** (`engines.bun`).
- **Docs and fixtures are public:** invent examples (Acme Shop, `ACME-12`, `github.com/acme/shop`, machine `ann-mbp`); never copy real titles, tickets, paths or project names from research notes.

### Regression intelligence

- **Keys are persisted once, at the terminal transition.** `testKey` is set at creation (hints need it before the prompt is built), `checkKey`/`keyKind`/`keyScore` on each check when the run first reaches a terminal status (cancelled and interrupted included; `scheduler.restore()` covers runs that were live at shutdown). A live run's keys are computed on the fly and never written, so the agent may re-plan freely. `backfill()` in `init()` keys old runs once, in `createdAt` order, before `scheduler.restore()`; it is idempotent.
- **Check keys are decided by the first matching rule:** suite id → re-run lineage (same check id as the parent) → `was` naming a hint → title key → inferred (`matchScore` ≥ `INFERRED_THRESHOLD` 0.6 against the last 3 runs of the test) → new title key. One key per run: a duplicate falls through. Only pass and fail are decisive; blocked is never a regression (pass → blocked is `changed` + `lostCoverage`).
- **No SQLite, no sidecar.** The index is derived from the store's runs in memory (queries are ≤ 1 ms at 2,000 runs) and rebuilt from `run.json`; comparisons are memoised per run and index generation, never persisted. The tripwire is store size, not these queries: at about 10,000 runs store boot reaches 0.6-1.8 s and ~156 MB of heap (retention is unbounded by default). At that point move run summaries to a SQLite index with `run.json` loaded lazily, a store refactor that the regression index would then read from.
- **Manual link/unlink rewrite `run.json`** (they re-key checks, `keyKind: "manual"`); there is no alias file. A user-picked baseline lives only in the URL; the runs-list chip, `qa_compare_runs`, `qa_find_regressions` and CI always use the auto baseline. Re-run re-resolves `source` from the project at enqueue; the automatic infra retry keeps the original.
- **Flaky checks are excluded from regression counts, the chip and the CLI exit code by default** (`includeFlaky` restores them). A pass on one device and a fail on another is `deviceSensitive`, not flaky and not excluded.
- **Never put real check titles, ticket keys or project names in tests, fixtures or docs**; invent examples ("Checkout total updates", `ACME-12`).

## Workflow that has worked here

Research (`researcher`) or design (`designer`, uses Mobbin) when the question is open → plan → write a contract (types, signatures, routes, ownership per file) → fan out implementation to parallel `engineer` subagents with disjoint file ownership, each working test-first → gates (`typecheck`, `test`, randomized tests, bundle) → concurrent `code-reviewer` subagents split by concern (lifecycle / API+security / frontend) → one batched fix round → QA pass (`qa` subagent) when the change touches user-visible flows: every touched page in a real browser in light + dark at 1100 and 1440 px, HTTP/MCP/CLI surfaces against a sandboxed instance, and a real device smoke run when the runner or devices changed → fix defects → commit. Subagents never run the full gates or formatters; the orchestrator does, once.

Project subagents live in `.omp/agents/` (omp picks them up automatically):

|Agent|Model|Use for|
|---|---|---|
|`engineer`|Sonnet 5.5|every coding slice; mandatory TDD (one failing test → minimal code → green, repeat); runs only its own test file|
|`code-reviewer`|Sonnet 5.5|read-only review of a change set, one instance per concern|
|`designer`|Opus 5.5|UI/UX specs for a screen, with Mobbin references (`mobbin_url`)|
|`researcher`|Opus 5.5|tool/library/approach evaluations and product audits, decision-ready report|
|`qa`|Sonnet 5.5|hands-on QA of Tapocalypse on a sandboxed instance (browser, API, MCP, CLI, optional device run); report with screenshots and severities|

Engineering and code review always run on Sonnet 5.5; design and research always on Opus 5.5.
