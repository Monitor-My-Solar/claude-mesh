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

/**
 * Install the relay as a user service so a machine stays reachable across
 * reboots. Without this the relay is a terminal someone has to remember to
 * start, and a machine silently drops off the mesh when it is closed.
 */
/**
 * Link the mesh skill into ~/.claude/skills so sessions learn the conventions
 * (naming, intents, etiquette) without any of it sitting in CLAUDE.md. A skill
 * costs nothing until it is invoked.
 */
function installSkill({ dryRun = false } = {}) {
  const src = path.join(__dirname, '..', 'skills', 'mesh');
  const dstDir = path.join(os.homedir(), '.claude', 'skills');
  const dst = path.join(dstDir, 'mesh');
  if (!dryRun) {
    fs.mkdirSync(dstDir, { recursive: true });
    try { fs.rmSync(dst, { recursive: true, force: true }); } catch {}
    fs.cpSync(src, dst, { recursive: true });
  }
  return { src, dst };
}

function installService({ dryRun = false } = {}) {
  const bin = path.join(__dirname, '..', 'bin', 'claude-mesh');
  const node = process.execPath;

  if (process.platform === 'darwin') {
    const label = 'dev.claude-mesh.relay';
    const dir = path.join(os.homedir(), 'Library', 'LaunchAgents');
    const file = path.join(dir, `${label}.plist`);
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>
    <string>${node}</string><string>${bin}</string><string>relay</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${path.join(os.homedir(), 'Library/Logs/claude-mesh-relay.log')}</string>
  <key>StandardErrorPath</key><string>${path.join(os.homedir(), 'Library/Logs/claude-mesh-relay.log')}</string>
</dict></plist>
`;
    if (!dryRun) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, plist);
    }
    return { platform: 'darwin', file, label,
             reload: [`launchctl unload ${file} 2>/dev/null || true`,
                      `launchctl load -w ${file}`] };
  }

  const dir = path.join(os.homedir(), '.config', 'systemd', 'user');
  const file = path.join(dir, 'claude-mesh-relay.service');
  const unit = `[Unit]
Description=claude-mesh relay
After=network-online.target

[Service]
Type=simple
ExecStart=${node} ${bin} relay
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
`;
  if (!dryRun) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, unit);
  }
  return { platform: 'linux', file,
           reload: ['systemctl --user daemon-reload',
                    'systemctl --user enable --now claude-mesh-relay',
                    'systemctl --user restart claude-mesh-relay'] };
}

/** Write the service file and (re)start it, so an upgrade needs no ceremony. */
function applyService() {
  const r = installService();
  const { execSync } = require('child_process');
  const ran = [];
  for (const cmd of r.reload || []) {
    try { execSync(cmd, { stdio: 'ignore' }); ran.push(cmd); }
    catch { /* report below rather than failing the whole install */ }
  }
  return { ...r, ran, ok: ran.length === (r.reload || []).length };
}

module.exports = { install, uninstall, installService, applyService, installSkill, SETTINGS };
