'use strict';
/**
 * registry.js — LAN directory + message bank.
 *
 * Sessions register through their machine's relay; messages are banked per
 * recipient until that relay long-polls for them. Stdlib only, so it runs
 * anywhere Node does.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { randomUUID, timingSafeEqual } = require('crypto');
const users = require('./users.js');
const sess = require('./session.js');
const ui = require('./ui.js');

const STATE_FILE = process.env.MESH_STATE || '/var/lib/claude-mesh/state.json';

/**
 * Resolve a recipient. Accepts a fully-qualified "group/name", a bare name when
 * it is unambiguous mesh-wide, or a name plus an explicit group. Ambiguity is
 * an error rather than a guess: delivering into the wrong session is worse than
 * refusing to deliver.
 */
function resolveTarget(peers, to, toGroup) {
  if (peers.has(to)) return { name: to };

  const all = [...peers.values()];
  const byGroupName = (g, n) => all.filter((p) => p.group === g && (p.name === n || p.name.endsWith(`/${n}`)));

  if (to.includes('/')) {
    const [g, ...restParts] = to.split('/');
    const n = restParts.join('/');
    const hits = byGroupName(g, n);
    if (hits.length === 1) return { name: hits[0].name };
    if (hits.length > 1) return { error: `ambiguous '${to}'`, candidates: hits.map((p) => p.name) };
  }

  const pool = toGroup ? all.filter((p) => p.group === toGroup) : all;
  const hits = pool.filter((p) => p.name === to || p.name.endsWith(`/${to}`));
  if (hits.length === 1) return { name: hits[0].name };
  if (hits.length > 1) return { error: `ambiguous '${to}' - qualify it as group/name`, candidates: hits.map((p) => p.name) };

  return {
    error: `unknown peer '${to}' - it is not registered, so no spelling of the ` +
           'address will route to it; its relay is probably not running',
    online: all.map((p) => `${p.group}/${p.name}${p.status ? ` [${p.status}]` : ''}`),
  };
}

/** Constant-time string compare, so the token can't be recovered by timing. */
function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && timingSafeEqual(x, y);
}

const STALE_MS  = Number(process.env.MESH_STALE_MS  || 15 * 60_000);
const MAX_BANK  = Number(process.env.MESH_MAX_BANK  || 50);
const MAX_BODY  = Number(process.env.MESH_MAX_BODY  || 16_384);
// Per-sender limits. Messages become turns in a live session, so an agent loop
// is not just noise - it burns the recipient's context and tokens.
// How long a relay has to acknowledge a message before it is handed out again.
const ACK_TIMEOUT_MS = Number(process.env.MESH_ACK_TIMEOUT_MS || 60_000);
const MAX_ATTEMPTS   = Number(process.env.MESH_MAX_ATTEMPTS || 5);
const RATE_WINDOW_MS = Number(process.env.MESH_RATE_WINDOW_MS || 60_000);
const RATE_MAX       = Number(process.env.MESH_RATE_MAX       || 20);
const PAIR_MAX       = Number(process.env.MESH_PAIR_MAX       || 10);

function createRegistry({ token = process.env.MESH_TOKEN || '', allowInsecure = process.env.MESH_ALLOW_INSECURE === '1' } = {}) {
  if (!token && !allowInsecure) {
    throw new Error(
      'MESH_TOKEN is required: the registry injects messages into live Claude sessions, ' +
      'so it must never run unauthenticated. Set MESH_TOKEN, or MESH_ALLOW_INSECURE=1 to override.');
  }
  const peers = new Map();   // name -> peer
  const bank  = new Map();   // name -> [msg]
  const waits = new Set();   // pending long-polls
  const replies = new Map(); // request id -> reply message (awaiting collection)
  const rate = new Map();    // "from" and "from>to" -> [timestamps]
  const inflight = new Map();// msg id -> {msg, relay, sentAt, attempts}
  const joins = new Map();   // join code -> {expires, uses}

  /**
   * Allow a send unless this sender is over its window budget, either overall
   * or against one recipient. Two agents can otherwise ping-pong indefinitely,
   * and each hop costs the receiver a turn.
   */
  function rateCheck(from, to) {
    const now = Date.now();
    const bump = (key, max) => {
      const hits = (rate.get(key) || []).filter((t) => now - t < RATE_WINDOW_MS);
      if (hits.length >= max) { rate.set(key, hits); return false; }
      hits.push(now);
      rate.set(key, hits);
      return true;
    };
    const secs = Math.round(RATE_WINDOW_MS / 1000);
    if (!bump(`${from}>${to}`, PAIR_MAX))
      return `rate limit: ${PAIR_MAX} messages per ${secs}s to a single peer`;
    if (!bump(from, RATE_MAX))
      return `rate limit: ${RATE_MAX} messages per ${secs}s total`;
    return null;
  }

  // Persist the roster and undelivered mail so a restart does not silently
  // orphan every session and drop queued messages.
  const persist = (() => {
    let timer = null;
    return () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        try {
          fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
          const tmp = STATE_FILE + '.tmp';
          fs.writeFileSync(tmp, JSON.stringify({
            v: 1,
            savedAt: Date.now(),
            peers: [...peers.values()],
            bank: [...bank.entries()],
            inflight: [...inflight.entries()],
          }), { mode: 0o600 });
          fs.renameSync(tmp, STATE_FILE);      // atomic
        } catch (e) {
          console.error('[registry] state save failed:', e.message);
        }
      }, 1000).unref?.() ?? null;
    };
  })();

  (function restore() {
    let d;
    try { d = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return; }
    if (!d || d.v !== 1) return;
    const cutoff = Date.now() - STALE_MS;
    let kept = 0;
    for (const p of d.peers || []) {
      // Only restore peers that were fresh when we stopped; the relays will
      // re-register anything still alive within a cycle anyway.
      if (p.seen > cutoff) { peers.set(p.name, p); kept++; }
    }
    for (const [k, v] of d.bank || []) if (Array.isArray(v) && v.length) bank.set(k, v);
    // Anything in flight when we stopped was never acked: put it back.
    for (const [, rec] of d.inflight || []) {
      if (!rec?.msg?.to) continue;
      const q = bank.get(rec.msg.to) || [];
      if (!q.some((m) => m.id === rec.msg.id)) { q.unshift(rec.msg); bank.set(rec.msg.to, q); }
    }
    console.log(`[registry] restored ${kept} peer(s), ${[...bank.values()].flat().length} queued message(s)`);
  })();

  const prune = () => {
    const cutoff = Date.now() - STALE_MS;
    for (const [n, p] of peers) if (p.seen < cutoff) peers.delete(n);

    // Drop bare-pid registrations once the same machine has registered a named
    // session on that pid. An old SessionStart hook could register before the
    // session file existed, leaving an orphan under the pid that nothing ever
    // reconciles - the relay registers the same session under its real name and
    // has no idea the two are the same.
    const namedPids = new Set();
    for (const p of peers.values()) if (p.pid && !/^\d+$/.test(p.name)) namedPids.add(`${p.relay}:${p.pid}`);
    for (const [n, p] of peers) {
      if (!/^\d+$/.test(n)) continue;
      if (namedPids.has(`${p.relay}:${n}`) || !p.version) peers.delete(n);
    }
  };

  const wake = () => {
    for (const w of [...waits]) w();
  };

  /** Return un-acked messages to the bank so they are handed out again. */
  function requeueExpired() {
    const cutoff = Date.now() - ACK_TIMEOUT_MS;
    for (const [id, rec] of inflight) {
      if (rec.sentAt > cutoff) continue;
      inflight.delete(id);
      if (rec.attempts >= MAX_ATTEMPTS) {
        console.log(`dropping ${id} -> ${rec.msg.to} after ${rec.attempts} attempts`);
        continue;
      }
      const q = bank.get(rec.msg.to) || [];
      if (q.some((m) => m.id === id)) continue;      // already back
      q.unshift(rec.msg);                            // retry before newer mail
      bank.set(rec.msg.to, q);
      console.log(`requeued ${id} -> ${rec.msg.to} (attempt ${rec.attempts} unacked)`);
    }
  }

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const reply = (code, obj) => {
      const b = Buffer.from(JSON.stringify(obj));
      res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': b.length });
      res.end(b);
      // Log every request: without this a client that never arrives and a client
      // that is rejected look identical from the server side.
      const who = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?';
      if (!(code === 200 && req.url.startsWith('/inbox')))
        console.log(`${code} ${req.method} ${req.url.split('?')[0]} from ${who} (${Date.now() - started}ms)`);
    };
    const isRedeem = req.method === 'POST' && req.url.startsWith('/join/redeem');
    const path0 = new URL(req.url, 'http://localhost').pathname;

    // Two ways in: machines present the shared token; browsers sign in and get
    // a session cookie, so no credential ever sits in a URL or browser history.
    const cookies = sess.parseCookies(req.headers.cookie);
    const who = sess.get(cookies.mesh_sid);
    const secure = (req.headers['x-forwarded-proto'] || '') === 'https';

    const html = (code, body, extraHeaders = {}) => {
      const b = Buffer.from(body);
      res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8',
                            'Content-Length': b.length, 'Cache-Control': 'no-store',
                            ...extraHeaders });
      res.end(b);
    };
    const redirect = (to, extraHeaders = {}) => {
      res.writeHead(302, { Location: to, 'Cache-Control': 'no-store', ...extraHeaders });
      res.end();
    };
    const readForm = () => new Promise((resolve) => {
      let raw = '';
      req.on('data', (c) => { raw += c; if (raw.length > 8192) req.destroy(); });
      req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(raw))));
    });

    // --- browser auth routes (no token required) ---------------------------
    const PUBLIC = ['/login', '/setup', '/logout'];
    if (PUBLIC.includes(path0)) {
      const firstRun = users.count() === 0;
      if (path0 === '/logout') {
        sess.destroy(cookies.mesh_sid);
        return redirect('login', { 'Set-Cookie': sess.cookie('', { secure, clear: true }) });
      }
      if (req.method === 'GET') {
        if (firstRun && path0 !== '/setup') return redirect('setup');
        if (!firstRun && path0 === '/setup') return redirect('login');
        return html(200, ui.loginPage({ setup: firstRun }));
      }
      if (req.method === 'POST') {
        const form = await readForm();
        if (path0 === '/setup') {
          if (!firstRun) return redirect('login');
          try { users.create(form.username, form.password); }
          catch (e) { return html(200, ui.loginPage({ setup: true, error: e.message })); }
        }
        const u = users.authenticate(form.username, form.password);
        if (!u) return html(200, ui.loginPage({ setup: false, error: 'Invalid username or password' }));
        return redirect('.', { 'Set-Cookie': sess.cookie(sess.create(u), { secure }) });
      }
    }

    // --- dashboard ---------------------------------------------------------
    if (path0 === '/' || path0 === '/ui') {
      if (!who) return redirect(users.count() === 0 ? 'setup' : 'login');
      return html(200, ui.page(''));
    }

    // --- everything else: a signed-in browser OR the shared token -----------
    if (token && !isRedeem && !who && !safeEqual(req.headers['x-mesh-token'], token))
      return reply(401, { error: 'bad token' });

    const url = new URL(req.url, 'http://localhost');
    const q = url.searchParams;

    if (req.method === 'GET') {
      if (url.pathname === '/health') {
        prune();
        return reply(200, { ok: true, peers: peers.size, version: require('./version.js').full });
      }

      if (url.pathname === '/peers') {
        prune();
        // No group filter by default: the mesh is one directory, and `group`
        // says WHERE a session lives (which machine), not who may see it.
        const group = q.get('group');
        return reply(200, {
          peers: [...peers.values()]
            .filter((p) => !group || p.group === group)
            .map(({ token, ...safe }) => safe),   // never expose inbox tokens
        });
      }

      // Block until a reply to `id` arrives, so a sender can ask a question and
      // wait for the answer rather than polling.
      if (url.pathname === '/await') {
        const id = q.get('id');
        if (!id) return reply(400, { error: 'id required' });
        const waitMs = Math.min(Number(q.get('wait') || 60), 300) * 1000;

        const take = () => {
          const m = replies.get(id);
          if (m) { replies.delete(id); return m; }
          return null;
        };
        const first = take();
        if (first) return reply(200, { reply: first });

        const onTick = () => {
          const got = take();
          if (!got) return;
          cleanup();
          reply(200, { reply: got });
        };
        const timer = setTimeout(() => { cleanup(); reply(200, { reply: null, timeout: true }); }, waitMs);
        const cleanup = () => { clearTimeout(timer); waits.delete(onTick); };
        waits.add(onTick);
        req.on('close', cleanup);
        return;
      }

      if (url.pathname === '/routes') {
        const relay = q.get('relay');
        if (!relay) return reply(400, { error: 'relay required' });
        prune();
        const want = relay.toLowerCase();
        return reply(200, {
          routes: [...peers.values()]
            .filter((p) => String(p.relay).toLowerCase() === want)
            .map((p) => ({ name: p.name, socket: p.socket, token: p.token })),
        });
      }

      if (url.pathname === '/inbox') {
        const relay = q.get('relay');
        if (!relay) return reply(400, { error: 'relay required' });
        const waitMs = Math.min(Number(q.get('wait') || 25), 60) * 1000;

        const drain = () => {
          prune();
          requeueExpired();
          const out = [];
          for (const [n, p] of peers) {
            if (String(p.relay).toLowerCase() !== relay.toLowerCase()) continue;
            const qq = bank.get(n);
            if (qq && qq.length) { out.push(...qq); bank.delete(n); }
          }
          // Messages are LENT to the relay, not given: they stay in flight
          // until acked, so a delivery that fails or a relay that dies does
          // not silently lose them.
          for (const m of out) {
            const prev = inflight.get(m.id);
            inflight.set(m.id, {
              msg: m, relay, sentAt: Date.now(),
              attempts: (prev?.attempts || 0) + 1,
            });
          }
          return out;
        };

        const first = drain();
        if (first.length) return reply(200, { messages: first });

        const onTick = () => {
          const got = drain();
          if (!got.length) return;
          cleanup();
          reply(200, { messages: got });
        };
        const timer = setTimeout(() => { cleanup(); reply(200, { messages: [] }); }, waitMs);
        const cleanup = () => { clearTimeout(timer); waits.delete(onTick); };
        waits.add(onTick);
        req.on('close', cleanup);
        return;
      }
      return reply(404, { error: 'not found' });
    }

    if (req.method === 'POST') {
      let raw = '';
      req.on('data', (c) => {
        raw += c;
        if (raw.length > MAX_BODY * 2) req.destroy();
      });
      req.on('end', () => {
        let d;
        try { d = JSON.parse(raw || '{}'); } catch { return reply(400, { error: 'bad json' }); }

        if (url.pathname === '/register') {
          const name = String(d.name || '').trim();
          if (!name) return reply(400, { error: 'name required' });
          peers.set(name, {
            name,
            group:  String(d.group || 'default').toLowerCase(),
            host:   d.host   || '',
            cwd:    d.cwd    || '',
            socket: d.socket || '',
            relay:  String(d.relay || '').toLowerCase(),
            token:  d.token  || '',
            sessionId: d.sessionId || '',
            status: d.status || '',
            named:  !!d.named,
            version: d.version || '',
            pid:    d.pid || null,
            seen:   Date.now(),
          });
          wake();
          persist();
          return reply(200, { ok: true, name });
        }

        if (url.pathname === '/deregister') {
          peers.delete(String(d.name || '').trim());
          persist();
          return reply(200, { ok: true });
        }

        if (url.pathname === '/join/redeem') {
          const code = String(d.code || '').trim().toUpperCase();
          const rec = joins.get(code);
          if (!rec) return reply(404, { error: 'unknown or already-used join code' });
          if (Date.now() > rec.expires) { joins.delete(code); return reply(410, { error: 'join code expired' }); }
          rec.uses -= 1;
          if (rec.uses <= 0) joins.delete(code); else joins.set(code, rec);
          return reply(200, { token });
        }

        if (url.pathname === '/join/new') {
          // Minting requires the master token; the code it returns is a
          // short-lived, single-use stand-in so a new machine never needs the
          // master token pasted into a terminal or a chat log.
          const ttl = Math.min(Math.max(Number(d.ttl || 900), 60), 86_400);
          const code = randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase();
          joins.set(code, { expires: Date.now() + ttl * 1000, uses: Number(d.uses || 1) });
          return reply(200, { code, expires_in: ttl, uses: Number(d.uses || 1) });
        }

        if (url.pathname === '/ack') {
          // A relay confirms it wrote the message into the target socket. Only
          // then is the message finally discarded.
          const ids = Array.isArray(d.ids) ? d.ids : [];
          const failed = Array.isArray(d.failed) ? d.failed : [];
          let acked = 0;
          for (const id of ids) if (inflight.delete(id)) acked++;
          // An explicit failure goes back to the bank immediately rather than
          // waiting out the ack timeout.
          for (const id of failed) {
            const rec = inflight.get(id);
            if (!rec) continue;
            inflight.delete(id);
            if (rec.attempts >= MAX_ATTEMPTS) continue;
            const q = bank.get(rec.msg.to) || [];
            if (!q.some((m) => m.id === id)) { q.unshift(rec.msg); bank.set(rec.msg.to, q); }
          }
          persist();
          return reply(200, { ok: true, acked, requeued: failed.length });
        }

        if (url.pathname === '/send') {
          const to = String(d.to || '').trim();
          const body = String(d.body || '').slice(0, MAX_BODY);
          if (!to || !body) return reply(400, { error: 'to and body required' });
          prune();

          const resolved = resolveTarget(peers, to, d.toGroup);
          if (resolved.error) return reply(404, resolved);
          const target = resolved.name;

          const limited = rateCheck(String(d.from || 'unknown'), target);
          if (limited) return reply(429, { error: limited });
          const qq = bank.get(target) || [];
          if (qq.length >= MAX_BANK) return reply(429, { error: 'recipient bank full' });
          // Resolve the sender to a registered address so REPLY is actionable.
          const senderHit = resolveTarget(peers, String(d.from || ''), d.group);
          const msg = {
            id: randomUUID().slice(0, 12),
            to: target,
            from: d.from || 'unknown',
            fromAddr: senderHit.error ? '' : `${peers.get(senderHit.name)?.group}/${senderHit.name}`,
            group: d.group || 'default',
            intent: d.intent || 'inform', re: d.re || '',
            priority: d.priority === 'immediate' ? 'immediate' : 'next',
            body, ts: Date.now(),
          };
          qq.push(msg); bank.set(target, qq); wake();

          // A message answering a request is also parked by request id, so the
          // original sender can collect it without being a registered relay.
          if (msg.re) {
            replies.set(msg.re, msg);
            wake();
          }
          persist();
          return reply(200, { ok: true, id: msg.id });
        }
        return reply(404, { error: 'not found' });
      });
      return;
    }
    return reply(405, { error: 'method not allowed' });
  });

  return server;
}

if (require.main === module) {
  const port = Number(process.env.MESH_PORT || 8787);
  const host = process.env.MESH_BIND || '127.0.0.1';
  createRegistry().listen(port, host, () =>
    console.log(`claude-mesh registry ${host}:${port} (auth on)`));
}

module.exports = { createRegistry };
