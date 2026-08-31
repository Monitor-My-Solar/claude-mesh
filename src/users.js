'use strict';
/**
 * users.js — account storage for the dashboard.
 *
 * SQLite would mean a native dependency for what is a handful of rows, so
 * accounts live in a JSON file written atomically with 0600 perms. Passwords
 * are stored as scrypt hashes with a per-user salt, never in clear.
 */
const fs = require('fs');
const path = require('path');
const { scryptSync, randomBytes, timingSafeEqual, randomUUID } = require('crypto');

const FILE = process.env.MESH_USERS || '/var/lib/claude-mesh/users.json';
const N = 16384, r = 8, p = 1, KEYLEN = 64;

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return { users: [] }; }
}

function save(db) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

function hash(password, salt = randomBytes(16).toString('hex')) {
  const key = scryptSync(password, salt, KEYLEN, { N, r, p }).toString('hex');
  return { salt, key };
}

function verify(password, salt, key) {
  const got = Buffer.from(scryptSync(password, salt, KEYLEN, { N, r, p }).toString('hex'));
  const want = Buffer.from(key);
  return got.length === want.length && timingSafeEqual(got, want);
}

function list() { return load().users.map(({ salt, key, ...u }) => u); }

function count() { return load().users.length; }

function create(username, password, { role = 'viewer' } = {}) {
  const db = load();
  const name = String(username || '').trim().toLowerCase();
  if (!name) throw new Error('username required');
  if (!password || password.length < 8) throw new Error('password must be at least 8 characters');
  if (db.users.some((u) => u.username === name)) throw new Error(`user '${name}' already exists`);
  const { salt, key } = hash(password);
  // The first account is the admin: someone has to be able to add the others.
  db.users.push({
    id: randomUUID(), username: name, salt, key,
    role: db.users.length === 0 ? 'admin' : role,
    created: Date.now(),
  });
  save(db);
  return { username: name, role: db.users[db.users.length - 1].role };
}

function authenticate(username, password) {
  const db = load();
  const u = db.users.find((x) => x.username === String(username || '').trim().toLowerCase());
  if (!u) return null;
  return verify(password, u.salt, u.key) ? { id: u.id, username: u.username, role: u.role } : null;
}

function remove(username) {
  const db = load();
  const before = db.users.length;
  db.users = db.users.filter((u) => u.username !== String(username || '').toLowerCase());
  save(db);
  return before - db.users.length;
}

function setPassword(username, password) {
  const db = load();
  const u = db.users.find((x) => x.username === String(username || '').toLowerCase());
  if (!u) throw new Error('no such user');
  if (!password || password.length < 8) throw new Error('password must be at least 8 characters');
  Object.assign(u, hash(password));
  save(db);
}

module.exports = { list, count, create, authenticate, remove, setPassword, FILE };
