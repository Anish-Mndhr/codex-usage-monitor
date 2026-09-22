# Stop Hook And Watch Usage Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a colored Codex usage box after completed turns, support optional local throttling, keep `watch` as the live long-running monitor, and document that neither path consumes model quota.

**Architecture:** Keep runtime local-only and zero-dependency. Add a focused hook-state module for quiet/throttle decisions, wire it into `bin/on-stop.js`, and keep all rendering in the existing formatter.

**Tech Stack:** Node.js built-ins, CommonJS, `node:test`, Codex plugin hooks.

---

## File Structure

- Create `lib/hook-state.js`: quiet/throttle parsing, cross-platform state file path, last-display read/write.
- Create `test/hook-state.test.js`: unit tests for quiet mode, interval parsing, corrupt state, and write failures.
- Modify `bin/on-stop.js`: use `lib/hook-state.js` before rendering and record successful display time.
- Modify `test/cli.test.js`: subprocess tests for quiet and throttled Stop hook behavior.
- Modify `README.md`: explain post-turn display, `watch`, throttle env var, quota impact, and cross-platform examples.

---

### Task 1: Add Hook State Helper

**Files:**
- Create: `lib/hook-state.js`
- Create: `test/hook-state.test.js`

- [ ] **Step 1: Write the failing unit tests**

Add `test/hook-state.test.js`:

```js
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
```

- [ ] **Step 2: Run the new tests and confirm they fail**

Run:

```bash
node --test test/hook-state.test.js
```

Expected: FAIL with `Cannot find module '../lib/hook-state'`.

- [ ] **Step 3: Implement the hook-state module**

Add `lib/hook-state.js`:

```js
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { defaultCodexHome } = require('./session');

const STATE_FILE = 'codex-usage-monitor-state.json';

function shouldShowHookSummary(options = {}) {
  const env = options.env || process.env;
  if (isQuiet(env)) return false;

  const intervalSeconds = positiveNumber(env.CODEX_USAGE_MONITOR_HOOK_INTERVAL_SECONDS);
  if (!intervalSeconds) return true;

  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const state = readHookState(options.codexHome || defaultCodexHome());
  const lastMs = Number(state.lastHookDisplayAt);
  if (!Number.isFinite(lastMs) || lastMs <= 0) return true;

  return nowMs - lastMs >= intervalSeconds * 1000;
}

function recordHookSummaryShown(options = {}) {
  const codexHome = options.codexHome || defaultCodexHome();
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  try {
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(hookStatePath(codexHome), `${JSON.stringify({ lastHookDisplayAt: nowMs })}\n`, 'utf8');
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

module.exports = {
  hookStatePath,
  recordHookSummaryShown,
  shouldShowHookSummary,
};
```

- [ ] **Step 4: Run the hook-state tests and confirm they pass**

Run:

```bash
node --test test/hook-state.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

```bash
git add lib/hook-state.js test/hook-state.test.js
git commit -m "feat: add hook display throttle state"
```

---

### Task 2: Wire Hook State Into Stop Hook

**Files:**
- Modify: `bin/on-stop.js`
- Modify: `test/cli.test.js`

- [ ] **Step 1: Add failing subprocess tests**

Append these tests to `test/cli.test.js`:

```js
const fs = require('node:fs');
const os = require('node:os');

function tempCodexHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-monitor-'));
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
```

- [ ] **Step 2: Run the CLI tests and confirm the interval test fails**

Run:

```bash
node --test test/cli.test.js
```

Expected: FAIL because the Stop hook does not yet consult interval state.

- [ ] **Step 3: Update the Stop hook**

Modify `bin/on-stop.js`:

```js
const { formatStopBox } = require('../lib/format');
const { recordHookSummaryShown, shouldShowHookSummary } = require('../lib/hook-state');
const { summarizeSessionFile } = require('../lib/session');
```

Replace the display block with:

```js
  if (transcriptPath && shouldShowHookSummary()) {
    const summary = await summarizeSessionFile(transcriptPath);
    if (summary) {
      if (hook.model && !summary.model) summary.model = hook.model;
      const box = formatStopBox(summary, {
        ascii: Boolean(process.env.CODEX_USAGE_MONITOR_ASCII),
        color: !(process.env.NO_COLOR || process.env.CODEX_USAGE_MONITOR_NO_COLOR || process.env.FORCE_COLOR === '0'),
      });
      if (box) {
        process.stderr.write(`${box}\n`);
        recordHookSummaryShown();
      }
    }
  }
```

Remove the now-unused `isQuiet()` function from `bin/on-stop.js`.

- [ ] **Step 4: Run the CLI tests and confirm they pass**

Run:

```bash
node --test test/cli.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add bin/on-stop.js test/cli.test.js
git commit -m "feat: throttle stop hook usage display"
```

---

### Task 3: Update Documentation And Help Text

**Files:**
- Modify: `README.md`
- Modify: `bin/codex-usage-monitor.js`

- [ ] **Step 1: Add documentation changes**

Update `README.md` to include:

```markdown
## Recommended Usage

### After Each Codex Turn

Install the plugin and restart Codex. The bundled Stop hook prints a colored
usage box after each completed turn. It does not replace the native Codex
footer.

### During Long Tasks

Run the watcher in another terminal, split pane, or tmux pane:

```bash
codex-usage-monitor watch --interval 60
```

PowerShell:

```powershell
codex-usage-monitor watch --interval 60
```

Bash, Ubuntu, macOS, or tmux:

```bash
codex-usage-monitor watch --interval 60
```

### Quota Impact

The Stop hook and watcher do not consume model quota. They read local Codex
session JSONL files, perform local formatting, and do not make network or model
calls.
```

Add this environment variable row:

```markdown
| `CODEX_USAGE_MONITOR_HOOK_INTERVAL_SECONDS=N` | Show the Stop-hook box at most once every `N` seconds. Unset means every turn. |
```

- [ ] **Step 2: Update help text**

Modify `helpText()` in `bin/codex-usage-monitor.js` so the `watch` line says:

```text
  codex-usage-monitor watch [--interval 5]  Refresh statusline every N seconds
```

Add to options:

```text
Environment:
  CODEX_USAGE_MONITOR_HOOK_INTERVAL_SECONDS=N
                   Throttle Stop-hook boxes to once every N seconds
```

- [ ] **Step 3: Run the CLI smoke commands**

Run:

```bash
npm run smoke:summary
npm run smoke:statusline
```

Expected: both commands exit 0 and show usage text.

- [ ] **Step 4: Commit Task 3**

```bash
git add README.md bin/codex-usage-monitor.js
git commit -m "docs: explain stop hook and watch usage"
```

---

### Task 4: Full Verification And Local Plugin Reinstall

**Files:**
- Modify: installed plugin cache only through Codex plugin install commands.

- [ ] **Step 1: Run the full test suite**

Run:

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 2: Run plugin validation if available**

Run:

```bash
codex plugin validate .
```

Expected: validation succeeds. If this Codex CLI version uses a different
validation command, run the available equivalent and record the exact output in
the final response.

- [ ] **Step 3: Reinstall the personal plugin**

Run:

```bash
codex plugin add codex-usage-monitor@personal --json
```

Expected: installed plugin path resolves under
`%USERPROFILE%\.codex\plugins\cache\personal\codex-usage-monitor\0.1.0` on
Windows or the equivalent `$HOME/.codex/plugins/cache/...` path on POSIX.

- [ ] **Step 4: Smoke test installed commands**

Run installed-cache commands or global bin commands:

```bash
codex-usage-monitor summary --file test/fixtures/session-basic.jsonl --ascii --no-color
codex-usage-monitor statusline --file test/fixtures/session-basic.jsonl --ascii --no-color
codex-usage-monitor doctor
```

Expected: all exit 0. Summary contains `codex-usage-monitor`; statusline
contains `GPT-5.4 mini`; doctor prints Codex home and latest session info.

- [ ] **Step 5: Smoke test installed Stop hook behavior**

Run `bin/on-stop.js` with fixture hook JSON twice using
`CODEX_USAGE_MONITOR_HOOK_INTERVAL_SECONDS=300` and a temp `CODEX_HOME`.

Expected:

- First run stdout parses as `{"continue":true}` and stderr contains
  `codex-usage-monitor`.
- Second run stdout parses as `{"continue":true}` and stderr is empty.

- [ ] **Step 6: Commit verification-related updates**

If no source files changed after Task 3, skip this commit. Otherwise:

```bash
git add <changed files>
git commit -m "test: verify stop hook monitor behavior"
```

---

## Self-Review

- Spec coverage: the plan covers Stop hook display, quiet mode, interval
  throttling, watcher documentation, local-only quota behavior, cross-platform
  state paths, and test coverage.
- Completion scan: all implementation steps are concrete and specified.
- Type consistency: planned APIs are `hookStatePath`, `shouldShowHookSummary`,
  and `recordHookSummaryShown`, and the tests and hook use those names
  consistently.
