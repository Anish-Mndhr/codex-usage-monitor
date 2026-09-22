'use strict';

const fs = require('node:fs');

function writeHumanOutput(text, options = {}) {
  const stderr = options.stderr || process.stderr;
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const fileSystem = options.fs || fs;

  stderr.write(text);

  if (!shouldWriteDirect(env, stderr)) return;

  try {
    if (platform === 'win32') {
      writeWindowsConsole(fileSystem, text);
    } else {
      fileSystem.appendFileSync('/dev/tty', text);
    }
  } catch {
    // Hook output is best-effort; never fail Codex because the terminal device is unavailable.
  }
}

function writeWindowsConsole(fileSystem, text) {
  const fd = fileSystem.openSync('\\\\.\\CONOUT$', 'w');
  try {
    fileSystem.writeSync(fd, text);
  } finally {
    fileSystem.closeSync(fd);
  }
}

function shouldWriteDirect(env, stderr) {
  if (env.CODEX_USAGE_MONITOR_DIRECT_TTY === '0'
    || env.CODEX_USAGE_MONITOR_DIRECT_TTY === 'false') {
    return false;
  }
  return !stderr.isTTY;
}

module.exports = {
  writeHumanOutput,
};
