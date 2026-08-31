'use strict';
/**
 * Inbox-socket delivery. A fake listener stands in for Claude Code so we can
 * assert the exact wire format, which is undocumented and captured from a real
 * client - if it drifts, delivery fails silently in production.
 */
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { test, run, assert, until } = require('./helpers.js');
const { deliver, buildEnvelope } = require('../src/peer.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-sock-'));
const sockPath = path.join(tmp, '12345.sock');
const received = [];

test('writes auth then the message frame, newline delimited', async () => {
  received.length = 0;
  await deliver({
    socketPath: sockPath, token: 'the-token', body: 'hello there',
    from: 'uds:/tmp/cc-socks/999.sock', fromName: 'tester',
  });
  const lines = await until(() => received.length >= 2 && received, { what: 'two frames' });

  const auth = JSON.parse(lines[0]);
  assert.strictEqual(auth.type, 'auth');
  assert.strictEqual(auth.token, 'the-token');

  const msg = JSON.parse(lines[1]);
  assert.strictEqual(msg.msgV, 1, 'peerProtocol version');
  assert.strictEqual(msg.type, 'user');
  assert.strictEqual(msg.message.role, 'user');
  assert.ok(msg.msg_id, 'every message needs an id');
  assert.strictEqual(msg.priority, 'next');
  assert.ok(msg.message.content.includes('hello there'));
});

test('sends priority=immediate when asked', async () => {
  received.length = 0;
  await deliver({ socketPath: sockPath, token: 't', body: 'urgent', priority: 'immediate' });
  const lines = await until(() => received.length >= 2 && received, { what: 'two frames' });
  assert.strictEqual(JSON.parse(lines[1]).priority, 'immediate');
});

test('envelope carries the attributes Claude Code parses', () => {
  const env = buildEnvelope({
    body: 'b', from: 'uds:/x.sock', fromName: 'n', fromSession: 'abc', fromMode: 'prompting',
  });
  assert.ok(env.startsWith('<cross-session-message '));
  assert.ok(env.includes('from="uds:/x.sock"'));
  assert.ok(env.includes('from-name="n"'));
  assert.ok(env.includes('from-mode="prompting"'));
  assert.ok(env.endsWith('</cross-session-message>'));
});

test('escapes quotes in attributes so the envelope cannot be broken', () => {
  const env = buildEnvelope({ body: 'b', fromName: 'ev"il', from: 'uds:/x.sock' });
  assert.ok(!env.includes('ev"il'), 'a raw quote would corrupt the attribute');
  assert.ok(env.includes('&quot;'));
});

test('refuses to deliver without a token', () => {
  // Throws synchronously rather than rejecting: a missing token is a caller
  // bug, not a delivery failure.
  assert.throws(() => deliver({ socketPath: sockPath, body: 'x' }), /token/);
  assert.throws(() => deliver({ token: 't', body: 'x' }), /socketPath/);
});

(async () => {
  const server = net.createServer((sock) => {
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        received.push(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
  });
  await new Promise((r) => server.listen(sockPath, r));
  const failed = await run('peer / inbox socket');
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})();
