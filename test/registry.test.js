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

// A Codex route has a thread id and no socket; testing for a socket anywhere
// in the path silently discards every non-Claude session.
test('carries kind and route for non-Claude agents', async () => {
  await register('codex-one', { kind: 'codex', route: { thread: 'thread-uuid-1' }, socket: '', token: '' });
  const { routes } = (await api('/routes?relay=r1')).body;
  const row = routes.find((r) => r.name === 'codex-one');
  assert.ok(row, 'a codex session should be routable');
  assert.strictEqual(row.kind, 'codex');
  assert.strictEqual(row.route.thread, 'thread-uuid-1');

  const { peers } = (await api('/peers')).body;
  const peer = peers.find((p) => p.name === 'codex-one');
  assert.strictEqual(peer.kind, 'codex', 'peers should say what kind of agent this is');
  assert.strictEqual(peer.route, undefined, 'a route can carry credentials and must not leak');
});

test('defaults kind to claude for older relays', async () => {
  await register('legacy-one');
  const { routes } = (await api('/routes?relay=r1')).body;
  const row = routes.find((r) => r.name === 'legacy-one');
  assert.strictEqual(row.kind, 'claude');
  assert.ok(row.route.socket, 'a legacy registration should still yield a usable route');
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

test('a reply to a blocked ask goes to the waiter, not also to the inbox', async () => {
  const sent = await api('/send', { method: 'POST',
    body: JSON.stringify({ to: 'alpha', from: 'g1/beta', body: 'q?' }) });
  await register('beta');
  await api('/inbox?relay=r1&wait=1');            // drain the question
  const waiter = api(`/await?id=${sent.body.id}&wait=5`);
  await new Promise((r) => setTimeout(r, 200));   // let the await open
  const rep = await api('/send', { method: 'POST',
    body: JSON.stringify({ to: 'g1/beta', from: 'g1/alpha', re: sent.body.id, body: 'a' }) });
  assert.strictEqual(rep.body.delivered, 'waiter');
  assert.strictEqual((await waiter).body.reply.body, 'a');
  const inbox = await api('/inbox?relay=r1&wait=1');
  assert.ok(!inbox.body.messages.some((m) => m.re === sent.body.id), 'reply was delivered twice');
});

test('a reply with nobody waiting is banked for the asker session', async () => {
  const sent = await api('/send', { method: 'POST',
    body: JSON.stringify({ to: 'alpha', from: 'g1/beta', body: 'q2?' }) });
  await api('/inbox?relay=r1&wait=1');
  const rep = await api('/send', { method: 'POST',
    body: JSON.stringify({ to: 'g1/beta', from: 'g1/alpha', re: sent.body.id, body: 'late' }) });
  assert.strictEqual(rep.body.delivered, 'inbox');
  const inbox = await api('/inbox?relay=r1&wait=1');
  assert.ok(inbox.body.messages.some((m) => m.body === 'late'));
});

test('a waiting ask gets its reply even when its own address does not resolve', async () => {
  const sent = await api('/send', { method: 'POST',
    body: JSON.stringify({ to: 'alpha', from: 'nowhere/ghost', intent: 'reply-needed', body: 'q3?' }) });
  const waiter = api(`/await?id=${sent.body.id}&wait=5`);
  await new Promise((r) => setTimeout(r, 200));
  const rep = await api('/send', { method: 'POST',
    body: JSON.stringify({ to: 'nowhere/ghost', from: 'g1/alpha', re: sent.body.id, body: 'found you' }) });
  assert.strictEqual(rep.status, 200);
  assert.strictEqual((await waiter).body.reply.body, 'found you');
});

test('resolves a sender whose configured group has different case', async () => {
  await register('mixed', { group: 'MixedCase' });     // stored lowercased
  await api('/send', { method: 'POST',
    body: JSON.stringify({ to: 'alpha', from: 'MixedCase/mixed', group: 'MixedCase', body: 'hi' }) });
  const inbox = await api('/inbox?relay=r1&wait=1');
  const m = inbox.body.messages.find((x) => x.body === 'hi');
  assert.strictEqual(m.fromAddr, 'mixedcase/mixed', 'sender did not resolve, so REPLY would be dropped');
});

test('addresses a session by its declared role', async () => {
  await register('app-term-1', { role: { role: 'mms-app', owns: 'mobile app' }, status: 'busy' });
  await register('app-term-2', { role: { role: 'mms-app', owns: 'mobile app' }, status: 'idle' });
  const r = await api('/send', { method: 'POST',
    body: JSON.stringify({ to: 'mms-app', from: 'g1/alpha', body: 'which build?' }) });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.viaRole, 'mms-app');
  assert.strictEqual(r.body.to, 'g1/app-term-2', 'prefers the idle session');
  const g = await api('/send', { method: 'POST',
    body: JSON.stringify({ to: 'g1/mms-app', from: 'g1/alpha', body: 'q' }) });
  assert.strictEqual(g.status, 200, 'group/role works too');
  await api('/inbox?relay=r1&wait=1');
});

test('the message carries the recipient role for the envelope', async () => {
  await register('infra-term', { role: { role: 'infra', autonomy: 'questions' } });
  await api('/send', { method: 'POST', body: JSON.stringify({ to: 'infra', from: 'g1/alpha', body: 'rolecheck' }) });
  const m = (await api('/inbox?relay=r1&wait=1')).body.messages.find((x) => x.body === 'rolecheck');
  assert.strictEqual(m.toRole.autonomy, 'questions');
});

test('an offline role says where it lives instead of unknown peer', async () => {
  await register('lonely', { role: { role: 'mms-gone', owns: 'x' } });
  await api('/deregister', { method: 'POST', body: JSON.stringify({ name: 'lonely' }) });
  const r = await api('/send', { method: 'POST', body: JSON.stringify({ to: 'mms-gone', from: 'g1/alpha', body: 'q' }) });
  assert.strictEqual(r.status, 404);
  assert.ok(/role 'mms-gone' is known but no session/.test(r.body.error), r.body.error);
  const roles = (await api('/roles')).body.roles;
  const row = roles.find((x) => x.role === 'mms-gone');
  assert.ok(row && row.online.length === 0, 'the directory keeps offline roles');
});

test('a session name wins over a role of the same name', async () => {
  await register('shadow', { role: { role: 'alpha' } });
  const r = await api('/send', { method: 'POST', body: JSON.stringify({ to: 'alpha', from: 'g1/x', body: 'q' }) });
  assert.strictEqual(r.body.viaRole, undefined);
  await api('/inbox?relay=r1&wait=1');
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
