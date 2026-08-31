'use strict';
/**
 * discover.js — enumerate live Claude Code sessions on this machine.
 *
 * Each session writes a handshake line describing itself when a peer connects,
 * but the socket filename alone (<pid>.sock) is enough to find and liveness-check
 * them, which avoids opening connections just to enumerate.
 */
const { listLocalSockets, isAlive } = require('./peer.js');

function localSessions() {
  return listLocalSockets()
    .filter((s) => isAlive(s.pid))
    .map((s) => ({ ...s, self: s.socket === process.env.CLAUDE_CODE_MESSAGING_SOCKET }));
}

module.exports = { localSessions };
