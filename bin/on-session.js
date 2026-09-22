#!/usr/bin/env node
'use strict';

const { ingestHook } = require('../lib/database');

main().catch(finish);

async function main() {
  const input = await readStdin();
  let hook = {};
  try { hook = input ? JSON.parse(input) : {}; } catch {}
  try { await ingestHook(hook); } catch {}
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
    process.stdin.on('end', () => { clearTimeout(timer); resolve(data); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(data); });
  });
}
