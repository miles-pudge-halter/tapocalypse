# Tapocalypse guide

Back to the [README](../README.md). This is the long-form reference: every page of the UI, how runs are scheduled and judged, the MCP tools, the CLI, suites, data, security and troubleshooting. Every configuration key is in [configuration.md](configuration.md), every HTTP route and MCP parameter in [api.md](api.md), and the step-by-step setup for coding agents in [agent-setup.md](agent-setup.md).

## Contents

- [What a run looks like](#what-a-run-looks-like)
- [Prerequisites](#prerequisites)
  - [Agent runtimes](#agent-runtimes)
  - [Operating systems](#operating-systems)
- [Quick start](#quick-start)
- [Tour of the UI](#tour-of-the-ui)
- [Projects](#projects)
- [Devices](#devices)
- [Sharing devices between agents](#sharing-devices-between-agents)
- [Run outcomes](#run-outcomes)
- [Costs and usage](#costs-and-usage)
- [Dispatching runs from your coding agent (MCP)](#dispatching-runs-from-your-coding-agent-mcp)
- [Run metadata](#run-metadata)
- [Batches](#batches)
- [Regressions, history and flaky checks](#regressions-history-and-flaky-checks)
- [CLI and CI](#cli-and-ci)
- [Reading reports and screenshots](#reading-reports-and-screenshots)
- [Sharing a report](#sharing-a-report)
- [Running as a service](#running-as-a-service)
- [Brief templates and suites](#brief-templates-and-suites)
- [Configuration](#configuration)
- [Data and retention](#data-and-retention)
- [How it works](#how-it-works)
- [Security model](#security-model)
- [Troubleshooting](#troubleshooting)
- [What's not here yet](#whats-not-here-yet)
- [Development](#development)

## What a run looks like

- You give Tapocalypse a **project** (your app's repo), a free-text **brief** ("open Settings, toggle dark mode, verify it survives a restart") and a platform or a specific device.
- A device is assigned: a free emulator or simulator, or one booted for you from your configured AVDs/simulators. If everything is busy the run waits in a queue and the UI says why.
- A headless QA agent starts inside your repo (to read the code; it is told never to write there) and drives the app through [mobile-mcp](https://github.com/mobile-next/mobile-mcp) (tapping, typing, screenshots, `adb`/`simctl`). Several runs execute side by side on different devices.
- The agent declares its checks up front and reports each as it goes; the UI shows every check turn pending → running → pass/fail, a live device screen and the agent's activity feed. You can cancel mid-run, and steer it on harnesses that support steering.
- The agent hands in a markdown report with embedded screenshots, and Tapocalypse stores both in its own data folder (`<data dir>/runs/<run-id>/report.md` and `screenshots/`), not in your repo. Reports are browsable in the UI and readable from your coding agent ([Reading reports and screenshots](#reading-reports-and-screenshots)).
- The run ends with a verdict (`PASS`, `PASS WITH ISSUES`, `FAIL`, `BLOCKED` or `PARTIAL`), a summary, what it cost and, on harnesses that export one, a full transcript. See [Run outcomes](#run-outcomes).

## Prerequisites

Run `bun run doctor` to check all of this. It prints one line per tool with a fix hint for anything missing and exits 1 if a required tool is absent. The same checks appear on the **Setup** page and through the `qa_doctor` MCP tool.

| Tool | Why | Required? | Install |
| --- | --- | --- | --- |
| [Bun](https://bun.sh) ≥ 1.3 | Runs the server, the UI bundler and the tests | Required | `curl -fsSL https://bun.sh/install \| bash` |
| An agent runtime, signed in: [omp](https://github.com/can1357/oh-my-pi), [Claude Code](https://code.claude.com) **or** [Codex CLI](https://github.com/openai/codex) | The QA agent. Tapocalypse starts one headless process of the harness you pick per run, and you need at least one. Doctor checks that each installed harness is signed in and requires only the one that is your default. See [Agent runtimes](#agent-runtimes) | Required (at least one of the three) | See [Agent runtimes](#agent-runtimes) |
| Node.js 18+ with `npx` | Fetches and runs `@mobilenext/mobile-mcp`, the device driver. Tapocalypse starts it itself and serves its tools to each run pinned to the run's device, no config edit needed | Required | https://nodejs.org |
| Android `adb` (platform-tools) | Talks to Android emulators and devices | Required for Android | Android Studio → SDK Manager, `brew install --cask android-platform-tools`, or your distro's `android-tools-adb`; put it on `PATH` or set `ADB_BIN` |
| Android Emulator + at least one AVD | Lets Tapocalypse boot emulators on demand | Optional (without it, only already-running devices are used) | Android Studio → SDK Manager, then Device Manager → Create device |
| Xcode + iOS simulators | iOS runs (macOS only) | Required for iOS | Install Xcode, then `sudo xcode-select --switch /Applications/Xcode.app` |
| git | Records branch, commit and dirty state on each run | Optional | https://git-scm.com |
| [gh](https://cli.github.com), logged in (`gh auth login`) | Looks up the pull request for the run's branch | Optional | `brew install gh` |

You need at least one of Android (adb) or iOS (Xcode). Your app must be installed on the device the run uses (or be installed for you with [`--install`](#cli-and-ci)); Tapocalypse does not build it.

### Agent runtimes

Tapocalypse does not ship a model or an agent loop: it drives a coding-agent CLI headlessly, the same one you may already use. Install and sign in to at least one:

| | [omp](https://github.com/can1357/oh-my-pi) | [Claude Code](https://code.claude.com) | [Codex CLI](https://github.com/openai/codex) |
| --- | --- | --- | --- |
| Install | Follow the omp README; `omp` on `PATH` or `OMP_BIN` | `npm install -g @anthropic-ai/claude-code` or the installer on code.claude.com; `claude` on `PATH` or `CLAUDE_BIN` | `npm install -g @openai/codex`; `codex` on `PATH` or `CODEX_BIN` |
| Sign in | `omp login`, or export a provider API key | `claude auth login` (a subscription or an API key) | `codex login` |
| Doctor probes (never a paid model call) | `omp --version`; `omp models --json` lists at least one model | `claude --version`; `claude auth status --json` | `codex --version`; `codex login status` |
| Progress tools (`qa_plan`, `qa_check`, `qa_finish`) | Native host tools | Run-scoped MCP endpoint over HTTP | Run-scoped MCP endpoint through a stdio bridge, so it works on every Codex version |
| Steer a running agent | Yes | Yes | No (the control is hidden; the 80% wrap-up reminder is skipped and the agent relies on the deadline in its prompt) |
| Cost | Yes, when the provider reports one | Yes (Claude Code's own estimate) | Tokens only; cost shows `—` |
| Full transcript (`transcript.html`) | Yes | No; the activity feed and `events.jsonl` are the record | No; same |
| Limits it enforces itself | Time (`--max-time`; Tapocalypse still kills it at budget + 5 min) | Turns and budget (`agent.maxTurns`, `agent.maxBudgetUsd`); Tapocalypse kills it at the time budget | None; Tapocalypse kills it at the time budget |
| Model and effort strings | `provider/model[:thinking]` | An alias (`opus`, `sonnet`, `haiku`) or a full model id; effort `low` … `max` | A `gpt-…` id; effort `minimal`, `low`, `medium`, `high` or `xhigh` |

**Which harness runs.** In order: the run's own `harness` (the **New run** picker, `--harness`, `harness` in `POST /api/runs` and `qa_start_run`), the project's `agent.harness`, the persona's `harness:` frontmatter, `agent.harness` in the config, then the first harness that is installed and signed in (omp, Claude Code, Codex CLI, in that order), else the first that is installed, and finally omp. Doctor and the **New run** picker use this same rule. The **New run** form only offers installed harnesses and preselects the default, and every run records the harness it used (a badge on the run page). Runs created before harnesses existed count as omp runs.

**Doctor.** Every harness gets an install check (id `omp`, `claude` or `codex`) and a sign-in check (`omp-auth`, `claude-auth`, `codex-auth`; skipped when the harness is not installed). Only one harness is *required*: the one that would run by default (`agent.harness` when set, otherwise the first that is installed and signed in, else the first installed, else omp); the others are informational. A synthetic required check, `agent-runtime`, is ok when at least one harness is installed and signed in, warns when some are installed but none is confirmed signed in, and fails when none is installed; its fix text lists the three options.

Settings per harness (binary, model, effort, permissions or sandbox) are under `agent` in the config; see [docs/configuration.md](configuration.md#agent-harnesses). Permissions are covered in the [Security model](#security-model).

### Operating systems

- **macOS:** Android and iOS (simulators, via Xcode).
- **Linux:** Android only; iOS simulators need macOS.
- **Windows:** not supported (doctor reports an error).

**Linux note.** The Android Emulator needs hardware acceleration (KVM). Enable virtualization in your BIOS/UEFI and make sure your user can use `/dev/kvm` (usually membership of the `kvm` group); without it emulators boot very slowly or not at all, and Tapocalypse gives up on a boot after 180 s. Tapocalypse finds the emulator under `$ANDROID_HOME`, `$ANDROID_SDK_ROOT` or `~/Android/Sdk` (macOS: `~/Library/Android/sdk`).

## Quick start

```sh
git clone https://github.com/miles-pudge-halter/tapocalypse.git
cd tapocalypse
bun install
bun run doctor     # fix anything marked ✗
bun start          # → tapocalypse listening on http://127.0.0.1:4310
```

To keep Tapocalypse running in the background and start it at login (macOS and Linux), run `bun src/cli.ts service install` instead of `bun start`; see [Running as a service](#running-as-a-service).

1. Open <http://127.0.0.1:4310>. The first start creates a config file (`~/.config/tapocalypse/config.json`, or next to the code if you already had a `tapocalypse.config.json` there; see [Data and retention](#data-and-retention)). The **Setup** page walks you through the rest.
2. Make sure an emulator or simulator with your app installed is running, or list an AVD in `devicePool.android.avds` ([Devices](#devices)) and let Tapocalypse boot it.
3. **Projects → Add project**: pick a suggested folder or paste the absolute path of your app's repository. Detection fills in the name, package/bundle id, platform and persona; check them and save.
4. **Runs → New run** (or press `n`): pick the project, a device (or "Any android" / "Any ios"), write a title and a brief, and start. You land on the run page with live checks, device screen and activity.

## Tour of the UI

The sidebar is on every page: a **project switcher** that scopes the whole UI to one project (or all), the navigation with live badges (running runs, busy/total devices, a red dot on Setup while a required prerequisite is missing), search (`⌘K`), a live-connection indicator, a notifications toggle, the light/dark/system theme and the version. It collapses to an icon rail.

| Page | What you do there |
| --- | --- |
| **Runs** (`#/`) | A live strip (running, queued, devices busy, how many are held by agents, 7-day pass rate and spend; each segment is a filter shortcut), an **Active** lane with a card per queued or running run (live screen, current check, progress, queue position and reason), and the history below. Filter by status, verdict, project and free text (title, branch, PR, ticket, commit); group by day, batch or nothing. Filters live in the URL, so they can be bookmarked. **New run** opens a sheet with brief templates, saved suites, recent briefs, harness, device, model, effort, package, working directory/PR and an optional app to install |
| **Run** (`#/runs/<id>`) | The workbench. Header with status, the harness badge, verdict (tagged *derived* when the agent never reported one), device and actions: Cancel, Re-run (all checks or failed only), Open report, Transcript (when the harness exports one), Details, Delete. A phase stepper while active, an outcome callout when it ended (what went wrong in plain words, the stderr tail, Retry / Re-run failed), then three panes: the **checks** list, the **timeline** of the agent's tool calls paired with their results and the **device** pane (live screen, or the evidence screenshot of the selected check). A Screenshots tab shows the gallery; a steer box sends instructions to a running agent (hidden when the run's harness cannot be steered). Narrow windows switch to tabs |
| **Batch** (`#/batches/<id>`) | One lane per device of a [batch](#batches), the rolled-up verdict and total cost, and **Re-run failed lanes** |
| **Devices** | Run slots and emulators booted vs `maxBooted`, and how many devices are held by agents; a card per connected device with a live thumbnail and its state (Free, Running, Held by an agent with its holder, reason, time left and the agents and runs waiting, Booting, Idle with a shutdown countdown, Excluded, "not used for QA" for watches and TVs); **New run here**, **Release…** (end an agent's lease), a bell to be notified when a held device frees up, **Shut down** (devices Tapocalypse booted) and ghost cards with a **Boot** button for your configured AVDs and simulators. See [Sharing devices between agents](#sharing-devices-between-agents) |
| **Setup** | A *Get started* checklist that ticks itself off (prerequisites, add a project, connect a device, first run, connect your coding agent), every doctor check (one pair per installed harness) with copyable fixes, and **Connect agent** snippets for omp, Claude Code and Cursor with live status of the first MCP call |
| **Projects** | A card per project with its last runs, 7-day pass rate and spend; New run, Edit, Reports, Suites and Delete. The add-project wizard suggests folders and shows what detection found |
| **Reports** | Per-project report list (search, verdict tabs, grouped by day). A report page has an "On this page" outline, the run's details with a link back to it, a screenshot gallery (click any image) and a reading-progress bar |
| **Compare** (`#/runs/<id>/compare/<baselineId>`) | One run against a baseline, check by check: newly failing first, then flaky, fixed, changed, still failing, new, removed and unchanged. Screenshots side by side, as a swipe or as an onion skin, the two notes, duration and cost deltas, and **Confirm / Unlink / Link** for matches Tapocalypse is unsure about. See [Regressions, history and flaky checks](#regressions-history-and-flaky-checks) |
| **Flaky checks** (`#/p/<projectId>/flaky`, the second tab of **Reports**) | Checks of the project that flip between pass and fail on the same code and device, with their recent results, pass rate and last flip; open any of them to see its history. Says "Not enough history yet" until some check has run more than once |

**Regressions in the UI.** A finished or running run page shows a *Compared to* strip under its header: the auto-picked baseline run (change it with the picker or `b`), the verdict change (`PASS → FAIL`) and the counts (↓ newly failing, ↑ fixed, ❄ flaky, + new, − removed, = unchanged), with **Open comparison** (`c`). These links, the `↓ n` chip and `c` open the comparison with the automatic baseline (`#/runs/<id>/compare/auto`), so they show what the strip counted; a baseline you picked yourself stays picked in the links of that run page. Every check in the checks list carries a badge such as "was pass on main · 2d ago", and its **History** button (or `h`) opens the check's history in a side sheet: a strip of its recent results, the pass rate, and each result with branch, commit, device, note and screenshot. In the runs list a red `↓ 2` chip marks a run with checks that passed in its baseline and fail now, and **Has regressions** filters to those runs. When a finished run has newly failing checks, its toast and desktop notification say so.

Finished runs raise a toast; with notifications enabled (sidebar bell) you also get a desktop notification while the tab is in the background, and the tab title shows how many runs finished while you were away.

**Command palette (`⌘K` / `Ctrl+K`).** Search runs (by title, id, branch, PR or ticket), projects, devices and reports; jump to any page; or run an action: New run, New run on a specific device, Re-run last failed, toggle theme, toggle notifications, show shortcuts.

**Keyboard shortcuts** (single keys are ignored while you type in a field; `?` shows this list in the app):

| Keys | Action |
| --- | --- |
| `⌘K` / `Ctrl+K` | Command palette |
| `n` | New run |
| `/` | Focus search (Runs page, run timeline) |
| `⌘B` / `Ctrl+B` | Collapse or expand the sidebar |
| `?` | Show the shortcuts |
| `g` then `r` / `d` / `p` / `s` | Go to Runs / Devices / Projects / Setup |
| `j` / `k`, `Esc` | On a run: next / previous check, clear the selection |
| `c` / `b` / `h` | On a run: open the comparison / change the baseline / history of the selected check |
| `1` `2` `3`, `[` `]`, `h` | On a comparison: side by side / swipe / onion skin, move the swipe or fade, history of the selected check |
| `⌘Enter` / `Ctrl+Enter` | Send the steer message |
| `←` `→`, `Esc` | Image viewer: previous / next, close |

## Projects

A project tells Tapocalypse where your app's repository is and how to test it. Add them in the UI (**Projects**), from your agent over MCP, or in the config file.

| Field | Meaning |
| --- | --- |
| `id` | 1-40 chars: lowercase letters, digits, dashes. Cannot change later |
| `name` | Display name, 1-60 chars |
| `repoPath` | Absolute path of the repo (`~` is expanded). The agent runs with this as its working directory |
| `personaFile` | QA persona markdown, relative to the repo. `null`/omitted = the built-in persona |
| `reportsDir` | Legacy and optional; not offered when you create or edit a project. Only read to show reports that earlier runs wrote into that folder of your repo (default `qa`). New runs never use it: their reports live in Tapocalypse's data folder |
| `defaultPackage` | Android `applicationId` or iOS bundle id of the app under test, e.g. `com.example.app.dev` |
| `defaultPlatform` | `android` or `ios`, used when a run names no platform or device |
| `agent` | Optional per-project override `{ harness?, model?, effort? }` of the [harness](#agent-runtimes), model and effort for this project's runs |
| `defaultBranch` | Optional. The branch [regressions](#regressions-history-and-flaky-checks) compare a feature branch against (for example `main`). Unset: the remote's default branch (`origin/HEAD`), else `main` or `master` when the repo has one. Editable in the project form; clear it to go back to the fallback |

**Detection.** The UI wizard and `qa_detect_project` inspect the repo without running anything and suggest every field. They read: `pubspec.yaml` (Flutter), `package.json` dependencies (Expo, React Native), `app.json`/`app.config.json` (Expo ids), Gradle files and `AndroidManifest.xml` (`applicationId`, flavors and suffixes in `android/app`, `app`, `androidApp`, `composeApp`), Xcode `project.pbxproj` (`PRODUCT_BUNDLE_IDENTIFIER`), `shared`/`composeApp` modules (Kotlin Multiplatform), `.omp/agents/`, `.claude/agents/` and `.codex/agents/` for QA-looking persona files and whether the folder is a git repo. When several package ids exist it prefers one ending in `.dev` or `.debug`. The wizard also suggests app folders it finds under common code directories (`~/Projects`, `~/code`, `~/src`, `~/Developer`, …).

**From your agent.** `qa_detect_project { repoPath }` then `qa_create_project { repoPath }`; omitted fields are filled from detection, and you are told which ones to supply if something cannot be inferred. See [MCP](#dispatching-runs-from-your-coding-agent-mcp).

**In the config file.** Add objects with the fields above to `projects`. Edits made by hand need a server restart; edits made in the UI or over MCP apply immediately and are written back to the file. Invalid projects are listed with their problems and cannot start runs, but never stop the server from booting.

**Persona.** The persona is the system prompt of the QA agent. Leave it unset to use the built-in [`personas/default-mobile-qa.md`](../personas/default-mobile-qa.md): a thorough, evidence-first mobile QA engineer for Android and iOS. To use your own, point `personaFile` at a markdown file in the repo. Its body is appended to the harness's system prompt (omp and Claude Code append it natively; Codex CLI receives it as developer instructions); its optional frontmatter may name the harness it was written for and a model:

```markdown
---
harness: claude
model: opus
---
You are the QA agent for our app. Known quirks: ...
```

`model` is a harness-native string: for omp `<provider>/<model>[:thinking]` (the suffix after the last `:` is the thinking level when it is one of `off minimal low medium high xhigh max`, otherwise it stays part of the model name), for Claude Code an alias or full id, for Codex CLI a `gpt-…` id. A persona's `model:` applies only when its `harness:` equals the harness the run uses; a persona without `harness:` counts as an omp persona, so existing personas keep working and are simply ignored on other harnesses (their `harness:` can also pick the harness, see [Agent runtimes](#agent-runtimes)).

The model for a run is, in order: the run's own `model`, the suite's, the project's `agent.model`, the persona's (when its harness matches), `agent.harnesses.<harness>.model` from the config, for omp the legacy `agent.model`, and finally the harness's own default. Effort (thinking level) resolves the same way, with `agent.thinking` as the legacy omp key. Whatever the persona says, every run's prompt adds the device, package, run id, time budget, screenshot folder and the progress-reporting protocol, and the built-in persona defers to them.

## Devices

- **Platform-only requests** ("Any android", "Any ios", or just a project default) go to the first free emulator or simulator, ordered by serial. Free means: connected and ready, not used by another run, not listed in `devicePool.android.excludeSerials`, and not [leased by a coding agent](#sharing-devices-between-agents).
- **Physical devices are never picked automatically.** They are used only when a run names their serial, so your own phone is never grabbed by accident. Watches and TVs never run QA: they are skipped, and naming one is rejected. Wear OS, TV and Automotive AVDs are never booted automatically.
- **Explicit serial.** If the device is busy the run waits in the queue (it is not rejected). A serial that is not connected, or is in `excludeSerials`, is rejected immediately. Runs for other devices are not blocked by a waiting run.
- **Queueing.** Runs start in order as devices free up, at most `maxConcurrentRuns` at a time. The queue survives restarts. A queued run shows its position and the reason it is waiting (for example `maxConcurrentRuns (2) reached`, `all android devices busy (1 held by agents, 1 running QA)`, `emulator-5554 is held by claude · checkout-redesign until 14:32`, `emulator-5554 is busy`, `maxBooted (1) reached`). Runs and waiting agents share one first-in, first-out queue.
- **Auto-boot.** If no device is free, Tapocalypse boots one from your pool: an AVD from `devicePool.android.avds` that is not already running (while fewer than `maxBooted` emulators are booted), or a simulator UDID from `devicePool.ios.simulators` (list them with `xcrun simctl list devices`). Emulators start with `-no-snapshot-save -no-boot-anim -no-audio` on even ports from `basePort` (`emulator-5560`, `emulator-5562`, …) and must finish booting within 180 s. Set `maxBooted` to `0` to disable auto-boot.
- **Manual boot and shutdown.** The **Devices** page boots any configured AVD or simulator on demand, and shuts down devices Tapocalypse booted that no run or agent lease is using (`POST /api/devices/boot`, `POST /api/devices/:serial/shutdown`).
- **Idle shutdown.** A device Tapocalypse booted is shut down after sitting unused for `idleShutdownMinutes` (checked every minute). Devices you started yourself are never shut down.
- **Minimum resolution.** Some AVDs boot with tiny screens that make screenshots unreadable. A booted emulator whose screen is smaller than `minSize` (default 720x1280) is switched to `minSize` at `minDensity` dpi.
- **Restarts.** Tapocalypse forgets which devices it booted; after a restart they are ordinary devices and are not shut down automatically.

## Sharing devices between agents

Your coding agents (Claude Code, Codex, omp, Cursor, in as many windows as you like) often need an emulator or simulator too, and two agents tapping through one device at once wreck each other's work. Tapocalypse is the **device broker** for the machine: an agent borrows a device with a **lease**, and nobody else (another agent, or a QA run) is given that device until the lease ends.

- **What a lease is.** An exclusive claim on one device, held by a named holder. A QA run already holds one implicitly from the moment its device is assigned until it finishes, so a leased device is never given to a run, and a device in use by a run is never leased. Agent leases last `ttlMinutes` (default 30, 5-120) from the last renewal.
- **Tools.** Three MCP tools on `/mcp` (or the same operations over [HTTP](api.md#device-leases)):

  | Tool | Purpose |
  | --- | --- |
  | `device_acquire` | Borrow a device: `{ serial }` or `{ platform }`, a required `holder` (who you are and what you work on, for example `claude-code · checkout-redesign`), an optional `reason`, `ttlMinutes`, `waitSeconds` (0-110, default 0), `ticket` and `cwd`. Returns `serial`, `platform`, `name`, `mobileDeviceId` (the id mobile-mcp tools expect), `leaseId`, `expiresAt` and `ttlMinutes` |
  | `device_renew` | `{ leaseId, ttlMinutes? }`: extend the lease to now + its TTL (or a new `ttlMinutes`) |
  | `device_release` | `{ leaseId }`: give the device back so the next waiter gets it |

  `qa_list_devices` shows each device's `lease` (holder, reason, times; never the secret) and who is waiting for it.
- **Choosing a device.** `{ platform }` takes the first free emulator or simulator, and boots one from your configured pool under `maxBooted` when none is free (booting can take up to 180 s, so the call may return `state: "booting"`). Physical devices are leased only by explicit `serial`. Devices in `excludeSerials` (`device_excluded`) and watches and TVs (`device_unsupported`) cannot be leased.
- **Waiting and tickets.** If nothing fits, `device_acquire` waits up to `waitSeconds`, then returns `timedOut: true` with a `ticket`, its `position`, `state` (`waiting` or `booting`), who holds the device (`heldBy`) and a `reason`. Call again with the same arguments plus the `ticket` to keep your place; a ticket is kept for 60 s after its call returns, and at most 32 tickets exist at once (`queue_full`). Waiting agents and queued QA runs share one first-in, first-out queue: the earliest compatible entry gets each freed device, and an entry that cannot be served yet does not block later ones. If a device is granted to your ticket between calls, it is held for you for 60 s; call again with the `ticket` to pick it up, or it goes to the next in line. `{ platform }` with nothing free and nothing bootable fails at once with `no_device` instead of waiting. MCP clients should allow a tool timeout of at least 120 s so a `waitSeconds: 110` call is not cut off.
- **Renewing and expiry.** `leaseId` is returned once and cannot be recovered; the agent keeps it in its notes. It renews with `device_renew` while it works (the [snippet](agent-setup.md#8-let-your-agents-borrow-devices-optional) says when) and always calls `device_release` when done, also on failure. A lease that is not renewed ends on its own at `expiresAt` (checked every 15 s), so an agent that crashed frees its device within one TTL. A lease also ends when its device disappears for 2 minutes or comes back as a different AVD (`emulator-5556` can be another emulator after a restart). A late `device_renew` or `device_release` is told why the lease ended (`released`, `expired`, `revoked` or `gone`) when Tapocalypse still remembers it (the last 100 ended leases).
- **In the UI.** On **Devices**, a held card shows the holder, reason, since/until times, a ring counting the time left, and the agents and runs waiting (`2 waiting: omp · checkout-redesign, run “Login smoke”`). **Release…** ends a stuck lease after a confirmation (it cannot stop the agent, which learns the next time it calls a lease tool); a lease held by a QA run is ended by cancelling the run instead. The bell notifies you when a held device frees up. The pool header counts devices held by agents and who waits for "any Android" or "any iOS", the live strip and the sidebar badge count leases as busy, the New run picker disables held devices and shows who holds them and when they free up, and a queued run says which agent it waits for. A device granted to a waiting agent shows "Reserved for <holder>" during its 60 s claim window.
- **Restarts and idle shutdown.** Agent leases are stored in `<data dir>/leases.json` (owner-only permissions) and survive a restart until they expire, because the agent in another window still holds its `leaseId`. Run leases and tickets are not stored: runs become `interrupted` and waiting agents call again. A device Tapocalypse booted is never idle-shut down or shut down from the UI while it is leased.
- **The `mobile_*` gateway.** The same `/mcp` endpoint also serves mobile-mcp's device tools (`mobile_take_screenshot`, `mobile_click_on_screen_at_coordinates`, `mobile_list_elements_on_screen`, `mobile_batch_commands`, … 28 of them), under the same names but with `device` replaced by a required `leaseId`. Tapocalypse starts one mobile-mcp child per leased device on the lease's first call (in the `cwd` you gave to `device_acquire`, so screenshots saved there are readable by your agent), always drives it on the leased device whatever the arguments say (steps of `mobile_batch_commands` included), renews the lease on every call and stops the child when the lease ends, however it ends. A call with an unknown or ended `leaseId` fails with `lease_not_found: <reason>`. Device listing (`mobile_list_available_devices`) and the remote-cloud tools are not offered. The tools are always listed; the first-ever listing starts a throwaway mobile-mcp once (up to 15 s) to learn their schemas and then caches them in `<data dir>/gateway-tools.json`. This is the one place a lease is enforced rather than agreed: an agent that uses Tapocalypse's `mobile_*` tools cannot touch a device it does not hold. It cannot stop an agent that bypasses the gateway (see Limits below).
- **Limits.** Only the gated `mobile_*` tools are enforced. Everything else is **cooperative**: Tapocalypse refuses to hand a leased device to a run or another agent that asks through it, but cannot stop a process that ignores the broker: raw `adb`, `xcrun simctl`, an agent's own mobile-mcp server, Appium, Maestro, `flutter run` or an IDE deploy all reach the device regardless. The lease protocol in the agent's instructions is what keeps them away. A QA run that names a serial its own agent holds waits behind the lease like any other (it does not take it over). Tapocalypse instances on other ports have their own data folders and do not see each other's leases. Because `leaseId` is the only secret, treat it like a password: see [Security model](#security-model).

Set your agents up with the [lease snippet in agent-setup.md](agent-setup.md#8-let-your-agents-borrow-devices-optional) or the **Setup** page.

## Run outcomes

**Statuses.** `queued` → `preflight` (booting a device, installing the app, reading its build) → `running` → `finishing` (the agent reported a verdict and is wrapping up) → `done`; or `error`, `cancelled` or `interrupted` (Tapocalypse stopped while the run was active).

**Verdicts.** The agent ends with `PASS`, `PASS WITH ISSUES`, `FAIL`, `BLOCKED` (it could not test, for example a login wall or a crash on launch) or `PARTIAL` (some checks could not be completed). A `done` run always has one; a batch shows the worst of its runs.

**Derived verdicts.** If the agent stops without reporting (it ran out of time, crashed or just quit) but at least one check resolved, the run is still `done` and Tapocalypse derives the verdict from the checks: `FAIL` if any failed, `PARTIAL` if any is blocked, unfinished or nothing passed, otherwise `PASS`. The summary says so ("No report from the agent; verdict derived from checks: 5 pass · 1 fail · 2 unresolved."), the UI tags the verdict *derived*, `verdictSource` is `derived`, and `error` keeps the cause. If no check resolved, the run ends `error`.

**Error kinds.** Every failed run records why, as `errorKind`:

| Kind | Meaning |
| --- | --- |
| `infra` | Tapocalypse or the machine failed: emulator did not boot, the agent runtime did not start or crashed (exit ≠ 0, other than SIGTERM) before any check resolved, mobile-mcp or the progress tools did not appear, the gateway served no device tools (its first mobile-mcp probe failed or timed out: the agent is not prompted), app install failed |
| `agent` | The agent ended without a report and without a resolved check ("agent ended without qa_finish"), or the harness reported a run error |
| `timeout` | The run used up its time budget, or the harness hit a turn or budget limit (`error` says which: "turn limit", "budget") |
| `cancelled` | You cancelled it |

**Infra auto-retry.** An `infra` failure with no resolved check is queued again automatically as a new attempt (`attempt` 2, linked by `retryOf` / `retriedBy`), up to `retry.infra` times (default 1; `0` disables). Failed installs and unsupported device types are not retried. The CLI and `qa_wait_run` follow the retry, so the exit code and result reflect the final attempt.

**Time budget.** `runMaxTime` (default 60 min; it must be a valid duration such as `90m`, `1h30m`, `45s` or `2h`, a bare number meaning minutes, and the server refuses to start otherwise) is written into the agent's prompt, and omp also enforces it itself (`--max-time`). At 80% of it Tapocalypse steers the agent to stop testing, write the report and finish, on harnesses that can be steered (Codex CLI cannot; it relies on the deadline in its prompt). Tapocalypse hard-kills Claude Code and Codex CLI when the budget is reached, and omp (which enforces `--max-time` itself) 5 minutes after it. Claude Code additionally honours `agent.maxTurns` and `agent.maxBudgetUsd`. Every limit that ends a session is treated like the time budget: a run that hits one with checks resolved ends `done` with a derived verdict and `errorKind: timeout` (with the limit named in `error`); with none, `error`.

**Installing the app first.** A run (or `--install <path>` on the CLI) can name an absolute `.apk` (Android) or `.app` / `.ipa` (iOS simulator). It is installed before the run (`adb install -r -d` / `xcrun simctl install`, 3 min limit); a failure ends the run `error` / `infra` without a retry. The installed app version is recorded before and after the run.

## Costs and usage

Every run records what the agent consumed, as reported by its harness: **cost** (omp: when the provider reports one; Claude Code: its own estimate; Codex CLI reports tokens only, so cost is `—`; shown as `—` whenever none is known), input, output and cache read/write tokens, tool calls and the model used. It is captured even for cancelled runs, and totals are rebuilt from the live event stream if a run dies before the harness can answer. You see it on the run page (usage strip), per run in the lists, summed per batch, as **Spend · 7d** on the Runs page and in `GET /api/stats` (totals, pass/fail counts, median duration, per-day buckets), and agents get it in `qa_get_run` (`usage`, `durationMs`). The raw omp session statistics, for omp runs, are under Details on the run page.

## Dispatching runs from your coding agent (MCP)

Tapocalypse serves an MCP endpoint (streamable HTTP, stateless, `POST` only) at `http://127.0.0.1:4310/mcp`, so the agent that just edited your code can start QA runs, wait for them and read the results. Keep Tapocalypse running while you work. The **Setup** page shows these snippets with the right URL and tells you when your agent first calls in.

**omp.** Add the server to `~/.omp/agent/mcp.json` (user level, so every git worktree of your project sees it):

```json
{
  "mcpServers": {
    "tapocalypse": { "type": "http", "url": "http://127.0.0.1:4310/mcp", "timeout": 120000 }
  }
}
```

**Claude Code.** `claude mcp add --transport http --scope user tapocalypse http://127.0.0.1:4310/mcp`

**Codex CLI.** Add a table to `~/.codex/config.toml` (`codex mcp add tapocalypse --url http://127.0.0.1:4310/mcp` writes the first two lines). Raise the tool timeout: Codex's default of 60 s is shorter than one `qa_wait_run` call (up to 110 s).

```toml
[mcp_servers.tapocalypse]
url = "http://127.0.0.1:4310/mcp"
tool_timeout_sec = 120
```

**Cursor** (`~/.cursor/mcp.json`) **or any other client** that supports streamable HTTP: point it at the same URL. Use `127.0.0.1` or `localhost` with the configured port; requests with any other `Host` are refused. If you change `port`, update the URL.

| Tool | Purpose |
| --- | --- |
| `qa_list_projects` | Registered projects with `status` (`ok`/`invalid`) and problems. Only `ok` projects can start runs |
| `qa_detect_project` | Inspect a repo and suggest project settings |
| `qa_create_project` / `qa_update_project` / `qa_delete_project` | Register a project (omitted fields come from detection), change only the fields you pass, or remove one (not while it has active runs) |
| `qa_list_devices` | Connected emulators, simulators and devices with busy/booting flags, the agent `lease` holding each and who is waiting |
| `device_acquire` / `device_renew` / `device_release` | Borrow a device for a coding agent with a lease, extend it, give it back; see [Sharing devices between agents](#sharing-devices-between-agents) |
| `qa_doctor` | Prerequisite report with a fix for anything missing; call it when runs fail to start |
| `qa_list_suites` | Saved suites of a project (reusable briefs with fixed check ids) |
| `qa_start_run` | Queue a run (optional `harness`: `omp`, `claude` or `codex`); returns `runId`, `status`, `queuePosition`, a UI `url` and the recorded `source` |
| `qa_start_batch` | The same brief on 1-8 devices, one run each (optional `harness`); returns `batchId` and the runs |
| `qa_rerun` | New run from a finished one, re-testing only the failed checks or everything; optional `harness` to repeat it on another runtime (default: the original's) |
| `qa_steer_run` | Send an instruction to a running agent |
| `qa_cancel_run` | Cancel a queued or active run |
| `qa_get_run` | Status, checks, verdict (and whether derived), summary, error and `errorKind`, usage, absolute `reportPath` and `screenshotsDir` (in Tapocalypse's data folder), source, build |
| `qa_wait_run` | Block until a run finishes or `timeoutSec` (default 90, clamped to 5-110) passes; check `timedOut` and call again |
| `qa_wait_runs` | The same for several runs or a whole batch (`mode` `all` or `any`) |
| `qa_list_runs` | Recent runs, newest first, filtered by project, branch, PR, ticket, commit or status; see [Run metadata](#run-metadata) |
| `qa_get_report` | The markdown report of a finished run, read from Tapocalypse's data folder |
| `qa_get_screenshots` | The run's screenshots: `[{ checkId, name, path, url }]`, `path` absolute so you can open the image |
| `qa_export` | Copy the report and screenshots of a run into a folder you name (`{ runId, dir }`, `dir` absolute), for example inside your repo |
| `qa_compare_runs` | Compare one run against its automatic baseline (or `baselineRunId`): verdict change, counts and the changed checks with status, note and absolute screenshot paths; see [Regressions, history and flaky checks](#regressions-history-and-flaky-checks) |
| `qa_check_history` | The history of one check across runs (by `projectId` + `checkKey`, or `runId` + `checkId`): recent results, pass rate, flaky label |
| `qa_find_regressions` | "Did I break anything?": the newly failing, flaky, lost-coverage and new failing checks of the runs for a branch, PR or commit, against their baselines. Call it after your runs finish |

Parameters for every tool are in [docs/api.md](api.md#mcp-tools). `source` is `{ path?, branch?, commit?, prNumber?, prTitle?, prUrl?, tickets?, labels? }`.

**Example.** You tell your agent:

> Implement the dark-mode toggle, then use Tapocalypse to check on Android that the toggle works and the choice survives an app restart.

The agent typically does this:

1. `qa_list_projects` to find the project id (or `qa_detect_project` + `qa_create_project` the first time).
2. `qa_start_run { projectId, title: "Dark mode toggle", brief: "...", requester: "my-agent", source: { path: "<its cwd>" } }`. `source.path` must be the project's repo root or one of its git worktrees; it makes the run record the agent's branch, commit and PR rather than the main checkout's.
3. `qa_wait_run { runId }` in a loop until `timedOut` is `false`, optionally narrating the `checks` it sees.
4. Reads the verdict and summary, then the report with `qa_get_report` (and the evidence with `qa_get_screenshots`) to fix what failed, then `qa_rerun { runId, only: "failed" }` to confirm.

Starting several runs back to back is fine: they are scheduled in parallel across devices. QA agents launched by Tapocalypse are told never to call `tapocalypse` tools, so registering the server at user level cannot cause recursion.

You can also start runs over plain HTTP ([docs/api.md](api.md)), or with the [CLI](#cli-and-ci):

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

Filter runs with `qa_list_runs` (`projectId`, `branch`, `prNumber`, `ticket`, `commit` as a sha prefix, `status`, `limit`) or `GET /api/runs?project=&status=running,done&branch=&pr=&ticket=&commit=`. The Runs page search box matches title, branch, PR, ticket and commit.

## Batches

A batch is one brief fanned out to several devices at once, for example the same smoke test on a phone and a tablet emulator, or on Android and iOS. Start one with `POST /api/batches`, the `qa_start_batch` MCP tool or `tapocalypse run --devices N` / repeated `--serial`. Every device gets its own run (titled `<title> · <device>`) that goes through the normal queue, so a batch is never faster than your device pool allows. The batch has one verdict, the worst of its runs (`FAIL` > `BLOCKED` > `PARTIAL` > `PASS WITH ISSUES` > `PASS`; none until every run has one), one total cost, and its own page in the UI with **Re-run failed lanes**.

## Regressions, history and flaky checks

A single run tells you what works today. Tapocalypse also remembers what worked before: every check gets an **identity across runs**, every run is compared with an automatic **baseline**, and you can ask "did this change break anything?" from the UI, an agent or CI. Nothing needs configuring and no model call is involved; it is derived from the runs you already have.

### How checks are matched

Two levels of identity are stored in each run's `run.json`:

- **Test.** A recurring brief. A suite run is the test `suite:<id>`; a re-run or retry keeps its parent's test; otherwise a run joins the earliest run of the project with the same brief text (the "Re-run ONLY these checks" section that re-runs add is ignored), or the same run title once version numbers, a trailing round number and `(re-run)` are dropped. Anything else starts a new test.
- **Check.** Each check gets a *check key*, decided when the run reaches a final state (including cancelled and interrupted runs), by the first rule that applies:

| Rule | Matches when | Shown as |
| --- | --- | --- |
| Suite id | the run is a suite run and the check id is one the suite fixed | "Identified by suite check id" |
| Re-run lineage | the run is a re-run or retry and its parent has a check with the same id | "Identified by re-run lineage" |
| Carried over | the agent said the check re-tests one of the previous checks it was shown (`was`, see below) | "Identified by checks the agent carried over" |
| Title | the title, normalised, equals that of an existing check in the project. Normalising drops accents, case, a leading agent id such as `B6.1` and filler words (`a`, `the`, `verify`, `check`, `ensure`, …) but keeps word order and negations, so "no crash" is not "crash" | "Identified by title" |
| Similar title | no title matches, but a check of one of the test's last 3 runs shares at least 60% of its words (a shared ticket key adds weight) | "likely match" |
| New | nothing matched | a new check |

Within one run, two checks never share a key. Keys of a running run are provisional and are written once, when it ends, so an agent can re-plan freely. Runs recorded before this feature are keyed once, in order, the first time the server starts after the upgrade.

### Helping the agent keep identity

Titles written from scratch rarely line up, so Tapocalypse asks the agent to cooperate. When a run starts, its prompt lists the checks of the test's last two runs (same platform preferred, newest first, at most 40 checks and 6,000 characters) *without their statuses or notes*, so they cannot anchor the verdict, and tells the agent to reuse a title where a check still applies and to say so with `was: "<previous id>"` in `qa_plan`. Who gets previous checks:

| Run | Checks shown |
| --- | --- |
| Suite run | none: the suite already fixes the ids |
| Re-run of failed checks | none extra: the brief already lists them and the ids are kept |
| Re-run of all checks, automatic retry | the parent's checks |
| Any other run, batch lanes included | the last two runs of the same test with at least one check |

Opt out with `reuseChecks: false` (`POST /api/runs`, `POST /api/batches`, `qa_start_run`, `qa_start_batch`), or **Don't reuse** under the brief in the New run sheet. `was` has limits: it is a request, not a guarantee. It only counts when it names one of the checks the prompt showed, the first claim on a previous check wins (a second claim falls back to the title rules and appears in the activity feed), an agent can ignore it, and it is kept on the check for audit even when ignored. A check the agent invented from scratch with a new wording is a new check.

A re-run takes its source (branch, commit, uncommitted changes) from the project as it is when you queue it, not from the original run; only the automatic infrastructure retry keeps the original.

### Which run is compared

The baseline of a run is picked automatically among runs of the **same project, the same test and the same platform** that are older, finished with at least one resolved check, not replaced by a retry and not part of the run's own re-run chain. The first tier that has any wins:

1. **PR base**: the run's pull request names a base branch, and a run exists on it.
2. **Default branch**: the run is on another branch, and a run exists on `Project.defaultBranch` (or the fallback in [Projects](#projects)).
3. **Same branch**: an older run on the same branch with a different commit.
4. **Any branch.**

Within the tier, runs at a different commit are preferred over runs at the same one (a run on a dirty working tree counts as code of its own, so two dirty runs at one commit are different code and edit, run, edit, run compares with the previous run), runs on the same device over other devices, and the baseline is the newest candidate *plus* every candidate at its commit, so a round-1 run and its round-2 run count as one baseline (per check, the newest pass or fail result wins, each linked to its own run). The comparison says what differs and never blocks: a different device, agent or model, a different build, the same commit ("any difference points to flakiness or the environment, not your change"), a different platform (only when you pick a baseline yourself). With no candidate the run says "No earlier run of this test to compare with yet", naming other platforms that do have runs. Picking a baseline yourself (`?baseline=<run id>` in the compare URL, the baseline picker) affects only that view; the runs-list chip, `qa_compare_runs`, `qa_find_regressions` and CI always use the automatic one unless you pass a run id.

### What a comparison says

Only **pass** and **fail** are decisive. Blocked, skipped and unfinished checks are never regressions: a check that passed before and is blocked now is *changed* with a **lost coverage** marker, because blocked results usually mean the device or network.

| Transition | Baseline → this run |
| --- | --- |
| **Newly failing** | pass → fail |
| **Fixed** | fail → pass |
| Still failing | fail → fail |
| Unchanged | same status (or both inconclusive) |
| Changed | any other change, for example pass → blocked (lost coverage) or blocked → pass |
| New / Removed | only in this run / only in the baseline (removed checks are marked *not reached* when this run was a re-run of failed checks or did not finish) |
| Flaky | a newly failing or fixed check whose key is flaky or suspect (below) |
| Pending | the baseline passed or failed and the check has not resolved in a running run |

The comparison also gives the verdict change (`PASS → FAIL`, better or worse), duration and cost deltas (cost only when both runs used the same harness and model) and, per check, both screenshots. For `qa_find_regressions` the "run" is a snapshot per test and platform: the newest run for the branch, PR or commit plus its same-commit re-runs, so re-running the failed checks counts.

### Flaky, suspect and device-sensitive

Per project and check, Tapocalypse looks at the newest 20 pass or fail results. Results are grouped by **code** (the commit when the working tree was clean, else the app's version and build number; a dirty working tree is never "the same code" as another run, and unknown code is not used), platform and device. A *flip* is a pass↔fail change within a group.

- **Flaky**: 2 or more flips. **Suspect**: exactly 1; one pass and one fail on the same code may be a flake or the agent judging the check differently. The label clears when the newest 5 results show no flip. The flaky page shows both (suspects can be filtered out).
- **Device-sensitive**: the same code passes on one device and fails on another. That is usually a layout or device bug, not flakiness, so it is only a chip in the history sheet and is *not* excluded from regressions.
- **Unstable**: repeated pass↔blocked mixes, an environment signal.

Flaky and suspect checks are left out of the *newly failing* counts, the runs-list chip, `qa_find_regressions.newlyFailing` and the CLI exit code, and listed on their own (`flakyFailing`, a fuchsia ❄). Ask for them back with `includeFlaky`.

### Correcting a match

A wrong or missing match is fixable in the comparison. A `≈ likely match` row (a similar-title match) offers **Confirm** and **Unlink**; a new and a removed check that look alike offer **Link** and **Not the same**. **Not the same** only hides that pair of rows: it is remembered in this browser (per project) and writes nothing to a run. Links are saved: **Confirm** marks the match `manual`, so the `≈ likely match` badge goes away; linking a check to itself, two checks of one run, or two checks whose keys already appear together in a run is refused (400); otherwise linking re-keys every check of the project that carries the newer check's key to the older one (`keyKind: "manual"`), unlinking gives that one check its own key, both by rewriting `run.json`, through `POST` / `DELETE /api/check-links`. History, flakiness and later comparisons follow.

### Where to ask

- **UI**: the strip and rail badges on a run, the compare page, the history sheet, the runs-list chip and filter, the flaky page ([tour](#tour-of-the-ui)).
- **Agents**: after changing code and finishing runs, `qa_find_regressions { projectId, branch | prNumber | commit }` returns `clean`, `regressions`, `pending`, `no_runs` or `no_baseline` with a one-sentence summary; `qa_compare_runs` and `qa_check_history` go deeper.
- **CI**: `tapocalypse compare <run>` and `tapocalypse run … --fail-on regression` ([CLI and CI](#cli-and-ci)).
- **HTTP**: [routes](api.md#regressions-history-and-flaky-checks).

### What history needs

Be honest about what this is: it compares runs of *the same test*, and it can only link checks that come back. A brief that is rewritten every time, checks the agent words differently on every run and a project that has run each test once produce "no baseline" or "new" everywhere; flaky detection needs the same check run more than once on the same code. To get useful history, run the same brief (or a [suite](#brief-templates-and-suites)) repeatedly, use **Re-run with changes** and the previous-check reuse, and keep the default of letting the agent see the previous checks. Tapocalypse does not judge whether an earlier pass was right either: a check the agent wrongly passed is a baseline like any other. History comes from the runs on disk, so [retention](#data-and-retention) shrinks it, and deleting a run removes it from baselines and histories. It is computed in memory from the stored runs; the only thing written is the key set in each `run.json`.

## CLI and CI

`tapocalypse` (`bun src/cli.ts`, or `bunx tapocalypse` once published) starts the server and drives it over HTTP, which makes Tapocalypse usable from CI and scripts.

```sh
bun src/cli.ts serve [--port 4311] [--dev]   # same as `bun start`; --dev = Bun's dev server (hot reload)
bun src/cli.ts service install|uninstall|start|stop|restart|status|logs   # run it in the background, start at login
bun src/cli.ts doctor                        # same as `bun run doctor`
bun src/cli.ts run --project my-app --brief "Launch the app and verify the home screen loads." --wait
bun src/cli.ts status <runId|batchId> [--json]
bun src/cli.ts report <runId> [--export <dir>] [--json]   # print a run's report, or copy it and its screenshots to <dir>
bun src/cli.ts compare <runId|batchId> [--baseline <runId|auto>] [--include-flaky] [--json] [--junit <file>]   # compare with the baseline; exit 1 on a regression
```

`run` options:

| Option | Meaning |
| --- | --- |
| `--project <id>` | Project to test (required) |
| `--brief <text>`, `--brief-file <file>` (`-` = stdin), `--suite <id>` | The brief; pass exactly one |
| `--title <text>` | Run title; defaults to the first line of the brief, or the suite's title |
| `--platform android\|ios`, `--serial <serial>`, `--devices <n>` | Where to run. Repeat `--serial`, or use `--devices 2`-`8`, to start a [batch](#batches) |
| `--harness omp\|claude\|codex` | Agent runtime for this run, overriding the project, persona and config (see [Agent runtimes](#agent-runtimes)) |
| `--model <model>` | Model for the agent (harness-native string), overriding the suite, persona and config |
| `--install <path>` | Install this `.apk` / `.app` / `.ipa` on the device before the run (single device only) |
| `--wait` | Wait for the run(s) to end, printing progress to stderr; the final report goes to stdout |
| `--timeout <duration>` | Stop waiting after this long (default `90m`; `30s`, `45m`, `2h`). The run keeps going on the server |
| `--json` | JSON on stdout instead of text |
| `--junit <file>` | Write a JUnit XML report (implies `--wait`): one `<testsuite>` per run, one `<testcase>` per check; failed checks are failures, skipped, blocked and unfinished checks are skipped, and an errored run adds an `<error>` case. The report carries the baseline comparison when it can be had, but `--junit` never changes the exit code |
| `--fail-on <list>` | Verdicts that make the exit code 1 (default `FAIL,BLOCKED,PARTIAL`; e.g. `FAIL` to tolerate the rest). `regression` is also a token: after the wait the CLI compares each run with its automatic baseline and exits 1 on a newly failing check that is not flaky. `--fail-on regression` alone fails only on new failures, which suits an app with known open failures; `--fail-on FAIL,regression` combines both |
| `--url <url>` | Server to use (default `$TAPOCALYPSE_URL`, else `http://127.0.0.1:4310`) |

`run --wait` and `status` print the absolute path of the report (inside Tapocalypse's data folder). `report <runId>` prints the markdown (`--json`: `{ runId, reportPath, markdown }`); with `--export <dir>` it copies the report as `QA-REPORT-<runId>.md` and the screenshots as `screenshots/<name>` into `<dir>` instead.

Without `--wait` the command prints the run id and URL and exits 0 right away. When `--serial` is used without `--platform`, the platform is looked up from the connected device; otherwise the project's `defaultPlatform` applies. An infrastructure failure that Tapocalypse retries automatically is followed to the retry, so the exit code reflects the final attempt.

**Exit codes**

| Code | Meaning |
| --- | --- |
| 0 | Success: every verdict is outside `--fail-on` (and, with the `regression` token, nothing newly fails) |
| 1 | At least one verdict is in `--fail-on` |
| 2 | A run errored, was cancelled, hit its time budget or had an infrastructure failure, or the wait timed out |
| 3 | Usage error, a request the server rejected (for example an unknown project) or the server cannot be reached; the message says how to start it |

With several runs the worst code wins (2 over 1 over 0).

**`compare`** prints the comparison of a run (a batch: each lane against its own baseline): the baseline and why it was chosen, the verdict change and the changed checks. Exit code `0` when no check is newly failing outside flaky ones, `1` when at least one is, `2` for an unknown or still-active run or a server error, `3` for a usage error. A run with no baseline exits `0` with a note on stderr, so the first CI run of a test is not red. `--junit <file>` writes JUnit XML as `run --junit` does, and when a comparison exists it adds the properties `baseline.run`, `baseline.tier`, `baseline.commit` and `regressions` to the testsuite, prefixes a newly failing testcase's message with `Newly failing (was pass in <runId>, <branch>@<sha7>): ` and a flaky one's with `Flaky (n flips in last w): `, and lists fixed and lost-coverage checks in `<system-out>`. Testcase names do not change.

**In CI.** Tapocalypse needs a signed-in agent runtime (omp, Claude Code or Codex CLI) and an emulator or simulator, so run it on a machine you control, for example a self-hosted runner with a booted emulator (on Linux with KVM). Start the server once there (`tapocalypse serve`), then call the CLI from the workflow:

```yaml
- name: QA smoke test
  run: |
    tapocalypse run --project my-app --suite smoke --wait --junit qa-junit.xml
- uses: actions/upload-artifact@v4
  if: always()
  with:
    name: qa-junit
    path: qa-junit.xml
```

Reports and screenshots live in Tapocalypse's data folder, not in the checkout, so nothing is written into the workspace. To attach them to the build, export them after the run with `tapocalypse report <run-id> --export qa-report` (or `qa_export`, or `POST /api/runs/:id/export`) and upload that folder, or read a report through the API (`GET /api/runs/:id/report`). On a machine that is not the one running the server, call these against `--url` / `$TAPOCALYPSE_URL`.

**Fail only on regressions.** A suite that is not green yet fails every build with `--fail-on` at its default. `--fail-on regression` fails only when a check that passed in the baseline fails now (flaky ones excluded), so known open failures do not block a pull request:

```yaml
- name: QA regression gate
  run: |
    tapocalypse run --project my-app --suite smoke --wait --junit qa-junit.xml --fail-on regression
```

The first run of a test has no baseline and exits 0; from the second run on, the baseline is the automatic one described in [Regressions, history and flaky checks](#regressions-history-and-flaky-checks). To compare a run you started elsewhere, call `tapocalypse compare <run-id>`.

## Reading reports and screenshots

A run's report and screenshots live in Tapocalypse's data folder, `<data dir>/runs/<run-id>/report.md` and `screenshots/`. The agent never writes into your repository, so a QA run leaves your working tree clean. You read them with:

| From | How |
| --- | --- |
| The UI | **Open report** on the run page, the **Reports** page, and the Screenshots tab |
| Your coding agent (MCP) | `qa_get_report { runId }`, `qa_get_screenshots { runId }` (absolute `path` per image) and `qa_get_run` (absolute `reportPath`, `screenshotsDir`) |
| The CLI | `tapocalypse report <runId>`; `run --wait` and `status` print the report path |
| HTTP | `GET /api/runs/:id/report`, `GET /api/runs/:id/screenshots`, `GET /api/runs/:id/files/screenshots/<name>` |

To keep a copy outside Tapocalypse, for example in the repo or as a CI artefact, **export** it: `qa_export { runId, dir }`, `tapocalypse report <runId> --export <dir>` or `POST /api/runs/:id/export { dir }`. Nothing is exported automatically, and retention deletes a run's report and screenshots with the run.

**Older runs.** Runs from before this change wrote `QA-REPORT-<run-id>.md` and `screenshots/<run-id>/` into `<repo>/<reportsDir>` (default `qa/`). They keep rendering from there, and a project's legacy `reportsDir` is still read so those reports stay in the Reports list, but nothing new is written to it. Delete those files from your repo whenever you like.

## Sharing a report

A stakeholder does not need Tapocalypse to read a run. Every finished run can be turned into **one self-contained HTML file**: the verdict, the run's facts, the agent's summary, the checks table, the report and every screenshot, with the images inlined and no scripts or external requests (a Content-Security-Policy meta tag forbids them). It follows the system's light or dark setting, reads well at phone width and prints cleanly. Runs without a report still produce a file with the checks and summary.

| You want | How |
| --- | --- |
| A file to attach or archive | **Share → Download HTML report** on the run page or a report page; `GET /api/runs/:id/report.html?download=1`; `tapocalypse report <runId> --html <file>`; `qa_share_report { runId }` (writes `<data dir>/runs/<run-id>/QA-REPORT-<run-id>.html` and returns its path) |
| A link to paste in chat or a ticket | **Share → Copy share link**; `tapocalypse share <runId>`; `POST /api/runs/:id/share`; `qa_share_report { runId }` once [`share.s3`](configuration.md#sharing) is configured |

Both are disabled while the run is still active, because its report is not final. The file embeds at most 25 MB of images in total; screenshots past that limit are replaced by a visible "screenshot omitted (size limit)" placeholder, and the share result tells you how many were left out.

**How a link works.** Tapocalypse uploads the HTML file to an S3-compatible bucket (AWS S3, Cloudflare R2, MinIO…) under `<prefix><project id>/<run id>-<random>.html` and returns a presigned URL that expires after `expiresInDays` (1 to 7, default 7). The bucket stays **private**: nothing is made public, and there is no listing. **Anyone who holds the link can open the report until it expires**, with no login, so treat it like a password-reset link: share it only with the people who should see the run. A link cannot be revoked early, only outlived (delete the object in the bucket to pull it sooner). Access keys are never stored in the config file: set `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` (or `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`) in the environment of the server, for a key that may write and read only the share prefix (a presigned link carries the signer's read permission). Each share uploads a new copy, so a new link shows the run as it is now while earlier links keep showing the earlier file.

Without `share.s3` the UI offers only the download, `tapocalypse share` exits 2 with a hint, and `qa_share_report` returns the file path and a note that links need `share.s3`.

## Running as a service

`tapocalypse service install` keeps Tapocalypse running in the background and starts it at login, so your coding agent's MCP calls always find it. On macOS it installs a launchd agent (`~/Library/LaunchAgents/dev.tapocalypse.server.plist`); on Linux a systemd user unit (`~/.config/systemd/user/tapocalypse.service`). Both run `<bun> <checkout>/src/cli.ts serve`, restart it if it exits with an error (a clean exit stays stopped), and write its output to `<data dir>/logs/service.log` (Linux: `journalctl --user -u tapocalypse`). The unit records your `PATH`, `HOME`, `NODE_ENV=production` and any `TAPOCALYPSE_*`, `ANDROID_HOME` / `ANDROID_SDK_ROOT` and harness binary variables (`OMP_BIN`, `CLAUDE_BIN`, `CODEX_BIN`, `ADB_BIN`, `XCRUN_BIN`, `EMULATOR_BIN`) set when you install, so run it from the shell that works with `bun start`; run `install` again after you change them.

```sh
bun src/cli.ts service install     # write the unit and start it
bun src/cli.ts service status      # installed? running? does /api/mcp/status answer?
bun src/cli.ts service logs        # the last lines of the log
bun src/cli.ts service stop        # stop it (it starts again at next login)
bun src/cli.ts service restart     # after pulling a new version
bun src/cli.ts service uninstall   # stop it and remove the unit
```

**Install and restart interrupt active runs.** `service install` (when a server is already running) and `service restart` restart the server, and the agents of runs in progress end as `interrupted` (queued runs are queued again afterwards). Both commands print this warning; run them when nothing important is running. If the log directory cannot be created, `install` stops with that error before loading the service.

`service` only ever addresses its own unit (`dev.tapocalypse.server` / `tapocalypse.service`); it never kills processes by name or port, so a server you started yourself with `bun start` is left alone. Windows is not supported: there `service` says so, and you keep using `bun start`.

## Brief templates and suites

A good brief says what to do, what to check and what counts as a failure. Tapocalypse ships generic starting points in [`templates/briefs/`](../templates/briefs): smoke, regression of critical flows, ticket or pull request verification, accessibility (large text, dark mode, screen-reader labels), offline and poor network, and first run on a fresh install. Each is a markdown file with `title` and `description` frontmatter and a brief containing `<placeholders>` to replace; the New run form offers them as starting points.

To make a brief repeatable, save it as a **suite**: `<repo>/.tapocalypse/suites/<id>.md` (id = file name, lowercase letters, digits and dashes), or tick *save as suite* in the New run form. The frontmatter holds `title` and optionally `platforms`, `model` and a `checks` list; the body is the brief. When `checks` is set, the agent must use exactly those check ids and titles, which keeps results comparable between runs.

```markdown
---
title: Smoke test
platforms: [android, ios]
checks:
  - id: C1
    title: App launches to the home screen
  - id: C2
    title: Every tab loads
---
Launch the app from a cold start, then open each tab in turn and confirm it loads.
```

Suites live in your repository, so commit them next to the code they test. Start one with `tapocalypse run --suite smoke`, `qa_start_run { suiteId }` or from the UI.

## Configuration

One JSON file plus a few environment variables. The keys you will touch most:

| Key | Default | Meaning |
| --- | --- | --- |
| `port` | `4310` | HTTP port; the server only binds `127.0.0.1` (`TAPOCALYPSE_PORT` overrides) |
| `maxConcurrentRuns` | `2` | Runs executing at once. Mind your RAM: each emulator needs several GB |
| `runMaxTime` | `"60m"` | Time budget per run (a valid duration, checked at startup); see [Run outcomes](#run-outcomes) |
| `retry.infra` | `1` | Automatic retries after an infrastructure failure |
| `retention.days`, `retention.maxRuns` | unset | Delete old finished runs; see [Data and retention](#data-and-retention) |
| `devicePool.android.avds` | `[]` | AVDs Tapocalypse may boot on demand |
| `devicePool.android.maxBooted` | `1` | Max emulators Tapocalypse keeps booted; `0` disables auto-boot |
| `devicePool.ios.simulators` | `[]` | Simulator UDIDs Tapocalypse may boot on demand |
| `agent.harness` | unset: first installed and signed in, else first installed, else omp | Default [agent runtime](#agent-runtimes): `omp`, `claude` or `codex` |
| `agent.harnesses.<id>` | unset | Per-harness `bin`, `model`, `effort`, and `permissions` (Claude Code) or `sandbox` (Codex CLI) |

The full key list (`agent` and its per-harness settings, ports, sizes, idle shutdown, `excludeSerials`) and every environment variable (`TAPOCALYPSE_CONFIG`, `TAPOCALYPSE_DATA_DIR`, `OMP_BIN`, `CLAUDE_BIN`, `CODEX_BIN`, `ADB_BIN`, `GIT_BIN`, `GH_BIN`, `EMULATOR_BIN`, `ANDROID_HOME`, `OMP_PROFILE`, …) are in [docs/configuration.md](configuration.md). The file is validated at startup (`fatal: config: …`, exit 1) and read once; restart after editing it by hand.

## Data and retention

Tapocalypse keeps three things outside your repositories: its config, its run history and every run's report and screenshots.

| What | Default location |
| --- | --- |
| Config | `$XDG_CONFIG_HOME/tapocalypse/config.json` (`~/.config/tapocalypse/config.json`) |
| Run data | `$XDG_DATA_HOME/tapocalypse` (`~/.local/share/tapocalypse`) |

`TAPOCALYPSE_CONFIG` and `TAPOCALYPSE_DATA_DIR` override both. **Legacy fallback:** if a `tapocalypse.config.json` or a `data/` folder already exists in the Tapocalypse checkout, those keep being used, so upgrading moves nothing. To switch to the XDG locations, move them and restart.

```text
<data dir>/runs/<run-id>/
  report.md        the QA report the agent handed in (images link to screenshots/<name>)
  screenshots/     the run's screenshots (png, jpg, jpeg, webp, gif), one file per image
  run.json         full run state: status, checks, verdict, source, build, usage, stats
  brief.md         your brief
  persona.md       the persona used (frontmatter stripped)
  events.jsonl     every raw event of the harness, verbatim, plus Tapocalypse's own activity lines (basis of the activity feed and its replay)
  stderr.log       the harness's stderr
  mcp.json         per-run MCP config, for harnesses that read one from a file (Claude Code)
  plugin/tpc/      the stdio-bridge plugin mounted into omp runs (omp runs only)
  tpc-mcp.json     endpoint + token for the stdio bridge (omp and Codex runs; owner-only)
  session/         the omp session (omp runs only)
  transcript.html  full agent transcript (omp runs only)
<data dir>/batches/                                     batch titles
<data dir>/leases.json                                  agent device leases (owner-only; holds lease secrets)
<data dir>/logs/service.log                             output of the background service, if installed
```

Run ids look like `20260101-093015-a1b2-dark-mode-toggle`. By default nothing is ever deleted. To cap history, set `retention` in the config: `days` removes finished runs that ended longer ago, `maxRuns` keeps only the newest N. It runs at startup and every 6 hours, only touches run folders in the data dir, and never deletes queued or active runs. A run's report and screenshots are part of its folder, so retention and **Delete** remove them with the run: export anything you want to keep first (see [Reading reports and screenshots](#reading-reports-and-screenshots)). Reports that old runs wrote into a repo (`<repo>/qa/…`) are never touched. You can delete a single finished run from its page (**Delete**) or with `DELETE /api/runs/:id`; that removes its run folder (report, screenshots, events, transcript, session).

**Restarts.** Stopping Tapocalypse (Ctrl-C) kills running agents. On the next start those runs are marked `interrupted`, and runs that were still queued are queued again. Emulators Tapocalypse booted keep running.

**History and retention.** Check keys live in each run's `run.json`; baselines, comparisons and flaky labels are computed from the runs on disk, so retention and **Delete** shrink them (see [Regressions, history and flaky checks](#regressions-history-and-flaky-checks)).

## How it works

1. **Queue and assign.** `POST /api/runs` (the UI, CLI or `qa_start_run`) validates the request and stores a `queued` run. The scheduler re-evaluates on every enqueue, release and cancel, and every 10 s, and assigns or boots devices as described in [Devices](#devices).
2. **Preflight.** If a device had to be booted, that happens first. Then the app is installed if requested, its version is read from the device, and Tapocalypse works out the device id mobile-mcp expects (the AVD name for Android emulators, the UDID for simulators, the serial for physical devices).
3. **Spawn.** It starts the run's [harness](#agent-runtimes) headless, with your repo as the working directory, the persona as its system prompt, the model and effort when known, and the harness's non-interactive approval setting (see [Security model](#security-model)). **omp** runs `omp --mode rpc --no-ui` with `--append-system-prompt`, `--session-dir`, `--auto-approve`, `--max-time <runMaxTime>` and `--no-title`; **Claude Code** runs `claude -p` with stream-json input and output, `--append-system-prompt-file`, `--no-session-persistence`, `--strict-mcp-config`, a permission mode, and `--max-turns` / `--max-budget-usd` when configured; **Codex CLI** runs `codex exec --json` with `--sandbox`, `approval_policy="never"`, the persona as developer instructions, and the prompt on stdin. Tapocalypse sends the prompt and receives every tool call and message as events, which feed the activity feed and `events.jsonl`. The raw events are stored as the harness emitted them and replayed through that harness's adapter, so old runs stay readable.
4. **The device, through Tapocalypse.** Every harness gets one MCP server for the run only, `tpc`: the run's own endpoint `POST /mcp/runs/<run-id>`. It serves the progress tools (on harnesses without native ones) and the same `mobile_*` device tools as the [gateway](#sharing-devices-between-agents), but pinned to the run's device: the schema has no `device` argument and every call, every step of a batch included, is rewritten to the assigned device. Tapocalypse starts one mobile-mcp child per run on its first device call (in the run folder) and stops it when the run's lease ends. Your own agent config is never modified and no mobile-mcp is mounted into the session. Claude Code gets a per-run `--mcp-config` file in the run folder plus `--strict-mcp-config`, so none of your other MCP servers (including a global Tapocalypse entry) are loaded; Codex CLI gets `-c mcp_servers.…` overrides on its command line and reaches the endpoint through a stdio bridge; omp has no per-session MCP switch, so Tapocalypse passes `--plugin-dir <data dir>/runs/<run-id>/plugin/tpc`, a per-run plugin whose `.mcp.json` runs the same stdio bridge (`src/mcp/stdio-bridge.ts`, credentials in the owner-only `tpc-mcp.json`). MCP servers connect a moment after the agent starts, so Tapocalypse waits until the tools are mounted (omp: it polls until they appear and learns their real name prefix; Claude Code: the session's init event; Codex CLI: the servers are marked `required`), and only then sends the prompt, with the tool names exactly as that harness spells them. If they never appear, the run fails with a message pointing back to [Prerequisites](#prerequisites).
5. **Progress tools.** Three tools are how the UI gets its data: `qa_plan { checks: [{id, title}] }` declares every check before the first device action; `qa_check { id, status, note?, screenshot? }` (`status` is `running`, `pass`, `fail`, `blocked` or `skipped`; `screenshot` is an absolute or working-directory-relative path of an image, which Tapocalypse copies into the run's `screenshots/` folder) reports each one; `qa_finish { verdict, summary, reportMarkdown | reportPath }` is called once, with the report text or the path of a file the agent wrote, which Tapocalypse stores as the run's `report.md`. Claude Code and Codex CLI reach them through a run-scoped MCP endpoint on the server, `POST /mcp/runs/<run-id>` (server name `tpc`, authenticated with a random per-run bearer token that stops working when the run ends). The token never appears on a command line, in your repo or in `run.json`, `events.jsonl` or `stderr.log`: Codex CLI gets it in an owner-only (mode 0600) `tpc-mcp.json` that a small stdio bridge (`src/mcp/stdio-bridge.ts`, which Codex starts as a stdio MCP server, so it works on every Codex version) reads by path, Claude Code in an owner-only `mcp.json`, both in the run's data folder, which stays until retention removes the run (see [docs/api.md](api.md#run-progress-endpoint)). omp registers the tools natively as host tools and needs no token. Both paths feed the same recorder, which validates the arguments and writes the check into the activity feed itself. Files the agent names are checked (extension, image content, size) and copied into the run's folder in the data directory.
6. **The prompt.** Besides your brief, the agent is told: its device (name and serial: the `mobile_*` tools are already bound to it and take no device argument; the serial is for `adb` and `simctl`), that it must not touch other devices, boot its own or mount or call another mobile-mcp server, the app package, the run id, the time budget, the code under test ([Run metadata](#run-metadata)), which driver tools to use and not use, to never spawn subagents or ask the user questions, and the reporting protocol: save every screenshot into the absolute screenshot folder it is given (`<data dir>/runs/<run-id>/screenshots/`), never write anything into the repository, and finish with `qa_finish { verdict, summary, reportMarkdown }` embedding images as `screenshots/<name>`. A folder per run keeps parallel runs from colliding. If it is blocked it records why and finishes with `BLOCKED`.
7. **Finish.** After the agent ends, Tapocalypse collects usage (omp: session statistics; Claude Code: the final result; Codex CLI: token counts), exports `transcript.html` on harnesses that can (omp), closes the agent's stdin and waits for it to exit, then applies the rules in [Run outcomes](#run-outcomes) (reported or derived verdict, error kind, retry). Cancelling interrupts the agent and kills it after 10 s; "steer" sends your message to the live agent on harnesses that support it (omp and Claude Code; others answer `409 steering is not supported by <harness>`).

## Security model

Tapocalypse is a local developer tool with no login.

- **Local only.** The server binds `127.0.0.1`. Do not expose the port (tunnels, port forwarding, reverse proxies).
- **Request guards.** Every request's `Host` must be `127.0.0.1:<port>` or `localhost:<port>` (blocks DNS rebinding). Writes carrying an `Origin` must come from those same origins, and JSON endpoints require `Content-Type: application/json` (blocks cross-site form posts). Clients without an `Origin`, such as `curl` and MCP clients, are allowed. Request bodies are capped at 1 MiB, and `/mcp` accepts only `POST`.
- **Agents are trusted code.** Runs start the harness in its non-interactive, no-prompt mode: omp with `--auto-approve`, Claude Code with `--permission-mode bypassPermissions` (or, with `permissions: "allowlist"`, `dontAsk` plus an allowlist), Codex CLI with `--sandbox danger-full-access` and `approval_policy="never"`. The agent runs shell commands (`adb`, `xcrun`, anything else it decides to) as your user, in your repo, without asking. A brief is effectively a program you execute. Anyone or anything that can reach the port, including every local process and every MCP client you register, can start runs, so treat them as having your shell. Review third-party personas before using them.
- **Reports are sanitized.** Markdown reports are rendered to HTML on the server and then sanitized: scripts, event handlers, iframes, styles, forms and `javascript:`-style links are stripped, and only `http`, `https`, `mailto`, relative and `#` links survive. External images are dropped and replaced by their alt text, so opening a report never contacts a third party. Task-list checkboxes are rendered disabled. Transcripts, which omp exports, are served with a `sandbox` Content-Security-Policy.
- **Shared reports.** A standalone HTML report contains no script and may only load `data:` images, and agent text goes through the same sanitizer as the UI. A share link is an unguessable presigned URL to an object in a private bucket; whoever has the link can read that report until it expires (at most 7 days). Credentials come only from the server's environment, never from the config file or the UI. See [Sharing a report](#sharing-a-report).
- **Content-Security-Policy.** The UI page allows only same-origin scripts, styles and connections, images from itself or `data:`/`blob:`, fonts from itself or `data:` (the bundled monospace font is inlined), and no plugins, base tags or foreign form targets.
- **Frame protection.** Every API and file response carries `X-Frame-Options: DENY` and `frame-ancestors 'none'`; the UI page itself refuses to render inside another page. This stops clickjacking of a running instance.
- **Guards on destructive actions.** Only finished runs can be deleted, only devices Tapocalypse booted (and no run or agent lease is using) can be shut down from the UI, projects with active runs cannot be removed, and retention only deletes run folders inside the data directory.
- **Device leases are enforced for Tapocalypse's `mobile_*` tools only.** A lease keeps well-behaved agents apart and is not a security boundary: the gated `mobile_*` tools on `/mcp` only drive the leased device, but nothing stops a process that bypasses them. The `leaseId` returned by `device_acquire` is a capability for renewing and releasing that lease: it is stored in `<data dir>/leases.json` (readable only by your user), never appears in lists, events or the UI, and is compared in constant time. But anything that can reach the port, or run `adb` or its own mobile-mcp, can still touch a device or end a lease from the Devices page.
- **Path safety.** A run's files are served only from that run's own folder in the data directory, and only images (`png`, `jpg`, `jpeg`, `webp`, `gif`) whose first bytes really are an image (served with `X-Content-Type-Options: nosniff`). Files that old runs wrote into a repo are served only from the project's legacy `reportsDir`, with a short extension list. Screenshots and reports an agent names must lie inside the repo, the run's folder or the OS temp directory (a screenshot is capped at 25 MB, a report at 2 MB), are copied in and are never served from where they were; `qa_export` and `--export` write only into the folder you give, never inside Tapocalypse's data folder or a `.git` folder. Persona files and a legacy `reportsDir` must resolve inside the repo (symlinks included), and `source.path` must be the project's repo or one of its git worktrees.

See [SECURITY.md](../SECURITY.md) to report a vulnerability.

## Troubleshooting

Start with `bun run doctor` (or the **Setup** page): it checks every prerequisite, your config and your projects, and says how to fix what is wrong.

- **The agent runtime is not signed in.** Doctor shows `agent-runtime` (and the harness's own sign-in check) as failed or warns, and runs end `error` right away with a message from the harness. Sign in with `omp login`, `claude auth login` or `codex login` (or export your provider's API key), re-run `bun run doctor`, and read `<data dir>/runs/<run-id>/stderr.log` if a run still fails. Also check that the persona's or project's `model:` exists for that harness.
- **"The device tools are not available to the agent".** The harness could not reach the run's `tpc` endpoint, or the endpoint could not list the device tools. The first `mobile_*` listing (and every device call) starts a mobile-mcp child through `npx`, so check that `npx` works (Node.js installed, network available for the first download) by running `npx -y @mobilenext/mobile-mcp@latest` once by hand (it waits on stdin; Ctrl-C to stop). Tapocalypse retries this kind of failure once on its own.
- **`steering is not supported by Codex CLI` (409).** Codex CLI cannot take a message mid-run. Cancel and start a new run, or use omp or Claude Code for runs you want to steer.
- **Codex CLI marked my repo as trusted.** The first `codex exec` in a directory makes Codex CLI add `[projects."<repo path>"] trust_level = "trusted"` to `~/.codex/config.toml`. That is Codex's own behaviour and Tapocalypse does not undo it; remove the entry if you do not want it.
- **A Claude Code run fails immediately as root.** `--permission-mode bypassPermissions` refuses to run as root. Run Tapocalypse as a normal user, or set `agent.harnesses.claude.permissions` to `"allowlist"`.
- **A run stays queued.** The run's card and page show the reason in plain words: `maxConcurrentRuns (n) reached`, `all android devices busy`, `no android device available`, `maxBooted (n) reached`, or `<serial> is busy` / `is not connected` / `is booting` for a run that named a device. When a coding agent holds the device the reason names it: `<serial> is held by <holder> until HH:MM`, or `all android devices busy (2 held by agents, 1 running QA)`. Physical devices are only used when requested by serial; to let a run start, free a device, raise the limits or list an AVD in `devicePool.android.avds`. A device held by a stuck agent can be released from the **Devices** page. The scheduler re-checks every 10 s.
- **Slow element lists on Flutter apps.** mobile-mcp can take 15-25 s to dump a large Flutter tree. The agent is told to list elements once per screen and to batch actions.
- **Emulator does not boot.** Names in `devicePool.android.avds` must match `emulator -list-avds` exactly (doctor flags unknown ones). Tapocalypse finds the emulator under `$ANDROID_HOME`, `$ANDROID_SDK_ROOT`, `~/Library/Android/sdk` (macOS) or `~/Android/Sdk` (Linux); elsewhere set `ANDROID_HOME` or `EMULATOR_BIN`. On Linux check KVM access (see [Operating systems](#operating-systems)). Try `emulator -avd <name>` by hand to see hardware-acceleration or disk-space errors. Booting is abandoned after 180 s.
- **Port 4310 is in use.** Start with another port: `TAPOCALYPSE_PORT=4311 bun start` (or set `port`), and update the URL in your MCP client config. Requests to a different host or port get `403 forbidden host`.
- **A run ended `done` but the verdict is tagged "derived".** The agent stopped without calling `qa_finish` (often because it hit `runMaxTime`) and the verdict was computed from its checks. Open the activity feed (or, on omp, the transcript) to see why, then re-run the failed checks with a narrower brief or a larger `runMaxTime`. If no check had resolved, the run is `error` with kind `agent` ("agent ended without qa_finish").
- **Screenshots look tiny or unreadable.** Emulators booted by Tapocalypse are raised to `minSize`; for ones you started yourself, use a larger AVD.

## What's not here yet

Roadmap, in no particular order. None of these exist today:

- Scheduled comparisons and trend charts across many runs, and a named-test parameter that would pin a test's identity by hand (a test is inferred from the brief, suite or run title today).
- Webhooks and other outbound notifications; exporting a run as a zip bundle; tags on runs.
- Scheduled and recurring runs (use cron plus the [CLI](#cli-and-ci) for now).
- A Settings page with hot reload: the config file is edited by hand and read once at startup (projects are the exception).
- A demo mode that works without devices or a model provider.
- Authentication: there is no login or access token; Tapocalypse relies on binding to localhost.
- Frame-by-frame evidence replay and an action overlay (tap markers) on the live device screen.

## Development

```sh
bun install
bun run dev         # server with hot reload; the UI hot-reloads in the browser
bun test            # unit tests (bun:test)
bun run typecheck   # tsc --noEmit
bun run doctor      # prerequisite check
bun start           # production mode (no hot reload)
bun src/cli.ts --help
```

CI ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)) runs `bun install --frozen-lockfile`, `bun run typecheck` and `bun test` on Linux and macOS for every push and pull request; run the last two before you push. See [CONTRIBUTING.md](../CONTRIBUTING.md) for the full workflow.

| Path | Contents |
| --- | --- |
| `src/server.ts`, `src/api.ts`, `src/app.ts` | Server start-up, HTTP/SSE routes and request guards, wiring |
| `src/config.ts` | Config schema, defaults, config/data locations, environment overrides |
| `src/runs/` | Scheduler (queue and device assignment), runner (run lifecycle), outcome rules, prompt, progress recorder, run metadata, run storage |
| `src/regression/` | Check and test identity (`keys.ts`), the in-memory history index (`index.ts`), baseline selection, comparison and flaky detection |
| `src/harness/` | The agent-runtime adapters: the shared `Harness` interface, the registry and default resolution, and one folder each for omp (RPC client, stdio-bridge plugin provisioning), Claude Code and Codex CLI |
| `src/devices/` | Device discovery, screenshots, emulator/simulator boot and idle shutdown |
| `src/projects/` | Project registry, repo detection and folder suggestions |
| `src/reports/` | Report listing, sanitized rendering and safe file serving |
| `src/runs/artefacts.ts` | Where a run's report and screenshots live (`<data dir>/runs/<id>/`), path guards and export |
| `src/service/` | The background service behind `tapocalypse service` (launchd on macOS, a systemd user unit on Linux) |
| `src/batches.ts`, `src/suites.ts`, `src/stats.ts`, `src/retention.ts` | Batches, suites, usage statistics, history cleanup |
| `src/mcp/server.ts`, `src/mcp/run-server.ts` | The MCP tools, and the run-scoped progress endpoint the agents call |
| `src/doctor.ts`, `scripts/doctor.ts` | Prerequisite checks and their CLI |
| `src/cli.ts` | The `tapocalypse` command: `serve`, `service`, `doctor`, `run`, `status`, `report`, `compare` |
| `web/` | The UI: React 19, Tailwind 4 and [shadcn/ui](https://ui.shadcn.com) (`views/` pages, `components/`, `components/ui/` primitives) |
| `templates/briefs/`, `personas/` | Built-in brief templates and the built-in QA persona |
| `docs/`, `test/` | This guide, the [configuration](configuration.md) and [HTTP API / MCP](api.md) references and the [agent setup](agent-setup.md) instructions; tests and fixtures |

Add a shadcn component with `bunx --bun shadcn@latest add <name>`; `components.json` already maps it to `web/components/ui`.
