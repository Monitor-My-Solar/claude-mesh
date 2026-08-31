'use strict';
/**
 * relay.js — per-machine agent.
 *
 * Registers this machine's live sessions with the registry, long-polls for
 * messages addressed to them, and delivers each straight into the target
 * session's inbox socket. Delivery costs no model inference.
 */
const os = require('os');
const { deliver, isAlive } = require('./peer.js');
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
    for (const r of rows) {
      if (!r.socket || !r.token) continue;
      const pid = Number.parseInt(String(r.socket).match(/(\d+)\.sock$/)?.[1] ?? '', 10);
      routes.set(r.name, { ...r, pid: Number.isNaN(pid) ? null : pid });
    }

    // Re-post anything the registry has forgotten. Registration normally happens
    // in each session's SessionStart hook, which won't fire again until that
    // session restarts, so without this a registry restart silently orphans
    // every live session.
    const known = new Set(rows.map((r) => r.name));
    for (const [name, r] of routes) {
      if (known.has(name)) continue;
      if (!isAlive(r.pid)) { routes.delete(name); continue; }
      await api('/register', {
        method: 'POST',
        body: JSON.stringify({
          name, group: GROUP, host: RELAY_ID, cwd: r.cwd || '',
          socket: r.socket, relay: RELAY_ID, token: r.token,
        }),
      }).then(() => console.log(`[relay] re-registered ${name}`))
        .catch((e) => console.error(`[relay] re-register ${name} failed:`, e.message));
    }

    // Drop routes for sessions that have exited.
    for (const [name, r] of routes) if (!isAlive(r.pid)) routes.delete(name);
    return routes.size;
  } catch (e) {
    console.error('[relay] route refresh failed:', e.message);
    return routes.size;
  }
}

function envelopeFor(m) {
  // Prefer the sender's resolvable address: --from is a free-text label and may
  // not name a registered peer, in which case a REPLY built from it fails.
  const replyTo = m.fromAddr || m.from;
  const head = [
    `FROM: ${m.from}${m.fromAddr && m.fromAddr !== m.from ? ` (${m.fromAddr})` : ''}`,
    `INTENT: ${m.intent}`,
    ...(m.re ? [`RE: ${m.re}`] : []),
    ...(m.fromAddr ? [`REPLY: claude-mesh send --to ${replyTo} --re ${m.id}`]
                   : ['REPLY: (sender is not a registered peer; run `claude-mesh peers`)']),
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
        // 'immediate' asks the receiving session to surface the message as soon
        // as it can rather than waiting for its next turn.
        priority: m.priority === 'immediate' ? 'immediate' : 'next',
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
