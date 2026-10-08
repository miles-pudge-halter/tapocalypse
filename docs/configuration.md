# Configuration reference

Back to the [README](../README.md). Tapocalypse is configured with one JSON file and a handful of environment variables. Most day-to-day settings (projects) are managed from the UI; the file is for the device pool, limits and retention.

## Where files live

| What | Location (first match wins) |
| --- | --- |
| Config file | `$TAPOCALYPSE_CONFIG`; a legacy `tapocalypse.config.json` in the Tapocalypse checkout, if it exists; otherwise `$XDG_CONFIG_HOME/tapocalypse/config.json` (default `~/.config/tapocalypse/config.json`) |
| Data directory | `$TAPOCALYPSE_DATA_DIR`; a legacy `data/` folder in the checkout, if it exists; otherwise `$XDG_DATA_HOME/tapocalypse` (default `~/.local/share/tapocalypse`) |

Existing installs that already have the in-repo `tapocalypse.config.json` or `data/` keep using them, so nothing moves on upgrade. Fresh installs use the XDG locations. To migrate, move the file or folder and restart. The server prints the config path it created on first start.

The config file is created with the defaults below when it does not exist. It is validated at startup (`fatal: config: …`, exit 1 when invalid) and read once: restart after editing it by hand. Projects added in the UI or over MCP take effect immediately and are written back to the file. [`tapocalypse.config.example.json`](../tapocalypse.config.example.json) is a copy of the defaults.

## Keys

| Key | Default | Meaning |
| --- | --- | --- |
| `port` | `4310` | HTTP port; the server only binds `127.0.0.1` |
| `maxConcurrentRuns` | `2` | Runs executing at once (including ones waiting for an emulator to boot). Mind your RAM: each emulator needs several GB |
| `runMaxTime` | `"60m"` | Time budget per run, passed to `omp --max-time` and shown to the agent. Accepts `90m`, `1h30m`, `45s`, `2h`; a bare number is minutes. At 80% of it the agent is told to wrap up; see [Run outcomes](../README.md#run-outcomes) |
| `projects` | `[]` | Project objects, see [Projects](../README.md#projects). Normally managed from the UI |
| `agent.model` | unset | Model for runs whose request, suite and persona name none (omp's own default when unset) |
| `agent.thinking` | unset | Thinking level for the same fallback: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `retry.infra` | `1` | Automatic retries of a run that failed on infrastructure (boot failure, omp crash, MCP tools missing) before any check resolved. `0` disables retries |
| `retention.days` | unset | Delete finished runs that ended more than this many days ago. Unset keeps them |
| `retention.maxRuns` | unset | Keep only the newest this-many runs, deleting older finished ones. Unset keeps them |
| `artemisPath` | unset | Path to a local Artemis clone; enables the optional [Artemis backend](../README.md#optional-artemis-backend) |
| `devicePool.android.avds` | `[]` | AVD names (`emulator -list-avds`) Tapocalypse may boot on demand. Wear OS, TV and Automotive AVDs are never booted automatically |
| `devicePool.android.basePort` | `5560` | First emulator console port; booted emulators get even ports from here |
| `devicePool.android.maxBooted` | `1` | Max emulators Tapocalypse keeps booted at once; `0` disables auto-boot |
| `devicePool.android.minSize` | `"720x1280"` | Booted emulators with a smaller screen are overridden to this size (`WxH`) |
| `devicePool.android.minDensity` | `320` | Density (dpi) used with that override |
| `devicePool.android.idleShutdownMinutes` | `20` | Shut down a Tapocalypse-booted emulator after this much idle time |
| `devicePool.android.excludeSerials` | `[]` | Android serials that are never used |
| `devicePool.ios.simulators` | `[]` | Simulator UDIDs Tapocalypse may boot on demand (macOS only) |
| `devicePool.ios.idleShutdownMinutes` | `20` | Same idle shutdown for simulators |

`retention` is evaluated at startup and every 6 hours. It only removes run folders under the data directory; reports and screenshots in your repositories are never touched, and queued or active runs are never deleted. See [Data and retention](../README.md#data-and-retention).

A fresh config file contains the defaults above for `port`, `maxConcurrentRuns`, `runMaxTime`, `projects` and `devicePool`; `agent`, `retry`, `retention` and `artemisPath` are optional and can be added by hand.

## Environment variables

| Variable | Effect |
| --- | --- |
| `TAPOCALYPSE_CONFIG` | Config file path (see above) |
| `TAPOCALYPSE_DATA_DIR` | Data directory (see above) |
| `TAPOCALYPSE_PORT` | Overrides `port`. `tapocalypse serve --port` sets it. The CLI also uses it to find the server |
| `TAPOCALYPSE_URL` | Server URL for `tapocalypse run` / `status` (default `http://127.0.0.1:<port>`); `--url` wins |
| `XDG_CONFIG_HOME`, `XDG_DATA_HOME` | Base directories for the default config and data locations |
| `OMP_BIN`, `ADB_BIN`, `GIT_BIN`, `GH_BIN` | Binaries to use instead of `omp`, `adb`, `git`, `gh` from `PATH` |
| `EMULATOR_BIN` | Android emulator binary. Otherwise looked up (not on `PATH`) at `$ANDROID_HOME/emulator/emulator`, `$ANDROID_SDK_ROOT/emulator/emulator`, `~/Library/Android/sdk/emulator/emulator` (macOS), then `~/Android/Sdk/emulator/emulator` (Linux) |
| `ANDROID_HOME`, `ANDROID_SDK_ROOT` | Android SDK location used for the emulator lookup |
| `OMP_PROFILE` / `PI_PROFILE` | If you run omp with a profile, set it here too so Tapocalypse reads that profile's MCP config |
| `NODE_ENV` | `bun start` and `tapocalypse serve` set `production`; `tapocalypse serve --dev` and `bun src/server.ts` without it enable Bun's development server (hot module reloading, browser console forwarding) |
| `NO_COLOR` | Disables colour in `bun run doctor` output |

## Command line

```sh
bun start                                 # production server
bun run dev                               # server with hot reload
bun src/cli.ts serve [--port 4311] [--dev]
bun run doctor
```

`serve --dev` runs the same server with Bun's development server (hot module reloading for the UI and browser console forwarding); without it `serve` runs in production mode. The `run` and `status` commands are described in [CLI and CI](../README.md#cli-and-ci).
