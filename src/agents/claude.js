'use strict';
/**
 * Claude Code adapter.
 *
 * Discovery reads ~/.claude/sessions/<pid>.json; delivery writes the peer frame
 * straight into that session's Unix inbox socket, which wakes an idle session.
 */
const { localSessions } = require('../discover.js');
const { deliver } = require('../peer.js');

const KIND = 'claude';

/** Live Claude Code sessions on this machine, in the mesh's shape. */
function sessions() {
  return localSessions().map((s) => ({
    kind: KIND,
    id: s.sessionId || String(s.pid),
    slug: s.slug,
    name: s.name || '',
    cwd: s.cwd || '',
    status: s.status || '',
    named: !!s.named,
    pid: s.pid ?? null,
    self: !!s.self,
    // Delivery needs both, and neither leaves this machine except to the
    // registry, which hands them back only to this machine's own relay.
    route: { socket: s.socket, token: s.token || '' },
  }));
}

function canDeliver(route) {
  return !!(route && route.socket && route.token);
}

async function send({ route, body, fromName, priority }) {
  await deliver({
    socketPath: route.socket,
    token: route.token,
    body,
    fromName,
    priority: priority === 'immediate' ? 'immediate' : 'next',
  });
}

module.exports = { KIND, sessions, canDeliver, send };
