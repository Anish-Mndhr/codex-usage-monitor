#!/usr/bin/env node
'use strict';

const { formatStatusLine, formatStopBox, formatTokens, formatUsd } = require('../lib/format');
const { defaultCodexHome, findLatestSessionFile, summarizeSessionFile } = require('../lib/session');
const { defaultDatabasePath, getSession, openDatabase, querySessions, queryTotals, syncSessions } = require('../lib/database');

main().catch((error) => {
  process.stderr.write(`codex-usage-monitor: ${error.message}\n`);
  process.exitCode = 1;
});

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args.command || 'summary';
  if (command === 'help' || args.flags.help) return process.stdout.write(helpText());
  if (command === 'doctor') return runDoctor(args);
  if (command === 'watch') return runWatch(args);
  if (command === 'sync') return runSync(args);
  if (['sessions', 'show', 'totals'].includes(command)) return runRecords(command, args);

  const summary = await loadSummary(args);
  const options = renderOptions(args);
  if (command === 'json') return process.stdout.write(`${JSON.stringify(summary || { error: 'no session found' }, null, 2)}\n`);
  if (command === 'statusline') return process.stdout.write(`${formatStatusLine(summary, options)}\n`);
  if (command === 'summary') return process.stdout.write(`${formatStopBox(summary, options) || 'codex usage: no session found'}\n`);
  throw new Error(`unknown command: ${command}`);
}

async function runSync(args) {
  const options = storageOptions(args);
  const result = await syncSessions({ ...options, all: Boolean(args.flags.all), file: args.flags.file });
  process.stdout.write(`${JSON.stringify({ database: options.databasePath, ...result }, null, 2)}\n`);
}

async function runRecords(command, args) {
  const options = storageOptions(args);
  if (!args.flags['no-sync']) await syncSessions(options);
  const db = openDatabase(options.databasePath);
  try {
    let rows;
    if (command === 'show') {
      const id = args.positionals[0];
      if (!id) throw new Error('show requires a session id');
      const record = getSession(db, id);
      if (!record) throw new Error(`session not found: ${id}`);
      return renderRecord(record, args.flags.format || 'table');
    }
    const filters = filterOptions(args.flags);
    rows = command === 'sessions'
      ? querySessions(db, filters)
      : queryTotals(db, filters, args.flags['group-by'] || null);
    renderRows(rows, args.flags.format || 'table');
  } finally { db.close(); }
}

async function runWatch(args) {
  const intervalMs = Math.max(1000, Number(args.flags.interval || 5) * 1000);
  const options = renderOptions(args);
  const print = async () => {
    const summary = await loadSummary(args);
    process.stdout.write(`\r${process.stdout.isTTY ? '\x1b[2K' : ''}${formatStatusLine(summary, options)}`);
  };
  await print();
  setInterval(print, intervalMs).unref();
  await new Promise(() => {});
}

async function runDoctor(args) {
  const options = storageOptions(args);
  const latest = args.flags.file || findLatestSessionFile(options.codexHome);
  process.stdout.write(`Codex home: ${options.codexHome}\nDatabase: ${options.databasePath}\n`);
  process.stdout.write(`Latest session: ${latest || 'not found'}\n`);
  if (latest) {
    const summary = await summarizeSessionFile(latest);
    process.stdout.write(`Model: ${summary ? summary.modelName : 'unreadable'}\nTurns: ${summary ? summary.turnCount : 0}\n`);
  }
  const db = openDatabase(options.databasePath);
  try {
    const row = db.prepare('SELECT COUNT(*) AS sessions, MAX(ingested_at) AS last_ingested_at FROM sessions').get();
    process.stdout.write(`Saved sessions: ${row.sessions}\nLast ingest: ${row.last_ingested_at || 'never'}\n`);
  } finally { db.close(); }
}

async function loadSummary(args) {
  const file = args.flags.file || findLatestSessionFile(args.flags['codex-home'] || defaultCodexHome());
  return summarizeSessionFile(file);
}

function storageOptions(args) {
  const codexHome = args.flags['codex-home'] || defaultCodexHome();
  return { codexHome, databasePath: args.flags.db || defaultDatabasePath(codexHome) };
}

function filterOptions(flags) {
  return { since: flags.since, until: flags.until, project: flags.project,
    model: flags.model, limit: flags.limit };
}

function renderRecord(record, format) {
  if (format === 'json') return process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
  if (format === 'csv') return renderRows([record], 'csv');
  const lines = [
    ['Session', record.session_id], ['Status', record.status], ['Project', record.cwd || 'unknown'],
    ['Updated', displayDate(record.updated_at)], ['Model', record.model || 'unknown'],
    ['Turns', record.turn_count], ['Input', formatTokens(record.input_tokens)],
    ['Cached', formatTokens(record.cached_input_tokens)], ['Cache write', formatTokens(record.cache_write_input_tokens)],
    ['Output', formatTokens(record.output_tokens)], ['Reasoning', formatTokens(record.reasoning_output_tokens)],
    ['Cost', record.cost_usd == null ? 'unknown' : `${formatUsd(record.cost_usd)} (${record.cost_status})`],
  ];
  process.stdout.write(`${lines.map(([key, value]) => `${key.padEnd(12)} ${value}`).join('\n')}\n`);
  if (record.models.length) {
    process.stdout.write('\nModels\n');
    renderTable(record.models.map(reportModelRow));
  }
  if (record.turns.length) {
    process.stdout.write('\nTurns\n');
    renderTable(record.turns.map(reportTurnRow));
  }
}

function renderRows(rows, format) {
  if (format === 'json') return process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
  if (format === 'csv') return process.stdout.write(toCsv(rows));
  renderTable(rows.map((row) => row.session_id ? reportSessionRow(row) : reportTotalRow(row)));
}

function reportSessionRow(row) {
  return { session: row.session_id, updated: displayDate(row.updated_at), project: row.cwd || '',
    model: row.model || '', turns: row.turn_count, input: row.input_tokens,
    cached: row.cached_input_tokens, output: row.output_tokens,
    cost: row.cost_usd == null ? '?' : formatUsd(row.cost_usd), status: row.status };
}

function reportTurnRow(row) {
  return { turn: row.turn_id, updated: displayDate(row.updated_at), model: row.model || '',
    input: row.input_tokens, cached: row.cached_input_tokens, output: row.output_tokens,
    cost: row.cost_usd == null ? '?' : formatUsd(row.cost_usd) };
}

function reportModelRow(row) {
  return { model: row.model, input: row.input_tokens, cached: row.cached_input_tokens,
    output: row.output_tokens, cost: row.cost_usd == null ? '?' : formatUsd(row.cost_usd) };
}

function reportTotalRow(row) {
  return { group: row.group_key, sessions: row.sessions, turns: row.turns ?? '', input: row.input_tokens,
    cached: row.cached_input_tokens, cache_write: row.cache_write_input_tokens,
    output: row.output_tokens, total: row.total_tokens,
    cost: row.cost_usd == null ? '?' : formatUsd(row.cost_usd), incomplete: row.incomplete_cost_sessions ?? '' };
}

function renderTable(rows) {
  if (!rows.length) return process.stdout.write('No records found.\n');
  const headers = Object.keys(rows[0]);
  const widths = headers.map((header) => Math.max(header.length, ...rows.map((row) => String(row[header] ?? '').length)));
  const line = (row) => headers.map((header, index) => String(row[header] ?? '').padEnd(widths[index])).join('  ').trimEnd();
  process.stdout.write(`${line(Object.fromEntries(headers.map((h) => [h, h])))}\n`);
  process.stdout.write(`${widths.map((width) => '-'.repeat(width)).join('  ')}\n`);
  for (const row of rows) process.stdout.write(`${line(row)}\n`);
}

function toCsv(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]).filter((key) => !Array.isArray(rows[0][key]));
  return `${headers.join(',')}\n${rows.map((row) => headers.map((key) => csv(row[key])).join(',')).join('\n')}\n`;
}

function csv(value) {
  const text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function displayDate(value) { return value ? new Date(value).toLocaleString() : ''; }
function renderOptions(args) { return { ascii: Boolean(args.flags.ascii || process.env.CODEX_USAGE_MONITOR_ASCII),
  color: !(args.flags['no-color'] || process.env.NO_COLOR || process.env.CODEX_USAGE_MONITOR_NO_COLOR) }; }

function parseArgs(argv) {
  const result = { command: null, flags: {}, positionals: [] };
  const commands = new Set(['summary', 'statusline', 'json', 'watch', 'doctor', 'sync', 'sessions', 'show', 'totals', 'help']);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!result.command && commands.has(arg)) { result.command = arg; continue; }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) { result.flags[arg.slice(2, eq)] = arg.slice(eq + 1); continue; }
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { result.flags[key] = next; i++; }
      else result.flags[key] = true;
    } else result.positionals.push(arg);
  }
  return result;
}

function helpText() {
  return `codex-usage-monitor

Usage:
  codex-usage-monitor summary [--file session.jsonl]
  codex-usage-monitor statusline [--file session.jsonl]
  codex-usage-monitor json [--file session.jsonl]
  codex-usage-monitor watch [--interval 5]  Refresh statusline every N seconds
  codex-usage-monitor sync [--all] [--file session.jsonl]
  codex-usage-monitor sessions [filters] [--format table|json|csv]
  codex-usage-monitor show SESSION_ID [--format table|json|csv]
  codex-usage-monitor totals [filters] [--group-by day|project|model]
  codex-usage-monitor doctor

Storage: --db PATH, --codex-home PATH, CODEX_USAGE_MONITOR_DB
Filters: --since DATE, --until DATE, --project TEXT, --model TEXT, --limit N
Output:  --format table|json|csv, --ascii, --no-color, --no-sync

Environment:
  CODEX_USAGE_MONITOR_HOOK_INTERVAL_SECONDS=N
  CODEX_USAGE_MONITOR_WORK_INTERVAL_SECONDS=N
  CODEX_USAGE_MONITOR_DIRECT_TTY=0
`;
}

module.exports = { parseArgs, toCsv };
