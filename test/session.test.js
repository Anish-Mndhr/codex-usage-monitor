'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { summarizeSessionFile } = require('../lib/session');

const fixture = path.join(__dirname, 'fixtures', 'session-basic.jsonl');

test('summarizeSessionFile extracts Codex usage, model, effort, context, limits, and cost', async () => {
  const summary = await summarizeSessionFile(fixture);

  assert.equal(summary.sessionId, 'sess_basic');
  assert.equal(summary.cliVersion, '0.142.4');
  assert.equal(summary.cwd, 'E:\\Project\\demo');
  assert.equal(summary.model, 'gpt-5.4-mini');
  assert.equal(summary.modelName, 'GPT-5.4 mini');
  assert.equal(summary.reasoningEffort, 'medium');
  assert.equal(summary.turnCount, 2);
  assert.equal(summary.contextWindow, 10000);
  assert.equal(summary.contextUsedPercent, 12);
  assert.equal(summary.latestUsage.inputTokens, 1200);
  assert.equal(summary.latestUsage.cachedInputTokens, 600);
  assert.equal(summary.latestUsage.cacheHitPercent, 50);
  assert.equal(summary.totalUsage.inputTokens, 2200);
  assert.equal(summary.totalUsage.cachedInputTokens, 900);
  assert.equal(summary.totalUsage.cacheHitPercent, 40.9);
  assert.equal(summary.rateLimits.primary.usedPercent, 42);
  assert.equal(summary.rateLimits.primary.label, '5h');
  assert.equal(summary.rateLimits.secondary.label, '7d');
  assert.equal(summary.planType, 'prolite');
  assert.equal(summary.cost.complete, true);
  assert.equal(summary.cost.perModel.length, 2);
  assert.ok(summary.cost.usd > 0);
  assert.equal(summary.usageRecords.length, 2);
  assert.equal(summary.usageRecords[0].turnId, 'turn_one');
  assert.equal(summary.usageRecords[1].turnId, 'turn_two');
  assert.ok(summary.usageRecords.every((record) => record.costStatus === 'estimated'));
});

test('summarizeSessionFile returns null for missing files', async () => {
  assert.equal(await summarizeSessionFile(path.join(__dirname, 'fixtures', 'missing.jsonl')), null);
});

test('current token_usage_record snapshots produce idempotent turn totals', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-session-')), 'current.jsonl');
  const records = [
    { timestamp: '2026-09-22T00:00:00Z', type: 'session_meta', payload: { id: 'current', cwd: '/work', source: 'cli' } },
    { timestamp: '2026-09-22T00:00:01Z', type: 'turn_context', payload: { turn_id: 'turn-1', model: 'gpt-5.6-sol', effort: 'medium' } },
    { timestamp: '2026-09-22T00:00:02Z', type: 'token_usage_record', payload: { session_id: 'current', turn_id: 'turn-1', usage: { input_tokens: 100, cached_input_tokens: 0, cache_write_input_tokens: 90, output_tokens: 10, total_tokens: 110 }, turn_token_usage: { input_tokens: 100, cached_input_tokens: 0, cache_write_input_tokens: 90, output_tokens: 10, total_tokens: 110 }, thread_token_usage: { input_tokens: 100, cached_input_tokens: 0, cache_write_input_tokens: 90, output_tokens: 10, total_tokens: 110 } } },
    { timestamp: '2026-09-22T00:00:03Z', type: 'token_usage_record', payload: { session_id: 'current', turn_id: 'turn-1', usage: { input_tokens: 120, cached_input_tokens: 90, cache_write_input_tokens: 20, output_tokens: 20, total_tokens: 140 }, turn_token_usage: { input_tokens: 220, cached_input_tokens: 90, cache_write_input_tokens: 110, output_tokens: 30, total_tokens: 250 }, thread_token_usage: { input_tokens: 220, cached_input_tokens: 90, cache_write_input_tokens: 110, output_tokens: 30, total_tokens: 250 } } },
  ];
  fs.writeFileSync(file, `${records.map(JSON.stringify).join('\n')}\n`);
  const summary = await summarizeSessionFile(file);
  assert.equal(summary.turnCount, 1);
  assert.equal(summary.turns[0].usage.inputTokens, 220);
  assert.equal(summary.totalUsage.cacheWriteInputTokens, 110);
  assert.equal(summary.models['gpt-5.6-sol'].inputTokens, 220);
  assert.equal(summary.models['gpt-5.6-sol'].costUsd, summary.cost.usd);
  assert.equal(summary.cost.complete, true);
  assert.equal(summary.usageRecords.length, 2);
  assert.equal(summary.usageRecords.reduce((sum, record) => sum + record.usage.inputTokens, 0), 220);
});
