# Stop Hook And Watch Usage Display Design

## Context

Codex CLI does not currently expose a plugin API for replacing the native TUI
footer with an arbitrary custom status command. The monitor therefore should
surface usage through Codex-supported entry points:

- A `Stop` hook that runs after Codex finishes a turn.
- A local `watch` command that refreshes in a separate terminal during long
  work.

Both surfaces must remain local-only. They read Codex session JSONL files and
must not call OpenAI APIs or send telemetry.

## Approaches Considered

### Recommended: Stop Hook Plus Local Watch

Use the existing plugin Stop hook for post-turn summaries, and keep
`codex-usage-monitor watch --interval N` as the live monitor for long-running
tasks. Add small controls for hook verbosity and refresh cadence.

Trade-off: this matches Codex's current extension model and stays simple, but
it cannot update the native footer while a turn is still running.

### Footer Configuration Only

Rely on Codex native `tui.status_line` items such as model, context, tokens, and
limits.

Trade-off: this is robust and built in, but it cannot show the monitor's custom
API-equivalent cost, cache rate, per-model breakdown, or colored box.

### Background Daemon

Start a long-lived background process that periodically prints or writes status
from outside the Codex hook lifecycle.

Trade-off: this could provide automatic timed updates, but it is harder to make
predictable across Windows, Linux, Ubuntu, and macOS. It also risks orphaned
processes if started implicitly by hooks.

## Selected Design

Implement the recommended approach:

1. The Stop hook prints a colored, multi-line usage box after each Codex turn by
   default.
2. The Stop hook always writes `{"continue":true}` to stdout so it does not
   block Codex.
3. Human output goes to stderr, preserving Codex hook compatibility.
4. A quiet mode disables hook display with `CODEX_USAGE_MONITOR_QUIET=1`.
5. A throttle mode limits hook display frequency with
   `CODEX_USAGE_MONITOR_HOOK_INTERVAL_SECONDS=N`.
6. The `watch` command remains the supported way to see updates while a long
   Codex task is running.
7. Documentation explains that neither mode consumes model quota because both
   read local files only.

## Components

### Hook State

Add a small cross-platform state helper that stores the last hook display time
under the Codex home directory, for example:

```text
$CODEX_HOME/codex-usage-monitor-state.json
```

The helper should use Node built-ins only and tolerate missing, corrupt, or
unwritable state files. If state cannot be written, the hook should still show
usage rather than fail.

### Stop Hook

`bin/on-stop.js` should:

- Parse hook JSON from stdin as it does today.
- Resolve `transcript_path` from known hook payload shapes.
- Honor `CODEX_USAGE_MONITOR_QUIET=1`.
- Honor `CODEX_USAGE_MONITOR_HOOK_INTERVAL_SECONDS=N` when `N > 0`.
- Render the existing `formatStopBox()` output with color enabled unless
  disabled by `NO_COLOR`, `CODEX_USAGE_MONITOR_NO_COLOR`, or `FORCE_COLOR=0`.
- Keep failure behavior non-blocking.

### Watch Command

`bin/codex-usage-monitor.js watch` should continue to refresh a compact
statusline. Documentation should show examples for PowerShell, Bash, tmux, and
terminal split panes instead of introducing an implicit daemon.

## Data Flow

```text
Codex Stop event
  -> hooks/hooks.json
  -> node bin/on-stop.js
  -> read transcript_path
  -> summarize session JSONL locally
  -> check quiet/throttle state
  -> stderr: colored usage box
  -> stdout: {"continue":true}
```

For long-running visibility:

```text
terminal split or tmux pane
  -> codex-usage-monitor watch --interval N
  -> scan latest local session JSONL
  -> stdout: refreshed one-line status
```

## Quota And Privacy

The monitor must not consume OpenAI model quota. Runtime code must not perform
network requests, model calls, or telemetry. Local terminal output also should
not be injected into future model prompts by this tool.

The only costs are local CPU, filesystem I/O, and Node.js process startup time.

## Cross-Platform Rules

- Use `path`, `os`, and filesystem APIs from Node.js instead of hard-coded path
  separators.
- Keep commands compatible with Windows PowerShell and POSIX shells.
- Avoid shell-specific logic inside hook commands.
- Keep Unicode output as the default, with `--ascii` and
  `CODEX_USAGE_MONITOR_ASCII=1` for terminals that need ASCII.

## Testing

Add tests for:

- Stop hook continues to write valid JSON to stdout.
- Stop hook writes a human box to stderr by default.
- `CODEX_USAGE_MONITOR_QUIET=1` suppresses the human box.
- Hook interval throttling suppresses repeated displays within the configured
  interval.
- Invalid or unwritable hook state does not fail the hook.
- Existing `watch`, `summary`, `statusline`, `json`, and `doctor` behavior
  remains intact.

## Out Of Scope

- Replacing the native Codex footer with custom plugin output.
- Starting implicit background daemons from hooks.
- Network-based price updates at runtime.
