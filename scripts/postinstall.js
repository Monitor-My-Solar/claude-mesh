#!/usr/bin/env node
'use strict';
/**
 * postinstall — refresh the parts of an install that live outside node_modules.
 *
 * Config in ~/.claude-mesh/config.json is never touched: an upgrade must not
 * ask anyone to re-enter a registry URL or token. We only refresh the skill,
 * the hooks and the service, and only if this machine was already configured.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

if (process.env.MESH_NO_POSTINSTALL === '1') process.exit(0);

const configured = fs.existsSync(path.join(os.homedir(), '.claude-mesh', 'config.json'));
if (!configured) {
  console.log('\nclaude-mesh installed. Set it up with:\n' +
              '  claude-mesh configure --ip https://<registry-host> --token <token>\n');
  process.exit(0);
}

try {
  const inst = require('../src/install.js');
  inst.installSkill();
  inst.install();
  const sv = inst.applyService();
  console.log('claude-mesh upgraded: skill, hooks and service refreshed' +
              (sv.ok ? ' (relay restarted).' : '; start the relay with `claude-mesh service`.'));
} catch (e) {
  console.log(`claude-mesh: post-install refresh skipped (${e.message}).`);
  console.log('run `claude-mesh upgrade` to finish.');
}
