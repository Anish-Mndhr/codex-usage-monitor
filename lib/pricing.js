'use strict';

/** Standard API-equivalent USD prices per million tokens. */
const PRICING_VERSION = 'openai-standard-2026-09-22';
const LONG_CONTEXT_THRESHOLD = 272_000;

const MODELS = [
  priced('gpt-6-astra', 'GPT-6 Astra', 10, 1, 12.5, 50, 20, 2, 25, 75),
  priced('gpt-5.6-sol', 'GPT-5.6 Sol', 4, 0.4, 5, 20, 8, 0.8, 10, 30),
  priced('gpt-5.6-terra', 'GPT-5.6 Terra', 2, 0.2, 2.5, 12, 4, 0.4, 5, 18),
  priced('gpt-5.6-luna', 'GPT-5.6 Luna', 0.2, 0.02, 0.25, 1.2, 0.4, 0.04, 0.5, 1.8),
  priced('gpt-5.5-pro', 'GPT-5.5 Pro', 30, 30, 30, 180, 60, 60, 60, 270),
  priced('gpt-5.5', 'GPT-5.5', 5, 0.5, 5, 30, 10, 1, 10, 45),
  priced('gpt-5.4-mini', 'GPT-5.4 mini', 0.75, 0.075, 0.75, 4.5),
  priced('gpt-5.4-nano', 'GPT-5.4 nano', 0.2, 0.02, 0.2, 1.25),
  priced('gpt-5.4-pro', 'GPT-5.4 Pro', 30, 30, 30, 180, 60, 60, 60, 270),
  priced('gpt-5.4', 'GPT-5.4', 2.5, 0.25, 2.5, 15, 5, 0.5, 5, 22.5),
  priced('gpt-5.3-codex', 'GPT-5.3 Codex', 1.75, 0.175, 1.75, 14),
  priced('gpt-5.2-pro', 'GPT-5.2 Pro', 21, 21, 21, 168),
  priced('gpt-5.2', 'GPT-5.2', 1.75, 0.175, 1.75, 14),
  priced('gpt-5.1', 'GPT-5.1', 1.25, 0.125, 1.25, 10),
  priced('gpt-5-mini', 'GPT-5 mini', 0.25, 0.025, 0.25, 2),
  priced('gpt-5-nano', 'GPT-5 nano', 0.05, 0.005, 0.05, 0.4),
  priced('gpt-5-pro', 'GPT-5 Pro', 15, 15, 15, 120),
  priced('gpt-5', 'GPT-5', 1.25, 0.125, 1.25, 10),
  priced('gpt-4.1-mini', 'GPT-4.1 mini', 0.4, 0.1, 0.4, 1.6),
  priced('gpt-4.1-nano', 'GPT-4.1 nano', 0.1, 0.025, 0.1, 0.4),
  priced('gpt-4.1', 'GPT-4.1', 2, 0.5, 2, 8),
  priced('gpt-4o-mini', 'GPT-4o mini', 0.15, 0.075, 0.15, 0.6),
  priced('gpt-4o', 'GPT-4o', 2.5, 1.25, 2.5, 10),
  priced('o4-mini', 'o4-mini', 1.1, 0.275, 1.1, 4.4),
  priced('o3-pro', 'o3-pro', 20, 20, 20, 80),
  priced('o3-mini', 'o3-mini', 1.1, 0.55, 1.1, 4.4),
  priced('o3', 'o3', 2, 0.5, 2, 8),
];

function priced(key, name, input, cachedInput, cacheWriteInput, output,
  longInput = null, longCachedInput = null, longCacheWriteInput = null, longOutput = null) {
  return {
    key, name,
    short: { input, cachedInput, cacheWriteInput, output },
    long: longInput == null ? null : {
      input: longInput,
      cachedInput: longCachedInput,
      cacheWriteInput: longCacheWriteInput,
      output: longOutput,
    },
    longContextThreshold: longInput == null ? null : LONG_CONTEXT_THRESHOLD,
    source: PRICING_VERSION,
  };
}

function normalizeModelId(modelId) {
  if (typeof modelId !== 'string') return null;
  const id = modelId.toLowerCase().replace(/\[[^\]]*\]/g, '').replace(/[_:]/g, '-').trim();
  return id || null;
}

function loadPricingConfig(configPath) {
  if (!configPath) return {};
  try {
    const value = JSON.parse(require('node:fs').readFileSync(configPath, 'utf8'));
    return value && typeof value === 'object' ? value.pricing || value : {};
  } catch {
    return {};
  }
}

function modelInfo(modelId, config = {}) {
  const normalized = normalizeModelId(modelId);
  if (!normalized) return null;
  const aliases = config.aliases && typeof config.aliases === 'object' ? config.aliases : {};
  const alias = aliases[modelId] || aliases[normalized];
  const resolved = normalizeModelId(alias || modelId);
  const overrides = config.models && typeof config.models === 'object' ? config.models : {};
  const override = overrides[modelId] || overrides[normalized] || overrides[resolved];
  if (override && typeof override === 'object') return normalizeOverride(resolved, override);
  for (const model of MODELS) {
    if (resolved === model.key || resolved.startsWith(`${model.key}-`) || resolved.includes(model.key)) {
      return { ...model, short: { ...model.short }, long: model.long && { ...model.long } };
    }
  }
  return null;
}

function normalizeOverride(key, value) {
  const short = normalizeRates(value.short || value);
  if (!short) return null;
  return {
    key,
    name: value.name || key,
    short,
    long: normalizeRates(value.long),
    longContextThreshold: positiveNumber(value.longContextThreshold),
    source: value.source || 'user-override',
  };
}

function normalizeRates(value) {
  if (!value || typeof value !== 'object') return null;
  const input = finiteNumber(value.input);
  const output = finiteNumber(value.output);
  if (input == null || output == null) return null;
  return {
    input,
    cachedInput: finiteNumber(value.cachedInput) ?? input,
    cacheWriteInput: finiteNumber(value.cacheWriteInput) ?? input,
    output,
  };
}

function modelDisplayName(modelId, config = {}) {
  const info = modelInfo(modelId, config);
  if (info) return info.name;
  return typeof modelId === 'string' && modelId.trim() ? modelId.trim() : null;
}

function costDetails(modelId, usage, config = {}) {
  const info = modelInfo(modelId, config);
  if (!info || !usage || typeof usage !== 'object') return null;
  const input = toNum(usage.inputTokens);
  const cached = Math.min(input, Math.max(0, toNum(usage.cachedInputTokens)));
  const cacheWrite = Math.min(input - cached, Math.max(0, toNum(usage.cacheWriteInputTokens)));
  const uncached = Math.max(0, input - cached - cacheWrite);
  const useLong = Boolean(info.long && info.longContextThreshold && input >= info.longContextThreshold);
  const rates = useLong ? info.long : info.short;
  const usd = (uncached * rates.input + cached * rates.cachedInput
    + cacheWrite * rates.cacheWriteInput + toNum(usage.outputTokens) * rates.output) / 1_000_000;
  return { usd, source: info.source, tier: useLong ? 'long' : 'short', rates: { ...rates } };
}

function costForUsage(modelId, usage, config = {}) {
  const details = costDetails(modelId, usage, config);
  return details ? details.usd : null;
}

function sessionCost(models, config = {}) {
  if (!models || typeof models !== 'object') return null;
  let usd = 0;
  let complete = true;
  let any = false;
  const perModel = [];
  const sources = new Set();
  for (const [modelId, usage] of Object.entries(models)) {
    if (!hasUsage(usage)) continue;
    any = true;
    const precomputed = finiteNumber(usage.costUsd);
    const details = precomputed == null ? costDetails(modelId, usage, config) : {
      usd: precomputed,
      source: usage.pricingSource || modelInfo(modelId, config)?.source || 'unknown',
    };
    if (!details) {
      complete = false;
      continue;
    }
    usd += details.usd;
    sources.add(details.source);
    perModel.push({ modelId, name: modelDisplayName(modelId, config), usd: details.usd, source: details.source });
  }
  if (!any) return null;
  perModel.sort((a, b) => (b.usd || 0) - (a.usd || 0));
  return { usd, complete, source: sources.size === 1 ? [...sources][0] : 'mixed', perModel };
}

function hasUsage(usage) {
  return ['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens',
    'reasoningOutputTokens', 'totalTokens'].some((key) => toNum(usage && usage[key]) > 0);
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function positiveNumber(value) {
  const number = finiteNumber(value);
  return number && number > 0 ? number : null;
}

function toNum(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

module.exports = {
  LONG_CONTEXT_THRESHOLD,
  MODELS,
  PRICING_VERSION,
  costDetails,
  costForUsage,
  loadPricingConfig,
  modelDisplayName,
  modelInfo,
  normalizeModelId,
  sessionCost,
};
