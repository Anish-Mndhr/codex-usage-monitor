'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { getSession, openDatabase, querySessions, queryTodayUsage, queryTotals, syncSessions } = require('../lib/database');

const fixture = path.join(__dirname, 'fixtures', 'session-basic.jsonl');

test('database migration adds daily usage storage to an existing ledger', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-db-migrate-'));
  const databasePath = path.join(root, 'usage.sqlite3');
  const { DatabaseSync } = require('node:sqlite');
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`CREATE TABLE ingestion_files (
    transcript_path TEXT PRIMARY KEY,
    session_id TEXT,
    file_size INTEGER NOT NULL,
    file_mtime_ms INTEGER NOT NULL,
    ingested_at TEXT NOT NULL
  )`);
  legacy.close();

  const db = openDatabase(databasePath);
  try {
    const columns = db.prepare('PRAGMA table_info(ingestion_files)').all();
    assert.ok(columns.some((column) => column.name === 'ingestion_version'));
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='usage_records'").get();
    assert.equal(table.name, 'usage_records');
  } finally { db.close(); }
});

test('SQLite sync is idempotent and retains session and turn records', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-db-'));
  const sessionDir = path.join(root, 'sessions', '2026', '06', '30');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.copyFileSync(fixture, path.join(sessionDir, 'rollout-test.jsonl'));
  const databasePath = path.join(root, 'usage-monitor', 'usage.sqlite3');

  assert.deepEqual(await syncSessions({ codexHome: root, databasePath }), {
    discovered: 1, imported: 1, skipped: 0, failed: 0,
  });
  assert.deepEqual(await syncSessions({ codexHome: root, databasePath }), {
    discovered: 1, imported: 0, skipped: 1, failed: 0,
  });

  const db = openDatabase(databasePath);
  try {
    const sessions = querySessions(db);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].input_tokens, 2200);
    const record = getSession(db, 'sess_basic');
    assert.equal(record.turns.length, 2);
    assert.equal(record.models.length, 2);
    assert.equal(getSession(db, 'sess_ba').session_id, 'sess_basic');
    assert.equal(queryTotals(db)[0].sessions, 1);

    const sessionDay = queryTodayUsage(db, {
      now: new Date('2026-06-30T12:00:00Z'),
      sessionId: 'sess_basic',
    });
    assert.equal(sessionDay.usage.inputTokens, 2200);
    assert.equal(sessionDay.usage.outputTokens, 300);
    assert.equal(sessionDay.turnCount, 2);
    assert.ok(sessionDay.cost.usd > 0);

    db.prepare(`INSERT INTO sessions (session_id, status, ingested_at)
      VALUES ('second_session', 'active', '2026-06-30T12:00:00Z')`).run();
    db.prepare(`INSERT INTO sessions (session_id, status, ingested_at)
      VALUES ('sess_beta', 'active', '2026-06-30T12:00:00Z')`).run();
    assert.throws(() => getSession(db, 'sess_b'), /ambiguous session id prefix/);
    db.prepare(`INSERT INTO usage_records
      (session_id, record_id, occurred_at, turn_id, model, input_tokens, output_tokens,
       total_tokens, cost_usd, cost_status)
      VALUES ('second_session', 'exact:1', '2026-06-30T13:00:00Z', 'turn-1',
       'gpt-5.6-sol', 500, 50, 550, 0.01, 'estimated')`).run();
    db.prepare(`INSERT INTO usage_records
      (session_id, record_id, occurred_at, turn_id, model, input_tokens, output_tokens,
       total_tokens, cost_usd, cost_status)
      VALUES ('sess_basic', 'historical', '2026-06-28T13:00:00Z', 'old-turn',
       'gpt-5.5', 9000, 900, 9900, 1.00, 'estimated')`).run();

    const allDay = queryTodayUsage(db, { now: new Date('2026-06-30T12:00:00Z') });
    assert.equal(allDay.sessionCount, 2);
    assert.equal(allDay.turnCount, 3);
    assert.equal(allDay.usage.inputTokens, 2700);
    assert.ok(allDay.cost.usd > sessionDay.cost.usd);
    assert.ok(allDay.cost.usd < 1);
  } finally { db.close(); }
});

test('pricing update reimports unchanged GPT-6.1 Sol history once without duplicating records', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-reprice-'));
  const sessionDir = path.join(root, 'sessions');
  fs.mkdirSync(sessionDir);
  const file = path.join(sessionDir, 'sol.jsonl');
  fs.writeFileSync(file, [
    { type: 'session_meta', payload: { id: 'sol-history' } },
    { type: 'turn_context', payload: { turn_id: 'turn-1', model: 'gpt-6.1-sol' } },
    { timestamp: '2026-10-01T00:00:00Z', type: 'token_usage_record', payload: {
      session_id: 'sol-history', turn_id: 'turn-1',
      usage: { input_tokens: 1000, output_tokens: 100 },
    } },
  ].map(JSON.stringify).join('\n'));
  const databasePath = path.join(root, 'usage.sqlite3');
  await syncSessions({ codexHome: root, databasePath });
  const db = openDatabase(databasePath);
  try {
    db.exec("UPDATE ingestion_files SET ingestion_version = 2;");
    db.exec("UPDATE sessions SET cost_usd = 0, cost_status = 'partial';");
    db.exec("INSERT INTO sessions (session_id, status, ingested_at) VALUES ('retained', 'archived', '2026-09-01');");
    assert.equal((await syncSessions({ codexHome: root, db })).imported, 1);
    assert.equal((await syncSessions({ codexHome: root, db })).skipped, 1);
    const record = getSession(db, 'sol-history');
    assert.equal(record.cost_usd, 0.003);
    assert.equal(record.cost_status, 'estimated');
    assert.equal(record.turns.length, 1);
    assert.equal(record.models.length, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM usage_records').get().n, 1);
    assert.ok(getSession(db, 'retained'));
    const today = queryTodayUsage(db, { now: new Date('2026-10-01T12:00:00Z') });
    assert.equal(today.cost.usd, 0.003);
    assert.equal(today.cost.complete, true);
  } finally { db.close(); }
});
