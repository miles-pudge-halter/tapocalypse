# AGENTS.md

Guidance for coding agents (omp, Claude Code, Cursor, …) working in this repository. `CLAUDE.md` is a symlink to this file.

## What this is

Tapocalypse: a local Bun server + React UI + MCP endpoint that runs parallel, agent-driven mobile QA. A run = project + brief + device; the server spawns a headless agent in the app's repo through a *harness* adapter (`omp --mode rpc`, `claude -p` stream-json or `codex exec --json`), which drives an Android emulator / iOS simulator through mobile-mcp (optionally Artemis, omp only) and reports checks back through the progress tools (`qa_plan`, `qa_check`, `qa_finish`): the run-scoped MCP endpoint `POST /mcp/runs/<id>` for every harness, plus omp host tools. User docs: `README.md`, `docs/guide.md`, `docs/configuration.md`, `docs/api.md`, `docs/agent-setup.md`.

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
| CLI | `bun src/cli.ts --help` (`serve`, `doctor`, `run`, `status`) |
| Frontend bundle check | `NODE_ENV=production bun -e 'await Bun.build({entrypoints:["./web/index.html"],outdir:"/tmp/tb",plugins:[(await import("bun-plugin-tailwind")).default]})'` |

Smoke a second instance without touching real data: `TAPOCALYPSE_PORT=43xx TAPOCALYPSE_CONFIG=$(mktemp -d)/c.json TAPOCALYPSE_DATA_DIR=$(mktemp -d) bun start`. Never restart or kill someone else's server on 4310; never `pkill` by pattern.

## Layout

| Path | Role |
|---|---|
| `src/server.ts`, `src/api.ts` | `Bun.serve` + routing (`fetchHandler`), Host/Origin/content-type guards, security headers, SSE |
| `src/app.ts` | composition root: scheduler + runner + views (`runView`, `queryRuns`, `batchView`) |
| `src/runs/` | `types.ts` (Run model), `store.ts` (run dirs + in-memory index), `scheduler.ts` (queue, devices, batches, rerun, retry), `runner.ts` (lifecycle), `outcome.ts` (pure: derived verdict, exit classification incl. harness limits, usage), `prompt.ts` (persona, prompt built with the harness's `toolName`, progress tool schemas), `progress.ts` (`ProgressRecorder`: records `qa_plan`/`qa_check`/`qa_finish` for both transports and writes the `check` activity), `source.ts` (git/PR metadata) |
| `src/harness/` | `types.ts` (the `Harness` interface, `HarnessId`, capabilities, `HarnessEvent`, canonical tool names; change it only deliberately), `index.ts` (registry, `getHarness`, `resolveHarnessId` precedence, cached `detectInstalled`), `omp/` (`rpc.ts` JSONL RPC client, `provision.ts` mobile-mcp via `--plugin-dir` + tool-prefix discovery, frame mapping), `claude/` (`claude -p` stream-json), `codex/` (`codex exec --json`) |
| `src/devices/` | discovery, screencap, app version, boot/idle pool |
| `src/projects/` | registry (config-backed CRUD), detection, folder suggestions |
| `src/mcp/server.ts`, `src/mcp/run-server.ts` | MCP tools (stateless streamable HTTP); `run-server.ts` is the run-scoped progress endpoint (`handleRunMcp`, bearer token per run) |
| `src/reports/`, `src/suites.ts`, `src/batches.ts`, `src/stats.ts`, `src/retention.ts`, `src/doctor.ts`, `src/cli.ts` | as named |
| `web/` | React 19 + Tailwind v4 + shadcn/ui (new-york, zinc). `lib/api.ts` (client + wire types), `lib/hooks.ts` (routes, SSE stores, shortcuts), `views/*`, `components/{run,report}/*`, `components/ui/*` (shadcn, generated) |
| `personas/default-mobile-qa.md` | built-in QA persona |
| `templates/briefs/*.md` | generic brief templates |
| `test/` | `bun:test`; `test/preload.ts` sets a temp config + data dir before any `src` import |

## Conventions (enforced in review)

- TypeScript strict. No `any`/`as any` — use `unknown` + zod or narrowing. `Promise.withResolvers()` instead of `new Promise(executor)`. `Bun.sleep` for delays. No one-expression helper wrappers unless exported or reused 3+ times. `Record` for static lookup tables.
- External input (HTTP bodies, MCP args, config, run.json) is parsed with zod once. Mutating routes go through the existing guards; new JSON routes must be added to the JSON-body check.
- Persisted run fields are additive: `store.getRun` normalizes old `run.json` files to defaults (`harness` defaults to `"omp"`). Never break old data: `events.jsonl` keeps raw harness frames and replays them through `harnesses[run.harness].toActivity`.
- Harness code lives behind `src/harness/types.ts`: the runner never branches on a harness id, it reads `capabilities`. Adapters write temp config under the run dir (never the repo or the user's home), pass secrets by env, and map tool names to the canonical form (`mcp__<server>_<tool>`, `bash`, `read`, `write`, `edit`, `search`). Progress tool calls are recorded server-side; `toActivity` returns null for them so they are not shown twice.
- Shell commands use argument arrays, never strings; package ids must match `PACKAGE_RE` before reaching `adb shell`.
- UI: every state has loading (Skeleton), error (Alert) and empty (EmptyState) handling and works in light + dark. Render agent text via JSX only; the single allowed `dangerouslySetInnerHTML` is the server-sanitized report HTML. Add shadcn components with `bunx --bun shadcn@latest add <name>` and then remove any bogus `cn` dependency / `import … from "cn"` the CLI injects.
- Tests are hermetic: temp dirs, fake command runners, no real adb/emulator/gh/omp/claude/codex. The data dir is shared across test files — assert only on ids your test created. Write a failing-before/passing-after test for bug fixes.
- No personal paths or third-party app/project names in tracked files (this repo is public).

## Hard-won facts (don't rediscover)

### omp

- **RPC**: first frame `ready`; `prompt`'s `response` returns immediately — completion is `session_settled` / `prompt_result{sessionSettled:true}`. Never send `negotiate_protocol` v2. Host tools via `set_host_tools`; calls arrive as `host_tool_call`.
- **MCP tools in omp are mounted as `xd://` devices**: a call shows as tool `write` with `args.path = "xd://mcp__<server>_<tool>"`; `read xd://…` only fetches docs. They are NOT in `get_state.dumpTools`; they appear ~1–3.5 s after `ready` under "MCP Tool Routes" in `get_state.systemPrompt`. Prompting earlier fails with "No such tool".
- **Provisioning**: omp has no per-session MCP flag; `--plugin-dir <dir>` with a `.mcp.json` works (servers namespaced `mcp__<plugin>_<server>_*`; names >64 chars get hash-truncated → plugin is named `tpc`). omp drops a plugin server whose command duplicates a configured one.

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
- **Everything goes through `-c key=value` (TOML)**: persona = `developer_instructions=<JSON string>` (a JSON string is a valid TOML basic string; it appears in argv); MCP = `mcp_servers.<name>.url` / `.command` + `.bearer_token_env_var=TPC_RUN_TOKEN` (token in the child env, never argv), `.required=true` (fails startup if the server cannot initialise), `.default_tools_approval_mode="auto"`, `.tool_timeout_sec=300` and `.startup_timeout_sec=60` (defaults 60 s / 10 s are too short for mobile-mcp: element lists take 5–25 s, a cold `npx` ~3.5 s). Unknown `-c` keys surface as `item.completed{type:"error"}` items, so treat those as notices, not failures.
- **Events**: `thread.started`, `turn.started`, `item.started|updated|completed` (`agent_message`, `reasoning`, `command_execution`, `file_change`, `mcp_tool_call{server,tool,arguments,result,error,status}`, `web_search`, `todo_list`, `error`), `turn.completed{usage}`, `turn.failed`, `error`. Tokens only (`input`, `cached_input`, `output`, `reasoning_output`), no cost, no steering, no turn/time limit.
- **Sandbox**: exec defaults to `read-only`; `workspace-write` blocks the network and `adb` needs its localhost server, so device QA runs `danger-full-access` + `approval_policy="never"`. MCP servers are not sandboxed. `codex login status` exits 1 when signed out. Parallel runs share one sqlite state under `CODEX_HOME`; concurrency safety is not verified.

### Harness-agnostic

- **Run MCP server name is `tpc`**, never `tapocalypse` (that is the user's global run-management server, and `backendViolation` flags `mcp__tapocalypse_*`). Keep server names short and free of `_`/hyphen surprises: omp hash-truncates long tool names.
- **Tool-name prefixes differ per harness** (omp `xd://` writes, Claude `mcp__s__t`, Codex `server`+`tool` fields), so prompts and activity matching must use `session.toolName(server, tool)` and canonical names, never hard-coded prefixes.
- **Persona `model:` is harness-native**: it applies only when the persona's `harness:` equals the run's harness (no `harness:` = omp). Effort/thinking strings are harness-native too; `splitThinking` is omp-only.

### Devices and tooling

- **mobile-mcp** addresses emulators by AVD name (not adb serial), iOS simulators by UDID. Its own UiAutomation session already exposes Flutter semantics; element listing on large Flutter trees can take 5–25 s.
- **Artemis** is optional (`artemisPath`, omp only); measured ~2× faster screen reads on Flutter but no correctness gain, heavy install. Its helper and mobile-mcp's on-device DeviceServer can't share UiAutomation.
- `simctl appinfo` often omits `CFBundleShortVersionString`; read the bundle's `Info.plist`.
- Bun HTML-import routes (`"/": index`) can't carry response headers → CSP is a `<meta>` in `web/index.html` plus `web/frame-guard.ts`.
- `bun-plugin-tailwind` peer-depends on `bun`; auto-installing peers shadows the user's Bun binary.

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
