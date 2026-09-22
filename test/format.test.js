'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  formatStatusLine,
  formatStopBox,
  formatTokens,
  formatUsd,
  progressBar,
} = require('../lib/format');

const summary = {
  sessionId: 'sess_basic',
  modelName: 'GPT-5.4 mini',
  reasoningEffort: 'medium',
  contextUsedPercent: 12,
  contextWindow: 10000,
  latestUsage: {
    inputTokens: 1200,
    cachedInputTokens: 600,
    outputTokens: 200,
    reasoningOutputTokens: 110,
    totalTokens: 1400,
    cacheHitPercent: 50,
  },
  totalUsage: {
    inputTokens: 2200,
    cachedInputTokens: 900,
    outputTokens: 300,
    reasoningOutputTokens: 150,
    totalTokens: 2500,
    cacheHitPercent: 40.9,
  },
  rateLimits: {
    primary: { label: '5h', usedPercent: 42, resetsAt: 1782808300 },
    secondary: { label: '7d', usedPercent: 15, resetsAt: 1783395100 },
  },
  turnCount: 2,
  cost: {
    usd: 0.0032425,
    complete: true,
    perModel: [
      { modelId: 'gpt-5.5', name: 'GPT-5.5', usd: 0.0026775 },
      { modelId: 'gpt-5.4-mini', name: 'GPT-5.4 mini', usd: 0.000565 },
    ],
  },
};

test('formatTokens and formatUsd keep compact human-friendly units', () => {
  assert.equal(formatTokens(999), '999');
  assert.equal(formatTokens(15_300), '15.3k');
  assert.equal(formatTokens(2_400_000), '2.4M');
  assert.equal(formatUsd(0.003373), '$0.0034');
  assert.equal(formatUsd(0.1234), '$0.123');
  assert.equal(formatUsd(12.3), '$12.30');
});

test('progressBar renders a bounded compact bar', () => {
  assert.equal(progressBar(40, 5, { ascii: true }), '##---');
  assert.equal(progressBar(null, 5, { ascii: true }), '-----');
});

test('formatStatusLine shows model, reasoning, context, limits, tokens, cache, and API cost', () => {
  const line = formatStatusLine(summary, { now: 1782790300, ascii: true, color: false });

  assert.match(line, /GPT-5\.4 mini/);
  assert.match(line, /think medium/);
  assert.match(line, /ctx #---- 12%/);
  assert.match(line, /5h ##--- 42%/);
  assert.match(line, /7d #---- 15%/);
  assert.match(line, /turn in 1\.2k out 200/);
  assert.match(line, /cache ###-- 50%/);
  assert.match(line, /API≈\$0\.0032/);
});

test('formatStopBox renders a bordered multi-line summary', () => {
  const box = formatStopBox(summary, { now: 1782790300, ascii: true, color: false });

  assert.match(box, /codex-usage-monitor/);
  assert.match(box, /Model/);
  assert.match(box, /Context/);
  assert.match(box, /This turn/);
  assert.match(box, /Session/);
  assert.match(box, /Models/);
  assert.match(box, /Cost/);
});
