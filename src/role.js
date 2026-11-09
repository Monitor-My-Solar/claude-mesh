'use strict';
/**
 * role.js — what a session's repo owns, read from a committed .mesh.json.
 *
 * Session names are ephemeral (directory slugs, /rename), but "the agent that
 * owns the mobile app" is not. A repo declares its role once, every session
 * opened in it advertises that role, and other agents address the role rather
 * than guessing which session is the right one:
 *
 *   {
 *     "role": "mms-web",
 *     "owns": "MMS backend services, web dashboard, DB, MQTT",
 *     "askFor": ["API/MQTT contracts", "DB lookups", "dev deploys"],
 *     "noAccessTo": ["mobile app code -> ask mms-app"],
 *     "autonomy": "requests"
 *   }
 *
 * autonomy is what OTHER agents may expect of this repo's agent without its
 * user being asked first:
 *   "requests"  - answers questions AND acts on change requests (default)
 *   "questions" - answers questions; change requests go to its user first
 * Either way the receiving agent stays inside its own permission settings.
 */
const fs = require('fs');
const path = require('path');

const FILE = '.mesh.json';
const AUTONOMY = ['requests', 'questions'];

const str = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const list = (v, max) => (Array.isArray(v) ? v : v ? [v] : [])
  .map((x) => str(x, 200)).filter(Boolean).slice(0, max);

function slugRole(v) {
  return str(v, 48).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Validate and trim a role object from any source (file or the wire). */
function normalize(d) {
  if (!d || typeof d !== 'object') return null;
  const role = slugRole(d.role);
  if (!role) return null;
  const autonomy = AUTONOMY.includes(d.autonomy) ? d.autonomy : 'requests';
  return {
    role,
    owns: str(d.owns, 300),
    askFor: list(d.askFor, 10),
    noAccessTo: list(d.noAccessTo, 10),
    autonomy,
  };
}

/** Find .mesh.json from cwd upwards, stopping at the repo root (or /). */
function findFile(cwd) {
  if (!cwd) return '';
  let dir = path.resolve(cwd);
  for (let i = 0; i < 40; i++) {
    const f = path.join(dir, FILE);
    if (fs.existsSync(f)) return f;
    if (fs.existsSync(path.join(dir, '.git'))) return '';   // repo root, none found
    const up = path.dirname(dir);
    if (up === dir) return '';
    dir = up;
  }
  return '';
}

const cache = new Map();   // file -> {mtimeMs, role}

/** The role declared for a working directory, or null. Never throws. */
function readRole(cwd) {
  try {
    const f = findFile(cwd);
    if (!f) return null;
    const { mtimeMs } = fs.statSync(f);
    const hit = cache.get(f);
    if (hit && hit.mtimeMs === mtimeMs) return hit.role;
    let role = null;
    try { role = normalize(JSON.parse(fs.readFileSync(f, 'utf8'))); }
    catch (e) { console.error(`[mesh] ignoring ${f}: ${e.message}`); }
    cache.set(f, { mtimeMs, role });
    return role;
  } catch { return null; }
}

/** Where a repo's .mesh.json lives: the nearest existing one, else the repo root. */
function targetFile(cwd) {
  const existing = findFile(cwd);
  if (existing) return existing;
  let dir = path.resolve(cwd || '.');
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) return path.join(dir, FILE);
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return path.join(path.resolve(cwd || '.'), FILE);   // not a repo: use cwd
}

/**
 * Create or edit a repo's .mesh.json, so an agent can declare its own role.
 *   set:    scalar fields to replace (role, owns, autonomy)
 *   add:    {askFor: [...], noAccessTo: [...]} appended, de-duplicated
 *   remove: same shape, removed
 * Returns {file, created, role}. Throws with a readable message on bad input.
 */
function writeRole(cwd, { set = {}, add = {}, remove = {}, create = false } = {}) {
  const file = targetFile(cwd);
  const exists = fs.existsSync(file);
  if (!exists && !create) throw new Error(`no ${FILE} here yet - create one with: claude-mesh role init --role <name> --owns "<what this repo owns>"`);
  if (exists && create) throw new Error(`${file} already exists - edit it with: claude-mesh role set / add / remove`);

  let d = {};
  if (exists) {
    try { d = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { throw new Error(`${file} is not valid JSON (${e.message}) - fix it by hand first`); }
  }
  for (const k of ['role', 'owns', 'autonomy']) if (set[k] !== undefined) d[k] = set[k];
  if (d.autonomy !== undefined && !AUTONOMY.includes(d.autonomy))
    throw new Error(`autonomy must be one of: ${AUTONOMY.join(', ')}`);
  for (const k of ['askFor', 'noAccessTo']) {
    let cur = Array.isArray(d[k]) ? d[k] : d[k] ? [d[k]] : [];
    for (const v of add[k] || []) if (v && !cur.includes(v)) cur.push(v);
    const drop = new Set(remove[k] || []);
    cur = cur.filter((v) => !drop.has(v));
    if (cur.length) d[k] = cur; else delete d[k];
  }
  const role = normalize(d);
  if (!role) throw new Error('a role name is required: --role <name>');

  // Key order fixed so diffs stay readable; unknown keys are kept.
  const ordered = {};
  for (const k of ['role', 'owns', 'askFor', 'noAccessTo', 'autonomy']) if (d[k] !== undefined) ordered[k] = d[k];
  for (const k of Object.keys(d)) if (!(k in ordered)) ordered[k] = d[k];
  fs.writeFileSync(file, JSON.stringify(ordered, null, 2) + '\n');
  cache.delete(file);
  return { file, created: !exists, role };
}

module.exports = { readRole, writeRole, targetFile, normalize, findFile, FILE, AUTONOMY };
