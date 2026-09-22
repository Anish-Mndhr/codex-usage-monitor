'use strict';

const ANSI = {
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  gray: '\x1b[90m',
  reset: '\x1b[0m',
};

function progressBar(percent, width = 5, options = {}) {
  const chars = options.ascii
    ? { filled: '#', empty: '-' }
    : { filled: '▰', empty: '▱' };
  if (percent == null) return chars.empty.repeat(width);
  const filled = Math.max(0, Math.min(width, Math.round((Number(percent) / 100) * width)));
  return chars.filled.repeat(filled) + chars.empty.repeat(width - filled);
}

function formatStatusLine(summary, options = {}) {
  if (!summary) return 'codex usage: waiting for session';

  const parts = [
    summary.modelName || summary.model || 'unknown model',
    summary.reasoningEffort ? `think ${summary.reasoningEffort}` : null,
    formatContext(summary, 5, options),
    formatLimit(summary.rateLimits && summary.rateLimits.primary, 5, options),
    formatLimit(summary.rateLimits && summary.rateLimits.secondary, 5, options),
    formatTurn(summary),
    formatSession(summary, options),
    formatCache(summary.latestUsage && summary.latestUsage.cacheHitPercent, 5, options),
    formatCost(summary.cost),
  ].filter(Boolean);

  return parts.join(' | ');
}

function formatStopBox(summary, options = {}) {
  if (!summary) return '';

  const rows = [
    ['Model', `${summary.modelName || summary.model || 'unknown'}${summary.reasoningEffort ? `  think ${summary.reasoningEffort}` : ''}${summary.planType ? `  ${summary.planType}` : ''}`],
    ['Limits', [formatLimit(summary.rateLimits && summary.rateLimits.primary, 12, options), formatLimit(summary.rateLimits && summary.rateLimits.secondary, 12, options)].filter(Boolean).join('  |  ')],
    ['Context', formatContext(summary, 12, options)],
    ['This turn', formatTurn(summary)],
    ['Session', `${formatTokens(summary.totalUsage.inputTokens)} in  ${formatTokens(summary.totalUsage.outputTokens)} out  ${summary.turnCount} turns  ${cacheText(summary.totalUsage.cacheHitPercent)}`],
    ['Session today', formatTodayUsage(summary.sessionTodayUsage)],
    ['All today', formatTodayUsage(summary.allTodayUsage, { includeSessions: true })],
    ['Models', formatModelBreakdown(summary.cost)],
    ['Cost', formatCost(summary.cost)],
  ].filter((row) => row[1]);

  const labelWidth = Math.max(...rows.map(([label]) => label.length));
  const lines = rows.map(([label, value]) => `${label.padEnd(labelWidth)}  ${value}`);
  const title = ' codex-usage-monitor ';
  const innerWidth = Math.max(title.length + 2, 60, ...lines.map(visibleLength));

  if (options.ascii) {
    const top = `+${title}${'-'.repeat(Math.max(0, innerWidth - title.length))}+`;
    const bottom = `+${'-'.repeat(innerWidth)}+`;
    return [top, ...lines.map((line) => `| ${line.padEnd(innerWidth - 2)} |`), bottom].join('\n');
  }

  const top = `┌${title}${'─'.repeat(Math.max(0, innerWidth - title.length))}┐`;
  const bottom = `└${'─'.repeat(innerWidth)}┘`;
  return [top, ...lines.map((line) => `│ ${line.padEnd(innerWidth - 2)} │`), bottom].join('\n');
}

function formatContext(summary, width, options) {
  if (summary.contextUsedPercent == null) return null;
  const bar = colorizeBar(summary.contextUsedPercent, progressBar(summary.contextUsedPercent, width, options), options);
  const latestInput = summary.latestUsage ? summary.latestUsage.inputTokens : null;
  const detail = summary.contextWindow
    ? ` (${formatTokens(latestInput)}/${formatTokens(summary.contextWindow)})`
    : '';
  return `ctx ${bar} ${formatPercent(summary.contextUsedPercent)}${detail}`;
}

function formatLimit(limit, width, options) {
  if (!limit) return null;
  const bar = colorizeBar(limit.usedPercent, progressBar(limit.usedPercent, width, options), options);
  const reset = limit.resetsAt ? ` (${timeUntil(limit.resetsAt, options.now)})` : '';
  return `${limit.label || 'limit'} ${bar} ${formatPercent(limit.usedPercent)}${reset}`;
}

function formatTurn(summary) {
  const usage = summary.latestUsage || {};
  const segments = [
    `turn in ${formatTokens(usage.inputTokens)}`,
    `out ${formatTokens(usage.outputTokens)}`,
  ];
  if (usage.reasoningOutputTokens) segments.push(`reason ${formatTokens(usage.reasoningOutputTokens)}`);
  return segments.join(' ');
}

function formatSession(summary) {
  const usage = summary.totalUsage || {};
  return `Σ in ${formatTokens(usage.inputTokens)} out ${formatTokens(usage.outputTokens)}`;
}

function formatTodayUsage(daily, options = {}) {
  if (!daily || !daily.usage) return null;
  const usage = daily.usage;
  const segments = [
    `${formatTokens(usage.inputTokens)} in`,
    `${formatTokens(usage.outputTokens)} out`,
    `${daily.turnCount || 0} turns`,
  ];
  if (options.includeSessions) segments.push(`${daily.sessionCount || 0} sessions`);
  const cost = formatCost(daily.cost);
  if (cost) segments.push(cost);
  return segments.join('  ');
}

function formatCache(percent, width, options) {
  if (percent == null) return null;
  const bar = colorizeCacheBar(percent, progressBar(percent, width, options), options);
  return `cache ${bar} ${formatPercent(percent)}`;
}

function cacheText(percent) {
  return percent == null ? 'cache n/a' : `cache ${formatPercent(percent)}`;
}

function formatCost(cost) {
  if (!cost || cost.usd == null || !Number.isFinite(cost.usd)) return null;
  const mark = cost.complete ? '' : '~';
  return `API≈${mark}${formatUsd(cost.usd)}`;
}

function formatModelBreakdown(cost) {
  if (!cost || !Array.isArray(cost.perModel) || cost.perModel.length === 0) return null;
  return cost.perModel
    .map((item) => `${item.name || item.modelId} ${item.usd == null ? '?' : formatUsd(item.usd)}`)
    .join('  |  ');
}

function formatTokens(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0';
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return trimFixed(n / 1_000_000_000, 1) + 'B';
  if (abs >= 1_000_000) return trimFixed(n / 1_000_000, 1) + 'M';
  if (abs >= 1_000) return trimFixed(n / 1_000, 1) + 'k';
  return String(Math.round(n));
}

function formatUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '$0.00';
  if (Math.abs(n) < 0.01) return `$${n.toFixed(4)}`;
  if (Math.abs(n) < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

function formatPercent(value) {
  if (value == null || !Number.isFinite(Number(value))) return '--%';
  return `${trimFixed(Number(value), 1)}%`;
}

function timeUntil(resetsAt, now = Math.floor(Date.now() / 1000)) {
  const seconds = Math.max(0, Number(resetsAt) - Number(now || 0));
  if (!Number.isFinite(seconds) || seconds <= 0) return 'now';
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours < 24) return mins ? `${hours}h ${mins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours ? `${days}d ${remHours}h` : `${days}d`;
}

function colorizeBar(percent, text, options) {
  if (!shouldColor(options)) return text;
  if (percent == null) return `${ANSI.gray}${text}${ANSI.reset}`;
  if (percent >= 90) return `${ANSI.red}${text}${ANSI.reset}`;
  if (percent >= 70) return `${ANSI.yellow}${text}${ANSI.reset}`;
  return `${ANSI.green}${text}${ANSI.reset}`;
}

function colorizeCacheBar(percent, text, options) {
  if (!shouldColor(options)) return text;
  if (percent == null) return `${ANSI.gray}${text}${ANSI.reset}`;
  if (percent >= 70) return `${ANSI.green}${text}${ANSI.reset}`;
  if (percent >= 30) return `${ANSI.yellow}${text}${ANSI.reset}`;
  return `${ANSI.red}${text}${ANSI.reset}`;
}

function shouldColor(options = {}) {
  if (options.color === false) return false;
  if (process.env.NO_COLOR || process.env.CODEX_USAGE_MONITOR_NO_COLOR || process.env.FORCE_COLOR === '0') return false;
  return Boolean(options.color);
}

function trimFixed(value, digits) {
  return Number(value).toFixed(digits).replace(/\.0$/, '');
}

function visibleLength(value) {
  return String(value).replace(/\x1b\[[0-9;]*m/g, '').length;
}

module.exports = {
  formatStatusLine,
  formatStopBox,
  formatTokens,
  formatUsd,
  progressBar,
  timeUntil,
};
