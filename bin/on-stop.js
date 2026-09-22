#!/usr/bin/env node
'use strict';

const { formatStopBox } = require('../lib/format');
const { ingestHook } = require('../lib/database');
const { recordHookSummaryShown, shouldShowHookSummary } = require('../lib/hook-state');
const { defaultCodexHome, findLatestSessionFile, summarizeSessionFile } = require('../lib/session');
const { writeHumanOutput } = require('../lib/terminal-output');

main().catch(() => {
  finish();
});

async function main() {
  const input = await readStdin();
  let hook = {};
  try {
    hook = input ? JSON.parse(input) : {};
  } catch {
    hook = {};
  }

  const transcriptPath = hook.transcript_path
    || hook.transcriptPath
    || (hook.payload && (hook.payload.transcript_path || hook.payload.transcriptPath))
    || findLatestSessionFile(defaultCodexHome());

  let ingestedSummary = null;
  try { ingestedSummary = await ingestHook({ ...hook, transcript_path: transcriptPath }); } catch {}

  if (transcriptPath && shouldShowHookSummary()) {
    const summary = ingestedSummary || await summarizeSessionFile(transcriptPath);
    if (summary) {
      if (hook.model && !summary.model) summary.model = hook.model;
      const box = formatStopBox(summary, {
        ascii: Boolean(process.env.CODEX_USAGE_MONITOR_ASCII),
        color: !(process.env.NO_COLOR || process.env.CODEX_USAGE_MONITOR_NO_COLOR || process.env.FORCE_COLOR === '0'),
      });
      if (box) {
        writeHumanOutput(`${box}\n`);
        recordHookSummaryShown();
      }
    }
  }

  finish();
}

function finish() {
  process.stdout.write(JSON.stringify({ continue: true }));
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    const timer = setTimeout(() => resolve(data), 1500).unref();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(data);
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}
