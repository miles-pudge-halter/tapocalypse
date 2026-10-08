# AGENTS.md

Guidance for coding agents (omp, Claude Code, Cursor, …) working in this repository. `CLAUDE.md` is a symlink to this file.

## What this is

Tapocalypse: a local Bun server + React UI + MCP endpoint that runs parallel, agent-driven mobile QA. A run = project + brief + device; the server spawns a headless `omp --mode rpc` agent in the app's repo, which drives an Android emulator / iOS simulator through mobile-mcp (optionally Artemis) and reports checks back through host tools (`qa_plan`, `qa_check`, `qa_finish`). User docs: `README.md`, `docs/configuration.md`, `docs/api.md`.

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
| `src/runs/` | `types.ts` (Run model), `store.ts` (run dirs + in-memory index), `scheduler.ts` (queue, devices, batches, rerun, retry), `runner.ts` (lifecycle), `outcome.ts` (pure: derived verdict, exit classification, usage), `prompt.ts` (persona, prompt, host tools, `frameToActivity`), `source.ts` (git/PR metadata) |
| `src/omp/` | `rpc.ts` (JSONL RPC client), `provision.ts` (mobile-mcp via `--plugin-dir`, tool-prefix discovery) |
| `src/devices/` | discovery, screencap, app version, boot/idle pool |
| `src/projects/` | registry (config-backed CRUD), detection, folder suggestions |
| `src/mcp/server.ts` | MCP tools (stateless streamable HTTP) |
| `src/reports/`, `src/suites.ts`, `src/batches.ts`, `src/stats.ts`, `src/retention.ts`, `src/doctor.ts`, `src/cli.ts` | as named |
| `web/` | React 19 + Tailwind v4 + shadcn/ui (new-york, zinc). `lib/api.ts` (client + wire types), `lib/hooks.ts` (routes, SSE stores, shortcuts), `views/*`, `components/{run,report}/*`, `components/ui/*` (shadcn, generated) |
| `personas/default-mobile-qa.md` | built-in QA persona |
| `templates/briefs/*.md` | generic brief templates |
| `test/` | `bun:test`; `test/preload.ts` sets a temp config + data dir before any `src` import |

## Conventions (enforced in review)

- TypeScript strict. No `any`/`as any` — use `unknown` + zod or narrowing. `Promise.withResolvers()` instead of `new Promise(executor)`. `Bun.sleep` for delays. No one-expression helper wrappers unless exported or reused 3+ times. `Record` for static lookup tables.
- External input (HTTP bodies, MCP args, config, run.json) is parsed with zod once. Mutating routes go through the existing guards; new JSON routes must be added to the JSON-body check.
- Persisted run fields are additive: `store.getRun` normalizes old `run.json` files to defaults. Never break old data.
- Shell commands use argument arrays, never strings; package ids must match `PACKAGE_RE` before reaching `adb shell`.
- UI: every state has loading (Skeleton), error (Alert) and empty (EmptyState) handling and works in light + dark. Render agent text via JSX only; the single allowed `dangerouslySetInnerHTML` is the server-sanitized report HTML. Add shadcn components with `bunx --bun shadcn@latest add <name>` and then remove any bogus `cn` dependency / `import … from "cn"` the CLI injects.
- Tests are hermetic: temp dirs, fake command runners, no real adb/emulator/gh/omp. The data dir is shared across test files — assert only on ids your test created. Write a failing-before/passing-after test for bug fixes.
- No personal paths or third-party app/project names in tracked files (this repo is public).

## Hard-won facts (don't rediscover)

- **omp RPC**: first frame `ready`; `prompt`'s `response` returns immediately — completion is `session_settled` / `prompt_result{sessionSettled:true}`. Never send `negotiate_protocol` v2. Host tools via `set_host_tools`; calls arrive as `host_tool_call`.
- **MCP tools in omp are mounted as `xd://` devices**: a call shows as tool `write` with `args.path = "xd://mcp__<server>_<tool>"`; `read xd://…` only fetches docs. They are NOT in `get_state.dumpTools`; they appear ~1–3.5 s after `ready` under "MCP Tool Routes" in `get_state.systemPrompt`. Prompting earlier fails with "No such tool".
- **Provisioning**: omp has no per-session MCP flag; `--plugin-dir <dir>` with a `.mcp.json` works (servers namespaced `mcp__<plugin>_<server>_*`; names >64 chars get hash-truncated → plugin is named `tpc`). omp drops a plugin server whose command duplicates a configured one.
- **mobile-mcp** addresses emulators by AVD name (not adb serial), iOS simulators by UDID. Its own UiAutomation session already exposes Flutter semantics; element listing on large Flutter trees can take 5–25 s.
- **Artemis** is optional (`artemisPath`); measured ~2× faster screen reads on Flutter but no correctness gain, heavy install. Its helper and mobile-mcp's on-device DeviceServer can't share UiAutomation.
- `simctl appinfo` often omits `CFBundleShortVersionString`; read the bundle's `Info.plist`.
- Bun HTML-import routes (`"/": index`) can't carry response headers → CSP is a `<meta>` in `web/index.html` plus `web/frame-guard.ts`.
- `bun-plugin-tailwind` peer-depends on `bun`; auto-installing peers shadows the user's Bun binary.

## Workflow that has worked here

Plan → write a contract (types, signatures, routes, ownership per file) → fan out implementation to parallel subagents with disjoint file ownership → gates (`typecheck`, `test`, randomized tests, bundle) → concurrent reviewers split by concern (lifecycle / API+security / frontend) → one batched fix round → browser verification of every page in light + dark at 1100 and 1440 px → a real device smoke run → commit. Subagents never run gates or formatters; the orchestrator does, once.
