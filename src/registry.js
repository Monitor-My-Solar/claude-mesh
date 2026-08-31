'use strict';
/**
 * registry.js — LAN directory + message bank.
 *
 * Sessions register through their machine's relay; messages are banked per
 * recipient until that relay long-polls for them. Stdlib only, so it runs
 * anywhere Node does.
 */
const http = require('http');
const { randomUUID, timingSafeEqual } = require('crypto');

/** Constant-time string compare, so the token can't be recovered by timing. */
function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && timingSafeEqual(x, y);
}

const STALE_MS  = Number(process.env.MESH_STALE_MS  || 15 * 60_000);
const MAX_BANK  = Number(process.env.MESH_MAX_BANK  || 50);
const MAX_BODY  = Number(process.env.MESH_MAX_BODY  || 16_384);

function createRegistry({ token = process.env.MESH_TOKEN || '', allowInsecure = process.env.MESH_ALLOW_INSECURE === '1' } = {}) {
  if (!token && !allowInsecure) {
    throw new Error(
      'MESH_TOKEN is required: the registry injects messages into live Claude sessions, ' +
      'so it must never run unauthenticated. Set MESH_TOKEN, or MESH_ALLOW_INSECURE=1 to override.');
  }
  const peers = new Map();   // name -> peer
  const bank  = new Map();   // name -> [msg]
  const waits = new Set();   // pending long-polls

  const prune = () => {
    const cutoff = Date.now() - STALE_MS;
    for (const [n, p] of peers) if (p.seen < cutoff) peers.delete(n);
  };

  const wake = () => {
    for (const w of [...waits]) w();
  };

  const server = http.createServer((req, res) => {
    const reply = (code, obj) => {
      const b = Buffer.from(JSON.stringify(obj));
      res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': b.length });
      res.end(b);
    };
    if (token && !safeEqual(req.headers['x-mesh-token'], token)) return reply(401, { error: 'bad token' });

    const url = new URL(req.url, 'http://localhost');
    const q = url.searchParams;

    if (req.method === 'GET') {
      if (url.pathname === '/health') { prune(); return reply(200, { ok: true, peers: peers.size }); }

      if (url.pathname === '/peers') {
        prune();
        const group = q.get('group');
        return reply(200, {
          peers: [...peers.values()]
            .filter((p) => !group || p.group === group)
            .map(({ token, ...safe }) => safe),   // never expose inbox tokens
        });
      }

      if (url.pathname === '/routes') {
        const relay = q.get('relay');
        if (!relay) return reply(400, { error: 'relay required' });
        prune();
        return reply(200, {
          routes: [...peers.values()]
            .filter((p) => p.relay === relay)
            .map((p) => ({ name: p.name, socket: p.socket, token: p.token })),
        });
      }

      if (url.pathname === '/inbox') {
        const relay = q.get('relay');
        if (!relay) return reply(400, { error: 'relay required' });
        const waitMs = Math.min(Number(q.get('wait') || 25), 60) * 1000;

        const drain = () => {
          prune();
          const out = [];
          for (const [n, p] of peers) {
            if (p.relay !== relay) continue;
            const qq = bank.get(n);
            if (qq && qq.length) { out.push(...qq); bank.delete(n); }
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
            group:  d.group  || 'default',
            host:   d.host   || '',
            cwd:    d.cwd    || '',
            socket: d.socket || '',
            relay:  d.relay  || '',
            token:  d.token  || '',
            sessionId: d.sessionId || '',
            seen:   Date.now(),
          });
          wake();
          return reply(200, { ok: true, name });
        }

        if (url.pathname === '/deregister') {
          peers.delete(String(d.name || '').trim());
          return reply(200, { ok: true });
        }

        if (url.pathname === '/send') {
          const to = String(d.to || '').trim();
          const body = String(d.body || '').slice(0, MAX_BODY);
          if (!to || !body) return reply(400, { error: 'to and body required' });
          prune();
          if (!peers.has(to)) return reply(404, { error: `unknown peer '${to}'` });
          const qq = bank.get(to) || [];
          if (qq.length >= MAX_BANK) return reply(429, { error: 'recipient bank full' });
          const msg = {
            id: randomUUID().slice(0, 12),
            to, from: d.from || 'unknown', group: d.group || 'default',
            intent: d.intent || 'inform', re: d.re || '',
            body, ts: Date.now(),
          };
          qq.push(msg); bank.set(to, qq); wake();
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
