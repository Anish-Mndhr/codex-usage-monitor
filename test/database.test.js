'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { getSession, openDatabase, querySessions, queryTotals, syncSessions } = require('../lib/database');

const fixture = path.join(__dirname, 'fixtures', 'session-basic.jsonl');

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
    assert.equal(queryTotals(db)[0].sessions, 1);
  } finally { db.close(); }
});
