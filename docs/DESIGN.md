# Design

## Goals

1. Show Codex CLI usage in the terminal with the same practical density as
   `cc-usage-monitor`.
2. Read only local Codex files and hook input. No prompt content, telemetry,
   analytics, or runtime network calls.
3. Stay zero-dependency and cross-platform.
4. Degrade gracefully when Codex changes a field or a model price is unknown.

## Surfaces

| Surface | File | Output |
| --- | --- | --- |
| CLI summary | `bin/codex-usage-monitor.js summary` | multi-line box on stdout |
| CLI statusline | `bin/codex-usage-monitor.js statusline` | compact one-line stdout |
| JSON | `bin/codex-usage-monitor.js json` | machine-readable summary |
| Watch | `bin/codex-usage-monitor.js watch` | periodically refreshed statusline |
| Stop hook | `bin/on-stop.js` | JSON to stdout, human box to stderr |
| Ledger | `$CODEX_HOME/usage-monitor/usage.sqlite3` | durable normalized records |
| Reports | `sessions`, `show`, `totals` | table, JSON, or CSV |

## Data Sources

Primary data comes from Codex session JSONL files under `~/.codex/sessions`.
The Stop hook receives a `transcript_path`, so it can read the exact session
file without scanning the directory tree.

Relevant record types:

- `session_meta`: session id, cwd, Codex CLI version.
- `turn_context`: active model, reasoning effort, context window.
- `event_msg` / `task_started`: turn id and context window snapshot.
- `token_usage_record`: exact response, turn, and session token snapshots.
- Legacy `event_msg` / `token_count`: compatibility totals and rate limits.

The parser keeps the latest thread and per-turn snapshots while summing response
deltas into model buckets. Older transcripts fall back to `token_count`.
SQLite writes replace derived child records transactionally, making ingestion
idempotent.

## Module Layout

```text
lib/pricing.js    Model registry and API-equivalent cost math.
lib/session.js    Codex JSONL walker and usage summarizer.
lib/database.js   SQLite schema, ingestion, filtering, and aggregation.
lib/format.js     Pure terminal formatting helpers.
bin/codex-usage-monitor.js  CLI command router.
bin/on-stop.js    Codex Stop hook entrypoint.
bin/on-session.js Start, interrupt, and end lifecycle entrypoint.
hooks/hooks.json  Plugin hook registration.
```

## Rendering Rules

Progress bars default to Unicode blocks and can switch to ASCII with
`--ascii` or `CODEX_USAGE_MONITOR_ASCII=1`.

Rate-limit and context colors:

| Usage | Color |
| --- | --- |
| `< 70%` | green |
| `70-89.9%` | yellow |
| `>= 90%` | red |

Cache-hit colors are inverted because higher is better:

| Cache hit | Color |
| --- | --- |
| `< 30%` | red |
| `30-69.9%` | yellow |
| `>= 70%` | green |

## Pricing

Pricing is calculated per turn so cache writes and long-context tiers survive
aggregation. User aliases and rate overrides come from the monitor config;
unknown models make cost incomplete instead of silently free.

## Database

SQLite uses WAL mode and a busy timeout for simultaneous Codex surfaces.
`sessions` stores durable aggregates, `turns` retains audit detail,
`session_models` supports model grouping, and `ingestion_files` avoids parsing
unchanged transcripts. Transcript text is never copied into the ledger.

## Failure Modes

- Missing session files return `null`.
- Oversized files are skipped. Default cap: 50 MB.
- Malformed JSON lines are counted and skipped.
- Unknown models keep token totals intact but mark cost incomplete.
- The Stop hook always emits `{"continue":true}` to stdout, even if parsing
  fails, so a monitor bug does not block Codex.

## Testing

Tests use Node's built-in `node:test` runner. Fixtures are synthetic Codex
JSONL records modeled after observed local session logs. The subprocess tests
verify that the CLI and hook behave like real commands rather than only pure
functions.
