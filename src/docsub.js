'use strict';
/**
 * docsub.js — publish/subscribe for shared docs.
 *
 * Agents working from one plan should not need their user to say "update the
 * doc AND tell the other agent". A write to a doc pings every subscriber's
 * session with what changed.
 *
 * Who is subscribed
 *   - anyone who writes a doc (put / append / section) - automatically
 *   - anyone pointed at a doc with send/ask --doc       - automatically
 *   - anyone who ran `claude-mesh doc sub NAME|PREFIX/`
 *
 * Subscribers are ROLES when the session has one (role:mms-app): sessions come
 * and go, the repo's role does not. A session without a role subscribes as
 * itself (session:<name>).
 *
 * Writes are debounced per (subscriber, doc): a burst of edits becomes one
 * message with the combined diff, sent after DEBOUNCE_MS of quiet (at most
 * MAX_WAIT_MS after the first edit). A subscriber that is offline gets the
 * notice when a session holding its role or name next registers.
 */
const { summarizeDiff } = require('./merge.js');

const DEBOUNCE_MS = Number(process.env.MESH_DOC_NOTIFY_MS || 20_000);
const MAX_WAIT_MS = Number(process.env.MESH_DOC_NOTIFY_MAX_MS || 120_000);
const OFFLINE_TTL = 7 * 86_400_000;
const MAX_SUBS_PER_DOC = 100;
const SESSION_TTL = 7 * 86_400_000;      // a session-keyed sub outlives its session this long
const MAX_BODY = Number(process.env.MESH_MAX_BODY || 16_384);
// Loop guard: two agents that each react to the other's edit would ping-pong
// forever. Past these limits notices to one subscriber about one doc slow
// down; nothing is lost, the next notice carries the combined diff.
const BURST_N = 3,  BURST_MS = 10 * 60_000;     // after 3 in 10 min: at most every MAX_WAIT_MS
const HOUR_N  = 12, HOUR_MS  = 60 * 60_000;     // after 12 in an hour: wait for the window

const matches = (pattern, doc) =>
  pattern === doc || pattern === '*' || (pattern.endsWith('/') && doc.startsWith(pattern));

/**
 * @param o.peers       live peer map (name -> peer)
 * @param o.resolve     (addr) -> peer name | null   (sessions and roles)
 * @param o.enqueue     (msg) -> void                 banks a message for msg.to
 * @param o.persist     () -> void
 */
function createDocSubs({ peers, resolve, enqueue, persist }) {
  const subs = new Map();      // pattern -> Set(subscriber key)
  const pending = new Map();   // "key\0doc" -> {key, doc, prev, body, fromV, toV, by, byAddr, ops, timer, first}
  const offline = new Map();   // subscriber key -> [{doc, fromV, toV, by, byAddr, diff, ts}]
  const optOut = new Set();    // "pattern\0key": explicit unsubs, so writing does not re-subscribe
  const seen = new Map();      // session key -> last time that session was registered
  const sent = new Map();      // "key\0doc" -> [timestamps of notices sent]

  /** A subscriber key for an address: its role if it has one, else the session. */
  function keyFor(addr, scope) {
    const name = resolve(addr);
    if (!name) return null;
    const p = peers.get(name);
    return p?.role?.role && scope !== 'session' ? `role:${p.role.role}` : `session:${name}`;
  }
  /** Every key a writer is known by, so it is never notified of its own edit. */
  function writerKeys(addr) {
    const name = resolve(addr);
    if (!name) return new Set();
    const p = peers.get(name);
    return new Set([`session:${name}`, ...(p?.role?.role ? [`role:${p.role.role}`] : [])]);
  }

  /**
   * auto: an implicit subscription (writing, --doc) - skipped if this key
   * explicitly unsubscribed from the pattern. Returns true | false (already) |
   * 'opted-out' | 'full'.
   */
  function subscribe(pattern, key, { auto = false } = {}) {
    if (!pattern || !key) return false;
    const id = `${pattern}\0${key}`;
    if (auto && optOut.has(id)) return 'opted-out';
    if (!auto && optOut.delete(id)) persist();
    const set = subs.get(pattern) || new Set();
    if (set.has(key)) return false;
    if (set.size >= MAX_SUBS_PER_DOC) return 'full';
    set.add(key); subs.set(pattern, set);
    if (key.startsWith('session:')) seen.set(key, Date.now());
    persist();
    return true;
  }
  function unsubscribe(pattern, key) {
    optOut.add(`${pattern}\0${key}`);
    const set = subs.get(pattern);
    if (!set || !set.delete(key)) { persist(); return false; }
    if (!set.size) subs.delete(pattern);
    persist();
    return true;
  }
  /** Subscriber keys for one doc (with the pattern that matched). */
  function subscribersOf(doc) {
    const out = new Map();
    for (const [pat, set] of subs) if (matches(pat, doc)) for (const k of set) if (!out.has(k)) out.set(k, pat);
    return out;
  }
  function list(filter = {}) {
    const rows = [];
    for (const [pattern, set] of subs) for (const key of set) {
      if (filter.key && !filter.key.has(key)) continue;
      if (filter.doc && !matches(pattern, filter.doc)) continue;
      rows.push({ pattern, key });
    }
    return rows;
  }

  /** A session holding this key, or null when nobody holding it is online. */
  function targetFor(key) {
    if (key.startsWith('session:')) { const n = key.slice(8); return peers.has(n) ? n : null; }
    if (key.startsWith('role:')) return resolve(key.slice(5)) || null;
    return null;
  }

  /** Never put more into a live session than a normal message may carry. */
  function capBody(b) {
    if (b.length <= MAX_BODY) return b;
    return b.slice(0, MAX_BODY - 200) + '\n... (notice truncated - read the doc for the full change)\n```';
  }

  function bodyFor(n, key, diffText) {
    const span = n.fromV && n.fromV !== n.toV ? `v${n.fromV} -> v${n.toV}` : `v${n.toV}`;
    const as = key.startsWith('role:') ? `as role ${key.slice(5)}` : 'as this session';
    const head = n.removed
      ? `SHARED DOC REMOVED: ${n.doc} was deleted by ${[...n.by].join(', ')}.`
      : `SHARED DOC UPDATED: ${n.doc} (${span}) by ${[...n.by].join(', ')}` +
        `${n.ops.size ? ` [${[...n.ops].join(', ')}]` : ''}.`;
    return [
      head,
      ...(diffText ? ['', 'What changed:', '```diff', diffText, '```'] : []),
      '',
      ...(n.removed ? [] : [`Read it in full: claude-mesh doc get ${n.doc}`]),
      'If this affects your work, act on it now within your role (update your part of the doc',
      `with \`claude-mesh doc section ${n.doc} --heading "<your section>" --body ...\`, or reply`,
      'to the editor with REPLY). If it does not affect you, carry on - no reply is needed.',
      'Do not edit the doc just to acknowledge this notice: every edit notifies the others.',
      ...(n.slowed ? ['(Notices for this doc are being batched: it is changing very often.)'] : []),
      `(You get these because you are subscribed to ${n.pattern} ${as}; ` +
        `stop with: claude-mesh doc unsub ${n.pattern})`,
    ].join('\n');
  }

  /** ms until another notice may go out for this (key, doc), or 0. */
  function holdFor(id) {
    const now = Date.now();
    const t = (sent.get(id) || []).filter((x) => now - x < HOUR_MS);
    sent.set(id, t);
    if (t.length >= HOUR_N) return t[t.length - HOUR_N] + HOUR_MS - now;
    const burst = t.filter((x) => now - x < BURST_MS);
    if (burst.length >= BURST_N) return Math.max(0, burst[burst.length - 1] + MAX_WAIT_MS - now);
    return 0;
  }

  function flush(id) {
    const n = pending.get(id);
    if (!n) return;
    clearTimeout(n.timer);
    // An edit that was reverted inside the window, or a no-op put: say nothing.
    if (!n.removed && n.prev === n.body) { pending.delete(id); return; }
    const hold = holdFor(id);
    if (hold > 0) {
      // Too many notices lately: keep accumulating; the diff stays complete.
      n.slowed = true;
      n.timer = setTimeout(() => flush(id), hold);
      n.timer.unref?.();
      return;
    }
    pending.delete(id);
    const diff = n.removed ? null : summarizeDiff(n.prev, n.body);
    const target = targetFor(n.key);
    if (!target) {
      // Nobody holding this role/session is online: keep it for the next one.
      const q = (offline.get(n.key) || []).filter((x) => x.doc !== n.doc);
      const earlier = (offline.get(n.key) || []).find((x) => x.doc === n.doc);
      q.push({ doc: n.doc, pattern: n.pattern, fromV: earlier?.fromV || n.fromV, toV: n.toV,
               by: [...new Set([...(earlier?.by || []), ...n.by])], removed: !!n.removed, ts: Date.now() });
      offline.set(n.key, q.slice(-20));
      persist();
      return;
    }
    sent.get(id)?.push(Date.now()) ?? sent.set(id, [Date.now()]);
    enqueue({
      to: target,
      from: [...n.by].join(', '),
      fromAddr: n.byAddr || '',
      intent: 'doc-update',
      doc: n.doc,
      body: capBody(bodyFor(n, n.key, diff?.text || '')),
    });
  }

  /**
   * A doc changed. prev/body are the text before and after this write; ops
   * is put|append|section|merge|rm.
   */
  function changed(doc, { prev = '', body = '', version, by, byAddr, op, removed = false }) {
    const self = writerKeys(byAddr || by);
    for (const [key, pattern] of subscribersOf(doc)) {
      if (self.has(key)) continue;
      const id = `${key}\0${doc}`;
      let n = pending.get(id);
      if (!n) {
        n = { key, doc, pattern, prev, fromV: Math.max(1, (version || 1) - 1), first: Date.now(),
              by: new Set(), ops: new Set() };
        if (version === 1) n.fromV = 0;
        pending.set(id, n);
      }
      n.body = body; n.toV = version; n.removed = removed;
      n.by.add(by); if (op) n.ops.add(op);
      n.byAddr = byAddr || n.byAddr;
      clearTimeout(n.timer);
      const wait = Math.max(0, Math.min(DEBOUNCE_MS, n.first + MAX_WAIT_MS - Date.now()));
      n.timer = setTimeout(() => flush(id), wait);
      n.timer.unref?.();
    }
    if (removed) for (const [pat] of subs) if (pat === doc) { subs.delete(pat); persist(); }
  }

  /** A session (re)registered: hand it whatever its role/name missed. */
  function onRegister(p) {
    seen.set(`session:${p.name}`, Date.now());
    const keys = [`session:${p.name}`, ...(p.role?.role ? [`role:${p.role.role}`] : [])];
    for (const key of keys) {
      const q = (offline.get(key) || []).filter((x) => Date.now() - x.ts < OFFLINE_TTL);
      if (!q.length) { offline.delete(key); continue; }
      offline.delete(key);
      const lines = q.map((x) => x.removed
        ? `  - ${x.doc}: deleted by ${x.by.join(', ')}`
        : `  - ${x.doc}: v${x.fromV} -> v${x.toV} by ${x.by.join(', ')}  (claude-mesh doc get ${x.doc})`);
      enqueue({
        to: p.name, from: 'mesh docs', fromAddr: '', intent: 'doc-update',
        body: [
          `SHARED DOCS CHANGED while ${key.startsWith('role:') ? `role ${key.slice(5)}` : 'this session'} was offline:`,
          ...lines,
          '',
          'Read the ones that matter to your work before continuing with it. No reply is needed.',
          `(Subscribed via ${[...new Set(q.map((x) => x.pattern))].join(', ')}; stop with: claude-mesh doc unsub NAME)`,
        ].join('\n'),
      });
      persist();
    }
  }

  function toJSON() {
    return {
      subs: [...subs.entries()].map(([k, v]) => [k, [...v]]),
      offline: [...offline.entries()],
      optOut: [...optOut],
      seen: [...seen.entries()],
    };
  }
  function restore(d) {
    for (const [k, v] of d?.subs || []) if (Array.isArray(v) && v.length) subs.set(k, new Set(v));
    for (const [k, v] of d?.offline || []) if (Array.isArray(v) && v.length) offline.set(k, v);
    for (const k of d?.optOut || []) optOut.add(k);
    for (const [k, v] of d?.seen || []) seen.set(k, v);
  }
  /** Forget offline notices nobody came back for within a week. */
  function prune() {
    // Session-keyed subscriptions die with their session (after a grace
    // period), so dead keys neither pile up nor fill a doc's subscriber cap.
    const now = Date.now();
    for (const [pat, set] of subs) for (const k of set) {
      if (!k.startsWith('session:') || peers.has(k.slice(8))) continue;
      if (!seen.has(k)) { seen.set(k, now); continue; }
      if (now - seen.get(k) > SESSION_TTL) { set.delete(k); offline.delete(k); seen.delete(k); if (!set.size) subs.delete(pat); persist(); }
    }
    for (const [id, t] of sent) if (!t.length || now - t[t.length - 1] > HOUR_MS) sent.delete(id);
    for (const [k, q] of offline) {
      const keep = q.filter((x) => Date.now() - x.ts < OFFLINE_TTL);
      if (keep.length !== q.length) { if (keep.length) offline.set(k, keep); else offline.delete(k); persist(); }
    }
  }
  /** Send everything still debouncing now (shutdown, tests). */
  function flushAll() { for (const id of [...pending.keys()]) flush(id); }

  return { keyFor, writerKeys, subscribe, unsubscribe, subscribersOf, list, changed, onRegister,
           toJSON, restore, flushAll, targetFor, prune };
}

module.exports = { createDocSubs, matches };
