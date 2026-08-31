'use strict';
/**
 * End-to-end: a real registry, a real relay subprocess, and a fake Claude Code
 * session (a socket plus the session files the relay reads). This is the layer
 * where the bugs that actually reached production lived.
 */
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { test, run, assert, until, sleep } = require('./helpers.js');

const TOKEN = 'e2e-token-0123456789';
const root = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-e2e-'));
const sessionsDir = path.join(tmp, 'sessions');
const socksDir = path.join(tmp, 'cc-socks');
const PID = process.pid;                    // a pid that is definitely alive
const sockPath = path.join(socksDir, `${PID}.sock`);
const delivered = [];

let server, base, relay;

function writeSessionFiles(name) {
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(path.join(sessionsDir, `${PID}.json`), JSON.stringify({
    pid: String(PID), sessionId: 'sess-1', cwd: '/work', version: '2.1.251',
    kind: 'interactive', messagingSocketPath: sockPath,
    name, nameSource: 'user', status: 'idle', updatedAt: Date.now(),
  }));
  fs.writeFileSync(path.join(sessionsDir, `${PID}.abc.key`),
    JSON.stringify({ peerToken: 'peer-inbox-token' }));
}

const api = async (p, opts = {}) => {
  const r = await fetch(base + p, {
    headers: { 'Content-Type': 'application/json', 'X-Mesh-Token': TOKEN }, ...opts });
  return r.json().catch(() => ({}));
};

test('the relay registers this machine under the session name', async () => {
  const peer = await until(async () => {
    const { peers } = await api('/peers');
    return peers.find((p) => p.name === 'worker-one');
  }, { timeout: 15000, what: 'the relay to register' });

  assert.strictEqual(peer.group, 'testgroup');
  assert.strictEqual(peer.status, 'idle');
  assert.ok(peer.named, 'a renamed session should be marked as deliberately named');
  assert.ok(peer.version, 'the relay should report its version');
});

// The production bug: relays registered once and then aged out forever while
// still polling, so the whole mesh read stale.
test('registration keeps refreshing, so a live machine never goes stale', async () => {
  const first = (await api('/peers')).peers.find((p) => p.name === 'worker-one').seen;
  const advanced = await until(async () => {
    const p = (await api('/peers')).peers.find((x) => x.name === 'worker-one');
    return p && p.seen > first ? p.seen : null;
  }, { timeout: 25000, interval: 1000, what: 'seen to advance' });
  assert.ok(advanced > first, 'a live relay must keep its registration fresh');
});

test('a message reaches the session socket with the envelope intact', async () => {
  delivered.length = 0;
  await api('/send', { method: 'POST', body: JSON.stringify({
    to: 'testgroup/worker-one', from: 'someone', intent: 'request', body: 'do the thing',
  }) });

  const frames = await until(() => delivered.length >= 2 && delivered.slice(),
    { timeout: 15000, what: 'delivery to the socket' });

  assert.strictEqual(JSON.parse(frames[0]).token, 'peer-inbox-token',
    'must authenticate with the RECIPIENT inbox token');
  const msg = JSON.parse(frames[1]);
  assert.ok(msg.message.content.includes('do the thing'));
  assert.ok(msg.message.content.includes('INTENT: request'));
  assert.ok(msg.message.content.includes('<cross-session-message'));
});

test('the REPLY line names an address that actually resolves', async () => {
  const content = JSON.parse(delivered[1]).message.content;
  const line = content.split('\n').find((l) => l.startsWith('REPLY:')) || '';
  assert.ok(line, 'every message should carry a REPLY line');
  const to = (line.match(/--to (\S+)/) || [])[1];
  if (to) {
    const { peers } = await api('/peers');
    const known = peers.some((p) => `${p.group}/${p.name}` === to || p.name === to.split('/').pop());
    assert.ok(known, `REPLY names '${to}', which is not a registered peer`);
  } else {
    assert.ok(line.includes('no session to reply to'),
      'if there is no resolvable address, say so rather than printing a broken command');
  }
});

test('a session that disappears is deregistered', async () => {
  fs.rmSync(path.join(sessionsDir, `${PID}.json`));
  await until(async () => {
    const { peers } = await api('/peers');
    return !peers.some((p) => p.name === 'worker-one');
  }, { timeout: 25000, interval: 1000, what: 'the ended session to be removed' });
});

(async () => {
  process.env.MESH_STATE = path.join(tmp, 'state.json');
  process.env.MESH_USERS = path.join(tmp, 'users.json');
  process.env.MESH_TOKEN = TOKEN;

  const { createRegistry } = require('../src/registry.js');
  server = createRegistry().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  fs.mkdirSync(socksDir, { recursive: true });
  const fake = net.createServer((sock) => {
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) !== -1) { delivered.push(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
  });
  await new Promise((r) => fake.listen(sockPath, r));
  writeSessionFiles('worker-one');

  relay = spawn(process.execPath, [path.join(root, 'bin', 'claude-mesh'), 'relay'], {
    env: { ...process.env,
      MESH_REGISTRY: base, MESH_TOKEN: TOKEN,
      MESH_RELAY_ID: 'testrelay', MESH_GROUP: 'testgroup',
      MESH_AUTO_UPDATE: '0',
      CLAUDE_SESSIONS_DIR: sessionsDir,
      HOME: tmp,
    },
    stdio: process.env.VERBOSE ? 'inherit' : 'ignore',
  });

  const failed = await run('end-to-end (registry + relay + session)');
  relay.kill();
  fake.close();
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})();
