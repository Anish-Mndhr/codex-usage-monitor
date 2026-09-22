'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { defaultCodexHome } = require('./session');

const STATE_FILE = 'codex-usage-monitor-state.json';

function shouldShowHookSummary(options = {}) {
  const env = options.env || process.env;
  if (isQuiet(env)) return false;

  const codexHome = options.codexHome || defaultCodexHome();
  const stateKey = options.stateKey || 'lastHookDisplayAt';
  const intervalSeconds = intervalSecondsFor(env, options);
  if (!intervalSeconds) return true;

  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const state = readHookState(codexHome);
  const lastMs = Number(state[stateKey]);
  if (!Number.isFinite(lastMs) || lastMs <= 0) {
    if (options.firstShow === false) {
      recordHookSummaryShown({ codexHome, nowMs, stateKey });
      return false;
    }
    return true;
  }

  return nowMs - lastMs >= intervalSeconds * 1000;
}

function recordHookSummaryShown(options = {}) {
  const codexHome = options.codexHome || defaultCodexHome();
  const stateKey = options.stateKey || 'lastHookDisplayAt';
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  try {
    fs.mkdirSync(codexHome, { recursive: true });
    const state = readHookState(codexHome);
    state[stateKey] = nowMs;
    fs.writeFileSync(hookStatePath(codexHome), `${JSON.stringify(state)}\n`, 'utf8');
  } catch {
    // Monitoring must never block Codex.
  }
}

function hookStatePath(codexHome = defaultCodexHome()) {
  return path.join(codexHome, STATE_FILE);
}

function readHookState(codexHome) {
  try {
    return JSON.parse(fs.readFileSync(hookStatePath(codexHome), 'utf8'));
  } catch {
    return {};
  }
}

function isQuiet(env) {
  return env.CODEX_USAGE_MONITOR_QUIET === '1'
    || env.CODEX_USAGE_MONITOR_QUIET === 'true';
}

function positiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function intervalSecondsFor(env, options) {
  const key = options.intervalEnv || 'CODEX_USAGE_MONITOR_HOOK_INTERVAL_SECONDS';
  if (Object.prototype.hasOwnProperty.call(env, key)) return positiveNumber(env[key]);
  return positiveNumber(options.defaultIntervalSeconds);
}

module.exports = {
  hookStatePath,
  recordHookSummaryShown,
  shouldShowHookSummary,
};
