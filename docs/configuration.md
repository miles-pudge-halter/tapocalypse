# Configuration reference

Back to the [README](../README.md). Tapocalypse is configured with one JSON file and a handful of environment variables. Most day-to-day settings (projects) are managed from the UI; the file is for the device pool, limits and retention.

## Where files live

| What | Location (first match wins) |
| --- | --- |
| Config file | `$TAPOCALYPSE_CONFIG`; a legacy `tapocalypse.config.json` in the Tapocalypse checkout, if it exists; otherwise `$XDG_CONFIG_HOME/tapocalypse/config.json` (default `~/.config/tapocalypse/config.json`) |
| Data directory | `$TAPOCALYPSE_DATA_DIR`; a legacy `data/` folder in the checkout, if it exists; otherwise `$XDG_DATA_HOME/tapocalypse` (default `~/.local/share/tapocalypse`) |

Existing installs that already have the in-repo `tapocalypse.config.json` or `data/` keep using them, so nothing moves on upgrade. Fresh installs use the XDG locations. To migrate, move the file or folder and restart. The server prints the config path it created on first start. Each run's report and screenshots are stored in the data directory too (`runs/<id>/report.md`, `runs/<id>/screenshots/`), never in your repositories. The data directory and `runs/` are created with mode 0700 and an existing one is tightened to 0700 at server start (a legacy in-repo `data/` too); only the folders themselves change, never what is inside them. If that fails (someone else owns the folder, a read-only mount) the server warns and starts anyway.

The config file is created with the defaults below when it does not exist. It is validated at startup (`fatal: config: …`, exit 1 when invalid) and read once: restart after editing it by hand. Projects added in the UI or over MCP take effect immediately and are written back to the file. [`tapocalypse.config.example.json`](../tapocalypse.config.example.json) is a copy of the defaults plus an `agent` block that spells out the default permission and sandbox settings (it leaves `agent.harness` unset, so the default is the first harness that is installed and signed in, else the first installed, else omp).

## Keys

| Key | Default | Meaning |
| --- | --- | --- |
| `port` | `4310` | HTTP port; the server only binds `127.0.0.1` (a [team hub](hub.md) binds `TAPOCALYPSE_HOST`) |
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
| `projects[].share` | `false` | Opt this project in to the [team hub](hub.md): its finished runs upload to `share.hub.url` automatically. Never on by default; turning it off stops future uploads and leaves what is already on the hub. A hub key is required, see below |
| `projects[].hubKey` | derived | The key that merges this project's runs with teammates' runs of the same app on the hub: lowercase `host/path` of the git remote `origin` (credentials in the URL dropped) plus `#subpath` for an app inside a monorepo, for example `github.com/acme/shop#apps/mobile`. Set it when the repo has no remote (suggestion `local/<project id>`) or when two projects on this machine would derive the same key. See [Team hub sharing](#team-hub-sharing) |
| `retry.infra` | `1` | Automatic retries of a run that failed on infrastructure (boot failure, agent crash, MCP tools missing) before any check resolved. `0` disables retries |
| `retention.days` | unset | Delete finished runs that ended more than this many days ago. Unset keeps them |
| `retention.maxRuns` | unset | Keep only the newest this-many runs, deleting older finished ones. Unset keeps them |
| `share.s3.bucket` | unset | Bucket that receives shared single-file HTML reports; setting `share.s3` turns on **Copy share link** and `tapocalypse share`. See [Sharing](#sharing) |
| `share.s3.endpoint` | unset (AWS) | S3-compatible endpoint URL, for example a Cloudflare R2 or MinIO endpoint |
| `share.s3.region` | unset | Signing region (R2 uses `auto`) |
| `share.s3.credentialsFile` | `share-credentials.json` next to the config file | JSON file with the S3 credentials, used when no credentials are set in the environment. Absolute path or `~/...`. See [Sharing](#sharing) |
| `share.s3.prefix` | `"tapocalypse/"` | Key prefix; reports are stored as `<prefix><project id>/<run id>-<random>.html` |
| `share.s3.expiresInDays` | `7` | How long a share link works, 1 to 7 days (the SigV4 maximum) |
| `share.hub.url` | unset | Address of the [team hub](hub.md), for example `https://qa.example.com`. Together with an upload token it connects this machine; see [Team hub sharing](#team-hub-sharing) |
| `share.hub.screenshots` | `"webp"` | `"webp"` re-encodes uploaded screenshots to WebP quality 80 (about 10× smaller); `"original"` uploads the files unchanged |
| `share.hub.live` | `true` | Send the progress of a shared project's runs **while they run**, so teammates see status and checks on the hub live (no screen, activity or screenshots until the run finishes). `false` keeps runs private until they are done. See "Live progress" in [Team hub sharing](#team-hub-sharing) |
| `share.hub.headers` | unset | Extra request headers sent on every hub request, for an access proxy that accepts static headers. Not for secrets: secret values go in `hub-credentials.json` |
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

Use the file when Tapocalypse runs under `tapocalypse service`: the launchd/systemd unit carries no secrets, so environment variables you export in your shell do not reach it, but the file does. These variables are also removed from the environment of every agent and mobile-mcp child (`AWS_*` only while `share.s3` is configured); see [What an agent's environment lacks](#agent-harnesses).

**What is redacted.** The shared HTML (a link, a download, `tapocalypse report --html`, `qa_share_report`) is redacted like a hub upload before it is built, so the title, summary, run facts, check titles and notes, the report and screenshot names carry `~`, `<repo>`, `<data>`, `<tmp>`, `<user>` and `<device>` instead of your paths, account name and device ids, and secret-shaped text is masked. It is a backstop, not a guarantee; the full list is in [the hub guide](hub.md#what-is-uploaded-and-what-never-is). Screenshots are embedded as they are.

 The bucket must stay private: Tapocalypse uploads the file and returns a presigned URL, so **anyone holding the link can open that report until it expires**, and nobody else can list or read the bucket. The key needs permission to write and read objects under the prefix. Links cannot be revoked before they expire; delete the object to pull one early. How it looks in use: [Sharing a report](guide.md#sharing-a-report).

## Team hub sharing

A [team hub](hub.md) is a read-only copy of your team's runs. To upload yours, connect this machine once and then opt projects in.

```json
{
  "share": {
    "hub": {
      "url": "https://qa.example.com",
      "screenshots": "webp"
    }
  },
  "projects": [
    { "id": "shop", "name": "Shop", "repoPath": "/Users/you/code/shop", "share": true }
  ]
}
```

Only `url` is required. Everything secret stays out of the config file. Tapocalypse looks for it, in this order, every time it uploads (no restart needed):

1. **Environment variables** of the server: `TAPOCALYPSE_HUB_TOKEN` (the upload token, which starts with `tpu_`) and `TAPOCALYPSE_HUB_HEADERS` (a JSON object of extra request headers, for example `{"X-Proxy-Key":"..."}`).
2. **A credentials file**, `hub-credentials.json` in the same folder as the active config file:

   ```json
   { "token": "tpu_...", "headers": { "X-Proxy-Key": "..." } }
   ```

   `tapocalypse hub login <url>` and **Setup → Connect to a team hub** write it for you. Like `share-credentials.json`, it must be `chmod 600`: a file that group or other users can read is refused, and `hub status`, `doctor` and Setup say why.

Use the file when Tapocalypse runs under `tapocalypse service`: `service install` never writes `TAPOCALYPSE_HUB_TOKEN` or `TAPOCALYPSE_HUB_HEADERS` into the unit (it warns on stderr that it skipped them), so the service finds the token only in the file. The same two variables are removed from every agent's environment.

**Changing the hub's address.** The saved token and proxy headers belong to the hub they were entered for. When the new address has a different origin than the saved one, `hub login` and **Setup → Connect to a team hub** need the new hub's token in the same request (`400 token_required_for_new_hub` otherwise), and the saved proxy headers are dropped unless you send new ones. **If `TAPOCALYPSE_HUB_TOKEN` is set in the environment, moving to a hub with a different origin through Setup or `hub login` is refused**, because the form cannot replace the environment's token: edit `share.hub.url` in the config file, change the environment variable (and `TAPOCALYPSE_HUB_HEADERS`), and restart. A change within one origin keeps the token and headers.

`share.hub.headers` (config) are sent on every hub request in addition to `Authorization: Bearer <token>`; values in the credentials file and then in `TAPOCALYPSE_HUB_HEADERS` override same-named keys. Use them when your access proxy accepts a static header or service token from machines instead of letting `/api/hub/v1/*` through ([proxy recipes](hub.md#put-an-access-proxy-in-front)).

**Which projects upload.** Only projects with `"share": true`, never all of them. Finished runs upload automatically, one at a time, oldest first; offline machines queue and catch up (`<data dir>/hub-outbox.json`). A project needs a **hub key** to share: it is derived from the git remote `origin` (and the folder inside a monorepo), so teammates with the same repository merge into one hub project. Without a remote, or when two projects on this machine would derive the same key, set `hubKey` yourself (lowercase `host/path`, plus `#subpath`: `github.com/acme/shop`, `github.com/acme/shop#apps/mobile`, `local/shop`). The project form shows the derived key and validates this.

**What leaves the machine** (the full list is in [the hub guide](hub.md#what-is-uploaded-and-what-never-is)): the run document, the activity feed, the report and the screenshots, with home, repository, temp and data paths rewritten, your account name and device ids replaced (`<user>`, `<device>`) and known secret shapes masked (cookies, `Authorization` headers, `--password`-style flags, camelCase names such as `accessToken` and more). Raw agent events, transcripts, the agent session, `stderr.log`, the run's MCP token and device serials are never uploaded. Briefs, notes and reports are uploaded as written, test-account emails included. `tapocalypse hub pack <runId> --out <dir>` writes exactly what would be sent so you can look.

**Live progress.** While a run of a shared project is queued, starting or running, this machine sends its current status and checks (notes redacted like an upload, no screenshots) to the hub: at most one update every 3 seconds per run, the latest state always included, and a repeat every minute while the run is active so the hub knows it is still alive. It is best effort: nothing is queued or retried, an unreachable hub is skipped until the next change, and it never delays the upload of a finished run, which replaces the live view. Live progress stops when the run ends, when the hub already holds the finished run, or when another machine owns the run id. A hub that predates live progress answers 404: live is then switched off until you change the hub address or token, or restart, while uploads carry on. A rejected token, an access-proxy login page or a protocol that is too old on the live route only switches live off the same way (an access proxy may let uploads through but not `/live`); it never pauses uploads, which find a real token, proxy or protocol problem themselves. A document the hub refuses as too large (413) ends live progress for that run; the brief and check notes are shortened in live updates (the finished upload has them in full). Set `share.hub.live` to `false` to turn it off; it is on when unset.

### Commands on a laptop

```sh
bun src/cli.ts hub login <url> [--token <t>] [--header "Name: value"]... [--screenshots webp|original]
                                                    # test the hub first; save the address and token only if it answers
bun src/cli.ts hub status                           # connection, queue, shared projects
bun src/cli.ts hub push [<runId>...] [--all] [--project <id>] [--since <date>] [--failed] [--verify] [--wait] [--dry-run]
bun src/cli.ts hub pack <runId> --out <dir>         # write upload.json + blobs/ (what would be uploaded), send nothing
bun src/cli.ts hub unpublish <runId>                # remove one of your uploaded runs from the hub
bun src/cli.ts hub unpublish --project <id>         # ... or all of a project's
```

`hub push` needs one selector (run ids, `--all`, `--project`, `--since` or `--failed`) and queues those finished runs of shared projects for the running server to upload (a **backfill**, oldest first); `--wait` follows the queue, `--dry-run` runs on this machine alone and prints counts, bytes and masked-secret totals without sending anything, and `--verify` asks the hub what it holds instead of trusting the local record (after restoring a hub from a backup). Deleting a run locally never deletes it from the hub; `hub unpublish` does.

### Commands on the hub

Run them where the hub's data directory is (`docker compose exec hub bun src/cli.ts hub …` on a container):

```sh
bun src/cli.ts hub token create <name> [--admin]    # prints the upload token once
bun src/cli.ts hub token list
bun src/cli.ts hub token revoke <name>
bun src/cli.ts hub rekey [--project <id>]           # recompute regression keys over all runs
bun src/cli.ts hub project list                     # hub project ids and keys
bun src/cli.ts hub project rename <hubKey> "<name>" # pin a project's display name
bun src/cli.ts hub project remove <hubKey>          # forget a project with no runs (409 project_not_empty otherwise)
bun src/cli.ts hub project set-default-branch <hubKey> <branch>   # pin the default branch; uploads stop changing it
bun src/cli.ts hub project set-default-branch <hubKey> --clear    # unpin it: detection resumes
bun src/cli.ts hub unpublish <runId>                # remove a run (also: --project <id>, --machine <name>)
```

### Hub environment variables

These apply to the hub process only ([details and deployment](hub.md#reference)):

| Variable | Effect |
| --- | --- |
| `TAPOCALYPSE_MODE` | `hub` starts the read-only hub (`tapocalypse serve --hub` does too). Default: the normal local app |
| `TAPOCALYPSE_HOST` | Bind address. Unset: `127.0.0.1`; the hub image sets `0.0.0.0` |
| `TAPOCALYPSE_HUB_HOSTS` | Comma-separated public hostnames that may reach the hub (the `Host` guard); `localhost` and `127.0.0.1` are always allowed for the health check |
| `TAPOCALYPSE_HUB_IDENTITY_HEADER` | Request header to read as the uploader's identity, for example `X-Forwarded-Email`. Only safe when the hub is reachable solely through the proxy that sets it |
| `TAPOCALYPSE_HUB_RETENTION_DAYS` | Remove hub runs that ended more than this many days ago. Default `365`; `0` keeps everything |
| `TAPOCALYPSE_HUB_RETENTION_MAX_RUNS` | Keep only the newest N runs on the hub |
| `TAPOCALYPSE_HUB_MAX_BLOB_MB` | Largest accepted upload file, default `16` |

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
| `permissions` | `claude` | `"bypass"` (default): `--permission-mode bypassPermissions`, the equivalent of omp's `--auto-approve`. `"allowlist"`: `dontAsk` mode with a per-run allowlist, described below; every other command is denied and shows as a warning in the activity feed. Personas that run other shell commands need `bypass` |
| `sandbox` | `codex` | `"danger-full-access"` (default) or `"workspace-write"`. Always combined with `approval_policy="never"`. `workspace-write` blocks the network, which `adb` and `xcrun simctl` may need, so device runs generally need the default |

**Claude `allowlist` mode.** The rules are built for each run from its folder, its repository and its device (the run has to have a device; one whose id contains anything but letters, digits, `.`, `_`, `:` and `-` cannot be scoped and does not start):

| Allowed | Denied |
| --- | --- |
| The run's own `tpc` tools (progress and `mobile_*`) | Subagents and questions to the user (off in both modes) |
| Read: the repository, the run folder, the system temp folder | Reading anything else, including `~/.ssh`, `~/.aws`, `~/.config` |
| Edit and write: the run folder only | Writing anywhere else, the repository included |
| Android: `adb -s <this run's serial> …` | `adb … push`, `pull`, `install`, `install-multiple`, `install-multi-package`, `uninstall`, `shell pm install` and `shell pm uninstall`; `adb` without `-s <serial>` or for another device |
| iOS: `xcrun simctl list …`; `launch`, `terminate`, `openurl`, `privacy`, `get_app_container` and `spawn` on this run's simulator; `simctl io <udid> screenshot` into the run folder | `simctl install`, `simctl uninstall`, a screenshot path that leaves the run folder or contains `..` |
| | Any other shell command (`curl`, `git`, `gh`, …) and web fetch tools |

It reduces accidents and closes the known ways to copy data off the machine or onto the device, but **it is not a sandbox against prompt injection.** Bash rules match the command text, not the program, so an agent can phrase a command that slips past them; whatever Claude Code itself treats as read-only inside the working directories stays allowed; and the process still runs as you. Treat the app under test, the device and the pull request as untrusted either way ([SECURITY.md](../SECURITY.md)). The syntax follows Claude Code's [permission rules](https://code.claude.com/docs/en/permissions#permission-rule-syntax).

**What an agent's environment lacks.** Every harness process, and every mobile-mcp child of the device gateway, starts with Tapocalypse's environment minus `TAPOCALYPSE_HUB_*` (the hub token and proxy headers, and the other hub variables), `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_SESSION_TOKEN` and, only when `share.s3` is configured, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_SESSION_TOKEN` (otherwise the `AWS_*` variables are your own and stay). The agent runs as you, though: it can read `hub-credentials.json` and `share-credentials.json`, which are mode 0600 and yours. Keep hub tokens and S3 keys narrowly scoped (one token per machine, a bucket key limited to the report prefix).

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
| `TAPOCALYPSE_HUB_TOKEN`, `TAPOCALYPSE_HUB_HEADERS` | Upload token and extra request headers (a JSON object) for the [team hub](#team-hub-sharing) this machine uploads to. They win over `hub-credentials.json`. Never put them in the config file. `service install` does not copy them into the service unit, agents never see them, and while `TAPOCALYPSE_HUB_TOKEN` is set a move to a hub with a different origin through Setup or `hub login` is refused |
| `TAPOCALYPSE_MODE`, `TAPOCALYPSE_HOST`, `TAPOCALYPSE_HUB_*` | Hub-side settings, see [Hub environment variables](#hub-environment-variables) |
| `XDG_CONFIG_HOME`, `XDG_DATA_HOME` | Base directories for the default config and data locations |
| `OMP_BIN`, `CLAUDE_BIN`, `CODEX_BIN`, `ADB_BIN`, `XCRUN_BIN`, `GIT_BIN`, `GH_BIN` | Binaries to use instead of `omp`, `claude`, `codex`, `adb`, `xcrun`, `git`, `gh` from `PATH`. The harness variables override `agent.harnesses.<id>.bin` |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Credentials for `share.s3` (`AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` work too, as Bun's S3 client reads them). They win over the credentials file. Never put them in the config file; under `tapocalypse service` use the [credentials file](#sharing) instead. `S3_*` is always, and `AWS_*` while `share.s3` is configured, removed from the environment of agents and mobile-mcp children |
| `MOBILE_MCP_BIN` | Command line that starts the mobile-mcp children of the `/mcp` device gateway instead of the default `npx -y @mobilenext/mobile-mcp@1.0.11` (your own install, or a stand-in in tests). The default is an exact version (`MOBILE_MCP_VERSION` in `src/devices/gateway.ts`), never `@latest`, so a new npm release changes nothing until Tapocalypse is updated. The command line is split on spaces, so a path that contains spaces cannot be used. Children start with the filtered environment agents get |
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

`service` keeps the server running in the background and starts it at login: `install` writes a launchd agent (macOS, `~/Library/LaunchAgents/dev.tapocalypse.server.plist`) or a systemd user unit (Linux, `~/.config/systemd/user/tapocalypse.service`) and starts it; `status` shows whether it is installed, running and answering; `logs` prints the end of `<data dir>/logs/service.log` (Linux: the journal); `start`, `stop` and `restart` control it; `uninstall` stops it and removes the unit. The unit stores the environment it was installed from (`PATH`, `HOME`, `TAPOCALYPSE_*`, `ANDROID_HOME`, `ANDROID_SDK_ROOT` and the `*_BIN` variables above), so run `install` again after changing it. It never copies `TAPOCALYPSE_HUB_TOKEN` or `TAPOCALYPSE_HUB_HEADERS` into the unit (it prints a warning on stderr saying so; the service reads them from `hub-credentials.json`, see [Team hub sharing](#team-hub-sharing)), and it writes the unit file with mode 0600, tightening one that an older version left readable. It only touches its own unit and is not supported on Windows. Details: [Running as a service](guide.md#running-as-a-service).

`report <runId>` prints a run's markdown report; `--export <dir>` copies the report (as `QA-REPORT-<runId>.md`) and its screenshots into `<dir>` instead, and `--json` prints `{ runId, reportPath, markdown }`. Details: [Reading reports and screenshots](guide.md#reading-reports-and-screenshots).

`report <runId> --html <file>` writes the run's [standalone HTML report](guide.md#sharing-a-report), and `share <runId>` uploads it to the bucket from [`share.s3`](#sharing) and prints the presigned link (exit code 2 when sharing is not configured).
