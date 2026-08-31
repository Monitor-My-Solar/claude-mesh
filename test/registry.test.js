'use strict';
/** Registry behaviour: auth, addressing, mail, rate limits, join codes. */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { test, run, assert, until } = require('./helpers.js');

const TOKEN = 'test-token-0123456789';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-test-'));
process.env.MESH_STATE = path.join(tmp, 'state.json');
process.env.MESH_USERS = path.join(tmp, 'users.json');
process.env.MESH_TOKEN = TOKEN;
process.env.MESH_ACK_TIMEOUT_MS = '1000';   // must be set before the require

const { createRegistry } = require('../src/registry.js');

let base;
const api = async (p, opts = {}, tok = TOKEN) => {
  const res = await fetch(base + p, {
    headers: { 'Content-Type': 'application/json', ...(tok ? { 'X-Mesh-Token': tok } : {}) },
    ...opts,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const register = (name, extra = {}) => api('/register', {
  method: 'POST',
  body: JSON.stringify({
    name, group: 'g1', host: 'h1', relay: 'r1',
    socket: `/tmp/cc-socks/${name}.sock`, token: 'peer-token', ...extra,
  }),
});

test('rejects a bad token', async () => {
  const r = await api('/health', {}, 'wrong');
  assert.strictEqual(r.status, 401);
});

test('accepts the shared token', async () => {
  const r = await api('/health');
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.version, 'reports a version');
});

test('registers a peer and lists it', async () => {
  await register('alpha');
  const r = await api('/peers');
  assert.ok(r.body.peers.some((p) => p.name === 'alpha'));
});

test('never exposes peer inbox tokens over /peers', async () => {
  const r = await api('/peers');
  assert.ok(r.body.peers.every((p) => p.token === undefined),
    'a peer inbox token leaked through /peers');
});

test('/routes carries socket and token for the owning relay', async () => {
  const r = await api('/routes?relay=r1');
  const row = r.body.routes.find((x) => x.name === 'alpha');
  assert.ok(row && row.socket && row.token, 'route is missing socket or token');
});

test('matches relay ids case-insensitively', async () => {
  const r = await api('/routes?relay=R1');
  assert.ok(r.body.routes.length > 0, 'MacMini and macmini must be one machine');
});

// The regression that made the whole mesh read stale: re-registering must
// refresh `seen`, or every relay ages out despite being alive and polling.
test('re-registering refreshes seen', async () => {
  const first = (await api('/peers')).body.peers.find((p) => p.name === 'alpha').seen;
  await new Promise((r) => setTimeout(r, 1100));
  await register('alpha');
  const second = (await api('/peers')).body.peers.find((p) => p.name === 'alpha').seen;
  assert.ok(second > first, `seen did not advance (${first} -> ${second})`);
});

// An old SessionStart hook registered under the bare pid when it ran before
// the session file existed, and nothing ever reconciled that with the relay's
// registration of the same session under its real name.
test('drops bare-pid orphans once the session is registered by name', async () => {
  await register('4242', { pid: 4242 });                    // orphan, no version
  await register('real-session', { pid: 4242, version: '0.1.0+abc1234' });
  const { peers } = (await api('/peers')).body;
  assert.ok(peers.some((p) => p.name === 'real-session'), 'the named session survives');
  assert.ok(!peers.some((p) => p.name === '4242'), 'the pid orphan should be pruned');
});

test('deregisters a peer', async () => {
  await register('temp');
  await api('/deregister', { method: 'POST', body: JSON.stringify({ name: 'temp' }) });
  const r = await api('/peers');
  assert.ok(!r.body.peers.some((p) => p.name === 'temp'));
});

test('resolves group/name, bare name, and rejects the unknown', async () => {
  assert.strictEqual((await api('/send', { method: 'POST',
    body: JSON.stringify({ to: 'g1/alpha', from: 'x', body: 'hi' }) })).status, 200);
  assert.strictEqual((await api('/send', { method: 'POST',
    body: JSON.stringify({ to: 'alpha', from: 'x', body: 'hi' }) })).status, 200);
  const bad = await api('/send', { method: 'POST',
    body: JSON.stringify({ to: 'nope', from: 'x', body: 'hi' }) });
  assert.strictEqual(bad.status, 404);
  assert.ok(Array.isArray(bad.body.online), 'an unknown peer should list who IS online');
});

test('banks mail and drains it to the right relay', async () => {
  await api('/send', { method: 'POST',
    body: JSON.stringify({ to: 'alpha', from: 'x', body: 'queued-message' }) });
  const r = await api('/inbox?relay=r1&wait=1');
  assert.ok(r.body.messages.some((m) => m.body === 'queued-message'));
  const again = await api('/inbox?relay=r1&wait=1');
  assert.ok(!again.body.messages.some((m) => m.body === 'queued-message'),
    'a drained message must not be delivered twice');
});

// Messages used to be deleted the moment a relay fetched them, so any failure
// after that - no route yet, a socket write error, a relay crash - lost the
// message silently.
test('an unacked message is handed out again', async () => {
  await register('acktest');
  await api('/send', { method: 'POST',
    body: JSON.stringify({ to: 'acktest', from: 'x', body: 'must-not-be-lost' }) });

  const first = await api('/inbox?relay=r1&wait=1');
  assert.ok(first.body.messages.some((m) => m.body === 'must-not-be-lost'));

  // Do not ack, wait out the timeout, and it should come back.
  await new Promise((r) => setTimeout(r, 1400));
  const again = await api('/inbox?relay=r1&wait=2');
  assert.ok(again.body.messages.some((m) => m.body === 'must-not-be-lost'),
    'an unacked message must be redelivered');
});

test('an acked message is not handed out again', async () => {
  await register('acktest2');
  await api('/send', { method: 'POST',
    body: JSON.stringify({ to: 'acktest2', from: 'x', body: 'deliver-once' }) });
  const got = await api('/inbox?relay=r1&wait=1');
  const msg = got.body.messages.find((m) => m.body === 'deliver-once');
  assert.ok(msg, 'the message should be handed out');

  await api('/ack', { method: 'POST', body: JSON.stringify({ ids: [msg.id] }) });
  await new Promise((r) => setTimeout(r, 1400));
  const again = await api('/inbox?relay=r1&wait=1');
  assert.ok(!again.body.messages.some((m) => m.id === msg.id),
    'an acked message must not be redelivered');
});

test('an explicit failure is requeued immediately', async () => {
  await register('acktest3');
  await api('/send', { method: 'POST',
    body: JSON.stringify({ to: 'acktest3', from: 'x', body: 'retry-me' }) });
  const got = await api('/inbox?relay=r1&wait=1');
  const msg = got.body.messages.find((m) => m.body === 'retry-me');
  await api('/ack', { method: 'POST', body: JSON.stringify({ ids: [], failed: [msg.id] }) });
  const again = await api('/inbox?relay=r1&wait=2');
  assert.ok(again.body.messages.some((m) => m.id === msg.id),
    'a reported failure should be retried without waiting for the ack timeout');
});

test('rate-limits a sender to one peer', async () => {
  let limited = 0;
  for (let i = 0; i < 14; i++) {
    const r = await api('/send', { method: 'POST',
      body: JSON.stringify({ to: 'alpha', from: 'flooder', body: `n${i}` }) });
    if (r.status === 429) limited++;
  }
  assert.ok(limited > 0, 'a flood of messages was not rate limited');
});

test('correlates a reply to its request via /await', async () => {
  const sent = await api('/send', { method: 'POST',
    body: JSON.stringify({ to: 'alpha', from: 'asker', body: 'question?' }) });
  const id = sent.body.id;
  const waiter = api(`/await?id=${id}&wait=5`);
  await api('/send', { method: 'POST',
    body: JSON.stringify({ to: 'alpha', from: 'answerer', re: id, body: 'the answer' }) });
  const got = await waiter;
  assert.strictEqual(got.body.reply.body, 'the answer');
});

test('join codes are single-use and need no prior credential', async () => {
  const mint = await api('/join/new', { method: 'POST', body: JSON.stringify({ ttl: 60 }) });
  const code = mint.body.code;
  const redeem = await api('/join/redeem', { method: 'POST', body: JSON.stringify({ code }) }, null);
  assert.strictEqual(redeem.body.token, TOKEN, 'redeeming should yield the shared token');
  const again = await api('/join/redeem', { method: 'POST', body: JSON.stringify({ code }) }, null);
  assert.strictEqual(again.status, 404, 'a join code must not work twice');
});

test('first run redirects to setup, and the API stays closed', async () => {
  const res = await fetch(base + '/', { redirect: 'manual' });
  assert.strictEqual(res.status, 302);
  assert.ok(String(res.headers.get('location')).includes('setup'));
  const anon = await fetch(base + '/peers');
  assert.strictEqual(anon.status, 401, 'the API must not be open to anonymous browsers');
});

(async () => {
  const server = createRegistry().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const failed = await run('registry');
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})();
