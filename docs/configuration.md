# Configuration reference

Back to the [README](../README.md). Tapocalypse is configured with one JSON file and a handful of environment variables. Most day-to-day settings (projects) are managed from the UI; the file is for the device pool, limits and retention.

## Where files live

| What | Location (first match wins) |
| --- | --- |
| Config file | `$TAPOCALYPSE_CONFIG`; a legacy `tapocalypse.config.json` in the Tapocalypse checkout, if it exists; otherwise `$XDG_CONFIG_HOME/tapocalypse/config.json` (default `~/.config/tapocalypse/config.json`) |
| Data directory | `$TAPOCALYPSE_DATA_DIR`; a legacy `data/` folder in the checkout, if it exists; otherwise `$XDG_DATA_HOME/tapocalypse` (default `~/.local/share/tapocalypse`) |

Existing installs that already have the in-repo `tapocalypse.config.json` or `data/` keep using them, so nothing moves on upgrade. Fresh installs use the XDG locations. To migrate, move the file or folder and restart. The server prints the config path it created on first start. Each run's report and screenshots are stored in the data directory too (`runs/<id>/report.md`, `runs/<id>/screenshots/`), never in your repositories.

The config file is created with the defaults below when it does not exist. It is validated at startup (`fatal: config: …`, exit 1 when invalid) and read once: restart after editing it by hand. Projects added in the UI or over MCP take effect immediately and are written back to the file. [`tapocalypse.config.example.json`](../tapocalypse.config.example.json) is a copy of the defaults plus an `agent` block that spells out the default permission and sandbox settings (it leaves `agent.harness` unset, so the default is the first harness that is installed and signed in, else the first installed, else omp).

## Keys

| Key | Default | Meaning |
| --- | --- | --- |
| `port` | `4310` | HTTP port; the server only binds `127.0.0.1` |
| `maxConcurrentRuns` | `2` | Runs executing at once (including ones waiting for an emulator to boot). Mind your RAM: each emulator needs several GB |
| `runMaxTime` | `"60m"` | Time budget per run, shown to the agent and passed to omp as `--max-time` (the other harnesses have no time flag). Tapocalypse hard-kills Claude Code and Codex CLI at the budget and omp, which enforces it itself, 5 minutes after it. Must be a valid duration, checked at startup (`fatal: config: …`, exit 1): `90m`, `1h30m`, `45s`, `2h`; a bare number is minutes. At 80% of it the agent is told to wrap up; see [Run outcomes](guide.md#run-outcomes) |
| `projects` | `[]` | Project objects, see [Projects](guide.md#projects). Normally managed from the UI |
| `agent.harness` | unset | Default [agent harness](#agent-harnesses): `omp`, `claude` or `codex`. Unset: the first of omp, Claude Code and Codex CLI that is installed and signed in, else the first installed, else omp |
| `agent.harnesses.<id>` | unset | Settings for one harness (`omp`, `claude` or `codex`): `bin`, `model`, `effort`, `permissions`, `sandbox`. See [Agent harnesses](#agent-harnesses) |
| `agent.maxTurns` | unset | Claude Code only (`--max-turns`): end the session after this many agent turns. Other harnesses ignore it. One mobile check takes 5-20 tool calls, so leave it unset unless you want a hard cap |
| `agent.maxBudgetUsd` | unset | Claude Code only (`--max-budget-usd`): end the session once it has spent about this much. Other harnesses ignore it |
| `agent.model`, `agent.thinking` | unset | Legacy omp keys, kept as they were: the omp model and thinking level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) for runs whose request, suite, project and persona name none. Prefer `agent.harnesses.omp.model` / `.effort` |
| `projects[].agent` | unset | Per-project override `{ harness?, model?, effort? }`, see [Projects](guide.md#projects) |
| `projects[].defaultBranch` | unset | Branch that [regression comparisons](guide.md#regressions-history-and-flaky-checks) treat as the project's default, for example `main`. Unset: the repo's `origin/HEAD` (looked up with `git`, cached for 10 minutes), else `main` or `master` if the repo has one |
| `retry.infra` | `1` | Automatic retries of a run that failed on infrastructure (boot failure, agent crash, MCP tools missing) before any check resolved. `0` disables retries |
| `retention.days` | unset | Delete finished runs that ended more than this many days ago. Unset keeps them |
| `retention.maxRuns` | unset | Keep only the newest this-many runs, deleting older finished ones. Unset keeps them |
| `share.s3.bucket` | unset | Bucket that receives shared single-file HTML reports; setting `share.s3` turns on **Copy share link** and `tapocalypse share`. See [Sharing](#sharing) |
| `share.s3.endpoint` | unset (AWS) | S3-compatible endpoint URL, for example a Cloudflare R2 or MinIO endpoint |
| `share.s3.region` | unset | Signing region (R2 uses `auto`) |
| `share.s3.credentialsFile` | `share-credentials.json` next to the config file | JSON file with the S3 credentials, used when no credentials are set in the environment. Absolute path or `~/...`. See [Sharing](#sharing) |
| `share.s3.prefix` | `"tapocalypse/"` | Key prefix; reports are stored as `<prefix><project id>/<run id>-<random>.html` |
| `share.s3.expiresInDays` | `7` | How long a share link works, 1 to 7 days (the SigV4 maximum) |
| `devicePool.android.avds` | `[]` | AVD names (`emulator -list-avds`) Tapocalypse may boot on demand. Wear OS, TV and Automotive AVDs are never booted automatically |
| `devicePool.android.basePort` | `5560` | First emulator console port; booted emulators get even ports from here |
| `devicePool.android.maxBooted` | `1` | Max emulators Tapocalypse keeps booted at once; `0` disables auto-boot |
| `devicePool.android.minSize` | `"720x1280"` | Booted emulators with a smaller screen are overridden to this size (`WxH`) |
| `devicePool.android.minDensity` | `320` | Density (dpi) used with that override |
| `devicePool.android.idleShutdownMinutes` | `20` | Shut down a Tapocalypse-booted emulator after this much idle time |
| `devicePool.android.excludeSerials` | `[]` | Android serials that are never used: not picked for runs, and not leasable by agents (`device_excluded`) |
| `devicePool.ios.simulators` | `[]` | Simulator UDIDs Tapocalypse may boot on demand (macOS only) |
| `devicePool.ios.idleShutdownMinutes` | `20` | Same idle shutdown for simulators |

`retention` is evaluated at startup and every 6 hours. It only removes run folders under the data directory, which now include each run's report and screenshots (export what you want to keep first with `tapocalypse report <id> --export <dir>`); files that old runs wrote into your repositories are never touched, and queued or active runs are never deleted. See [Data and retention](guide.md#data-and-retention).

A fresh config file contains the defaults above for `port`, `maxConcurrentRuns`, `runMaxTime`, `projects` and `devicePool`; `agent`, `retry` and `retention` are optional and can be added by hand.

**Ignored keys.** Keys the schema does not know, including those of removed features, are ignored. Runs no longer take a `backend`; old runs that recorded one still load. [Device leases](guide.md#sharing-devices-between-agents) have no settings: the TTL (default 30 min, 5-120) is chosen per lease by the agent, and agent leases are stored in `<data dir>/leases.json`.

## Sharing

Every finished run can be downloaded as one self-contained HTML file with no setup. To also hand out **links**, point Tapocalypse at a private S3-compatible bucket:

```json
{
  "share": {
    "s3": {
      "bucket": "team-qa-reports",
      "endpoint": "https://<account-id>.r2.cloudflarestorage.com",
      "region": "auto",
      "prefix": "tapocalypse/",
      "expiresInDays": 7
    }
  }
}
```

Only `bucket` is required. Credentials are **never** read from the config file. Tapocalypse looks for them, in this order, every time you share (no restart needed):

1. **Environment variables** of the server: `S3_ACCESS_KEY_ID` + `S3_SECRET_ACCESS_KEY`, or `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` (both of a pair are needed).
2. **A credentials file**, by default `share-credentials.json` in the same folder as the active config file (or the path in `share.s3.credentialsFile`):

   ```json
   { "accessKeyId": "...", "secretAccessKey": "...", "sessionToken": "optional" }
   ```

   Create it with `chmod 600`: like an SSH key, a file that group or other users can read is refused, and the **Copy share link** button and `tapocalypse share` report why (`GET /api/share/status` returns `configured: false` and a `problem`).

Use the file when Tapocalypse runs under `tapocalypse service`: the launchd/systemd unit carries no secrets, so environment variables you export in your shell do not reach it, but the file does.

 The bucket must stay private: Tapocalypse uploads the file and returns a presigned URL, so **anyone holding the link can open that report until it expires**, and nobody else can list or read the bucket. The key needs permission to write and read objects under the prefix. Links cannot be revoked before they expire; delete the object to pull one early. How it looks in use: [Sharing a report](guide.md#sharing-a-report).

## Agent harnesses

A *harness* is the headless coding-agent CLI that plays the QA agent: `omp`, `claude` (Claude Code) or `codex` (Codex CLI). Which one a run uses, and the settings it gets, come from the config like this:

```json
{
  "agent": {
    "harness": "claude",
    "maxBudgetUsd": 15,
    "harnesses": {
      "omp": { "model": "provider/model:high" },
      "claude": { "model": "opus", "effort": "high", "permissions": "allowlist" },
      "codex": { "model": "gpt-5.5", "effort": "high", "sandbox": "danger-full-access" }
    }
  },
  "projects": [
    { "id": "my-app", "name": "My app", "repoPath": "/path/to/my-app", "agent": { "harness": "codex", "model": "gpt-5.5" } }
  ]
}
```

| Setting (`agent.harnesses.<id>.…`) | Applies to | Meaning |
| --- | --- | --- |
| `bin` | all | Executable to start. Default `omp`, `claude`, `codex` from `PATH`; the environment variables `OMP_BIN`, `CLAUDE_BIN`, `CODEX_BIN` win over it |
| `model` | all | Default model for runs that name none. A harness-native string: omp `provider/model[:thinking]`, Claude Code an alias (`opus`, `sonnet`, `haiku`) or full model id, Codex CLI a `gpt-…` id. There is no translation between harnesses |
| `effort` | all | Default reasoning level: omp thinking (`off` … `max`), Claude Code `--effort` (`low`, `medium`, `high`, `xhigh`, `max`), Codex CLI `model_reasoning_effort` (`minimal`, `low`, `medium`, `high`, `xhigh`) |
| `permissions` | `claude` | `"bypass"` (default): `--permission-mode bypassPermissions`, the equivalent of omp's `--auto-approve`. `"allowlist"`: `dontAsk` mode with an allowlist for the device-driver and progress tools, `adb`, `xcrun simctl` and file read, write and edit; every other command is denied and shows as a warning in the activity feed. Personas that run other shell commands need `bypass` |
| `sandbox` | `codex` | `"danger-full-access"` (default) or `"workspace-write"`. Always combined with `approval_policy="never"`. `workspace-write` blocks the network, which `adb` and `xcrun simctl` may need, so device runs generally need the default |

**Harness precedence** (first that is set wins): the run's own `harness`, the project's `agent.harness`, the persona's `harness:` frontmatter, `agent.harness`, the first harness that is installed and signed in (omp, Claude Code, Codex CLI, in that order; cached `--version` and sign-in probes), the first that is installed, then `omp`.

**Model precedence:** the run's `model`, the suite's `model`, the project's `agent.model`, the persona's `model:` (only when the persona's `harness:` equals the run's harness; a persona without `harness:` counts as omp), `agent.harnesses.<harness>.model`, then, for omp only, the legacy `agent.model`. The harness's own default applies when nothing is set. **Effort** resolves the same way (run, suite, project `agent.effort`, persona, `agent.harnesses.<harness>.effort`, then for omp the legacy `agent.thinking`). The model and effort a run used are stored on the run (`model`, `effort`; `thinking` stays filled for omp runs).

**Limits.** `runMaxTime` applies to every harness: omp enforces it with `--max-time` and Tapocalypse kills it 5 minutes after the budget; Claude Code and Codex CLI are killed at the budget. `agent.maxTurns` and `agent.maxBudgetUsd` apply to Claude Code only. A limit that ends a session is reported as a run with `errorKind: "timeout"` and the limit named in `error`; the verdict is derived from the resolved checks as for a time-out ([Run outcomes](guide.md#run-outcomes)).

**What a harness can do.** Steering a running agent works with omp and Claude Code but not Codex CLI (`POST /api/runs/:id/steer` answers 409). Cost is reported by omp (when the provider says) and Claude Code; Codex CLI reports tokens only. An HTML transcript is omp-only. Each adapter writes its per-run configuration into the run's data folder, never into your repository or your home directory. The run's progress token reaches the agent through an owner-only file (mode 0600) in the run's data folder: `mcp.json` for Claude Code, `tpc-mcp.json` for the stdio bridge Codex CLI talks to; the file stays until retention removes the run; omp uses host tools and needs no token. It is never on the command line or in `run.json`, `events.jsonl` or `stderr.log`. One side effect is outside Tapocalypse's control: the first `codex exec` in a repository makes Codex CLI add that path as trusted to `~/.codex/config.toml`; see [SECURITY.md](../SECURITY.md).

## Environment variables

| Variable | Effect |
| --- | --- |
| `TAPOCALYPSE_CONFIG` | Config file path (see above) |
| `TAPOCALYPSE_DATA_DIR` | Data directory (see above) |
| `TAPOCALYPSE_PORT` | Overrides `port`. `tapocalypse serve --port` sets it. The CLI also uses it to find the server |
| `TAPOCALYPSE_URL` | Server URL for `tapocalypse run` / `status` / `report` (default `http://127.0.0.1:<port>`); `--url` wins |
| `XDG_CONFIG_HOME`, `XDG_DATA_HOME` | Base directories for the default config and data locations |
| `OMP_BIN`, `CLAUDE_BIN`, `CODEX_BIN`, `ADB_BIN`, `XCRUN_BIN`, `GIT_BIN`, `GH_BIN` | Binaries to use instead of `omp`, `claude`, `codex`, `adb`, `xcrun`, `git`, `gh` from `PATH`. The harness variables override `agent.harnesses.<id>.bin` |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Credentials for `share.s3` (`AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` work too, as Bun's S3 client reads them). They win over the credentials file. Never put them in the config file; under `tapocalypse service` use the [credentials file](#sharing) instead |
| `MOBILE_MCP_BIN` | Command line that starts the mobile-mcp children of the `/mcp` device gateway instead of `npx -y @mobilenext/mobile-mcp@latest` (a pinned install, or a stand-in in tests). It is split on spaces, so a path that contains spaces cannot be used |
| `EMULATOR_BIN` | Android emulator binary. Otherwise looked up (not on `PATH`) at `$ANDROID_HOME/emulator/emulator`, `$ANDROID_SDK_ROOT/emulator/emulator`, `~/Library/Android/sdk/emulator/emulator` (macOS), then `~/Android/Sdk/emulator/emulator` (Linux) |
| `ANDROID_HOME`, `ANDROID_SDK_ROOT` | Android SDK location used for the emulator lookup |
| `OMP_PROFILE` / `PI_PROFILE` | omp only: if you run omp with a profile, set it here too so Tapocalypse reads that profile's MCP config |
| `NODE_ENV` | `bun start` and `tapocalypse serve` set `production`; `tapocalypse serve --dev` and `bun src/server.ts` without it enable Bun's development server (hot module reloading, browser console forwarding) |
| `NO_COLOR` | Disables colour in `bun run doctor` output |

## Command line

```sh
bun start                                 # production server
bun run dev                               # server with hot reload
bun src/cli.ts serve [--port 4311] [--dev]
bun src/cli.ts service install|uninstall|start|stop|restart|status|logs
bun src/cli.ts report <runId> [--export <dir>] [--json]
bun src/cli.ts report <runId> --html <file>              # write the standalone HTML report to <file>
bun src/cli.ts share <runId>                              # upload it and print a presigned link (exit 2 when share.s3 is not configured)
bun src/cli.ts compare <runId|batchId> [--baseline <runId|auto>] [--include-flaky] [--json] [--junit <file>]
bun run doctor
```

`serve --dev` runs the same server with Bun's development server (hot module reloading for the UI and browser console forwarding); without it `serve` runs in production mode. The `run`, `status`, `report` and `compare` commands are described in [CLI and CI](guide.md#cli-and-ci); `run --harness omp|claude|codex` picks the agent runtime for one run, and `run --fail-on regression` fails only on newly failing checks.

`service` keeps the server running in the background and starts it at login: `install` writes a launchd agent (macOS, `~/Library/LaunchAgents/dev.tapocalypse.server.plist`) or a systemd user unit (Linux, `~/.config/systemd/user/tapocalypse.service`) and starts it; `status` shows whether it is installed, running and answering; `logs` prints the end of `<data dir>/logs/service.log` (Linux: the journal); `start`, `stop` and `restart` control it; `uninstall` stops it and removes the unit. The unit stores the environment it was installed from (`PATH`, `HOME`, `TAPOCALYPSE_*`, `ANDROID_HOME`, `ANDROID_SDK_ROOT` and the `*_BIN` variables above), so run `install` again after changing it. It only touches its own unit and is not supported on Windows. Details: [Running as a service](guide.md#running-as-a-service).

`report <runId>` prints a run's markdown report; `--export <dir>` copies the report (as `QA-REPORT-<runId>.md`) and its screenshots into `<dir>` instead, and `--json` prints `{ runId, reportPath, markdown }`. Details: [Reading reports and screenshots](guide.md#reading-reports-and-screenshots).

`report <runId> --html <file>` writes the run's [standalone HTML report](guide.md#sharing-a-report), and `share <runId>` uploads it to the bucket from [`share.s3`](#sharing) and prints the presigned link (exit code 2 when sharing is not configured).
