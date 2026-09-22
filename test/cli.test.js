'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const fixture = path.join(__dirname, 'fixtures', 'session-basic.jsonl');
const cli = path.join(__dirname, '..', 'bin', 'codex-usage-monitor.js');
const stop = path.join(__dirname, '..', 'bin', 'on-stop.js');
const work = path.join(__dirname, '..', 'bin', 'on-work.js');

function tempCodexHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-monitor-'));
}

function seedLatestSession(codexHome) {
  const sessionDir = path.join(codexHome, 'sessions', '2026', '06', '30');
  fs.mkdirSync(sessionDir, { recursive: true });
  const sessionFile = path.join(sessionDir, 'rollout-test.jsonl');
  fs.copyFileSync(fixture, sessionFile);
  return sessionFile;
}

function stopInput() {
  return JSON.stringify({
    hook_event_name: 'Stop',
    session_id: 'sess_basic',
    transcript_path: fixture,
    cwd: 'E:\\Project\\demo',
    model: 'gpt-5.4-mini',
    turn_id: 'turn_two',
  });
}

test('statusline command prints a compact one-line summary', () => {
  const result = spawnSync(process.execPath, [cli, 'statusline', '--file', fixture, '--ascii', '--no-color'], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout.trim(), /GPT-5\.4 mini/);
  assert.match(result.stdout.trim(), /API≈\$0\.0080/);
});

test('default summary adds separate session-today and all-today usage rows', () => {
  const codexHome = tempCodexHome();
  seedLatestSession(codexHome);
  const result = spawnSync(process.execPath, [cli, '--codex-home', codexHome, '--ascii', '--no-color'], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Session today/);
  assert.match(result.stdout, /All today/);
  assert.match(result.stdout, /Cost\s+API≈/);
});

test('json command emits machine-readable usage summary', () => {
  const result = spawnSync(process.execPath, [cli, 'json', '--file', fixture], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.sessionId, 'sess_basic');
  assert.equal(payload.model, 'gpt-5.4-mini');
  assert.equal(payload.totalUsage.totalTokens, 2500);
  assert.equal(Object.hasOwn(payload, 'usageRecords'), false);
});

test('help command documents watch interval and hook throttle', () => {
  const result = spawnSync(process.execPath, [cli, 'help'], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /watch \[--interval 5\].*Refresh statusline every N seconds/);
  assert.match(result.stdout, /CODEX_USAGE_MONITOR_HOOK_INTERVAL_SECONDS=N/);
  assert.match(result.stdout, /CODEX_USAGE_MONITOR_WORK_INTERVAL_SECONDS=N/);
  assert.match(result.stdout, /CODEX_USAGE_MONITOR_DIRECT_TTY=0/);
});

test('Stop hook writes JSON to stdout and human summary to stderr', () => {
  const result = spawnSync(process.execPath, [stop], {
    input: stopInput(),
    encoding: 'utf8',
    env: {
      ...process.env,
      CODEX_HOME: tempCodexHome(),
      CODEX_USAGE_MONITOR_ASCII: '1',
      CODEX_USAGE_MONITOR_HOOK_INTERVAL_SECONDS: '0',
      CODEX_USAGE_MONITOR_QUIET: '0',
      NO_COLOR: '1',
    },
  });

  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), { continue: true });
  assert.match(result.stderr, /codex-usage-monitor/);
  assert.match(result.stderr, /GPT-5\.4 mini/);
});

test('Stop hook falls back to latest Codex session when transcript_path is missing', () => {
  const codexHome = tempCodexHome();
  seedLatestSession(codexHome);
  const result = spawnSync(process.execPath, [stop], {
    input: JSON.stringify({ hook_event_name: 'Stop', model: 'gpt-5.4-mini' }),
    encoding: 'utf8',
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      CODEX_USAGE_MONITOR_ASCII: '1',
      CODEX_USAGE_MONITOR_HOOK_INTERVAL_SECONDS: '0',
      NO_COLOR: '1',
    },
  });

  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), { continue: true });
  assert.match(result.stderr, /codex-usage-monitor/);
  assert.match(result.stderr, /GPT-5\.4 mini/);
});

test('Stop hook quiet mode suppresses human summary', () => {
  const result = spawnSync(process.execPath, [stop], {
    input: stopInput(),
    encoding: 'utf8',
    env: {
      ...process.env,
      CODEX_USAGE_MONITOR_QUIET: '1',
      CODEX_HOME: tempCodexHome(),
    },
  });

  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), { continue: true });
  assert.equal(result.stderr, '');
});

test('Stop hook interval suppresses repeated human summaries', () => {
  const codexHome = tempCodexHome();
  const env = {
    ...process.env,
    CODEX_USAGE_MONITOR_ASCII: '1',
    CODEX_USAGE_MONITOR_HOOK_INTERVAL_SECONDS: '300',
    NO_COLOR: '1',
    CODEX_HOME: codexHome,
  };

  const first = spawnSync(process.execPath, [stop], {
    input: stopInput(),
    encoding: 'utf8',
    env,
  });
  const second = spawnSync(process.execPath, [stop], {
    input: stopInput(),
    encoding: 'utf8',
    env,
  });

  assert.equal(first.status, 0);
  assert.match(first.stderr, /codex-usage-monitor/);
  assert.equal(second.status, 0);
  assert.deepEqual(JSON.parse(second.stdout), { continue: true });
  assert.equal(second.stderr, '');
});

test('PostToolUse work hook can show usage during long work intervals', () => {
  const codexHome = tempCodexHome();
  seedLatestSession(codexHome);
  const result = spawnSync(process.execPath, [work], {
    input: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash' }),
    encoding: 'utf8',
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      CODEX_USAGE_MONITOR_ASCII: '1',
      CODEX_USAGE_MONITOR_WORK_INTERVAL_SECONDS: '0',
      NO_COLOR: '1',
    },
  });

  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), { continue: true });
  assert.match(result.stderr, /codex-usage-monitor/);
  assert.match(result.stderr, /GPT-5\.4 mini/);
});

test('sessions and totals commands persist and query records', () => {
  const codexHome = tempCodexHome();
  seedLatestSession(codexHome);
  const sessions = spawnSync(process.execPath, [cli, 'sessions', '--codex-home', codexHome, '--format', 'json'], { encoding: 'utf8' });
  assert.equal(sessions.status, 0, sessions.stderr);
  assert.equal(JSON.parse(sessions.stdout)[0].session_id, 'sess_basic');

  const totals = spawnSync(process.execPath, [cli, 'totals', '--codex-home', codexHome, '--format', 'json'], { encoding: 'utf8' });
  assert.equal(totals.status, 0, totals.stderr);
  assert.equal(JSON.parse(totals.stdout)[0].sessions, 1);
});

test('sessions table isolates today and fits narrow terminals', () => {
  const codexHome = tempCodexHome();
  seedLatestSession(codexHome);
  const result = spawnSync(process.execPath, [cli, 'sessions', '--codex-home', codexHome], {
    encoding: 'utf8',
    env: { ...process.env, COLUMNS: '80' },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Today \(\d{4}-\d{2}-\d{2}\)/);
  assert.match(result.stdout, /\nSessions\n/);
  assert.match(result.stdout, /output/);
  assert.match(result.stdout, /cost/);
  assert.match(result.stdout, /status/);
  for (const line of result.stdout.trimEnd().split('\n')) assert.ok(line.length <= 80, line);
});

test('sessions JSON remains machine-readable without the human Today block', () => {
  const codexHome = tempCodexHome();
  seedLatestSession(codexHome);
  const result = spawnSync(process.execPath, [cli, 'sessions', '--codex-home', codexHome, '--format', 'json'], {
    encoding: 'utf8',
    env: { ...process.env, COLUMNS: '60' },
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload[0].session_id, 'sess_basic');
  assert.doesNotMatch(result.stdout, /^Today/);
});

test('show accepts an unambiguous displayed session prefix', () => {
  const codexHome = tempCodexHome();
  seedLatestSession(codexHome);
  const result = spawnSync(process.execPath, [cli, 'show', 'sess_ba', '--codex-home', codexHome, '--format', 'json'], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).session_id, 'sess_basic');
});
