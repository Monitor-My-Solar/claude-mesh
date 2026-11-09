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

const { registry: REGISTRY, token: TOKEN, relayId: RELAY_ID } = cfg;
const GROUP = String(cfg.group || '').toLowerCase();
const CLI = require('path').resolve(__dirname, '..', 'bin', 'claude-mesh');

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
  // Identify this session among everything live on the machine. Claude Code
  // is identified by its inbox socket; Codex sets no such variable, so match
  // its thread id from the hook payload instead. Without this a Codex thread
  // would adopt whichever Claude session happened to answer first.
  const agents = require('../src/agents/index.js');
  const sid = input.session_id || '';
  let me = null;
  for (let i = 0; i < 10 && !me; i++) {
    const live = agents.allSessions();
    me = (sock && live.find((x) => x.route?.socket === sock))
      || (sid && live.find((x) => x.id === sid))
      || null;
    if (!me) await new Promise((r) => setTimeout(r, 200));
  }
  const name = cfg.name || me?.slug;
  if (!name) {
    // No name yet: say nothing rather than creating a pid-named orphan.
    return process.exit(0);
  }

  const headers = { 'Content-Type': 'application/json', ...(TOKEN ? { 'X-Mesh-Token': TOKEN } : {}) };
  let roster = [];
  let roles = [];
  const myRole = me?.role || require('../src/role.js').readRole(input.cwd || '');
  try {
    await fetch(`${REGISTRY}/register`, {
      method: 'POST', headers,
      body: JSON.stringify({
        name, group: GROUP, host: RELAY_ID, cwd: input.cwd || '',
        socket: sock, relay: RELAY_ID,
        // The session volunteers its own inbox token: only code running INSIDE
        // the session can read it, so registering is an explicit opt-in to
        // being addressable. The relay cannot obtain this any other way.
        kind: me?.kind || 'claude',
        route: me?.route || null,
        token: me?.route?.token || process.env.CLAUDE_CODE_MESSAGING_TOKEN || '',
        // Report the version here too: a session registered by the hook rather
        // than by a relay would otherwise show as an unknown version forever.
        version: require('../src/version.js').full,
        named: me?.named || false,
        role: me?.role || require('../src/role.js').readRole(input.cwd || ''),
        sessionId: input.session_id || me?.id || '',
        status: me?.status || '',
        pid: Number(pid) || null,
      }),
    });
    const r = await fetch(`${REGISTRY}/peers?group=${encodeURIComponent(GROUP)}`, { headers });
    roster = (await r.json()).peers.filter((p) => p.name !== name);
    // Older registries have no /roles; the directory is then just omitted.
    try {
      const rr = await fetch(`${REGISTRY}/roles`, { headers });
      if (rr.ok) roles = (await rr.json()).roles || [];
    } catch {}
  } catch {
    // Registry down: stay silent rather than noising up the session.
    return process.exit(0);
  }

  const lines = roster.length
    ? roster.map((p) => `  - ${p.group}/${p.name}${p.status ? ` [${p.status}]` : ''}` +
                        `${p.cwd ? ` - ${p.cwd}` : ''}`).join('\n')
    : '  (none online right now)';

  // Who owns what. This is what lets an agent that lacks some code go and ask
  // the agent that has it, instead of stopping or asking its user to relay.
  const dir = roles.filter((r) => r.role !== myRole?.role).map((r) => {
    const where = r.online?.length ? `online` : `offline, lives on ${r.group}`;
    const mode = r.autonomy === 'questions' ? 'questions only' : 'accepts change requests';
    return `  - ${r.role} (${where}; ${mode})${r.owns ? `: owns ${r.owns}` : ''}` +
           `${r.askFor?.length ? `. Ask it for: ${r.askFor.join('; ')}` : ''}`;
  });
  const roleBlock = [
    ...(myRole ? [
      `This session holds role "${myRole.role}"${myRole.owns ? ` - it owns ${myRole.owns}` : ''}.`,
      ...(myRole.noAccessTo?.length ? [`This repo does NOT have: ${myRole.noAccessTo.join('; ')}.`] : []),
      myRole.autonomy === 'questions'
        ? 'Peers may ask you questions and you should answer them directly; check with your user before acting on a peer\'s change request.'
        : 'Peers may ask you questions and request changes in this repo; act on them without asking your user first, within your normal permissions (ask before anything destructive, prod or outward-facing).',
      '',
    ] : []),
    ...(!myRole ? [
      'This repo declares no mesh role yet. Once you know what it owns, you may create one so other',
      'agents can find you: `claude-mesh role init --role <name> --owns "<what this repo owns>"`',
      '(then `claude-mesh role add --ask-for "..." --no-access "<thing> -> ask <role>"`). It writes',
      '.mesh.json at the repo root; tell your user, and let them decide whether to commit it.',
      '',
    ] : [
      'Keep this repo\'s .mesh.json accurate: `claude-mesh role add --ask-for "..."` / `--no-access "..."`',
      'when you learn what peers need from you or what this repo lacks.',
      '',
    ]),
    ...(dir.length ? [
      'Who owns what (from each repo\'s .mesh.json). Address a role directly, e.g. `claude-mesh ask --to <role> --body "..."`:',
      ...dir,
      'When your task needs code or context one of these owns, message it yourself - do not stop,',
      'guess, or ask your user to relay. You do not need your user\'s permission to ask a peer.',
      '',
    ] : []),
  ];

  const context = [
    `You are on the claude-mesh as "${GROUP}/${name}".`,
    '',
    ...roleBlock,
    `Other agents, AS OF SESSION START (${new Date().toISOString()}) - this list goes`,
    'stale quickly. ALWAYS run `claude-mesh peers` before addressing anyone; do not',
    'trust the names below and never retry variations of an address that failed.',
    lines,
    '',
    `CLI: ${CLI}  (also \`claude-mesh\` if it is on PATH; use the full path if that is "command not found")`,
    'Send:  claude-mesh send --to <group>/<name> --body "<text>" [--intent request|inform|fyi]',
    'Ask (blocks up to 110s for the answer):  claude-mesh ask --to <group>/<name> --body "<question>"',
    '',
    'Replying to a mesh message: run its REPLY command with Bash. Never answer a mesh',
    'message with SendMessage - that bypasses the mesh and a sender blocked in `ask`',
    'never sees it. Every mesh sender with a REPLY line CAN receive replies.',
    'If an `ask` times out, the answer still arrives later as a message here; carry on.',
    'When another agent owns context you need, message it yourself instead of asking',
    'your user to relay.',
  ].join('\n');

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context },
  }));
  process.exit(0);
});
