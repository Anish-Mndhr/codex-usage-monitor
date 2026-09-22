'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  hookStatePath,
  recordHookSummaryShown,
  shouldShowHookSummary,
} = require('../lib/hook-state');

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-monitor-'));
}

test('shouldShowHookSummary hides output in quiet mode', () => {
  assert.equal(shouldShowHookSummary({
    env: { CODEX_USAGE_MONITOR_QUIET: '1' },
    codexHome: tempHome(),
    nowMs: 1000,
  }), false);

  assert.equal(shouldShowHookSummary({
    env: { CODEX_USAGE_MONITOR_QUIET: 'true' },
    codexHome: tempHome(),
    nowMs: 1000,
  }), false);
});

test('shouldShowHookSummary shows output when interval is unset or invalid', () => {
  assert.equal(shouldShowHookSummary({
    env: {},
    codexHome: tempHome(),
    nowMs: 1000,
  }), true);

  assert.equal(shouldShowHookSummary({
    env: { CODEX_USAGE_MONITOR_HOOK_INTERVAL_SECONDS: 'abc' },
    codexHome: tempHome(),
    nowMs: 1000,
  }), true);
});

test('shouldShowHookSummary throttles repeated displays within interval', () => {
  const codexHome = tempHome();
  const env = { CODEX_USAGE_MONITOR_HOOK_INTERVAL_SECONDS: '300' };

  assert.equal(shouldShowHookSummary({ env, codexHome, nowMs: 1000 }), true);
  recordHookSummaryShown({ codexHome, nowMs: 1000 });

  assert.equal(shouldShowHookSummary({ env, codexHome, nowMs: 200000 }), false);
  assert.equal(shouldShowHookSummary({ env, codexHome, nowMs: 301000 }), true);
});

test('shouldShowHookSummary can seed and throttle an independent work interval', () => {
  const codexHome = tempHome();
  const options = {
    env: {},
    codexHome,
    stateKey: 'lastWorkDisplayAt',
    intervalEnv: 'CODEX_USAGE_MONITOR_WORK_INTERVAL_SECONDS',
    defaultIntervalSeconds: 300,
    firstShow: false,
  };

  assert.equal(shouldShowHookSummary({ ...options, nowMs: 1000 }), false);
  assert.equal(shouldShowHookSummary({ ...options, nowMs: 200000 }), false);
  assert.equal(shouldShowHookSummary({ ...options, nowMs: 301000 }), true);

  recordHookSummaryShown({ codexHome, stateKey: 'lastWorkDisplayAt', nowMs: 301000 });
  assert.equal(shouldShowHookSummary({ ...options, nowMs: 400000 }), false);
});

test('hook state tolerates corrupt or unwritable state', () => {
  const codexHome = tempHome();
  fs.writeFileSync(hookStatePath(codexHome), '{not json', 'utf8');

  assert.equal(shouldShowHookSummary({
    env: { CODEX_USAGE_MONITOR_HOOK_INTERVAL_SECONDS: '300' },
    codexHome,
    nowMs: 1000,
  }), true);

  const fileAsHome = path.join(tempHome(), 'not-a-directory');
  fs.writeFileSync(fileAsHome, 'x', 'utf8');
  assert.doesNotThrow(() => recordHookSummaryShown({ codexHome: fileAsHome, nowMs: 1000 }));
});
