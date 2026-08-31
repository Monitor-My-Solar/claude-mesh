'use strict';
/**
 * peer.js — direct delivery into a local Claude Code session's inbox socket.
 *
 * Wire protocol (captured from Claude Code 2.1.251, peerProtocol 1) is two
 * newline-delimited JSON lines written in a single write:
 *
 *   {"type":"auth","token":"<hex>"}
 *   {"msgV":1,"msg_id":"<uuid>","type":"user","message":{...},"priority":"next","from":"uds:<sock>"}
 *
 * The socket closes a connection that sends no complete line within 30s, so we
 * connect only once the payload is ready and write it in one go. Delivery is
 * fire-and-forget: the receiver sends no reply on this socket.
 */
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const PEER_PROTOCOL = 1;
const TAG = 'cross-session-message';

/** Directories Claude Code accepts sockets in (see socket-path hardening). */
function socketDirs() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const dirs = [];
  if (uid !== null) dirs.push(`/run/user/${uid}/cc-socks`);
  dirs.push('/tmp/cc-socks', path.join(os.tmpdir(), 'cc-socks'));
  return [...new Set(dirs)];
}

/** Escape a value for an XML-ish attribute in the envelope. */
function attr(v) {
  return String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
                  .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Build the envelope the receiving session parses. Attribute order matters:
 * Claude Code re-serialises and compares, discarding anything that differs.
 */
function buildEnvelope({ body, from, fromName, fromSession, fromMode = 'prompting' }) {
  let a = '';
  if (from)        a += ` from="${attr(from)}"`;
  if (fromSession) a += ` from-session="${attr(fromSession)}"`;
  if (fromName)    a += ` from-name="${attr(fromName)}"`;
  if (fromMode)    a += ` from-mode="${attr(fromMode)}"`;
  return `<${TAG}${a}>\n${body}\n</${TAG}>`;
}

/** Discover live sessions from the socket directories. */
function listLocalSockets() {
  const out = [];
  for (const dir of socketDirs()) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!/^(\d+(-[0-9a-f]{8})?|[0-9a-f]{1,16})\.sock$/.test(n)) continue;
      const p = path.join(dir, n);
      let st;
      try { st = fs.lstatSync(p); } catch { continue; }
      if (st.isSymbolicLink() || !st.isSocket()) continue;   // refuse symlinks
      const pid = Number.parseInt(n, 10);
      out.push({ socket: p, pid: Number.isNaN(pid) ? null : pid });
    }
  }
  return out;
}

/** True if the pid encoded in the socket name is still alive. */
function isAlive(pid) {
  if (!pid) return true;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/**
 * Deliver a message into a session's inbox socket.
 * Resolves on flush; the receiver never replies on this channel.
 */
function deliver({
  socketPath,
  token,
  body,
  from = process.env.CLAUDE_CODE_MESSAGING_SOCKET
    ? `uds:${process.env.CLAUDE_CODE_MESSAGING_SOCKET}` : undefined,
  fromName,
  fromSession,
  fromMode = 'prompting',
  priority = 'next',
  timeoutMs = 5000,
} = {}) {
  if (!socketPath) throw new Error('socketPath is required');
  if (!token)      throw new Error('token is required');
  if (!body)       throw new Error('body is required');

  const payload =
    JSON.stringify({ type: 'auth', token }) + '\n' +
    JSON.stringify({
      msgV: PEER_PROTOCOL,
      msg_id: randomUUID(),
      type: 'user',
      message: {
        role: 'user',
        content: buildEnvelope({ body, from, fromName, fromSession, fromMode }),
      },
      priority,
      ...(from ? { from } : {}),
    }) + '\n';

  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ path: socketPath });
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      sock.destroy();
      err ? reject(err) : resolve({ ok: true, bytes: Buffer.byteLength(payload) });
    };
    sock.setTimeout(timeoutMs, () => finish(new Error('socket timeout')));
    sock.on('error', finish);
    // Connect only once data is ready, then write both lines in one shot.
    sock.on('connect', () => sock.write(payload, () => finish()));
  });
}

module.exports = { deliver, listLocalSockets, isAlive, buildEnvelope, socketDirs, PEER_PROTOCOL };
