#!/usr/bin/env node
'use strict';
/** Run every suite in a child process, so one crash cannot hide the rest. */
const { spawnSync } = require('child_process');
const path = require('path');

const suites = ['registry.test.js', 'peer.test.js', 'e2e.test.js'];
let failed = 0;

for (const s of suites) {
  const r = spawnSync(process.execPath, [path.join(__dirname, s)], {
    stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8',
  });
  // Registry request logging is noise here; keep the test lines.
  process.stdout.write(
    (r.stdout || '').split('\n')
      .filter((l) => !/^\d{3} (GET|POST) /.test(l))
      .join('\n'));
  if (r.status !== 0) failed++;
}

console.log(failed ? `\n${failed} suite(s) failed\n` : '\nall suites passed\n');
process.exit(failed ? 1 : 0);
