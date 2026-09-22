# Changelog

## 0.2.0 - 2026-09-22

- Add a persistent SQLite ledger with session, turn, and per-model records.
- Add automatic lifecycle ingestion and historical active/archive backfill.
- Add filtered session reports, totals, JSON export, and CSV export.
- Add current token usage record support, cache-write accounting, current
  OpenAI pricing, and configurable deployment aliases/rates.

## 0.1.0 - 2026-06-30

- Initial public release.
- Add Codex JSONL session parser.
- Add model, reasoning effort, token, context, cache, rate-limit, and cost
  summaries.
- Add `summary`, `statusline`, `json`, `watch`, and `doctor` CLI commands.
- Add Codex Stop hook entrypoint.
- Add zero-dependency Node test suite.
