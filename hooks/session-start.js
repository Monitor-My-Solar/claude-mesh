#!/usr/bin/env node
'use strict';
/**
 * SessionStart hook — announce this session to the mesh and inject the roster.
 *
 * Wire up in settings.json:
 *   "SessionStart": [{ "hooks": [{ "type": "command",
 *      "command": "node /path/to/claude-mesh/hooks/session-start.js" }] }]
 */
const cfg = require('../src/config.js').load();

const { registry: REGISTRY, token: TOKEN, relayId: RELAY_ID, group: GROUP } = cfg;

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', async () => {
  let input = {};
  try { input = JSON.parse(raw || '{}'); } catch {}

  const sock = process.env.CLAUDE_CODE_MESSAGING_SOCKET || '';
  const pid  = sock.match(/(\d+)\.sock$/)?.[1] || String(process.ppid);

  // SessionStart can fire before Claude Code has written this session's file,
  // so the name may not be resolvable yet. Registering under the bare pid then
  // leaves an orphan the relay never reconciles - it registers the same session
  // under its real name and has no idea the pid entry refers to it. Wait
  // briefly for the name, and if it never appears, leave registration to the
  // relay (which runs every 15s and always has the real name).
  const { localSessions } = require('../src/discover.js');
  let me = null;
  for (let i = 0; i < 10 && !me; i++) {
    me = localSessions().find((x) => x.socket === sock) || null;
    if (!me) await new Promise((r) => setTimeout(r, 200));
  }
  const name = cfg.name || me?.slug;
  if (!name) {
    // No name yet: say nothing rather than creating a pid-named orphan.
    return process.exit(0);
  }

  const headers = { 'Content-Type': 'application/json', ...(TOKEN ? { 'X-Mesh-Token': TOKEN } : {}) };
  let roster = [];
  try {
    await fetch(`${REGISTRY}/register`, {
      method: 'POST', headers,
      body: JSON.stringify({
        name, group: GROUP, host: RELAY_ID, cwd: input.cwd || '',
        socket: sock, relay: RELAY_ID,
        // The session volunteers its own inbox token: only code running INSIDE
        // the session can read it, so registering is an explicit opt-in to
        // being addressable. The relay cannot obtain this any other way.
        token: process.env.CLAUDE_CODE_MESSAGING_TOKEN || '',
        // Report the version here too: a session registered by the hook rather
        // than by a relay would otherwise show as an unknown version forever.
        version: require('../src/version.js').full,
        named: me?.named || false,
        sessionId: input.session_id || me?.sessionId || '',
        status: me?.status || '',
        pid: Number(pid) || null,
      }),
    });
    const r = await fetch(`${REGISTRY}/peers?group=${encodeURIComponent(GROUP)}`, { headers });
    roster = (await r.json()).peers.filter((p) => p.name !== name);
  } catch {
    // Registry down: stay silent rather than noising up the session.
    return process.exit(0);
  }

  const lines = roster.length
    ? roster.map((p) => `  - ${p.group}/${p.name}${p.status ? ` [${p.status}]` : ''}` +
                        `${p.cwd ? ` - ${p.cwd}` : ''}`).join('\n')
    : '  (none online right now)';

  const context = [
    `You are on the claude-mesh as "${GROUP}/${name}".`,
    '',
    `Other agents, AS OF SESSION START (${new Date().toISOString()}) - this list goes`,
    'stale quickly. ALWAYS run `claude-mesh peers` before addressing anyone; do not',
    'trust the names below and never retry variations of an address that failed.',
    lines,
    '',
    'Send:  claude-mesh send --to <group>/<name> --body "<text>" [--intent request|inform|fyi]',
    'Ask (blocks for the answer):  claude-mesh ask --to <group>/<name> --body "<question>"',
    'Incoming messages carry FROM / INTENT / REPLY lines; reply with the REPLY command verbatim.',
  ].join('\n');

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context },
  }));
  process.exit(0);
});
