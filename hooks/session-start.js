#!/usr/bin/env node
'use strict';
/**
 * SessionStart hook — announce this session to the mesh and inject the roster.
 *
 * Wire up in settings.json:
 *   "SessionStart": [{ "hooks": [{ "type": "command",
 *      "command": "node /path/to/claude-mesh/hooks/session-start.js" }] }]
 */
const os = require('os');

const REGISTRY = process.env.MESH_REGISTRY || 'http://127.0.0.1:8787';
const TOKEN    = process.env.MESH_TOKEN || '';
const RELAY_ID = process.env.MESH_RELAY_ID || os.hostname();
const GROUP    = process.env.MESH_GROUP || 'default';

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', async () => {
  let input = {};
  try { input = JSON.parse(raw || '{}'); } catch {}

  const sock = process.env.CLAUDE_CODE_MESSAGING_SOCKET || '';
  const pid  = sock.match(/(\d+)\.sock$/)?.[1] || String(process.ppid);
  const name = process.env.MESH_NAME || `${RELAY_ID}/${pid}`;

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
        sessionId: input.session_id || '',
      }),
    });
    const r = await fetch(`${REGISTRY}/peers?group=${encodeURIComponent(GROUP)}`, { headers });
    roster = (await r.json()).peers.filter((p) => p.name !== name);
  } catch {
    // Registry down: stay silent rather than noising up the session.
    return process.exit(0);
  }

  const lines = roster.length
    ? roster.map((p) => `  - ${p.name} (${p.host}${p.cwd ? `, ${p.cwd}` : ''})`).join('\n')
    : '  (no other agents online)';

  const context = [
    `You are on the claude-mesh as "${name}" in group "${GROUP}".`,
    '',
    'Other agents online:',
    lines,
    '',
    'To message one:  cc-mesh send --to <name> --body "<text>" [--intent request|inform|reply-needed|fyi]',
    'Messages arrive as <cross-session-message> with FROM / INTENT / REPLY lines; reply with the REPLY command.',
  ].join('\n');

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context },
  }));
  process.exit(0);
});
