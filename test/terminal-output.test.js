'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { writeHumanOutput } = require('../lib/terminal-output');

test('writeHumanOutput writes stderr and direct terminal when stderr is captured on Windows', () => {
  const writes = [];
  const fakeFs = {
    openSync(file, flags) {
      writes.push({ file, flags });
      return 42;
    },
    writeSync(fd, text) {
      writes.push({ fd, text });
    },
    closeSync(fd) {
      writes.push({ fd, close: true });
    },
  };
  let stderrText = '';

  writeHumanOutput('usage box\n', {
    env: {},
    fs: fakeFs,
    platform: 'win32',
    stderr: {
      isTTY: false,
      write(text) { stderrText += text; },
    },
  });

  assert.equal(stderrText, 'usage box\n');
  assert.deepEqual(writes, [
    { file: '\\\\.\\CONOUT$', flags: 'w' },
    { fd: 42, text: 'usage box\n' },
    { fd: 42, close: true },
  ]);
});

test('writeHumanOutput writes /dev/tty on POSIX when stderr is captured', () => {
  const writes = [];
  const fakeFs = {
    openSync() {
      throw new Error('should not open windows device');
    },
    appendFileSync(file, text) {
      writes.push({ file, text });
    },
  };

  writeHumanOutput('usage box\n', {
    env: {},
    fs: fakeFs,
    platform: 'linux',
    stderr: {
      isTTY: false,
      write() {},
    },
  });

  assert.deepEqual(writes, [{ file: '/dev/tty', text: 'usage box\n' }]);
});

test('writeHumanOutput skips direct terminal when stderr is already a TTY or disabled', () => {
  const writes = [];
  const fakeFs = {
    openSync(file, flags) {
      writes.push({ file, flags });
      return 42;
    },
    writeSync(fd, text) {
      writes.push({ fd, text });
    },
    closeSync(fd) {
      writes.push({ fd, close: true });
    },
    appendFileSync(file, text) {
      writes.push({ file, text });
    },
  };

  writeHumanOutput('tty\n', {
    env: {},
    fs: fakeFs,
    platform: 'win32',
    stderr: {
      isTTY: true,
      write() {},
    },
  });
  writeHumanOutput('disabled\n', {
    env: { CODEX_USAGE_MONITOR_DIRECT_TTY: '0' },
    fs: fakeFs,
    platform: 'linux',
    stderr: {
      isTTY: false,
      write() {},
    },
  });

  assert.deepEqual(writes, []);
});
