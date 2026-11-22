'use strict';
/** Doc pub/sub: who is told, when, and the guards against noise and loops. */
process.env.MESH_DOC_NOTIFY_MS = '20';
process.env.MESH_DOC_NOTIFY_MAX_MS = '300';
const { test, run, assert } = require('./helpers.js');
const { createDocSubs } = require('../src/docsub.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function world() {
  const peers = new Map([
    ['web', { name: 'web', group: 'srv', role: { role: 'x-web' } }],
    ['app', { name: 'app', group: 'mac', role: { role: 'x-app' } }],
    ['ops', { name: 'ops', group: 'srv' }],
  ]);
  const resolve = (a) => {
    const n = String(a).split('/').pop();
    if (peers.has(n)) return n;
    return [...peers.values()].find((p) => p.role?.role === n)?.name || null;
  };
  const out = [];
  const ds = createDocSubs({ peers, resolve, enqueue: (m) => out.push(m), persist: () => {} });
  return { peers, ds, out };
}

test('a no-op write and an edit reverted within the window send nothing', async () => {
  const { ds, out } = world();
  ds.subscribe('d', 'role:x-app');
  ds.changed('d', { prev: 'a\n', body: 'a\n', version: 2, by: 'srv/web' });
  await sleep(60);
  ds.changed('d', { prev: 'a\n', body: 'b\n', version: 3, by: 'srv/web' });
  ds.changed('d', { prev: 'b\n', body: 'a\n', version: 4, by: 'srv/web' });
  await sleep(60);
  assert.strictEqual(out.length, 0, JSON.stringify(out));
});

test('notices are capped in size, long lines truncated', async () => {
  const { ds, out } = world();
  ds.subscribe('d', 'role:x-app');
  const huge = Array.from({ length: 60 }, (_, i) => `${i}:` + 'x'.repeat(100_000)).join('\n');
  ds.changed('d', { prev: '', body: huge, version: 2, by: 'srv/web' });
  await sleep(60);
  assert.strictEqual(out.length, 1);
  assert.ok(out[0].body.length <= 16_384, `notice is ${out[0].body.length} chars`);
  assert.ok(out[0].body.includes('more lines of changes') || out[0].body.includes('truncated'));
});

test('two agents reacting to each other are slowed down, and nothing is lost', async () => {
  const { ds, out } = world();
  ds.subscribe('d', 'role:x-app');
  for (let i = 1; i <= 5; i++) {
    ds.changed('d', { prev: `v${i}\n`, body: `v${i + 1}\n`, version: i + 1, by: 'srv/web' });
    await sleep(40);
  }
  // The first 3 go out promptly; the 4th and 5th are held and merged into one.
  assert.strictEqual(out.length, 3, `expected 3 prompt notices, got ${out.length}`);
  await sleep(400);
  assert.strictEqual(out.length, 4);
  assert.ok(out[3].body.includes('- v4') && out[3].body.includes('+ v6') && out[3].body.includes('batched'), out[3].body);
});

test('the notice tells the agent not to acknowledge by editing', async () => {
  const { ds, out } = world();
  ds.subscribe('d', 'session:ops');
  ds.changed('d', { prev: 'a', body: 'b', version: 2, by: 'srv/web' });
  await sleep(60);
  assert.ok(out[0].body.includes('Do not edit the doc just to acknowledge'));
});

test('explicit unsub survives later auto-subscribes; explicit sub undoes it', () => {
  const { ds } = world();
  assert.strictEqual(ds.subscribe('d', 'role:x-app', { auto: true }), true);
  assert.strictEqual(ds.unsubscribe('d', 'role:x-app'), true);
  assert.strictEqual(ds.subscribe('d', 'role:x-app', { auto: true }), 'opted-out');
  assert.strictEqual(ds.subscribe('d', 'role:x-app'), true);
});

test('removing a doc tells subscribers and drops its subscriptions', async () => {
  const { ds, out } = world();
  ds.subscribe('gone', 'role:x-app');
  ds.changed('gone', { prev: 'a', body: '', version: 3, by: 'srv/web', removed: true });
  await sleep(60);
  assert.ok(out[0].body.startsWith('SHARED DOC REMOVED: gone'), out[0].body);
  assert.strictEqual(ds.subscribersOf('gone').size, 0);
});

test('session-keyed subscriptions expire after their session is long gone', () => {
  const { ds, peers } = world();
  ds.subscribe('d', 'session:ops');
  peers.delete('ops');
  const realNow = Date.now;
  try {
    ds.prune();                                         // first sighting of the absence
    Date.now = () => realNow() + 8 * 86_400_000;
    ds.prune();
  } finally { Date.now = realNow; }
  assert.strictEqual(ds.subscribersOf('d').size, 0);
});

(async () => process.exit(await run('doc pub/sub') ? 1 : 0))();
