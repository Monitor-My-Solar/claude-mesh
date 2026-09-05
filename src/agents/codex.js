'use strict';
/**
 * Codex CLI adapter.
 *
 * Codex keeps its own session registry in ~/.codex/state_5.sqlite and marks the
 * threads it is actively writing with a lock file, so discovery reads those.
 * Delivery uses `codex queue`, the supported way to push a message into a live
 * session - the equivalent of Claude Code's inbox socket.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');

const KIND = 'codex';
const HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const LOCKS = path.join(HOME, 'thread-writer-locks');

function slug(name) {
  return String(name || '').trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 48).toLowerCase();
}

/** The codex binary, or '' when Codex is not installed here. */
function bin() {
  const explicit = process.env.MESH_CODEX_BIN;
  if (explicit) return fs.existsSync(explicit) ? explicit : '';
  for (const p of [path.join(os.homedir(), '.local/bin/codex'), '/usr/local/bin/codex', '/opt/homebrew/bin/codex']) {
    if (fs.existsSync(p)) return p;
  }
  try { return execFileSync('sh', ['-lc', 'command -v codex'], { encoding: 'utf8' }).trim(); }
  catch { return ''; }
}

/** Thread ids Codex currently holds a writer lock on: its liveness signal. */
function liveThreadIds() {
  try {
    return new Set(fs.readdirSync(LOCKS)
      .filter((f) => f.endsWith('.lock'))
      .map((f) => f.replace(/\.lock$/, '')));
  } catch { return new Set(); }
}

/**
 * Read the threads table. Opened read-only and via a file: URI so we never
 * take a write lock on a database Codex is actively using.
 */
function readThreads(ids) {
  const db = path.join(HOME, 'state_5.sqlite');
  if (!ids.size || !fs.existsSync(db)) return [];
  // node:sqlite lands in Node 22; fall back to the sqlite3 CLI, and if neither
  // is available fall back to the ids alone rather than losing the sessions.
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch {}
  const wanted = [...ids];

  if (DatabaseSync) {
    try {
      const d = new DatabaseSync(`file:${db}?mode=ro`, { open: true });
      const rows = d.prepare(
        `SELECT id, name, title, cwd, updated_at_ms, archived FROM threads
          WHERE id IN (${wanted.map(() => '?').join(',')})`).all(...wanted);
      d.close();
      return rows;
    } catch {}
  }
  try {
    const q = `SELECT id||char(31)||coalesce(name,'')||char(31)||coalesce(title,'')||char(31)||`
            + `coalesce(cwd,'')||char(31)||coalesce(updated_at_ms,0)||char(31)||coalesce(archived,0) `
            + `FROM threads WHERE id IN (${wanted.map((i) => `'${i}'`).join(',')});`;
    const out = execFileSync('sqlite3', [`file:${db}?mode=ro`, q], { encoding: 'utf8' });
    return out.trim().split('\n').filter(Boolean).map((l) => {
      const [id, name, title, cwd, updated_at_ms, archived] = l.split('\x1f');
      return { id, name, title, cwd, updated_at_ms: Number(updated_at_ms), archived: Number(archived) };
    });
  } catch {}
  return wanted.map((id) => ({ id, name: '', title: '', cwd: '', updated_at_ms: 0, archived: 0 }));
}

/** Live Codex sessions on this machine, in the mesh's shape. */
function sessions() {
  if (!bin()) return [];
  const live = liveThreadIds();
  if (!live.size) return [];

  return readThreads(live)
    .filter((t) => !t.archived)
    .map((t) => {
      // A Codex thread has an explicit name only when someone set one; the
      // title is the first prompt, which makes a poor address.
      const named = !!(t.name && t.name.trim());
      return {
        kind: KIND,
        id: t.id,
        slug: named ? slug(t.name) : slug(path.basename(t.cwd || '') || t.id.slice(0, 8)),
        name: t.name || '',
        cwd: t.cwd || '',
        status: '',                     // Codex exposes no idle/busy signal
        named,
        pid: null,
        self: false,
        route: { thread: t.id },
      };
    });
}

function canDeliver(route) {
  return !!(route && route.thread && bin());
}

/** Push a message into a live Codex session via the supported queue command. */
function send({ route, body }) {
  const codex = bin();
  if (!codex) throw new Error('codex is not installed on this machine');
  return new Promise((resolve, reject) => {
    execFile(codex, ['queue', '--thread', route.thread, '--message', body],
      { timeout: 20_000 }, (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || err.message).trim().split('\n')[0]));
        resolve({ ok: true });
      });
  });
}

module.exports = { KIND, sessions, canDeliver, send, bin, HOME };
