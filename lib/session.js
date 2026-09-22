'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

const { costDetails, costForUsage, loadPricingConfig, modelDisplayName, sessionCost } = require('./pricing');

async function summarizeSessionFile(transcriptPath, options = {}) {
  if (!transcriptPath || typeof transcriptPath !== 'string') return null;
  let stat;
  try { stat = fs.statSync(transcriptPath); } catch { return null; }
  if (!stat.isFile()) return null;
  const maxBytes = toPositiveInt(process.env.CODEX_USAGE_MONITOR_MAX_BYTES, 50 * 1024 * 1024);
  if (stat.size > maxBytes) return null;

  const pricingConfig = options.pricingConfig || loadPricingConfig(options.configPath || defaultConfigPath());
  const summary = emptySummary(transcriptPath);
  summary.fileSize = stat.size;
  summary.fileMtimeMs = Math.floor(stat.mtimeMs);
  const state = {
    currentModel: null,
    currentEffort: null,
    currentTurnId: null,
    exactUsageRecords: 0,
    exactModels: Object.create(null),
    exactTurns: new Map(),
    exactTurnCosts: new Map(),
    legacyModels: Object.create(null),
    legacyTurns: new Map(),
    pricingConfig,
  };

  await new Promise((resolve) => {
    const stream = fs.createReadStream(transcriptPath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolve(); } };
    rl.on('line', (line) => {
      if (!line) return;
      try { consumeRecord(JSON.parse(line), summary, state); }
      catch { summary.parseFailures++; }
    });
    rl.on('close', finish);
    rl.on('error', finish);
    stream.on('error', finish);
  });

  if (!summary.sessionId && state.exactTurns.size === 0 && state.legacyTurns.size === 0) return null;
  const selectedTurns = state.exactUsageRecords ? state.exactTurns : state.legacyTurns;
  const selectedModels = state.exactUsageRecords ? state.exactModels : state.legacyModels;
  summary.turns = [...selectedTurns.values()].sort(compareTurns);
  summary.turnCount = summary.turns.length;
  summary.models = selectedModels;
  summary.totalUsage.cacheHitPercent = cacheHitPercent(summary.totalUsage);
  summary.latestUsage.cacheHitPercent = cacheHitPercent(summary.latestUsage);
  summary.contextUsedPercent = computeContextUsedPercent(summary);
  summary.modelName = modelDisplayName(summary.model, pricingConfig) || summary.model || 'unknown';
  for (const turn of summary.turns) {
    turn.usage.cacheHitPercent = cacheHitPercent(turn.usage);
    if (turn.costUsd == null) turn.costUsd = costForUsage(turn.model, turn.usage, pricingConfig);
    const bucket = selectedModels[turn.model];
    if (!state.exactUsageRecords && bucket && turn.costUsd != null) {
      bucket.costUsd = (bucket.costUsd || 0) + turn.costUsd;
    }
  }
  summary.cost = sessionCost(selectedModels, pricingConfig);
  return summary;
}

function consumeRecord(record, summary, state) {
  const timestamp = parseTimestamp(record.timestamp);
  if (timestamp) {
    summary.latestAt = !summary.latestAt || timestamp > summary.latestAt ? timestamp : summary.latestAt;
    summary.startedAt = !summary.startedAt || timestamp < summary.startedAt ? timestamp : summary.startedAt;
  }
  const payload = record.payload && typeof record.payload === 'object' ? record.payload : {};

  if (record.type === 'session_meta') {
    summary.sessionId = stringValue(payload.session_id) || stringValue(payload.id) || summary.sessionId;
    summary.cwd = stringValue(payload.cwd) || summary.cwd;
    summary.cliVersion = stringValue(payload.cli_version) || summary.cliVersion;
    summary.source = sourceValue(payload.source) || summary.source;
    summary.originator = stringValue(payload.originator) || summary.originator;
    return;
  }

  if (record.type === 'turn_context') {
    state.currentTurnId = stringValue(payload.turn_id) || state.currentTurnId;
    state.currentModel = stringValue(payload.model)
      || stringValue(payload.collaboration_mode?.settings?.model) || state.currentModel;
    state.currentEffort = stringValue(payload.effort)
      || stringValue(payload.collaboration_mode?.settings?.reasoning_effort) || state.currentEffort;
    summary.model = state.currentModel || summary.model;
    summary.reasoningEffort = state.currentEffort || summary.reasoningEffort;
    summary.contextWindow = toNum(payload.model_context_window) || summary.contextWindow;
    summary.cwd = stringValue(payload.cwd) || summary.cwd;
    return;
  }

  if (record.type === 'token_usage_record') {
    consumeExactUsage(payload, timestamp, summary, state);
    return;
  }

  if (record.type !== 'event_msg') return;
  if (payload.type === 'task_started') {
    state.currentTurnId = stringValue(payload.turn_id) || state.currentTurnId;
    summary.contextWindow = toNum(payload.model_context_window) || summary.contextWindow;
    const startedAt = epochSecondsToDate(payload.started_at);
    if (startedAt && (!summary.startedAt || startedAt < summary.startedAt)) summary.startedAt = startedAt;
    return;
  }
  if (payload.type !== 'token_count') return;
  const info = payload.info && typeof payload.info === 'object' ? payload.info : {};
  summary.totalUsage = normalizeUsage(info.total_token_usage);
  summary.latestUsage = normalizeUsage(info.last_token_usage);
  summary.contextWindow = toNum(info.model_context_window) || summary.contextWindow;
  summary.rateLimits = normalizeRateLimits(payload.rate_limits);
  summary.planType = stringValue(payload.rate_limits?.plan_type) || summary.planType;
  const turnId = state.currentTurnId || `legacy-${state.legacyTurns.size + 1}`;
  const model = state.currentModel || summary.model || 'unknown';
  state.legacyTurns.set(turnId, turnRecord(turnId, model, state.currentEffort, timestamp, summary.latestUsage));
  rebuildLegacyModels(state);
}

function consumeExactUsage(payload, timestamp, summary, state) {
  state.exactUsageRecords++;
  const usage = normalizeUsage(payload.usage);
  const turnUsage = normalizeUsage(payload.turn_token_usage || payload.usage);
  const threadUsage = normalizeUsage(payload.thread_token_usage || payload.turn_token_usage || payload.usage);
  const turnId = stringValue(payload.turn_id) || state.currentTurnId || `exact-${state.exactTurns.size + 1}`;
  const model = state.currentModel || summary.model || 'unknown';
  summary.sessionId = stringValue(payload.session_id) || stringValue(payload.thread_id) || summary.sessionId;
  summary.totalUsage = threadUsage;
  summary.latestUsage = turnUsage;
  summary.model = model;
  const details = costDetails(model, usage, state.pricingConfig);
  const accumulatedCost = (state.exactTurnCosts.get(turnId) || 0) + (details?.usd || 0);
  state.exactTurnCosts.set(turnId, accumulatedCost);
  const turn = turnRecord(turnId, model, state.currentEffort, timestamp, turnUsage);
  turn.costUsd = details ? accumulatedCost : null;
  state.exactTurns.set(turnId, turn);
  const bucket = state.exactModels[model] || (state.exactModels[model] = zeroUsage());
  addUsage(bucket, usage);
  if (details) {
    bucket.costUsd = (bucket.costUsd || 0) + details.usd;
    bucket.pricingSource = details.source;
  }
}

function rebuildLegacyModels(state) {
  for (const key of Object.keys(state.legacyModels)) delete state.legacyModels[key];
  for (const turn of state.legacyTurns.values()) {
    const bucket = state.legacyModels[turn.model] || (state.legacyModels[turn.model] = zeroUsage());
    addUsage(bucket, turn.usage);
  }
}

function turnRecord(turnId, model, effort, timestamp, usage) {
  return {
    turnId,
    model,
    reasoningEffort: effort,
    updatedAt: timestamp,
    usage: { ...usage },
    costUsd: null,
  };
}

function emptySummary(transcriptPath) {
  return {
    sessionId: null, transcriptPath, cwd: null, cliVersion: null, source: null,
    originator: null, model: null, modelName: null, reasoningEffort: null,
    planType: null, startedAt: null, latestAt: null, turnCount: 0,
    parseFailures: 0, contextWindow: null, contextUsedPercent: null,
    latestUsage: zeroUsage(), totalUsage: zeroUsage(),
    rateLimits: { primary: null, secondary: null }, cost: null,
    models: Object.create(null), turns: [], fileSize: 0, fileMtimeMs: 0,
  };
}

function normalizeUsage(raw) {
  const usage = raw && typeof raw === 'object' ? raw : {};
  return {
    inputTokens: toNum(usage.input_tokens),
    cachedInputTokens: toNum(usage.cached_input_tokens),
    cacheWriteInputTokens: toNum(usage.cache_write_input_tokens),
    outputTokens: toNum(usage.output_tokens),
    reasoningOutputTokens: toNum(usage.reasoning_output_tokens),
    totalTokens: toNum(usage.total_tokens),
  };
}

function normalizeRateLimits(raw) {
  if (!raw || typeof raw !== 'object') return { primary: null, secondary: null };
  return { primary: normalizeLimit(raw.primary), secondary: normalizeLimit(raw.secondary) };
}

function normalizeLimit(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const minutes = toNum(raw.window_minutes);
  return { label: labelForWindow(minutes), usedPercent: roundPercent(raw.used_percent),
    windowMinutes: minutes || null, resetsAt: toNum(raw.resets_at) || null };
}

function labelForWindow(minutes) {
  if (minutes === 300) return '5h';
  if (minutes === 10080) return '7d';
  if (!minutes) return 'limit';
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function addUsage(target, usage) {
  for (const key of ['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens',
    'outputTokens', 'reasoningOutputTokens', 'totalTokens']) target[key] += toNum(usage[key]);
}

function zeroUsage() {
  return { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0,
    outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 };
}

function cacheHitPercent(usage) {
  if (!usage || usage.inputTokens <= 0) return null;
  return roundPercent((usage.cachedInputTokens / usage.inputTokens) * 100);
}

function computeContextUsedPercent(summary) {
  if (!summary.contextWindow || summary.contextWindow <= 0) return null;
  return roundPercent((summary.latestUsage.inputTokens / summary.contextWindow) * 100);
}

function findSessionFiles(codexHome = defaultCodexHome()) {
  const roots = [path.join(codexHome, 'sessions'), path.join(codexHome, 'archived_sessions')];
  return roots.flatMap((root) => walkJsonl(root));
}

function findLatestSessionFile(codexHome = defaultCodexHome()) {
  let latest = null;
  for (const file of findSessionFiles(codexHome)) {
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    if (!latest || stat.mtimeMs > latest.mtimeMs) latest = { file, mtimeMs: stat.mtimeMs };
  }
  return latest ? latest.file : null;
}

function walkJsonl(root) {
  const result = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) result.push(fullPath);
    }
  }
  return result;
}

function defaultCodexHome() { return process.env.CODEX_HOME || path.join(os.homedir(), '.codex'); }
function defaultConfigPath(codexHome = defaultCodexHome()) {
  return process.env.CODEX_USAGE_MONITOR_CONFIG || path.join(codexHome, 'usage-monitor', 'config.json');
}
function sourceValue(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') return stringValue(value.type) || JSON.stringify(value);
  return null;
}
function parseTimestamp(value) { const ms = Date.parse(value); return Number.isFinite(ms) ? new Date(ms) : null; }
function epochSecondsToDate(value) { const seconds = toNum(value); return seconds ? new Date(seconds * 1000) : null; }
function stringValue(value) { return typeof value === 'string' && value ? value : null; }
function toNum(value) { const n = Number(value); return Number.isFinite(n) ? n : 0; }
function toPositiveInt(value, fallback) { const n = Number(value); return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback; }
function roundPercent(value) { const n = Number(value); return Number.isFinite(n) ? Math.round(n * 10) / 10 : null; }
function compareTurns(a, b) { return String(a.updatedAt || '').localeCompare(String(b.updatedAt || '')); }

module.exports = {
  cacheHitPercent,
  defaultCodexHome,
  defaultConfigPath,
  findLatestSessionFile,
  findSessionFiles,
  normalizeUsage,
  summarizeSessionFile,
  zeroUsage,
};
