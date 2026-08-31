'use strict';
/** Minimal test harness: no framework, so the package stays dependency-free. */
const assert = require('assert');

const tests = [];
let only = null;

function test(name, fn) { tests.push({ name, fn }); }
test.only = (name, fn) => { only = { name, fn }; };

async function run(label) {
  const list = only ? [only] : tests;
  let pass = 0, fail = 0;
  console.log(`\n${label}`);
  for (const t of list) {
    const started = Date.now();
    try {
      await t.fn();
      console.log(`  ok    ${t.name} (${Date.now() - started}ms)`);
      pass++;
    } catch (e) {
      console.log(`  FAIL  ${t.name}`);
      console.log(`        ${e.message.split('\n')[0]}`);
      if (process.env.VERBOSE) console.log(e.stack);
      fail++;
    }
  }
  console.log(`\n  ${pass} passed, ${fail} failed`);
  return fail;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until fn() is truthy, or throw. Avoids arbitrary sleeps in tests. */
async function until(fn, { timeout = 8000, interval = 150, what = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e.message; }
    await sleep(interval);
  }
  throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)})`);
}

module.exports = { test, run, assert, sleep, until };
