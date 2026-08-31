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

const VERSION = require('./version.js');
const cfg = require('./config.js').load();
const { registry: REGISTRY, token: TOKEN, relayId: RELAY_ID, group: GROUP } = cfg;

const headers = () => ({
  'Content-Type': 'application/json',
  ...(TOKEN ? { 'X-Mesh-Token': TOKEN } : {}),
});

async function api(path, opts = {}) {
  const res = await fetch(REGISTRY + path, { headers: headers(), ...opts });
  if (!res.ok) {
    // A proxy returns an HTML error page when the registry is restarting;
    // dumping that into the log buries the real cause.
    const raw = await res.text().catch(() => '');
    const brief = raw.trim().startsWith('<') ? '(proxy error page)' : raw.slice(0, 200);
    throw new Error(`${path} -> ${res.status} ${brief}`);
  }
  return res.json();
}

/**
 * Sessions are named by the mesh, not by Claude Code: <relay>/<pid>. A session
 * can override this by exporting MESH_NAME before it starts.
 */
function sessionName(s) {
  return s.slug || String(s.pid);
}

/**
 * Re-register every live local session under its current name and status. This
 * is what keeps the roster correct across /rename and busy/idle transitions,
 * since the SessionStart hook only fires once.
 */
const lastSeenLocal = new Set();   // names we registered on the previous pass

async function refreshLocal() {
  const live = localSessions();
  const names = new Set(live.map(sessionName));

  // Deregister sessions that have gone away, so the roster reflects reality
  // rather than waiting out the registry's staleness window.
  for (const gone of [...lastSeenLocal].filter((n) => !names.has(n))) {
    await api('/deregister', { method: 'POST', body: JSON.stringify({ name: gone }) })
      .then(() => console.log(`[relay] deregistered ${gone} (session ended)`))
      .catch(() => {});
    lastSeenLocal.delete(gone);
  }

  for (const s of live) {
    lastSeenLocal.add(sessionName(s));
    await api('/register', {
      method: 'POST',
      body: JSON.stringify({
        name: sessionName(s), group: GROUP, host: RELAY_ID, cwd: s.cwd || '',
        socket: s.socket, relay: RELAY_ID,
        sessionId: s.sessionId || '', status: s.status || '', pid: s.pid,
        token: s.token || '', named: !!s.named, version: VERSION.full,
      }),
    }).catch(() => {});
  }
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

/**
 * Self-update: check the registry's version periodically and pull when this
 * machine is behind. Opt-out via MESH_AUTO_UPDATE=0 - some people will want to
 * pin a version, and silently changing code on someone's machine is a decision
 * they should be able to decline.
 */
async function autoUpdate() {
  if (process.env.MESH_AUTO_UPDATE === '0') return;
  let health;
  try { health = await api('/health'); } catch { return; }
  if (!health.version || health.version === VERSION.full) return;

  const { execSync } = require('child_process');
  const root = VERSION.root;
  if (!require('fs').existsSync(require('path').join(root, '.git'))) return;

  console.log(`[relay] registry is ${health.version}, this machine is ${VERSION.full}: updating`);
  try {
    execSync('git fetch --quiet origin main && git reset --quiet --hard origin/main',
             { cwd: root, stdio: 'ignore' });
    const inst = require('./install.js');
    inst.installSkill();
    inst.install();
    console.log('[relay] updated; restarting to pick up the new code');
    process.exit(0);          // the service manager restarts us
  } catch (e) {
    console.error('[relay] self-update failed:', e.message);
  }
}

async function main() {
  console.log(`[relay] ${RELAY_ID} -> ${REGISTRY} (group ${GROUP})`);
  await refreshLocal();
  const n = await announce();
  console.log(`[relay] registered ${n} session(s)`);
  setInterval(() => announce().catch(() => {}), 30_000);
  let backoff = 1000;
  for (;;) {
    try {
      await pump();
      backoff = 1000;                       // healthy again
    } catch (e) {
      console.error('[relay] poll error:', e.message);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30_000);   // back off, but always retry
    }
  }
}

if (require.main === module) main();
module.exports = { main, announce, pump, sessionName };
