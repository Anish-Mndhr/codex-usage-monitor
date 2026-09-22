# codex-usage-monitor

> A zero-dependency Codex usage ledger for every local CLI, desktop, and IDE
> session, with token accounting, durable records, and configurable cost estimates.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node >=22.5](https://img.shields.io/badge/node-%3E%3D22.5-43853d.svg)](package.json)

## What it shows

Compact statusline:

```text
GPT-5.4 mini | think medium | ctx ##--- 12% (1.2k/10k) | 5h ##--- 42% (4h 59m) | 7d #---- 15% (6d 23h) | turn in 1.2k out 200 reason 110 | Σ in 2.2k out 300 | cache ###-- 50% | API≈$0.0080
```

Stop-hook box after a Codex turn:

```text
+ codex-usage-monitor ------------------------------------------+
| Model      GPT-5.4 mini  think medium  prolite                |
| Limits     5h #####------- 42% (4h 59m)  |  7d ##---------- 15% |
| Context    ctx #----------- 12% (1.2k/10k)                    |
| This turn  turn in 1.2k out 200 reason 110                    |
| Session    2.2k in  300 out  2 turns  cache 40.9%             |
| Models     GPT-5.5 $0.0066  |  GPT-5.4 mini $0.0014          |
| Cost       API≈$0.0080                                       |
+---------------------------------------------------------------+
```

## Features

- Reads Codex CLI session JSONL files from `~/.codex/sessions`.
- Saves normalized session, turn, and per-model records in a local SQLite database.
- Imports active and archived history, then incrementally updates changed sessions.
- Tracks input, cached input, cache-write input, output, and reasoning-output tokens.
- Supports Codex `Stop` hooks through the bundled `hooks/hooks.json`.
- Shows the active model and reasoning effort from `turn_context` records.
- Shows latest-turn and session-total token usage from `token_count` events.
- Computes cache hit rate from `cached_input_tokens / input_tokens`.
- Shows context fill as latest request input tokens over `model_context_window`.
- Shows Codex primary and secondary rolling limits when present.
- Estimates API-equivalent cost from versioned OpenAI prices with custom overrides.
- Breaks cost down by model when a session uses multiple models.
- Provides live summaries plus `sync`, `sessions`, `show`, `totals`, and exports.
- Uses only Node.js built-ins and makes no runtime network requests.
- Keeps all data local. No telemetry, no network calls at runtime.

## Recommended Usage

### After Each Codex Turn

Install the plugin and restart Codex. The bundled Stop hook prints a colored
usage box after each completed turn. It does not replace the native Codex
footer. Because some Codex surfaces capture hook stdout and stderr, the hook
also tries to write directly to the active terminal (`CONOUT$` on Windows,
`/dev/tty` on Linux and macOS).

### While Codex Is Working

The bundled `PostToolUse` hook can print the same monitor while Codex is still
working. It runs after tool calls and is throttled to once every 300 seconds by
default:

```bash
CODEX_USAGE_MONITOR_WORK_INTERVAL_SECONDS=300
```

Set the value to `0` to show after every tool call, or use a larger number for
less frequent updates.

### During Long Tasks

Run the watcher in another terminal, split pane, or tmux pane:

```bash
codex-usage-monitor watch --interval 60
```

PowerShell:

```powershell
codex-usage-monitor watch --interval 60
```

Bash, Ubuntu, macOS, or tmux:

```bash
codex-usage-monitor watch --interval 60
```

### Quota Impact

The Stop hook and watcher do not consume model quota. They read local Codex
session JSONL files, perform local formatting, and do not make network or model
calls.

## Install

### Requirements

- Codex CLI or Codex in the ChatGPT desktop app.
- Node.js 22.5 or newer. Check with `node --version`.
- Git, if installing from the repository.

No `npm install` is required. The monitor uses only Node.js built-ins and does
not need an OpenAI API key.

### Install the same plugin configuration on another computer

This repository uses the supported Codex compatibility layout:

- `.codex-plugin/plugin.json` defines the plugin and its presentation.
- `hooks/hooks.json` registers the lifecycle hooks.
- `bin/` contains the hook and command entry points.

Clone the complete repository into the user's Codex plugin directory. Do not
copy your Codex session files or usage database; every installation measures
the sessions belonging to that computer.

```bash
git clone https://github.com/Anish-Mndhr/codex-usage-monitor.git ~/.codex/plugins/codex-usage-monitor
```

To expose the `codex-usage-monitor` and `cum` commands globally, link the local
package:

```bash
cd ~/.codex/plugins/codex-usage-monitor
npm link
```

Next, expose the cloned folder through a personal marketplace and install it
from the plugin browser. A personal marketplace file lives at
`~/.agents/plugins/marketplace.json`. If that file already exists, add the
following plugin object to its existing `plugins` array instead of replacing
the file:

```json
{
  "name": "personal-plugins",
  "interface": {
    "displayName": "Personal Plugins"
  },
  "plugins": [
    {
      "name": "codex-usage-monitor",
      "source": {
        "source": "local",
        "path": "./.codex/plugins/codex-usage-monitor"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Developer Tools"
    }
  ]
}
```

Then restart Codex. In Codex CLI, open the plugin browser and install **Codex
Usage Monitor** from **Personal Plugins**:

```text
codex
/plugins
```

Review and trust the bundled hooks when prompted. Codex does not run newly
installed non-managed hooks until the user trusts their current definitions.
Start a new Codex session after installation.

The ChatGPT desktop app can use the same personal marketplace: restart the app,
open **Plugins**, choose **Personal Plugins**, and install **Codex Usage
Monitor**. Plugin hooks need a local Codex execution environment; installing a
plugin only on the web does not deploy its scripts.

For background on marketplace installation and hook trust, see the
[official OpenAI plugin packaging documentation](https://developers.openai.com/plugins/build/plugins).

### Verify the installation

Run the diagnostic and import existing local history once:

```bash
codex-usage-monitor doctor
codex-usage-monitor sync --all
codex-usage-monitor sessions
```

If you skipped `npm link`, invoke the same commands through the repository:

```bash
node ~/.codex/plugins/codex-usage-monitor/bin/codex-usage-monitor.js doctor
node ~/.codex/plugins/codex-usage-monitor/bin/codex-usage-monitor.js sync --all
node ~/.codex/plugins/codex-usage-monitor/bin/codex-usage-monitor.js sessions
```

On Windows, clone to `%USERPROFILE%\.codex\plugins\codex-usage-monitor`, run
`npm link` from that directory, or use the absolute script path:

```powershell
node "$env:USERPROFILE\.codex\plugins\codex-usage-monitor\bin\codex-usage-monitor.js" doctor
```

### Update an installation

Pull the latest version, then restart Codex so it reloads the plugin and asks
for hook trust again if the hook definition changed:

```bash
cd ~/.codex/plugins/codex-usage-monitor
git pull --ff-only
npm link
```

## Persistent Records

The ledger defaults to `$CODEX_HOME/usage-monitor/usage.sqlite3` (normally
`~/.codex/usage-monitor/usage.sqlite3`). It stores no prompt or response text,
only session metadata, token counters, pricing provenance, and computed costs.
Records remain available if Codex later archives or removes the transcript.

Import all existing history after installation:

```bash
codex-usage-monitor sync --all
```

Lifecycle hooks then keep it current. Report commands also perform an
incremental scan unless `--no-sync` is supplied.

## Codex Hook Setup

The plugin includes hooks for `SessionStart`, `PostToolUse`, `Stop`,
`Interrupt`, and `SessionEnd`. Together they create, update, and finalize
records across supported local Codex surfaces. Hook failures never block Codex.

| Hook           | Purpose                                                 |
| -------------- | ------------------------------------------------------- |
| `SessionStart` | Creates or refreshes the session ledger record.         |
| `PostToolUse`  | Periodically updates usage while Codex is working.      |
| `Stop`         | Saves the latest measurements and prints the usage box. |
| `Interrupt`    | Saves state when a run is interrupted.                  |
| `SessionEnd`   | Finalizes the session record.                           |

Marketplace installation automatically discovers `hooks/hooks.json`. The user
must still review and trust the hook definitions, then start a new session.

For a direct config installation that does not use the plugin browser, the
following minimal example enables only the end-of-turn display:

```toml
[[hooks.Stop]]
matcher = "*"

[[hooks.Stop.hooks]]
type = "command"
command = "node C:/Users/YourName/.codex/plugins/codex-usage-monitor/bin/on-stop.js"
timeout = 30
```

Replace the example path for the local operating system. This minimal setup
does not install the other lifecycle hooks, so marketplace installation is the
recommended way to reproduce the full configuration. Restart Codex after
changing plugin or hook configuration.

## Everyday Use

After the plugin is installed and trusted, normal Codex work needs no manual
monitor command. The hooks update the ledger automatically and print a summary
at the configured intervals.

Useful commands include:

```bash
# Current/latest session
codex-usage-monitor summary
codex-usage-monitor statusline

# Continuously refresh in another terminal
codex-usage-monitor watch --interval 60

# Browse and aggregate saved records
codex-usage-monitor sessions
codex-usage-monitor totals --group-by day
codex-usage-monitor totals --group-by project

# Inspect one session from the sessions output
codex-usage-monitor show SESSION_ID

# Export report output
codex-usage-monitor sessions --format json
codex-usage-monitor totals --group-by model --format csv
```

## CLI

```bash
codex-usage-monitor summary [--file session.jsonl]
codex-usage-monitor statusline [--file session.jsonl]
codex-usage-monitor json [--file session.jsonl]
codex-usage-monitor watch [--interval 5]
codex-usage-monitor sync [--all] [--file session.jsonl]
codex-usage-monitor sessions [--since DATE] [--project TEXT] [--format table|json|csv]
codex-usage-monitor show SESSION_ID [--format table|json|csv]
codex-usage-monitor totals [--group-by day|project|model] [--format table|json|csv]
codex-usage-monitor doctor
```

Options:

| Option                 | Effect                                          |
| ---------------------- | ----------------------------------------------- |
| `--file PATH`          | Read a specific Codex session JSONL file.       |
| `--codex-home PATH`    | Override `CODEX_HOME` / `~/.codex`.             |
| `--db PATH`            | Override the SQLite database path.              |
| `--since`, `--until`   | Filter records by ISO date or timestamp.        |
| `--project`, `--model` | Filter records by project path or model.        |
| `--format`             | Select `table`, `json`, or `csv` report output. |
| `--group-by`           | Group totals by `day`, `project`, or `model`.   |
| `--ascii`              | Use ASCII progress bars.                        |
| `--no-color`           | Disable ANSI color.                             |

Environment variables:

| Variable                                      | Effect                                                                           |
| --------------------------------------------- | -------------------------------------------------------------------------------- |
| `CODEX_USAGE_MONITOR_ASCII=1`                 | Use ASCII bars in all output.                                                    |
| `CODEX_USAGE_MONITOR_NO_COLOR=1`              | Disable ANSI colors.                                                             |
| `CODEX_USAGE_MONITOR_QUIET=1`                 | Silence the Stop-hook summary box.                                               |
| `CODEX_USAGE_MONITOR_HOOK_INTERVAL_SECONDS=N` | Show the Stop-hook box at most once every `N` seconds. Unset means every turn.   |
| `CODEX_USAGE_MONITOR_WORK_INTERVAL_SECONDS=N` | Show the work-in-progress hook box at most once every `N` seconds. Default: 300. |
| `CODEX_USAGE_MONITOR_DIRECT_TTY=0`            | Disable direct terminal writes from hooks.                                       |
| `CODEX_USAGE_MONITOR_MAX_BYTES=N`             | Skip transcript files larger than `N` bytes. Default: 50 MB.                     |
| `CODEX_USAGE_MONITOR_DB=PATH`                 | Override the persistent database path.                                           |
| `CODEX_USAGE_MONITOR_CONFIG=PATH`             | Override the pricing configuration path.                                         |

## Pricing Notes

`API≈` means estimated API-equivalent USD, not your Codex subscription or
Azure invoice. The bundled standard pricing snapshot was checked against the
OpenAI API pricing page on 2026-09-22.

The current cost formula is:

```text
uncached_input_tokens * input_rate
+ cached_input_tokens * cached_input_rate
+ cache_write_input_tokens * cache_write_rate
+ output_tokens * output_rate
```

Unknown models are not treated as free. If any model in the session is missing
from the pricing table, the monitor marks the total as approximate with `~`.
Copy `examples/config.json` to `$CODEX_HOME/usage-monitor/config.json` to alias
Azure deployment names or provide contracted rates.

## How It Works

Codex session logs contain records like:

- `session_meta`: session id, cwd, CLI version.
- `turn_context`: model, reasoning effort, context window.
- `token_usage_record`: exact response, turn, and session counters, including
  cache writes on current Codex versions.
- Legacy `event_msg` with `type: "token_count"`: compatible totals and limits.

The monitor idempotently upserts those records into SQLite. Re-running a sync
never double-counts a response or turn.

See [docs/DESIGN.md](docs/DESIGN.md) for the full architecture.

## Tests

```bash
npm test
```

The suite covers:

- OpenAI pricing and unknown-model handling.
- Codex JSONL summarization.
- Formatter output for statusline and Stop-hook box.
- CLI and hook subprocess behavior.

## Sources

- Codex hooks documentation: https://developers.openai.com/codex/hooks
- Codex plugin documentation: https://developers.openai.com/codex/plugins/build
- OpenAI API pricing: https://developers.openai.com/api/docs/pricing

## License

MIT. See [LICENSE](LICENSE).

# codex-usage-monitor

# codex-usage-monitor

# codex-usage-monitor
