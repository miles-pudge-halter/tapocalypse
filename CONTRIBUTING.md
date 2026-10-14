# Contributing to Tapocalypse

Thanks for helping. Tapocalypse is a local developer tool: a Bun server, a React UI and an MCP endpoint that start headless coding-agent CLIs ([omp](https://github.com/can1357/oh-my-pi), [Claude Code](https://code.claude.com) or [Codex CLI](https://github.com/openai/codex), called *harnesses*) to QA mobile apps on emulators and simulators.

## Setup

You need [Bun](https://bun.sh) 1.3.14 or newer and, to exercise real runs, at least one of omp, Claude Code or Codex CLI (signed in) plus Android `adb` and/or Xcode. See [Prerequisites](docs/guide.md#prerequisites) in the guide.

```sh
git clone https://github.com/miles-pudge-halter/tapocalypse.git
cd tapocalypse
bun install
bun run doctor      # shows what is missing on your machine
```

## Dev loop

```sh
bun run dev         # server with hot reload; the UI hot-reloads in the browser
bun test            # unit tests
bun run typecheck   # tsc --noEmit over src, test and web
```

CI runs `bun install --frozen-lockfile`, `bun run typecheck` and `bun test` on Linux and macOS. Run the last two before you push, and commit `bun.lock` when you change dependencies.

Use a throwaway config and data directory when you need a second instance next to one with real data:

```sh
TAPOCALYPSE_PORT=4399 TAPOCALYPSE_CONFIG=/tmp/tpc/config.json TAPOCALYPSE_DATA_DIR=/tmp/tpc/data bun src/server.ts
```

The CLI is `src/cli.ts` (`bun src/cli.ts --help`); it only needs a running server for `run` and `status`.

## Tests

- Tests live in `test/` and use `bun:test`. `test/preload.ts` points the config and data directory at a temporary fake project, so tests never touch your real state.
- Test behaviour a user or integrator could notice: lifecycle transitions, scheduling rules, parsing, path safety, error mapping. Do not pin wording, copies of the implementation or incidental defaults.
- A bug fix comes with a test that fails without the fix.
- Tests must be deterministic and must not need adb, a simulator or a model provider. Stub the device and harness layers (see `test/scheduler.test.ts`, `test/rpc.test.ts` and the adapter tests; `test/fixtures/` holds recorded or synthetic streams of each harness, such as `rpc-session.jsonl` for omp). A harness adapter is tested by feeding its fixture stream or a fake child process through its public interface, never by launching the real CLI.

## Adding a harness

A harness is one folder, `src/harness/<id>/index.ts`, that exports `harness: Harness` (see `src/harness/types.ts`) and is registered in `src/harness/index.ts`. It spawns the CLI headless, normalizes its event stream into `HarnessEvent`s, maps tool names to the canonical form, reports its capabilities (steer, cost, transcript, limits) and doctor checks, and writes any per-run config under the run folder, never into the repository or the user's home. Secrets such as the run's progress token go through the environment, not argv. Keep the raw frames verbatim in `events.jsonl`; `toActivity` replays them. Test it test-first with a fixture stream and a fake child process.

## Code style

- Strict TypeScript, no `any`.
- Match the surrounding code; prefer small, boring modules. No one-line wrapper helpers unless they are reused.
- Anything that touches a file path from a client or an agent goes through `resolveUnder` in `src/reports/reports.ts`; where a run's report and screenshots live (and the guarded lookups for them) is `src/runs/artefacts.ts`. Agents never write into the user's repo: new artefacts go under the run's folder in the data dir.
- Older persisted runs (missing newer fields) must keep loading: add defaults in the store, do not require a migration. In particular, runs with `storage: "repo"` (the default for runs without the field) keep repo-relative `reportPath` / `Check.screenshot` values, and must keep rendering from the project's `reportsDir`.

## UI (`web/`)

The UI is React 19 with Tailwind v4 and [shadcn/ui](https://ui.shadcn.com) (new-york style, zinc base). `components.json` maps shadcn to `web/components/ui`.

```sh
bunx --bun shadcn@latest add <component>    # e.g. sheet, command
```

Every view needs a loading state (Skeleton), an error state (Alert) and an empty state, and must look right in light and dark mode. Render text through JSX; the only place HTML is injected is the sanitized report body.

## Pull requests

1. Open an issue first for anything larger than a bug fix, so the direction is agreed.
2. Keep each pull request focused; describe what changed and how you tested it (screenshots for UI changes).
3. Update the README and `CHANGELOG.md` when users will notice the change.

Security problems: do not open a public issue, see [SECURITY.md](SECURITY.md).

By contributing you agree your work is released under the [MIT license](LICENSE).
