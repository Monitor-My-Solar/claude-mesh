#!/usr/bin/env node
'use strict';
/** SessionEnd hook — remove this session from the mesh roster. */
const cfg = require('../src/config.js').load();

const { registry: REGISTRY, token: TOKEN, relayId: RELAY_ID } = cfg;

const sock = process.env.CLAUDE_CODE_MESSAGING_SOCKET || '';
const pid  = sock.match(/(\d+)\.sock$/)?.[1] || String(process.ppid);
const { localSessions } = require('../src/discover.js');
const name = cfg.name || localSessions().find((x) => x.socket === sock)?.slug || String(pid);

fetch(`${REGISTRY}/deregister`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(TOKEN ? { 'X-Mesh-Token': TOKEN } : {}) },
  body: JSON.stringify({ name }),
}).catch(() => {}).finally(() => process.exit(0));
