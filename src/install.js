'use strict';
/**
 * install.js — wire the mesh hooks into Claude Code's global settings.
 *
 * Adds SessionStart / SessionEnd entries to ~/.claude/settings.json, preserving
 * any hooks already configured there. Idempotent: re-running replaces only the
 * mesh's own entries, which are tagged by their command path.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const SETTINGS = process.env.CLAUDE_SETTINGS
  || path.join(os.homedir(), '.claude', 'settings.json');
const HOOK_DIR = path.join(__dirname, '..', 'hooks');
const MARK = 'claude-mesh';

const entry = (script) => ({
  hooks: [{ type: 'command', command: `node ${path.join(HOOK_DIR, script)}`, timeout: 10 }],
});

const isMesh = (e) =>
  JSON.stringify(e).includes(MARK) || (e.hooks || []).some((h) => String(h.command || '').includes(MARK));

function install({ dryRun = false, acceptInbound = false } = {}) {
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch {}

  // Without this, some permission modes HOLD an inbound peer message for the
  // user to approve instead of delivering it, so a mesh message can sit unseen
  // in an idle session. Opt-in, because it lets any peer start a turn here.
  if (acceptInbound) settings.crossSessionInbound = 'accept';

  settings.hooks ||= {};
  for (const [event, script] of [['SessionStart', 'session-start.js'], ['SessionEnd', 'session-end.js']]) {
    const existing = (settings.hooks[event] || []).filter((e) => !isMesh(e));
    settings.hooks[event] = [...existing, entry(script)];
  }

  if (!dryRun) {
    fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
    if (fs.existsSync(SETTINGS)) fs.copyFileSync(SETTINGS, SETTINGS + '.mesh-backup');
    fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
  }
  return { settingsPath: SETTINGS, hooks: Object.keys(settings.hooks),
           crossSessionInbound: settings.crossSessionInbound || '(unset)' };
}

function uninstall() {
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch { return { removed: 0 }; }
  let removed = 0;
  for (const event of ['SessionStart', 'SessionEnd']) {
    const before = (settings.hooks?.[event] || []).length;
    if (settings.hooks?.[event]) {
      settings.hooks[event] = settings.hooks[event].filter((e) => !isMesh(e));
      removed += before - settings.hooks[event].length;
      if (!settings.hooks[event].length) delete settings.hooks[event];
    }
  }
  fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
  return { removed, settingsPath: SETTINGS };
}

module.exports = { install, uninstall, SETTINGS };
