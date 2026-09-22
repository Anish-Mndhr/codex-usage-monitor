# Contributing

## Development

This project intentionally has no runtime dependencies.

```bash
npm test
node bin/codex-usage-monitor.js statusline --file test/fixtures/session-basic.jsonl --ascii --no-color
node bin/codex-usage-monitor.js summary --file test/fixtures/session-basic.jsonl --ascii --no-color
```

## Pricing Updates

When OpenAI changes model pricing:

1. Update `lib/pricing.js`.
2. Add or update tests in `test/pricing.test.js`.
3. Update the pricing snapshot date in `README.md` and `lib/pricing.js`.
4. Run `npm test`.

## Data Shape Changes

If Codex changes session JSONL fields, add the smallest fixture that reproduces
the new shape before changing `lib/session.js`.

## Release Checklist

1. `npm test`
2. `node bin/codex-usage-monitor.js doctor`
3. Update `CHANGELOG.md`
4. Tag the release
