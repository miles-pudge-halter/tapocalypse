# Set up Tapocalypse: instructions for coding agents

You are a coding agent (omp, Claude Code, Codex CLI, Cursor or similar) running on the user's machine. The user asked you to set up Tapocalypse for the mobile app repository you are working in. Follow the steps below in order. Each step says how to check it worked and what to do when it did not. Humans: the [README](../README.md#quick-start) has the manual version, the [guide](guide.md) has everything else.

Tapocalypse is a local server (Bun, port 4310) with a web UI and an MCP endpoint. A *run* = project (the app's repo) + brief (plain-language test instructions) + device. For each run it starts a headless QA agent (omp, Claude Code or Codex CLI, called the *harness*) that drives an Android emulator or iOS simulator through mobile-mcp and reports checks, a verdict and a markdown report. Tapocalypse keeps the report and screenshots in its own data folder and gives them to you over MCP (`qa_get_report`, `qa_get_screenshots`, `qa_export`) or the CLI (`tapocalypse report <run-id>`); the QA agent never writes into the user's repo.

## Goal

When you are done:

1. Tapocalypse is installed and its server answers on `http://127.0.0.1:4310` (or another port you chose in step 3).
2. Its MCP server is registered in **your** harness under the name `tapocalypse`.
3. The user's app is registered as a Tapocalypse project with status `ok`.
4. One short smoke run has finished on an emulator or simulator.
5. You have told the user the run URL, the verdict, and anything still missing.

## Guardrails

Read these before running anything. They override convenience.

- **Never `pkill`, `killall` or kill by pattern.** Stop only processes you started, by the PID you recorded. The background service started by `service install` is stopped only with `bun src/cli.ts service stop` or `service uninstall`, which touch nothing but Tapocalypse's own launchd or systemd unit; never use `launchctl`, `systemctl` or `kill` on it yourself.
- **Never stop, restart or kill a server on port 4310 that you did not start.** If Tapocalypse already runs there, reuse it. If something else holds the port, pick another port (step 3).
- **Never commit Tapocalypse state.** `tapocalypse.config.json` and `data/` in the Tapocalypse checkout, and its config and data under `~/.config/tapocalypse` and `~/.local/share/tapocalypse`, hold machine-specific paths and run history. Runs do not write reports into the user's repo; if you export one with `qa_export` or `tapocalypse report <run-id> --export <dir>`, do not commit the exported files unless the user asks.
- **Runs cost real money.** Every run is a full agent session on the user's model provider or subscription. Start exactly one smoke run. Ask before starting more.
- **Ask before installing system software** (Bun, Node.js, Android Studio, Xcode, Homebrew packages, an agent CLI) or signing in to anything. Print the install command and let the user decide.
- **Never use a physical phone** unless the user names it. Tapocalypse never picks one automatically, and neither should you.
- **Do not build the app** unless the user asks. Tapocalypse does not build apps; it tests what is installed.
- **Edit configs by merging.** When you register the MCP server, add one entry and keep every other entry in the file.
- **Keep it local.** The server binds `127.0.0.1` and has no login. Never expose the port with a tunnel, port forward or proxy.

## 0. Collect inputs

Work these out before you start. Ask the user only for what you cannot determine.

| Name | Meaning | How to find it |
| --- | --- | --- |
| `APP_REPO` | Absolute path of the app repository | Usually your working directory: `git rev-parse --show-toplevel` |
| `TPC_DIR` | Where to clone Tapocalypse | Use the path the user gave you, else `~/tapocalypse`. Never inside `APP_REPO` |
| `TPC_URL` | Server URL | `http://127.0.0.1:4310` unless step 3 changes the port |
| Your harness | Where to register MCP in step 4 | omp, Claude Code, Codex CLI, Cursor or other |

## 1. Check prerequisites

Run each check and note the result. Commands that are missing exit with "command not found".

| Need | Check | Pass when |
| --- | --- | --- |
| Bun ≥ 1.3 (required) | `bun --version` | Prints 1.3 or newer |
| git (required to clone) | `git --version` | Prints a version |
| Node.js 18+ with `npx` (required) | `node --version && npx --version` | Node prints v18 or newer |
| One agent runtime, signed in (required) | omp: `omp --version && omp models --json`<br>Claude Code: `claude --version && claude auth status --json`<br>Codex CLI: `codex --version && codex login status` | At least one: omp lists one or more models; Claude Code prints `"loggedIn": true`; `codex login status` exits 0 |
| Android (for Android runs) | `adb version` and `emulator -list-avds` (or `"$ANDROID_HOME/emulator/emulator" -list-avds`) | `adb` prints a version; at least one AVD is listed |
| iOS (for iOS runs, macOS only) | `xcrun simctl list devices available` | Lists at least one iPhone simulator |
| gh (optional, PR lookup) | `gh auth status` | Logged in |

You need Bun, git, Node.js, one signed-in runtime, and Android or iOS. The runtime Tapocalypse uses does not have to be the harness you are running in: a Cursor user still needs omp, Claude Code or Codex CLI for the QA agent. Linux supports Android only; Windows is not supported.

**If something required is missing**, stop and send the user one message that lists each missing item with its fix, then wait for them:

| Missing | Fix to give the user |
| --- | --- |
| Bun | `curl -fsSL https://bun.sh/install \| bash` |
| Node.js | Install from https://nodejs.org |
| omp | Install per the [omp README](https://github.com/can1357/oh-my-pi), then `omp login` |
| Claude Code | `npm install -g @anthropic-ai/claude-code`, then `claude auth login` |
| Codex CLI | `npm install -g @openai/codex`, then `codex login` |
| adb | Android Studio → SDK Manager, or `brew install --cask android-platform-tools`; put it on `PATH` or set `ADB_BIN` |
| An AVD | Android Studio → Device Manager → Create device |
| Xcode | Install Xcode, then `sudo xcode-select --switch /Applications/Xcode.app` |

Step 2 runs `bun run doctor`, which repeats these checks with the exact fix for each failure. Its verdict wins over this table.

## 2. Clone, install, check

```sh
git clone https://github.com/miles-pudge-halter/tapocalypse.git "$TPC_DIR"
cd "$TPC_DIR"
bun install
bun run doctor
```

- If `TPC_DIR` already holds a Tapocalypse clone, do not clone again. Run `git -C "$TPC_DIR" status --short`; if it is clean, `git -C "$TPC_DIR" pull --ff-only`. If it has local changes, leave it as it is.
- `bun run doctor` prints one line per check: `✓` ok, `!` warning, `✗` failed, `–` skipped, with a `fix:` line under anything that needs attention. It exits 1 when a required check failed and lists their ids (for example `agent-runtime`, `npx`, `adb`).
- Exit 0 means you can continue. Warnings marked `(optional)` (gh) can be ignored.
- Exit 1: relay the failed lines and their `fix:` text to the user, and stop until they are fixed. Re-run `bun run doctor` afterwards.

## 3. Start the server

First find out what is on the port:

```sh
curl -fsS http://127.0.0.1:4310/api/mcp/status
```

| Result | Meaning | Do |
| --- | --- | --- |
| JSON like `{"url":"http://127.0.0.1:4310/mcp","lastCallAt":…}` | Tapocalypse already runs | Reuse it. Do not restart it. Skip to step 4 |
| `Connection refused` / `Failed to connect` | The port is free | Start the server (below) |
| Any other answer | Something else owns the port | Start on another port: prefix the start command with `TAPOCALYPSE_PORT=4311` and use `http://127.0.0.1:4311` as `TPC_URL` everywhere below |

On macOS and Linux, install it as a background service. It keeps Tapocalypse running, restarts it if it crashes and starts it at login, so it outlives your session and the user's MCP calls always find it:

```sh
cd "$TPC_DIR"
bun src/cli.ts service install     # on another port: TAPOCALYPSE_PORT=4311 bun src/cli.ts service install
bun src/cli.ts service status
```

`service install` records the current `PATH`, `ANDROID_HOME` and any `TAPOCALYPSE_*` variables, so run it from the shell where `bun run doctor` passed. Wait for it: poll `curl -fsS "$TPC_URL/api/mcp/status"` once per second for up to 30 s, and run `service status` to see whether the unit is installed and running. If it never answers, read `bun src/cli.ts service logs`.

**Fallback (Windows, or when `service` reports it is not supported).** Start it in the background so it outlives your session, and record the PID. If your harness has its own background-process feature, use that instead of `nohup`.

```sh
cd "$TPC_DIR"
nohup bun start > "${TMPDIR:-/tmp}/tapocalypse.log" 2>&1 &
echo $!
```

Poll `curl -fsS "$TPC_URL/api/mcp/status"` the same way. The log shows `tapocalypse listening on http://127.0.0.1:4310` when it is ready. If it never answers, read the log. `fatal: config: …` means the config file is invalid: report the message to the user and stop.

The first start creates the config file (`~/.config/tapocalypse/config.json`, unless `TAPOCALYPSE_CONFIG` is set or a `tapocalypse.config.json` already exists in `TPC_DIR`). Remember which path it is; step 6 may need it.

## 4. Register the MCP server in your harness

Register `<TPC_URL>/mcp` (streamable HTTP) under the name `tapocalypse`. Never name it `tpc`: that name is reserved for the per-run endpoint Tapocalypse gives its own QA agents. Allow tool calls of at least 120 s, because `qa_wait_run` blocks for up to 110 s.

**omp.** Merge into `~/.omp/agent/mcp.json` (create the file if it does not exist; keep other servers):

```json
{
  "mcpServers": {
    "tapocalypse": { "type": "http", "url": "http://127.0.0.1:4310/mcp", "timeout": 120000 }
  }
}
```

**Claude Code.** Check first with `claude mcp get tapocalypse`. If it is not registered:

```sh
claude mcp add --transport http --scope user tapocalypse http://127.0.0.1:4310/mcp
```

**Codex CLI.** Merge into `~/.codex/config.toml`:

```toml
[mcp_servers.tapocalypse]
url = "http://127.0.0.1:4310/mcp"
tool_timeout_sec = 120
```

**Cursor.** Merge into `~/.cursor/mcp.json`, then ask the user to reload Cursor:

```json
{ "mcpServers": { "tapocalypse": { "url": "http://127.0.0.1:4310/mcp" } } }
```

**Anything else.** Use the client's way of adding a streamable-HTTP MCP server with that URL. Requests must use host `127.0.0.1` or `localhost` with the right port; any other `Host` gets `403`.

Most harnesses load MCP servers when a session starts. If the `qa_*` tools do not appear in your current session, do not wait: do steps 5 to 7 over HTTP and the CLI (each step shows both), and tell the user to start a new session to get the tools. Once the tools are live, `curl -fsS "$TPC_URL/api/mcp/status"` shows a non-null `lastCallAt` after your first call.

## 5. Register the app as a project

**Over MCP.**

1. `qa_list_projects`. If a project already has `repoPath` equal to `APP_REPO` and `status: "ok"`, use its `id` and skip to step 6.
2. `qa_detect_project { repoPath: "<APP_REPO>" }`. Look at `framework`, `platforms`, `androidPackages`, `iosBundleIds` and `suggestion`.
3. `qa_create_project { repoPath: "<APP_REPO>" }`. Omitted fields come from detection. If the call says it could not infer some fields, pass them explicitly (`id`, `name`, `defaultPackage`, `defaultPlatform`).

**Over HTTP.**

```sh
curl -fsS -X POST "$TPC_URL/api/projects/detect" -H 'content-type: application/json' \
  -d '{"repoPath":"<APP_REPO>"}'
```

Take `suggestion` from the answer and create the project with it (`personaFile` is `null` for the built-in persona, or `suggestion.personaFile`):

```sh
curl -fsS -X POST "$TPC_URL/api/projects" -H 'content-type: application/json' -d '{
  "id": "<suggestion.id>", "name": "<suggestion.name>", "repoPath": "<APP_REPO>",
  "defaultPackage": "<suggestion.defaultPackage>", "defaultPlatform": "<android|ios>",
  "personaFile": null
}'
```

**Choosing values.**

- `defaultPackage` is the Android `applicationId` or iOS bundle id of the build that is installed on the device. Detection prefers ids ending in `.dev` or `.debug`. If `androidPackages` or `iosBundleIds` lists several and you cannot tell which one is installed, ask the user. If it is `null`, read `applicationId` in the Gradle files or `PRODUCT_BUNDLE_IDENTIFIER` in the Xcode project, and confirm with the user.
- `defaultPlatform` is the platform the user has a device for. Prefer Android when both work and the user did not say.
- `id`: 1-40 lowercase letters, digits and dashes. It cannot change later.

A `400` or a project with `status: "invalid"` lists its problems. Fix the fields and retry.

## 6. Make sure a device is ready

List devices with `qa_list_devices` or `curl -fsS "$TPC_URL/api/devices"`. You need one entry with the project's platform, `kind` `emulator` or `simulator`, no `busyRunId`, no `lease` (another coding agent may be holding it; see step 8) and not `excluded`.

**No suitable device?** Ask the user which they prefer, then do one of:

- Let Tapocalypse boot one. Add the AVD name (from `emulator -list-avds`) to `devicePool.android.avds`, or a simulator UDID (from `xcrun simctl list devices available`) to `devicePool.ios.simulators`, in the config file from step 3. Hand edits need a restart: if you started the server, stop it with `kill <PID>` and start it again as in step 3; if you did not, ask the user to restart it. Runs then boot the device on demand.
- Boot one directly: `"$ANDROID_HOME/emulator/emulator" -avd <name> -no-snapshot-save &` for Android, or `xcrun simctl boot <udid> && open -a Simulator` for iOS. Wait until it shows up in the device list.

**Is the app installed?** With `<serial>` from the device list and the project's `defaultPackage`:

- Android: `adb -s <serial> shell pm list packages <package>` prints `package:<package>`.
- iOS simulator: `xcrun simctl get_app_container <udid> <bundle-id>` exits 0.

If it is not installed, tell the user. If they have a build (`.apk` for Android, `.app` or `.ipa` for the simulator), pass its absolute path as `install` in step 7 and Tapocalypse installs it before the run. Build it yourself only if they ask.

**Need the device yourself?** The smoke run in step 7 gets its own device. If you must touch a device directly (`adb install`, `flutter run`, taking a screenshot), borrow it first so QA runs and other agents stay away from it: `device_acquire { platform: "<android|ios>", holder: "<your harness> · tapocalypse setup", reason: "<what for>", waitSeconds: 60, cwd: "<APP_REPO>" }`, use the returned `serial` for `adb`/`simctl` and `mobileDeviceId` for mobile tools, and call `device_release { leaseId }` when done. Without the MCP tools: `POST "$TPC_URL/api/leases"` with the same JSON and `POST "$TPC_URL/api/leases/release"` with `{"leaseId":"…"}`. Do not use a device another holder has leased; wait for it or tell the user who holds it (`heldBy`).

## 7. Run one smoke test

Tell the user a run is starting and that it costs a few minutes and one agent session's worth of tokens.

**Over MCP.**

```text
qa_start_run {
  projectId: "<id>",
  title: "Tapocalypse setup smoke test",
  brief: "Launch the app from a cold start and verify the first screen loads without a crash or an error dialog. One check only. Take one screenshot as evidence.",
  platform: "<android|ios>",            // or serial: "<serial>" for the device from step 6
  requester: "<your harness name>",
  source: { path: "<APP_REPO>" }
}
```

Give the user the returned `url` right away so they can watch live. Then call `qa_wait_run { runId }` again and again until `timedOut` is `false`. An infrastructure failure is retried once automatically, and `qa_wait_run` follows the retry.

**Over the CLI** (when the MCP tools are not loaded yet), from `TPC_DIR`:

```sh
bun src/cli.ts run --project <id> --platform <android|ios> --title "Tapocalypse setup smoke test" \
  --brief "Launch the app from a cold start and verify the first screen loads without a crash or an error dialog. One check only. Take one screenshot as evidence." \
  --wait --timeout 30m
```

It prints `started run <run-id>: <url>` and progress on stderr, and the final result on stdout. Add `--url "$TPC_URL"` if you changed the port. Exit codes: `0` the verdict is `PASS` or `PASS WITH ISSUES`, `1` the verdict is `FAIL`, `BLOCKED` or `PARTIAL`, `2` the run errored, was cancelled or timed out, `3` usage error or the server is unreachable. The run page is `<TPC_URL>/#/runs/<run-id>`.

**If the run did not pass.** `qa_get_run { runId }` (or `curl -fsS "$TPC_URL/api/runs/<run-id>"`) returns `status`, `verdict`, `summary`, `error` and `errorKind`.

| `errorKind` | Likely cause | Next step |
| --- | --- | --- |
| `infra` | Emulator did not boot, the runtime is not signed in, mobile-mcp did not start, install failed | `curl -fsS "$TPC_URL/api/runs/<run-id>/stderr"`, then `bun run doctor` |
| `agent` | The agent ended without reporting | Check the activity feed on the run page |
| `timeout` | Time, turn or budget limit | Shorten the brief, or raise `runMaxTime` |

A `FAIL` or `BLOCKED` verdict with no `errorKind` means Tapocalypse works and the agent found a problem in the app (or could not get past a login wall). That still counts as a successful setup. More fixes: [Troubleshooting](guide.md#troubleshooting).

## 8. Let your agents borrow devices (optional)

Tapocalypse is also the device broker for your coding agents: with a lease, two agents (and QA runs) never drive the same emulator or simulator at once. This is cooperative; it works because every agent follows the same instructions. Ask the user whether to add the snippet below to the instructions the agents on this machine read (for example `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, the repo's `AGENTS.md`, a Cursor rule). Merge it as its own section and do not write it without their go-ahead. The Setup page of the UI has the same text as a copyable prompt and skill file.

```md
## Using a device (Tapocalypse device broker)
Devices on this machine are shared with other agents. Before your first device action (mobile tool, adb, simctl, flutter run/install):
1. `device_acquire { platform | serial, holder: "<your client> · <task>", reason, ttlMinutes?, waitSeconds: 60, cwd: <your working dir> }`.
   - Success → note `leaseId`, `serial` (adb/simctl) and `mobileDeviceId` (mobile tools). Keep the leaseId in your notes; it cannot be recovered.
   - `timedOut: true` → it is busy (`heldBy`). Call again with the same args plus `ticket` to keep your place, or tell the user who holds it. Never use a device you do not hold.
2. Use only that device: `serial` for adb/simctl/flutter, `mobileDeviceId` for mobile tools.
3. Renew with `device_renew { leaseId }` when less than 10 minutes are left.
4. Always `device_release { leaseId }` when done, also on failure or abort.
If a call says the lease ended, stop touching the device and acquire again.
```

Check that `qa_list_devices` is callable, and tell the user that leases are advisory: they do not stop a process that runs `adb` or `xcrun simctl` on its own. Details: [Sharing devices between agents](guide.md#sharing-devices-between-agents).

## 9. Report back

Send the user one short message:

```text
Tapocalypse is set up.
- Server: http://127.0.0.1:4310. <Installed by me as a background service (`bun src/cli.ts service status|logs|stop|uninstall`) | Started by me in the background, PID <pid>, log at <path>; stop it with `kill <pid>` | Already running; reused it>.
- MCP: registered as `tapocalypse` in <config file or command>. <Start a new session to load the qa_* tools | Tools are live>.
- Project: <id> (<defaultPackage>, <platform>).
- Smoke run: <verdict>. <summary>. Watch or replay: <url>. Report: <reportPath from `qa_get_run`, in Tapocalypse's data folder; read it with `qa_get_report` or `tapocalypse report <run-id>`>. Cost: <cost, or tokens>.
- Device sharing: <snippet added to <file> | not added>.
- Still missing: <optional items, or "nothing">.
Next time, ask me to "QA what you just built with Tapocalypse" and I will start a run, wait for it and fix what fails.
```

Done. Do not start further runs unless the user asks.
