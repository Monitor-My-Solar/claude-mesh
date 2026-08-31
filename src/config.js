'use strict';
/**
 * config.js — persistent mesh config at ~/.claude-mesh/config.json.
 *
 * Written by `claude-mesh configure`, read by the hooks and the CLI. Env vars
 * always win, so a single session can be pointed elsewhere without touching
 * the file.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR  = process.env.MESH_CONFIG_DIR || path.join(os.homedir(), '.claude-mesh');
const FILE = path.join(DIR, 'config.json');

function load() {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
  return {
    registry: process.env.MESH_REGISTRY || file.registry || 'http://127.0.0.1:8787',
    token:    process.env.MESH_TOKEN    || file.token    || '',
    relayId:  process.env.MESH_RELAY_ID || file.relayId  || os.hostname(),
    // A group is a place, so it defaults to this machine. Sessions on the mac
    // mini land in "macmini" without anyone configuring it.
    group:    process.env.MESH_GROUP    || file.group    ||
              (process.env.MESH_RELAY_ID || file.relayId || os.hostname()).toLowerCase(),
    name:     process.env.MESH_NAME     || file.name     || '',
  };
}

function save(patch) {
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
  const next = { ...cur, ...patch };
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  return next;
}

module.exports = { load, save, FILE, DIR };
