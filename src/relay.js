'use strict';
/**
 * relay.js — per-machine agent.
 *
 * Registers this machine's live sessions with the registry, long-polls for
 * messages addressed to them, and delivers each straight into the target
 * session's inbox socket. Delivery costs no model inference.
 */
const os = require('os');
const { deliver } = require('./peer.js');
const { localSessions } = require('./discover.js');

const cfg = require('./config.js').load();
const { registry: REGISTRY, token: TOKEN, relayId: RELAY_ID, group: GROUP } = cfg;

const headers = () => ({
  'Content-Type': 'application/json',
  ...(TOKEN ? { 'X-Mesh-Token': TOKEN } : {}),
});

async function api(path, opts = {}) {
  const res = await fetch(REGISTRY + path, { headers: headers(), ...opts });
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

/**
 * Sessions are named by the mesh, not by Claude Code: <relay>/<pid>. A session
 * can override this by exporting MESH_NAME before it starts.
 */
function sessionName(s) {
  return `${RELAY_ID}/${s.pid}`;
}

const routes = new Map();   // mesh name -> {socket, token}

/**
 * Refresh routes from the registry. Sessions register themselves (with their
 * own inbox token) from their SessionStart hook; the relay never invents a
 * route from a bare pid, because a pid alone cannot yield a valid token and
 * mis-mapping a name delivers into the wrong session.
 */
async function announce() {
  try {
    const { routes: rows } = await api(`/routes?relay=${encodeURIComponent(RELAY_ID)}`);
    routes.clear();
    for (const r of rows) if (r.socket && r.token) routes.set(r.name, r);
    return routes.size;
  } catch (e) {
    console.error('[relay] route refresh failed:', e.message);
    return routes.size;
  }
}

function envelopeFor(m) {
  const head = [
    `FROM: ${m.from}`,
    `INTENT: ${m.intent}`,
    ...(m.re ? [`RE: ${m.re}`] : []),
    `REPLY: claude-mesh send --to ${m.from} --re ${m.id}`,
  ].join('\n');
  return `${head}\n\n${m.body}`;
}

async function pump() {
  const { messages } = await api(`/inbox?relay=${encodeURIComponent(RELAY_ID)}&wait=25`);
  for (const m of messages) {
    const target = routes.get(m.to);
    if (!target) {
      console.error(`[relay] UNDELIVERED ${m.id}: no route for ${m.to} ` +
                    '(is its SessionStart hook installed?)');
      continue;
    }
    if (!target.token) {
      console.error(`[relay] UNDELIVERED ${m.id}: no inbox token for ${m.to}`);
      continue;
    }
    try {
      await deliver({
        socketPath: target.socket,
        token: target.token,               // the recipient's own token
        body: envelopeFor(m),
        fromName: `mesh:${m.from}`,
      });
      // The inbox socket never acknowledges, so a clean write is NOT proof of
      // delivery — a frame with a stale token is dropped silently. Say so.
      console.log(`[relay] wrote ${m.id} -> ${m.to} (unacknowledged by design)`);
    } catch (e) {
      console.error(`[relay] UNDELIVERED ${m.id} -> ${m.to}:`, e.message);
    }
  }
}

async function main() {
  console.log(`[relay] ${RELAY_ID} -> ${REGISTRY} (group ${GROUP})`);
  const n = await announce();
  console.log(`[relay] registered ${n} session(s)`);
  setInterval(() => announce().catch(() => {}), 30_000);
  for (;;) {
    try { await pump(); }
    catch (e) { console.error('[relay] poll error:', e.message); await new Promise(r => setTimeout(r, 3000)); }
  }
}

if (require.main === module) main();
module.exports = { main, announce, pump, sessionName };
