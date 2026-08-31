'use strict';
/**
 * discover.js — enumerate live Claude Code sessions on this machine.
 *
 * Claude Code maintains its own session registry at ~/.claude/sessions/<pid>.json
 * carrying the session's name (which follows /rename), status, cwd, session id
 * and socket path. We read that rather than inferring anything from pids, so a
 * renamed session is addressable by its real name.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isAlive, listLocalSockets } = require('./peer.js');

const SESSIONS = process.env.CLAUDE_SESSIONS_DIR
  || path.join(os.homedir(), '.claude', 'sessions');

/** Slugify a session name into something safe to address on the CLI. */
function slug(name) {
  return String(name || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .toLowerCase();
}

/**
 * Read a session's peer token from its sibling <pid>.<hash>.key file. This is
 * the same local credential Claude Code's own SendMessage uses to reach a peer
 * on this machine; it never leaves the machine except to the mesh registry,
 * which needs it to deliver into that session's inbox.
 */
function readPeerToken(files, pid) {
  const key = files.find((f) => f.startsWith(`${pid}.`) && f.endsWith('.key'));
  if (!key) return '';
  try {
    const d = JSON.parse(fs.readFileSync(path.join(SESSIONS, key), 'utf8'));
    return d.peerToken || '';
  } catch { return ''; }
}

function readSessionFiles() {
  let files = [];
  try { files = fs.readdirSync(SESSIONS); } catch { return []; }
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const d = JSON.parse(fs.readFileSync(path.join(SESSIONS, f), 'utf8'));
      if (!d.messagingSocketPath) continue;
      out.push({
        pid: Number(d.pid),
        sessionId: d.sessionId,
        cwd: d.cwd || '',
        socket: d.messagingSocketPath,
        name: d.name || '',
        nameSource: d.nameSource || '',
        status: d.status || '',
        kind: d.kind || '',
        version: d.version || '',
        updatedAt: Number(d.updatedAt || 0),
        token: readPeerToken(files, d.pid),
      });
    } catch {}
  }
  return out;
}

/**
 * Live sessions on this machine. Falls back to bare socket enumeration when the
 * session registry is unavailable, so discovery still works if its layout changes.
 */
function localSessions() {
  const self = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
  const fromFiles = readSessionFiles()
    .filter((s) => isAlive(s.pid) && fs.existsSync(s.socket))
    .map((s) => ({ ...s, slug: slug(s.name) || String(s.pid), self: s.socket === self }));

  if (fromFiles.length) return fromFiles;

  return listLocalSockets()
    .filter((s) => isAlive(s.pid))
    .map((s) => ({ ...s, name: '', slug: String(s.pid), self: s.socket === self }));
}

module.exports = { localSessions, slug, SESSIONS };
