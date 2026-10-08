# Tapocalypse

Tapocalypse lets AI agents QA your mobile app on real emulators, simulators and devices, in parallel, while you watch. You describe what to test in plain language, a headless agent drives the app, and you get live per-check results, a live device screen and a markdown report with screenshots. It works with any app you can install on a device: Flutter, React Native / Expo, native Android or iOS, Kotlin Multiplatform.

Runs start from a local web UI or from your coding agent over [MCP](https://modelcontextprotocol.io), so the agent that just changed your code can also ask for it to be tested. Everything runs on your machine; the agent runtime is [omp (oh-my-pi)](https://github.com/can1357/oh-my-pi), which uses whichever model provider you have configured there.

## What a run looks like

- You give Tapocalypse a **project** (your app's repo), a free-text **brief** ("open Settings, toggle dark mode, verify it survives a restart") and a platform or a specific device.
- A device is assigned: a free emulator or simulator, or one booted for you from your configured AVDs/simulators. If everything is busy the run waits in a queue.
- A headless QA agent starts inside your repo and drives the app through [mobile-mcp](https://github.com/mobile-next/mobile-mcp) (tapping, typing, screenshots, `adb`/`simctl`). Several runs execute side by side on different devices.
- The agent declares its checks up front and reports each as it goes; the UI shows every check turn pending → running → pass/fail, a live device screen and the agent's activity feed. You can steer or cancel mid-run.
- The agent writes `QA-REPORT-<run-id>.md` with embedded screenshots into your repo (`qa/` by default). Reports are browsable in the UI.
- The run ends with a verdict: `PASS`, `PASS WITH ISSUES`, `FAIL`, `BLOCKED` or `PARTIAL`, plus a summary and a full transcript.

## Prerequisites

Run `bun run doctor` to check all of this. It prints one line per tool with a fix hint for anything missing and exits 1 if a required tool is absent. The same checks appear as a setup checklist in the web UI and through the `qa_doctor` MCP tool.

| Tool | Why | Required? | Install |
| --- | --- | --- | --- |
| [Bun](https://bun.sh) ≥ 1.3 | Runs the server, the UI bundler and the tests | Required | `curl -fsSL https://bun.sh/install \| bash` |
| [omp](https://github.com/can1357/oh-my-pi) | The agent runtime. Tapocalypse starts one `omp --mode rpc` process per run. Start `omp` once and sign in to (or configure an API key for) a model provider; `bun run doctor` only checks that the binary exists, not that you are logged in | Required | Follow the omp README; `omp` must be on `PATH` (or set `OMP_BIN`) |
| Node.js 18+ with `npx` | Fetches and runs `@mobilenext/mobile-mcp`, the default device driver. Tapocalypse wires it into omp for you, no config edit needed | Required | https://nodejs.org |
| Android `adb` (platform-tools) | Talks to Android emulators and devices | Required for Android | Android Studio → SDK Manager, or `brew install --cask android-platform-tools`; put it on `PATH` or set `ADB_BIN` |
| Android Emulator + at least one AVD | Lets Tapocalypse boot emulators on demand | Optional (without it, only already-running devices are used) | Android Studio → SDK Manager, then Device Manager → Create device |
| Xcode + iOS simulators | iOS runs (macOS only) | Required for iOS | Install Xcode, then `sudo xcode-select --switch /Applications/Xcode.app` |
| git | Records branch, commit and dirty state on each run | Optional | https://git-scm.com |
| [gh](https://cli.github.com), logged in (`gh auth login`) | Looks up the pull request for the run's branch | Optional | `brew install gh` |

You need at least one of Android (adb) or iOS (Xcode). Your app must be installed on the device the run uses; Tapocalypse does not build or install it.

## Quick start

```sh
git clone https://github.com/miles-pudge-halter/tapocalypse.git
cd tapocalypse
bun install
bun run doctor     # fix anything marked ✗
bun start          # → tapocalypse listening on http://127.0.0.1:4310
```

1. Open <http://127.0.0.1:4310>. The first start creates `tapocalypse.config.json` (gitignored) next to the code.
2. Make sure an emulator or simulator with your app installed is running, or list an AVD in `devicePool.android.avds` ([Devices](#devices)) and let Tapocalypse boot it.
3. **Projects → Add project**: paste the absolute path of your app's repository. Detection fills in the name, package/bundle id, platform and persona; check them and save.
4. **Runs → New run**: pick the project, a device (or "Any android" / "Any ios"), write a title and a brief, and start. You land on the run page with live checks, device screen and activity.

## Projects

A project tells Tapocalypse where your app's repository is and how to test it. Add them in the UI (**Projects**), from your agent over MCP, or in `tapocalypse.config.json`.

| Field | Meaning |
| --- | --- |
| `id` | 1-40 chars: lowercase letters, digits, dashes. Cannot change later |
| `name` | Display name, 1-60 chars |
| `repoPath` | Absolute path of the repo (`~` is expanded). The agent runs with this as its working directory |
| `personaFile` | QA persona markdown, relative to the repo. `null`/omitted = the built-in persona |
| `reportsDir` | Where reports and screenshots are written, relative to the repo. Default `qa` (created on first run) |
| `defaultPackage` | Android `applicationId` or iOS bundle id of the app under test, e.g. `com.example.app.dev` |
| `defaultPlatform` | `android` or `ios`, used when a run names no platform or device |

**Detection.** The UI wizard and `qa_detect_project` inspect the repo without running anything and suggest every field. They read: `pubspec.yaml` (Flutter), `package.json` dependencies (Expo, React Native), `app.json`/`app.config.json` (Expo ids), Gradle files and `AndroidManifest.xml` (`applicationId`, flavors and suffixes in `android/app`, `app`, `androidApp`, `composeApp`), Xcode `project.pbxproj` (`PRODUCT_BUNDLE_IDENTIFIER`), `shared`/`composeApp` modules (Kotlin Multiplatform), `.omp/agents/` and `.claude/agents/` for QA-looking persona files, existing report folders (`qa`, `docs/qa`, `test/qa`, `reports/qa`) and whether the folder is a git repo. When several package ids exist it prefers one ending in `.dev` or `.debug`.

**From your agent.** `qa_detect_project { repoPath }` then `qa_create_project { repoPath }`; omitted fields are filled from detection, and you are told which ones to supply if something cannot be inferred. See [MCP](#dispatching-runs-from-your-coding-agent-mcp).

**In the config file.** Add objects with the fields above to `projects`. Edits made by hand need a server restart; edits made in the UI or over MCP apply immediately and are written back to the file. Invalid projects are listed with their problems and cannot start runs, but never stop the server from booting.

**Persona.** The persona is the system prompt of the QA agent. Leave it unset to use the built-in [`personas/default-mobile-qa.md`](personas/default-mobile-qa.md): a thorough, evidence-first mobile QA engineer for Android and iOS. To use your own, point `personaFile` at a markdown file in the repo. Its body is appended to omp's system prompt; its optional frontmatter may set the model:

```markdown
---
model: <provider>/<model>:high
---
You are the QA agent for our app. Known quirks: ...
```

The suffix after the last `:` is the thinking level when it is one of `off minimal low medium high xhigh max`; otherwise it stays part of the model name. If the persona has no `model:`, Tapocalypse uses `agent.model` / `agent.thinking` from the config, and if those are unset, omp's own default. Whatever the persona says, every run's prompt adds the device, package, run id, report/screenshot paths and the progress-reporting protocol, and the built-in persona defers to them.

## Devices

- **Platform-only requests** ("Any android", "Any ios", or just a project default) go to the first free emulator or simulator, ordered by serial. Free means: connected and ready, not used by another run, not listed in `devicePool.android.excludeSerials`, and not held by an Artemis task.
- **Physical devices are never picked automatically.** They are used only when a run names their serial, so your own phone is never grabbed by accident.
- **Explicit serial.** If the device is busy the run waits in the queue (it is not rejected). A serial that is not connected, or is in `excludeSerials`, is rejected immediately. Runs for other devices are not blocked by a waiting run.
- **Queueing.** Runs start in order as devices free up, at most `maxConcurrentRuns` at a time. The queue survives restarts.
- **Auto-boot.** If no device is free, Tapocalypse boots one from your pool: an AVD from `devicePool.android.avds` that is not already running (while Tapocalypse has booted fewer than `maxBooted` Android emulators), or a simulator UDID from `devicePool.ios.simulators` (list them with `xcrun simctl list devices`). Emulators start with `-no-snapshot-save -no-boot-anim -no-audio` on even ports from `basePort` (`emulator-5560`, `emulator-5562`, …) and must finish booting within 180 s. Set `maxBooted` to `0` to disable auto-boot.
- **Idle shutdown.** A device Tapocalypse booted is shut down after sitting unused for `idleShutdownMinutes` (checked every minute). Devices you started yourself are never shut down.
- **Minimum resolution.** Some AVDs boot with tiny screens that make screenshots unreadable. A booted emulator whose screen is smaller than `minSize` (default 720x1280) is switched to `minSize` at `minDensity` dpi.
- **Restarts.** Tapocalypse forgets which devices it booted; after a restart they are ordinary devices and are not shut down automatically.

The UI's device picker labels each device with its model and screen size and flags it as busy, held by an Artemis task, or booted by Tapocalypse.

## Dispatching runs from your coding agent (MCP)

Tapocalypse serves an MCP endpoint (streamable HTTP, stateless) at `http://127.0.0.1:4310/mcp`, so the agent that just edited your code can start QA runs, wait for them and read the results. Keep Tapocalypse running while you work.

**omp.** Add the server to `~/.omp/agent/mcp.json` (user level, so every git worktree of your project sees it):

```json
{
  "mcpServers": {
    "tapocalypse": { "type": "http", "url": "http://127.0.0.1:4310/mcp", "timeout": 120000 }
  }
}
```

**Claude Code.**

```sh
claude mcp add --transport http --scope user tapocalypse http://127.0.0.1:4310/mcp
```

**Any other MCP client** that supports streamable HTTP: point it at the same URL. Use `127.0.0.1` or `localhost` with the configured port; requests with any other `Host` are refused. If you change `port`, update the URL.

| Tool | Purpose |
| --- | --- |
| `qa_list_projects` | Registered projects with `status` (`ok`/`invalid`) and problems. Only `ok` projects can start runs |
| `qa_detect_project { repoPath }` | Inspect a repo and suggest project settings |
| `qa_create_project { repoPath, id?, name?, defaultPackage?, defaultPlatform?, personaFile?, reportsDir? }` | Register a project; omitted fields come from detection |
| `qa_update_project { id, repoPath?, name?, defaultPackage?, defaultPlatform?, personaFile?, reportsDir? }` | Change only the fields you pass |
| `qa_delete_project { id }` | Remove a project (fails while it has queued or active runs; the repo and reports are untouched) |
| `qa_list_devices` | Connected emulators, simulators and devices with busy/booting/Artemis flags |
| `qa_doctor` | Prerequisite report with a fix for anything missing; call it when runs fail to start |
| `qa_start_run { projectId, title, brief, platform?, serial?, backend?, packageId?, requester?, source? }` | Queue a run; returns `runId`, `status`, `queuePosition`, a UI `url` and the recorded `source` |
| `qa_get_run { runId }` | Status, checks, verdict, summary, error, absolute `reportPath` and `screenshotsDir`, source and build |
| `qa_wait_run { runId, timeoutSec? }` | Block until the run is finished or `timeoutSec` (default 90, clamped to 5-110) passes; check `timedOut` and call again |
| `qa_cancel_run { runId }` | Cancel a queued or active run |
| `qa_list_runs { projectId?, branch?, prNumber?, ticket?, commit?, status?, limit? }` | Recent runs, newest first (default 20, max 100); see [Run metadata](#run-metadata) |

`source` is `{ path?, branch?, commit?, prNumber?, prTitle?, prUrl?, tickets?, labels? }`.

**Example.** You tell your agent:

> Implement the dark-mode toggle, then use Tapocalypse to check on Android that the toggle works and the choice survives an app restart.

The agent typically does this:

1. `qa_list_projects` to find the project id (or `qa_detect_project` + `qa_create_project` the first time).
2. `qa_start_run { projectId, title: "Dark mode toggle", brief: "...", requester: "my-agent", source: { path: "<its cwd>" } }`. `source.path` must be the project's repo root or one of its git worktrees; it makes the run record the agent's branch, commit and PR rather than the main checkout's.
3. `qa_wait_run { runId }` in a loop until `timedOut` is `false`, optionally narrating the `checks` it sees.
4. Reads the verdict and summary, and opens the markdown file at `reportPath` (screenshots are in `screenshotsDir`) to fix what failed.

Starting several runs back to back is fine: they are scheduled in parallel across devices. QA agents launched by Tapocalypse are told never to call `tapocalypse` tools, so registering the server at user level cannot cause recursion.

You can also start runs over plain HTTP, for example from CI:

```sh
curl -X POST http://127.0.0.1:4310/api/runs -H 'content-type: application/json' -d '{
  "projectId": "my-app", "title": "Smoke test", "brief": "Launch the app and verify the home screen loads.",
  "device": { "platform": "android" }, "requestedBy": "ci"
}'
```

## Run metadata

Every run records what code and build it tested, shows it in the UI and in the agent prompt (so the report header carries it), and makes it searchable.

| Field | Source |
| --- | --- |
| Branch, commit (sha and subject), dirty | `git` in `source.path` (default: the project's repo), overridable per run |
| Pull request (number, title, url, state, draft, author) | Given in `source`, or looked up with `gh pr view` for the branch in the background (needs `gh` logged in) |
| Tickets | Keys like `ABC-123` found in the branch name, PR title and run title, plus any in `source.tickets` |
| Labels | Up to 20 free-form key/value pairs in `source.labels` (flavor, epic, build id, …) |
| Build | App version name and code read from the device before the run starts, and re-read after it |

Filter runs with `qa_list_runs` (`projectId`, `branch`, `prNumber`, `ticket`, `commit` as a sha prefix, `status`, `limit`) or `GET /api/runs?project=&status=running,done&branch=&pr=&ticket=&commit=`. The History table's search box matches title, branch, PR, ticket and commit.

## Configuration reference

`tapocalypse.config.json` lives in the repo root by default (gitignored) and is created with the defaults below on first start. It is validated at startup (`fatal: config: …`, exit 1 when invalid) and read once: restart after editing it by hand. [`tapocalypse.config.example.json`](tapocalypse.config.example.json) is a copy of the defaults.

| Key | Default | Meaning |
| --- | --- | --- |
| `port` | `4310` | HTTP port; the server only binds `127.0.0.1` |
| `maxConcurrentRuns` | `2` | Runs executing at once (including ones waiting for an emulator to boot). Mind your RAM: each emulator needs several GB |
| `runMaxTime` | `"60m"` | Wall-clock limit per run, passed to `omp --max-time` |
| `projects` | `[]` | Project objects, see [Projects](#projects). Normally managed from the UI |
| `agent.model` | unset | Model for projects whose persona has no `model:` |
| `agent.thinking` | unset | Thinking level for the same fallback (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) |
| `artemisPath` | unset | Path to a local Artemis clone; enables the optional [Artemis backend](#optional-artemis-backend) |
| `devicePool.android.avds` | `[]` | AVD names (`emulator -list-avds`) Tapocalypse may boot on demand |
| `devicePool.android.basePort` | `5560` | First emulator console port; booted emulators get even ports from here |
| `devicePool.android.maxBooted` | `1` | Max emulators Tapocalypse keeps booted at once; `0` disables auto-boot |
| `devicePool.android.minSize` | `"720x1280"` | Booted emulators with a smaller screen are overridden to this size |
| `devicePool.android.minDensity` | `320` | Density (dpi) used with that override |
| `devicePool.android.idleShutdownMinutes` | `20` | Shut down a Tapocalypse-booted emulator after this much idle time |
| `devicePool.android.excludeSerials` | `[]` | Android serials that are never used |
| `devicePool.ios.simulators` | `[]` | Simulator UDIDs Tapocalypse may boot on demand |
| `devicePool.ios.idleShutdownMinutes` | `20` | Same idle shutdown for simulators |

**Environment variables**

| Variable | Effect |
| --- | --- |
| `TAPOCALYPSE_CONFIG` | Config file path (default `<repo>/tapocalypse.config.json`) |
| `TAPOCALYPSE_DATA_DIR` | Where runs are stored (default `<repo>/data`) |
| `TAPOCALYPSE_PORT` | Overrides `port` |
| `OMP_BIN`, `ADB_BIN`, `GIT_BIN`, `GH_BIN` | Binaries to use instead of `omp`, `adb`, `git`, `gh` from `PATH` |
| `EMULATOR_BIN` | Android emulator binary. Otherwise looked up under `$ANDROID_HOME`, `$ANDROID_SDK_ROOT`, then `~/Library/Android/sdk` (not `PATH`) |
| `OMP_PROFILE` / `PI_PROFILE` | If you run omp with a profile, set it here too so Tapocalypse reads that profile's MCP config |

## How it works

1. **Queue and assign.** `POST /api/runs` (the UI, or `qa_start_run`) validates the request and stores a `queued` run. The scheduler re-evaluates on every enqueue, release and cancel, and every 10 s, and assigns or boots devices as described in [Devices](#devices).
2. **Preflight.** If a device had to be booted, that happens first. Then Tapocalypse reads the installed app's version from the device and works out the device id mobile-mcp expects (the AVD name for Android emulators, the UDID for simulators, the serial for physical devices).
3. **Spawn.** It starts `omp --mode rpc --no-ui` with your repo as the working directory and `--append-system-prompt <persona>`, `--session-dir`, `--auto-approve`, `--max-time <runMaxTime>`, `--no-title`, plus `--model`/`--thinking` when known. Communication is JSON lines over stdio ([omp's RPC mode](https://github.com/can1357/oh-my-pi)): Tapocalypse sends the prompt and receives every tool call and message as events, which feed the activity feed and `events.jsonl`.
4. **mobile-mcp, provisioned for you.** omp has no per-session MCP switch, so Tapocalypse checks omp's user and project MCP config files (`~/.omp/agent/mcp.json`, `.mcp.json` and `.omp/mcp.json` variants in the repo) for an enabled server that runs `@mobilenext/mobile-mcp`. If there is one, it is used as is. Otherwise Tapocalypse passes `--plugin-dir data/omp-plugins/tpc`, a tiny plugin that runs `npx -y @mobilenext/mobile-mcp@latest`. Your own omp config is never modified. MCP servers connect a moment after omp starts, so Tapocalypse polls omp until the tools appear, learns their real name prefix (it depends on how the server was configured), and only then sends the prompt. If they never appear (20 s), the run fails with a message pointing back to [Prerequisites](#prerequisites).
5. **Host tools.** Three tools are registered with omp for the run; they are how the UI gets its data:
   - `qa_plan { checks: [{id, title}] }`: declares every check before the first device action.
   - `qa_check { id, status, note?, screenshot? }`: `status` is `running`, `pass`, `fail`, `blocked` or `skipped`; `screenshot` is a repo-relative path.
   - `qa_finish { verdict, summary, reportPath }`: called once after the report is written.

   Paths the agent reports must resolve inside your repo.
6. **The prompt.** Besides your brief, the agent is told: its device (and the mobile-mcp device id), that it must not touch other devices or boot its own, the app package, the run id, the code under test ([Run metadata](#run-metadata)), which driver tools to use and not use, to never spawn subagents or ask the user questions, and the reporting protocol: save screenshots to `<reportsDir>/screenshots/<run-id>/` and the report to `<reportsDir>/QA-REPORT-<run-id>.md`. Unique paths keep parallel runs from colliding. If it is blocked it records why and finishes with `BLOCKED`.
7. **Finish.** After the agent ends, Tapocalypse collects session stats, exports `transcript.html`, closes omp's stdin and waits for it to exit. A recorded verdict means status `done`; otherwise the run is an `error` (the agent's own error, or "agent ended without qa_finish"). Run statuses: `queued` → `preflight` → `running` → `finishing` → `done`, or `error` / `cancelled` / `interrupted`. Cancelling sends omp an abort and kills it after 10 s; "steer" sends your message to the live agent.

**Where things live**

```text
<your repo>/<reportsDir>/QA-REPORT-<run-id>.md          the report
<your repo>/<reportsDir>/screenshots/<run-id>/*.png     its screenshots
data/runs/<run-id>/                                     (override with TAPOCALYPSE_DATA_DIR)
  run.json         full run state: status, checks, verdict, source, build, stats
  brief.md         your brief
  persona.md       the persona used (frontmatter stripped)
  events.jsonl     every omp event (basis of the activity feed and its replay)
  stderr.log       omp's stderr
  session/         the omp session
  transcript.html  full agent transcript
data/omp-plugins/tpc/.mcp.json                          the mobile-mcp plugin, if provisioned
```

Run ids look like `20260101-093015-a1b2-dark-mode-toggle`. The UI serves reports and screenshots only from the project's `reportsDir` (images, `.txt` and `.json`), and rewrites relative links inside reports so they work in the browser.

**Restarts.** Stopping Tapocalypse (Ctrl-C) kills running agents. On the next start those runs are marked `interrupted`, and runs that were still queued are queued again. Emulators Tapocalypse booted keep running.

## Optional: Artemis backend

The default driver is mobile-mcp: it works on Android and iOS, needs nothing but Node, and returns the real accessibility labels of Flutter, React Native and native apps. **Artemis** is an optional second driver for Android that reads the UI tree through an on-device accessibility service, which is much faster on large UI trees, and returns a fresh screenshot plus element list with every action.

Measured on one large Flutter app (Android emulator): reading the element tree took 0.6 s with Artemis versus 17-25 s per call with mobile-mcp; the same one-check smoke test finished in about 51 s versus 107 s. On ordinary native screens mobile-mcp answered in about 0.5 s, so the gain depends on your UI tree. Both returned the same verdict.

What it costs: Android only; a local clone of Artemis with Python 3.12+ and [uv](https://docs.astral.sh/uv/) (a virtualenv of roughly 900 MB); and a helper app on each device that shows a persistent notification and an entry under Accessibility settings.

To enable it:

1. Set up Artemis, and add its MCP server to your omp config (`~/.omp/agent/mcp.json`) so omp sessions can use its tools (any server name works; Tapocalypse finds the tools by name).
2. Set `"artemisPath": "/path/to/artemis"` in `tapocalypse.config.json` and restart. `bun run doctor` then reports the Artemis check and lists `artemis` under *Backends*.
3. Choose **Backend: artemis** in the New run form, or pass `backend: "artemis"` to `qa_start_run` / `POST /api/runs`.

For such runs Tapocalypse installs or upgrades the helper on the device (`uv run artemis helper install`), stops mobile-mcp's on-device server (only one tool can hold Android's UI-automation connection at a time), and tells the agent to use only Artemis's direct tools (click, swipe, input text, key press, long press, device state, app launch/stop), never its autonomous `mobile_run_task`. Devices with a live Artemis task are skipped by the scheduler, so a run for one waits in the queue until the task ends.

## Security model

Tapocalypse is a local developer tool with no login.

- **Local only.** The server binds `127.0.0.1`. Do not expose the port (tunnels, port forwarding, reverse proxies).
- **Request guards.** Every request's `Host` must be `127.0.0.1:<port>` or `localhost:<port>` (blocks DNS rebinding). Writes carrying an `Origin` must come from those same origins, and JSON endpoints require `Content-Type: application/json` (blocks cross-site form posts). Clients without an `Origin`, such as `curl` and MCP clients, are allowed.
- **Agents are trusted code.** Runs use `omp --auto-approve`: the agent runs shell commands (`adb`, `xcrun`, anything else it decides to) as your user, in your repo, without asking. A brief is effectively a program you execute. Anyone or anything that can reach the port, including every local process and every MCP client you register, can start runs, so treat them as having your shell. Review third-party personas before using them.
- **Reports render raw HTML.** Markdown reports are shown as written, including embedded HTML. Treat report files like source files and do not open reports from untrusted sources. Transcripts are served sandboxed.
- **Path safety.** File serving is limited to a project's `reportsDir` and a short list of extensions. Agent-reported report and screenshot paths, persona files and `reportsDir` must resolve inside the repo (symlinks included), and `source.path` must be the project's repo or one of its git worktrees.

## Troubleshooting

Start with `bun run doctor`: it checks every prerequisite, your config and your projects, and says how to fix what is wrong.

- **"mobile-mcp tools are not available to the agent".** omp could not start the mobile-mcp server. Check that `npx` works (Node.js installed, network available for the first download) by running `npx -y @mobilenext/mobile-mcp@latest` once by hand (it waits on stdin; Ctrl-C to stop). If you already configured a mobile-mcp server in omp, that one is used instead, so make sure it starts. See [Prerequisites](#prerequisites).
- **A run stays queued.** Possible reasons: `maxConcurrentRuns` runs are already active; every matching emulator or simulator is busy and nothing can be booted (no AVD in `devicePool.android.avds`, `maxBooted` reached, or the AVD is already running); the run names a serial that is busy or held by an Artemis task; or it needs a physical device, which is only used when requested by serial. `qa_list_devices` shows `busyRunId` per device. Runs are retried every 10 s.
- **Slow element lists on Flutter apps.** mobile-mcp can take 15-25 s to dump a large Flutter tree. The agent is told to list elements once per screen and to batch actions. The [Artemis backend](#optional-artemis-backend) avoids this on Android.
- **Emulator does not boot.** Names in `devicePool.android.avds` must match `emulator -list-avds` exactly (doctor flags unknown ones). Tapocalypse finds the emulator under `$ANDROID_HOME`, `$ANDROID_SDK_ROOT` or `~/Library/Android/sdk`; elsewhere set `ANDROID_HOME` or `EMULATOR_BIN`. Try `emulator -avd <name>` by hand to see hardware-acceleration or disk-space errors. Booting is abandoned after 180 s.
- **Port 4310 is in use.** Start with another port: `TAPOCALYPSE_PORT=4311 bun start` (or set `port`), and update the URL in your MCP client config. Requests to a different host or port get `403 forbidden host`.
- **A run ends in `error` right away with a message from omp.** Often omp is not signed in to a model provider, or the persona's `model:` is not available to you. Run `omp` interactively to sign in, and read `data/runs/<run-id>/stderr.log`.
- **"agent ended without qa_finish".** The agent stopped before reporting a verdict, for example because it hit `runMaxTime`. Open the run's transcript to see why, then retry with a narrower brief or a larger `runMaxTime`.
- **Screenshots look tiny or unreadable.** Emulators booted by Tapocalypse are raised to `minSize`; for ones you started yourself, use a larger AVD.

## Development

```sh
bun install
bun run dev         # server with hot reload; the UI hot-reloads in the browser
bun test            # unit tests (bun:test)
bun run typecheck   # tsc --noEmit
bun run doctor      # prerequisite check
bun start           # production mode (no hot reload)
```

| Path | Contents |
| --- | --- |
| `src/server.ts`, `src/app.ts` | HTTP/SSE routes, request guards, wiring |
| `src/config.ts` | Config schema, defaults, environment overrides |
| `src/runs/` | Scheduler (queue and device assignment), runner (run lifecycle), prompt and host tools, run metadata, run storage |
| `src/omp/` | omp RPC client and mobile-mcp provisioning |
| `src/devices/` | Device discovery, screenshots, emulator/simulator boot and idle shutdown |
| `src/projects/` | Project registry and repo detection |
| `src/reports/` | Report listing, rendering and safe file serving |
| `src/mcp/server.ts` | The MCP tools |
| `src/doctor.ts`, `scripts/doctor.ts` | Prerequisite checks and their CLI |
| `web/` | The UI: React 19, Tailwind 4 and [shadcn/ui](https://ui.shadcn.com) (`views/` pages, `components/`, `components/ui/` primitives) |
| `personas/` | The built-in QA persona |
| `test/` | Tests and fixtures |

Add a shadcn component with `bunx --bun shadcn@latest add <name>`; `components.json` already maps it to `web/components/ui`.

## License

MIT, see [LICENSE](LICENSE).
