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
process.env.MESH_ACK_TIMEOUT_MS = '1000';
process.env.MESH_DOC_NOTIFY_MS = '150';     // doc pub/sub debounce   // must be set before the require

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

const { execFile } = require('child_process');
const cli = (...args) => new Promise((resolve, reject) => execFile(process.execPath,
  [path.join(__dirname, '..', 'bin', 'claude-mesh'), ...args],
  { env: { ...process.env, MESH_REGISTRY: base, MESH_TOKEN: TOKEN, MESH_CONFIG_DIR: tmp }, timeout: 15000 },
  (e, out, err) => (e ? reject(Object.assign(new Error(err || e.message), { out, err, code: e.code })) : resolve({ out, err }))));
const post = (p, d) => api(p, { method: 'POST', body: JSON.stringify(d) });

test('docs: put, get, list, with a normalised name and title', async () => {
  const r = await post('/docs/put', { name: 'MMS/Push Plan.md', body: '# Push rollout\nstep 1\n', from: 'g1/alpha' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.name, 'mms/push-plan');
  assert.strictEqual(r.body.version, 1);
  const g = await api('/docs?name=mms/push-plan');
  assert.strictEqual(g.body.body, '# Push rollout\nstep 1\n');
  assert.strictEqual(g.body.meta.title, 'Push rollout');
  const l = await api('/docs?prefix=mms');
  assert.ok(l.body.docs.some((d) => d.name === 'mms/push-plan'));
  const none = await api('/docs?prefix=other');
  assert.strictEqual(none.body.docs.length, 0);
});

test('docs: append keeps both writers and stamps each section', async () => {
  await post('/docs/append', { name: 'mms/push-plan', body: '## web: API ready', from: 'g1/alpha' });
  const r = await post('/docs/append', { name: 'mms/push-plan', body: '## app: UI ready', from: 'g2/beta' });
  assert.strictEqual(r.body.version, 3);
  const g = await api('/docs?name=mms/push-plan');
  for (const s of ['step 1', '## web: API ready', '## app: UI ready', 'g2/beta @'])
    assert.ok(g.body.body.includes(s), `missing ${s}`);
});

test('docs: concurrent edits merge; same-line edits are refused with the conflict', async () => {
  // v3 is the plan plus two appended sections. Two agents both read v3.
  const v3 = (await api('/docs?name=mms/push-plan')).body.body;
  const a = await post('/docs/put', { name: 'mms/push-plan', ifVersion: 3, from: 'g1/alpha',
    body: v3.replace('step 1', 'step 1 (web done)') });
  assert.strictEqual(a.body.version, 4);
  const b = await post('/docs/put', { name: 'mms/push-plan', ifVersion: 3, from: 'g2/beta',
    body: v3.replace('## app: UI ready', '## app: UI shipped') });
  assert.strictEqual(b.status, 200, JSON.stringify(b.body));
  assert.ok(b.body.merged, 'second writer should have been merged, not refused');
  const now = (await api('/docs?name=mms/push-plan')).body.body;
  assert.ok(now.includes('step 1 (web done)') && now.includes('## app: UI shipped'), now);
  const c = await post('/docs/put', { name: 'mms/push-plan', ifVersion: 3, from: 'g3/gamma',
    body: v3.replace('step 1', 'step 1 (gamma)') });
  assert.strictEqual(c.status, 409);
  assert.ok(c.body.error.includes('[yours]') && c.body.conflicts.length === 1);
  assert.ok((await api('/docs?name=mms/push-plan')).body.body.includes('(web done)'), 'refused write must not change the doc');
  // An unread overwrite is refused; ifVersion omitted (--force) replaces.
  const unread = await post('/docs/put', { name: 'mms/push-plan', body: 'x', ifVersion: 0, from: 'a' });
  assert.strictEqual(unread.status, 409);
  const ok = await post('/docs/put', { name: 'mms/push-plan', body: '# v6\n', from: 'a' });
  assert.strictEqual(ok.body.version, 6);
  const fresh = await post('/docs/put', { name: 'brand-new', body: 'y', ifVersion: 0, from: 'a' });
  assert.strictEqual(fresh.status, 200, 'ifVersion 0 means "must not exist yet"');
});

test('docs: section writes from two agents never collide', async () => {
  await post('/docs/section', { name: 'sec', heading: 'Web', body: 'web part', from: 'a' });
  await post('/docs/section', { name: 'sec', heading: 'App', body: 'app part', from: 'b' });
  await post('/docs/section', { name: 'sec', heading: 'Web', body: 'web part v2', from: 'a' });
  const d = (await api('/docs?name=sec')).body.body;
  assert.strictEqual(d, '## Web\nweb part v2\n\n## App\napp part\n');
});

test('docs: CLI get -> edit -> put merges with an edit made in between', async () => {
  const f = path.join(tmp, 'edit.md');
  await post('/docs/put', { name: 'cli-merge', body: '# T\none\ntwo\nthree\n', from: 'x' });
  await cli('doc', 'get', 'cli-merge', '--out', f, '--from', 'g1/alpha');
  await post('/docs/put', { name: 'cli-merge', body: '# T\none\ntwo\nthree (other agent)\n', from: 'g2/beta', ifVersion: 1 });
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('one', 'one (me)'));
  const r = await cli('doc', 'put', 'cli-merge', '--file', f, '--from', 'g1/alpha');
  assert.ok(/merged with g2\/beta/.test(r.out), r.out);
  assert.strictEqual((await api('/docs?name=cli-merge')).body.body, '# T\none (me)\ntwo\nthree (other agent)\n');
});

test('docs: earlier versions stay readable', async () => {
  const v1 = await api('/docs?name=mms/push-plan&v=1');
  assert.strictEqual(v1.body.body, '# Push rollout\nstep 1\n');
  const v6 = await api('/docs?name=mms/push-plan');
  assert.strictEqual(v6.body.body, '# v6\n');
});

test('docs: bad names, oversize and unknown docs are rejected', async () => {
  assert.strictEqual((await post('/docs/put', { name: '../../etc', body: 'x' })).body.name, 'etc',
    'path traversal is flattened into a plain name');
  assert.strictEqual((await post('/docs/put', { name: '///', body: 'x' })).status, 400);
  assert.strictEqual((await api('/docs?name=nope')).status, 404);
  const big = await post('/docs/put', { name: 'big', body: 'x'.repeat(600 * 1024) });
  assert.strictEqual(big.status, 413);
});

test('docs: rm removes it from the list', async () => {
  assert.strictEqual((await post('/docs/rm', { name: 'brand-new' })).status, 200);
  assert.strictEqual((await api('/docs?name=brand-new')).status, 404);
});

test('docs: survive a registry restart', async () => {
  const again = createRegistry().listen(0, '127.0.0.1');
  await new Promise((r) => again.once('listening', r));
  const r = await fetch(`http://127.0.0.1:${again.address().port}/docs?name=mms/push-plan`,
    { headers: { 'X-Mesh-Token': TOKEN } }).then((x) => x.json());
  again.close();
  assert.strictEqual(r.body, '# v6\n');
});

test('docs: a large non-ASCII body round-trips byte for byte', async () => {
  const body = '# Plan — ✓ → ünïcødé\n' + '— ✓ → 日本 '.repeat(12_000);
  const r = await post('/docs/put', { name: 'utf8', body, from: 'a' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const g = await api('/docs?name=utf8');
  assert.ok(g.body.body === body, 'multi-byte characters were corrupted in transit');
});

test('docs: a re-created name does not inherit the removed doc\'s history', async () => {
  await post('/docs/put', { name: 'reuse', body: 'old one', from: 'a' });
  await post('/docs/put', { name: 'reuse', body: 'old two', from: 'a' });
  await post('/docs/rm', { name: 'reuse' });
  await post('/docs/put', { name: 'reuse', body: 'new', from: 'a' });
  assert.strictEqual((await api('/docs?name=reuse&v=1')).status, 200);   // v1 is current
  assert.strictEqual((await api('/docs?name=reuse&v=2')).status, 404, 'old history leaked');
});

test('docs: send --doc delivers a pointer the recipient can act on', async () => {
  await register('docrecv', { relay: 'rdoc' });
  // Async: the registry under test runs in this process, so a sync child
  // would deadlock waiting on a server that can no longer answer.
  await cli('send', '--to', 'docrecv', '--doc', 'mms/push-plan', '--body', 'please review', '--from', 'g1/alpha');
  const r = await api('/inbox?relay=rdoc&wait=1');
  const m = (r.body.messages || []).find((x) => x.to === 'docrecv');
  assert.ok(m, 'message not delivered');
  assert.ok(m.body.startsWith('please review'));
  assert.ok(m.body.includes('SHARED DOC: mms/push-plan') && m.body.includes('claude-mesh doc get mms/push-plan'), m.body);
});

// --- doc pub/sub -----------------------------------------------------------
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const drain = async (relay) => (await api(`/inbox?relay=${relay}&wait=1`)).body.messages || [];
const docMsgs = (msgs, doc) => msgs.filter((m) => m.intent === 'doc-update' && (!doc || m.body.includes(doc)));

test('pub/sub: an edit pings the other participant with the diff, not the editor', async () => {
  await register('webagent', { group: 'srv', relay: 'rweb', role: { role: 'ps-web', owns: 'backend' } });
  await register('appagent', { group: 'mac', relay: 'rapp', role: { role: 'ps-app', owns: 'mobile' } });
  const w = await post('/docs/put', { name: 'ps/plan', from: 'srv/webagent', body: '# Plan\n\n## Web\ntodo\n\n## App\ntodo\n' });
  assert.strictEqual(w.body.subscribed, true, 'writer should be auto-subscribed');
  const a = await post('/docs/section', { name: 'ps/plan', from: 'mac/appagent', heading: 'App', body: 'screen built' });
  assert.deepStrictEqual(a.body.notifying, ['role:ps-web']);
  await sleepMs(400);
  const web = docMsgs(await drain('rweb'), 'ps/plan');
  assert.strictEqual(web.length, 1, 'web should get exactly one notice');
  assert.ok(web[0].body.includes('SHARED DOC UPDATED: ps/plan') && web[0].body.includes('+ screen built'), web[0].body);
  assert.strictEqual(web[0].fromAddr, 'mac/appagent', 'notice is replyable to the editor');
  assert.strictEqual(docMsgs(await drain('rapp'), 'ps/plan').length, 0, 'the editor is never pinged about its own edit');
});

test('pub/sub: a burst of edits becomes one message', async () => {
  for (const b of ['one', 'two', 'three'])
    await post('/docs/section', { name: 'ps/plan', from: 'srv/webagent', heading: 'Web', body: b });
  await sleepMs(400);
  const app = docMsgs(await drain('rapp'), 'ps/plan');
  assert.strictEqual(app.length, 1, `expected 1 coalesced notice, got ${app.length}`);
  assert.ok(app[0].body.includes('+ three') && !app[0].body.includes('+ one'), app[0].body);
});

test('pub/sub: send --doc subscribes the recipient; folder subs match', async () => {
  await register('opsagent', { group: 'srv', relay: 'rops' });
  await post('/docs/put', { name: 'ps/other', from: 'srv/webagent', body: 'x' });
  await api('/send', { method: 'POST', body: JSON.stringify({ to: 'opsagent', from: 'srv/webagent', body: 'see doc', doc: 'ps/other' }) });
  const sub = await post('/docs/sub', { name: 'ps/', from: 'srv/opsagent' });
  assert.strictEqual(sub.body.key, 'session:opsagent');
  const subs = await api('/docs/subs?who=srv/opsagent');
  assert.deepStrictEqual(subs.body.subs.map((x) => x.pattern).sort(), ['ps/', 'ps/other']);
  await drain('rops');
  await post('/docs/put', { name: 'ps/third', from: 'srv/webagent', body: 'new doc' });
  await sleepMs(400);
  assert.strictEqual(docMsgs(await drain('rops'), 'ps/third').length, 1, 'folder subscription missed a new doc');
  const un = await post('/docs/unsub', { name: 'ps/', from: 'srv/opsagent' });
  assert.strictEqual(un.body.changed, true);
});

test('pub/sub: a role that is offline is told when it comes back', async () => {
  await api('/deregister', { method: 'POST', body: JSON.stringify({ name: 'appagent' }) });
  await post('/docs/append', { name: 'ps/plan', from: 'srv/webagent', body: 'while you were out' });
  await sleepMs(400);
  assert.strictEqual(docMsgs(await drain('rapp')).length, 0);
  await register('appagent2', { group: 'mac', relay: 'rapp', role: { role: 'ps-app', owns: 'mobile' } });
  const back = docMsgs(await drain('rapp'));
  assert.strictEqual(back.length, 1);
  assert.ok(back[0].to === 'appagent2' && back[0].body.includes('while role ps-app was offline') &&
            back[0].body.includes('ps/plan'), back[0].body);
});

test('pub/sub: subscriptions survive a registry restart', async () => {
  await sleepMs(1200);   // let the debounced state save land
  const again = createRegistry().listen(0, '127.0.0.1');
  await new Promise((r) => again.once('listening', r));
  const r = await fetch(`http://127.0.0.1:${again.address().port}/docs/subs?name=ps/plan`,
    { headers: { 'X-Mesh-Token': TOKEN } }).then((x) => x.json());
  again.close();
  assert.deepStrictEqual(r.subs.map((x) => x.key).sort(), ['role:ps-app', 'role:ps-web']);
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
