'use strict';
/**
 * session.js — signed cookie sessions for the dashboard.
 *
 * In-memory: a registry restart logs everyone out, which is an acceptable
 * trade for not persisting anything that behaves like a credential.
 */
const { randomBytes } = require('crypto');

const TTL_MS = Number(process.env.MESH_SESSION_TTL_MS || 7 * 24 * 3600 * 1000);
const sessions = new Map();   // sid -> {user, expires}

function create(user) {
  const sid = randomBytes(32).toString('hex');
  sessions.set(sid, { user, expires: Date.now() + TTL_MS });
  return sid;
}

function get(sid) {
  const s = sessions.get(sid);
  if (!s) return null;
  if (Date.now() > s.expires) { sessions.delete(sid); return null; }
  return s.user;
}

function destroy(sid) { sessions.delete(sid); }

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Cookie flags: HttpOnly so scripts cannot read it, SameSite=Lax, Secure over TLS. */
function cookie(sid, { secure = false, clear = false } = {}) {
  const bits = [`mesh_sid=${clear ? '' : sid}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (secure) bits.push('Secure');
  bits.push(clear ? 'Max-Age=0' : `Max-Age=${Math.floor(TTL_MS / 1000)}`);
  return bits.join('; ');
}

module.exports = { create, get, destroy, parseCookies, cookie };
