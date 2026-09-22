'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { defaultCodexHome, defaultConfigPath, findSessionFiles, summarizeSessionFile, zeroUsage } = require('./session');
const { loadPricingConfig, PRICING_VERSION, costForUsage } = require('./pricing');

function sqliteModule() {
  // Node 22-24 labels node:sqlite experimental. It is the only warning hidden.
  const emitWarning = process.emitWarning;
  process.emitWarning = function filteredWarning(warning, ...args) {
    if (String(warning).includes('SQLite is an experimental feature')) return;
    return emitWarning.call(process, warning, ...args);
  };
  return require('node:sqlite');
}

function defaultDatabasePath(codexHome = defaultCodexHome()) {
  return process.env.CODEX_USAGE_MONITOR_DB || path.join(codexHome, 'usage-monitor', 'usage.sqlite3');
}

function openDatabase(databasePath = defaultDatabasePath()) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const { DatabaseSync } = sqliteModule();
  const db = new DatabaseSync(databasePath);
  // Configure waiting before any pragma or migration that may need a lock.
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      transcript_path TEXT,
      cwd TEXT,
      source TEXT,
      originator TEXT,
      cli_version TEXT,
      started_at TEXT,
      updated_at TEXT,
      ended_at TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      last_event TEXT,
      model TEXT,
      reasoning_effort TEXT,
      plan_type TEXT,
      context_window INTEGER,
      turn_count INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      cached_input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL,
      cost_status TEXT NOT NULL DEFAULT 'unknown',
      pricing_source TEXT,
      parse_failures INTEGER NOT NULL DEFAULT 0,
      ingested_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS turns (
      session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      turn_id TEXT NOT NULL,
      updated_at TEXT,
      model TEXT,
      reasoning_effort TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      cached_input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL,
      PRIMARY KEY (session_id, turn_id)
    );
    CREATE TABLE IF NOT EXISTS session_models (
      session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      cached_input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL,
      pricing_source TEXT,
      PRIMARY KEY (session_id, model)
    );
    CREATE TABLE IF NOT EXISTS ingestion_files (
      transcript_path TEXT PRIMARY KEY,
      session_id TEXT,
      file_size INTEGER NOT NULL,
      file_mtime_ms INTEGER NOT NULL,
      ingested_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_updated_idx ON sessions(updated_at);
    CREATE INDEX IF NOT EXISTS sessions_cwd_idx ON sessions(cwd);
    CREATE INDEX IF NOT EXISTS turns_model_idx ON turns(model);
    PRAGMA user_version = 1;
  `);
}

async function syncSessions(options = {}) {
  const codexHome = options.codexHome || defaultCodexHome();
  const db = options.db || openDatabase(options.databasePath || defaultDatabasePath(codexHome));
  const ownsDb = !options.db;
  const files = options.file ? [options.file] : findSessionFiles(codexHome);
  const result = { discovered: files.length, imported: 0, skipped: 0, failed: 0 };
  try {
    for (const file of files) {
      let stat;
      try { stat = fs.statSync(file); } catch { result.failed++; continue; }
      const previous = db.prepare('SELECT file_size, file_mtime_ms FROM ingestion_files WHERE transcript_path = ?').get(file);
      if (!options.all && previous && previous.file_size === stat.size
        && previous.file_mtime_ms === Math.floor(stat.mtimeMs)) {
        result.skipped++;
        continue;
      }
      const summary = await summarizeSessionFile(file, {
        configPath: options.configPath || defaultConfigPath(codexHome),
      });
      if (!summary) { result.failed++; continue; }
      const status = options.status || (file.includes(`${path.sep}archived_sessions${path.sep}`) ? 'archived' : 'active');
      saveSummary(db, summary, { status, event: options.event || 'sync' });
      result.imported++;
    }
    return result;
  } finally {
    if (ownsDb) db.close();
  }
}

function saveHookStub(db, hook, options = {}) {
  const sessionId = hook.session_id || hook.sessionId;
  if (!sessionId) return false;
  const now = new Date().toISOString();
  const status = options.status || hookStatus(hook.hook_event_name);
  db.prepare(`
    INSERT INTO sessions (session_id, transcript_path, cwd, started_at, updated_at, ended_at,
      status, last_event, model, input_tokens, cached_input_tokens, cache_write_input_tokens,
      output_tokens, reasoning_output_tokens, total_tokens, cost_status, ingested_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0, 'unknown', ?)
    ON CONFLICT(session_id) DO UPDATE SET
      transcript_path = COALESCE(excluded.transcript_path, sessions.transcript_path),
      cwd = COALESCE(excluded.cwd, sessions.cwd),
      updated_at = excluded.updated_at,
      ended_at = COALESCE(excluded.ended_at, sessions.ended_at),
      status = CASE WHEN sessions.status = 'ended' THEN sessions.status ELSE excluded.status END,
      last_event = excluded.last_event,
      model = COALESCE(excluded.model, sessions.model),
      ingested_at = excluded.ingested_at
  `).run(sessionId, hook.transcript_path || hook.transcriptPath || null, hook.cwd || null,
    now, now, status === 'ended' ? now : null, status, hook.hook_event_name || options.event || 'hook',
    hook.model || null, now);
  return true;
}

function saveSummary(db, summary, options = {}) {
  if (!summary || !summary.sessionId) return false;
  const usage = summary.totalUsage || zeroUsage();
  const now = new Date().toISOString();
  const status = options.status || 'active';
  const endedAt = status === 'ended' ? now : null;
  const costStatus = summary.cost ? (summary.cost.complete ? 'estimated' : 'partial') : 'unknown';
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`
      INSERT INTO sessions (session_id, transcript_path, cwd, source, originator, cli_version,
        started_at, updated_at, ended_at, status, last_event, model, reasoning_effort, plan_type,
        context_window, turn_count, input_tokens, cached_input_tokens, cache_write_input_tokens,
        output_tokens, reasoning_output_tokens, total_tokens, cost_usd, cost_status, pricing_source,
        parse_failures, ingested_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        transcript_path=excluded.transcript_path, cwd=COALESCE(excluded.cwd,sessions.cwd),
        source=COALESCE(excluded.source,sessions.source), originator=COALESCE(excluded.originator,sessions.originator),
        cli_version=COALESCE(excluded.cli_version,sessions.cli_version),
        started_at=CASE WHEN sessions.started_at IS NULL OR excluded.started_at < sessions.started_at
          THEN excluded.started_at ELSE sessions.started_at END,
        updated_at=excluded.updated_at, ended_at=COALESCE(excluded.ended_at,sessions.ended_at),
        status=CASE WHEN sessions.status='ended' AND excluded.status='active' THEN sessions.status ELSE excluded.status END,
        last_event=excluded.last_event, model=excluded.model, reasoning_effort=excluded.reasoning_effort,
        plan_type=excluded.plan_type, context_window=excluded.context_window, turn_count=excluded.turn_count,
        input_tokens=excluded.input_tokens, cached_input_tokens=excluded.cached_input_tokens,
        cache_write_input_tokens=excluded.cache_write_input_tokens, output_tokens=excluded.output_tokens,
        reasoning_output_tokens=excluded.reasoning_output_tokens, total_tokens=excluded.total_tokens,
        cost_usd=excluded.cost_usd, cost_status=excluded.cost_status, pricing_source=excluded.pricing_source,
        parse_failures=excluded.parse_failures, ingested_at=excluded.ingested_at
    `).run(summary.sessionId, summary.transcriptPath, summary.cwd, summary.source, summary.originator,
      summary.cliVersion, iso(summary.startedAt), iso(summary.latestAt) || now, endedAt, status,
      options.event || 'sync', summary.model, summary.reasoningEffort, summary.planType,
      summary.contextWindow, summary.turnCount, usage.inputTokens, usage.cachedInputTokens,
      usage.cacheWriteInputTokens, usage.outputTokens, usage.reasoningOutputTokens, usage.totalTokens,
      summary.cost?.usd ?? null, costStatus, summary.cost?.source || PRICING_VERSION,
      summary.parseFailures, now);

    db.prepare('DELETE FROM turns WHERE session_id = ?').run(summary.sessionId);
    const insertTurn = db.prepare(`INSERT INTO turns VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const turn of summary.turns || []) {
      const item = turn.usage || zeroUsage();
      insertTurn.run(summary.sessionId, turn.turnId, iso(turn.updatedAt), turn.model,
        turn.reasoningEffort, item.inputTokens, item.cachedInputTokens, item.cacheWriteInputTokens,
        item.outputTokens, item.reasoningOutputTokens, item.totalTokens, turn.costUsd);
    }

    db.prepare('DELETE FROM session_models WHERE session_id = ?').run(summary.sessionId);
    const insertModel = db.prepare(`INSERT INTO session_models VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const costByModel = new Map((summary.cost?.perModel || []).map((item) => [item.modelId, item]));
    for (const [model, item] of Object.entries(summary.models || {})) {
      const modelCost = costByModel.get(model);
      insertModel.run(summary.sessionId, model, item.inputTokens, item.cachedInputTokens,
        item.cacheWriteInputTokens, item.outputTokens, item.reasoningOutputTokens, item.totalTokens,
        modelCost?.usd ?? null, modelCost?.source || 'unknown');
    }
    db.prepare(`INSERT INTO ingestion_files VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(transcript_path) DO UPDATE SET session_id=excluded.session_id,
      file_size=excluded.file_size, file_mtime_ms=excluded.file_mtime_ms, ingested_at=excluded.ingested_at`)
      .run(summary.transcriptPath, summary.sessionId, summary.fileSize, summary.fileMtimeMs, now);
    db.exec('COMMIT');
    return true;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

async function ingestHook(hook, options = {}) {
  const codexHome = options.codexHome || defaultCodexHome();
  const db = openDatabase(options.databasePath || defaultDatabasePath(codexHome));
  try {
    const event = hook.hook_event_name || options.event || 'hook';
    const transcriptPath = hook.transcript_path || hook.transcriptPath;
    if (transcriptPath) {
      const summary = await summarizeSessionFile(transcriptPath, { configPath: defaultConfigPath(codexHome) });
      if (summary) {
        saveSummary(db, summary, { status: hookStatus(event), event });
        return summary;
      }
    }
    saveHookStub(db, hook, { status: hookStatus(event), event });
    return null;
  } finally { db.close(); }
}

function querySessions(db, filters = {}) {
  const { clause, params } = filterSql(filters);
  const limit = Math.max(1, Math.min(10_000, Number(filters.limit) || 50));
  return db.prepare(`SELECT * FROM sessions ${clause} ORDER BY updated_at DESC LIMIT ?`).all(...params, limit);
}

function getSession(db, sessionId) {
  const session = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId);
  if (!session) return null;
  return {
    ...session,
    turns: db.prepare('SELECT * FROM turns WHERE session_id = ? ORDER BY updated_at').all(sessionId),
    models: db.prepare('SELECT * FROM session_models WHERE session_id = ? ORDER BY input_tokens DESC').all(sessionId),
  };
}

function queryTotals(db, filters = {}, groupBy = null) {
  if (groupBy === 'model') {
    const { clause, params } = filterSql(filters, 's');
    return db.prepare(`SELECT sm.model AS group_key, COUNT(DISTINCT sm.session_id) AS sessions,
      SUM(sm.input_tokens) AS input_tokens, SUM(sm.cached_input_tokens) AS cached_input_tokens,
      SUM(sm.cache_write_input_tokens) AS cache_write_input_tokens, SUM(sm.output_tokens) AS output_tokens,
      SUM(sm.total_tokens) AS total_tokens, SUM(sm.cost_usd) AS cost_usd
      FROM session_models sm JOIN sessions s ON s.session_id=sm.session_id ${clause}
      GROUP BY sm.model ORDER BY cost_usd DESC`).all(...params);
  }
  const expression = groupBy === 'day' ? "substr(updated_at,1,10)" : groupBy === 'project' ? "COALESCE(cwd,'unknown')" : "'all'";
  const { clause, params } = filterSql(filters);
  return db.prepare(`SELECT ${expression} AS group_key, COUNT(*) AS sessions, SUM(turn_count) AS turns,
    SUM(input_tokens) AS input_tokens, SUM(cached_input_tokens) AS cached_input_tokens,
    SUM(cache_write_input_tokens) AS cache_write_input_tokens, SUM(output_tokens) AS output_tokens,
    SUM(reasoning_output_tokens) AS reasoning_output_tokens, SUM(total_tokens) AS total_tokens,
    SUM(cost_usd) AS cost_usd,
    SUM(CASE WHEN cost_status!='estimated' THEN 1 ELSE 0 END) AS incomplete_cost_sessions
    FROM sessions ${clause} GROUP BY ${expression} ORDER BY group_key DESC`).all(...params);
}

function filterSql(filters, alias = '') {
  const prefix = alias ? `${alias}.` : '';
  const where = [];
  const params = [];
  if (filters.since) { where.push(`${prefix}updated_at >= ?`); params.push(normalizeDate(filters.since, false)); }
  if (filters.until) { where.push(`${prefix}updated_at <= ?`); params.push(normalizeDate(filters.until, true)); }
  if (filters.project) { where.push(`${prefix}cwd LIKE ?`); params.push(`%${filters.project}%`); }
  if (filters.model) {
    where.push(`EXISTS (SELECT 1 FROM session_models fm WHERE fm.session_id=${prefix}session_id AND fm.model LIKE ?)`);
    params.push(`%${filters.model}%`);
  }
  return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

function hookStatus(event) { return event === 'SessionEnd' ? 'ended' : 'active'; }
function iso(value) { return value instanceof Date ? value.toISOString() : value || null; }
function normalizeDate(value, end) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T${end ? '23:59:59.999' : '00:00:00.000'}Z`;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : value;
}

module.exports = {
  defaultDatabasePath,
  getSession,
  ingestHook,
  openDatabase,
  querySessions,
  queryTotals,
  saveHookStub,
  saveSummary,
  syncSessions,
};
