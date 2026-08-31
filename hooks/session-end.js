#!/usr/bin/env node
'use strict';
/** SessionEnd hook — remove this session from the mesh roster. */
const os = require('os');

const REGISTRY = process.env.MESH_REGISTRY || 'http://127.0.0.1:8787';
const TOKEN    = process.env.MESH_TOKEN || '';
const RELAY_ID = process.env.MESH_RELAY_ID || os.hostname();

const sock = process.env.CLAUDE_CODE_MESSAGING_SOCKET || '';
const pid  = sock.match(/(\d+)\.sock$/)?.[1] || String(process.ppid);
const name = process.env.MESH_NAME || `${RELAY_ID}/${pid}`;

fetch(`${REGISTRY}/deregister`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(TOKEN ? { 'X-Mesh-Token': TOKEN } : {}) },
  body: JSON.stringify({ name }),
}).catch(() => {}).finally(() => process.exit(0));
