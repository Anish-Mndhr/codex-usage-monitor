'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  costDetails,
  costForUsage,
  modelDisplayName,
  modelInfo,
  sessionCost,
} = require('../lib/pricing');

test('resolves current Codex model slugs to friendly names', () => {
  assert.equal(modelDisplayName('gpt-6.1-sol'), 'GPT-6.1 Sol');
  assert.equal(modelDisplayName('openai/GPT-6.1-Sol-2026-10-01'), 'GPT-6.1 Sol');
  assert.equal(modelDisplayName('gpt-5.6-sol'), 'GPT-5.6 Sol');
  assert.equal(modelDisplayName('gpt-5.5'), 'GPT-5.5');
  assert.equal(modelDisplayName('openai/gpt-5.4-mini-2026-06-01'), 'GPT-5.4 mini');
  assert.equal(modelDisplayName('gpt-5.4-nano'), 'GPT-5.4 nano');
  assert.equal(modelInfo('unknown-model'), null);
});

test('GPT-6.1 Sol prices input, cache reads, writes, and output without counting reasoning twice', () => {
  assert.equal(costForUsage('gpt-6.1-sol', {
    inputTokens: 100_000, cachedInputTokens: 25_000,
    cacheWriteInputTokens: 20_000, outputTokens: 10_000,
    reasoningOutputTokens: 4_000,
  }), 0.2625);
});

test('long-context pricing starts strictly above 272K input tokens for both Sol models', () => {
  for (const model of ['gpt-5.6-sol', 'gpt-6.1-sol']) {
    for (const inputTokens of [271_999, 272_000, 272_001]) {
      const details = costDetails(model, { inputTokens, cachedInputTokens: 20_000,
        cacheWriteInputTokens: 10_000, outputTokens: 1_000 });
      const long = inputTokens > 272_000;
      const info = modelInfo(model);
      const rates = long ? info.long : info.short;
      assert.equal(details.tier, long ? 'long' : 'short');
      assert.equal(details.usd, ((inputTokens - 30_000) * rates.input
        + 20_000 * rates.cachedInput + 10_000 * rates.cacheWriteInput
        + 1_000 * rates.output) / 1_000_000);
    }
  }
});

test('null costs remain incomplete for unknown models and are recalculated for known models', () => {
  const result = sessionCost({
    'gpt-6.1-sol': { inputTokens: 1000, outputTokens: 100, costUsd: null },
    'gpt-5.6-sol': { inputTokens: 1000, outputTokens: 100 },
    'future-model': { inputTokens: 1000, costUsd: null },
  });
  assert.equal(result.complete, false);
  assert.ok(Math.abs(result.usd - 0.009) < 1e-12);
  assert.equal(result.perModel.length, 2);
  assert.equal(sessionCost({ 'gpt-6.1-sol': {
    inputTokens: 1000, costUsd: 0,
  } }).usd, 0);
});

test('prices cached input at cached-input rate and output at output rate', () => {
  const usd = costForUsage('gpt-5.5', {
    inputTokens: 100_000,
    cachedInputTokens: 25_000,
    outputTokens: 10_000,
  });

  assert.equal(usd, 0.6875);
});

test('prices cache writes and supports deployment overrides', () => {
  const usd = costForUsage('my-azure-deployment', {
    inputTokens: 1000,
    cachedInputTokens: 200,
    cacheWriteInputTokens: 300,
    outputTokens: 100,
  }, {
    models: {
      'my-azure-deployment': { input: 2, cachedInput: 0.2, cacheWriteInput: 2.5, output: 12 },
    },
  });
  assert.equal(usd, 0.00299);
});

test('sessionCost reports per-model totals and incomplete pricing for unknown models', () => {
  const result = sessionCost({
    'gpt-5.5': {
      inputTokens: 1000,
      cachedInputTokens: 300,
      outputTokens: 100,
      reasoningOutputTokens: 40,
    },
    'gpt-5.4-mini': {
      inputTokens: 1200,
      cachedInputTokens: 600,
      outputTokens: 200,
      reasoningOutputTokens: 110,
    },
    'future-model': {
      inputTokens: 10,
      cachedInputTokens: 0,
      outputTokens: 5,
      reasoningOutputTokens: 0,
    },
  });

  assert.equal(result.complete, false);
  assert.equal(result.perModel.length, 2);
  assert.equal(result.perModel[0].name, 'GPT-5.5');
  assert.ok(result.usd > 0);
});
