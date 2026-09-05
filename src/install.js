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
  const installed = [];

  // Claude Code, and Codex when it is present: same skill content, worded for
  // each client's naming. A Codex session that cannot see the mesh commands
  // can be delivered TO but can never reply or start a conversation.
  const targets = [
    { home: path.join(os.homedir(), '.claude'), src: path.join(__dirname, '..', 'skills', 'mesh') },
    { home: codexHome(), src: path.join(__dirname, '..', 'skills-codex', 'mesh'), optional: true },
  ];

  for (const t of targets) {
    if (t.optional && !fs.existsSync(t.home)) continue;
    if (!fs.existsSync(t.src)) continue;
    const dst = path.join(t.home, 'skills', 'mesh');
    if (!dryRun) {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      try { fs.rmSync(dst, { recursive: true, force: true }); } catch {}
      fs.cpSync(t.src, dst, { recursive: true });
    }
    installed.push(dst);
  }
  return { installed, dst: installed[0] };
}

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

/**
 * Register the mesh hooks with Codex. Codex uses the same hook events and the
 * same stdin-JSON contract as Claude Code, so the hook scripts are shared; only
 * the config file differs. Existing hooks are preserved.
 */
function installCodexHooks({ dryRun = false } = {}) {
  const home = codexHome();
  if (!fs.existsSync(home)) return { skipped: 'codex not installed' };

  const file = path.join(home, 'hooks.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  cfg.hooks ||= {};

  const dir = path.join(__dirname, '..', 'hooks');
  const entry = (script) => ({
    hooks: [{ type: 'command', command: `node ${path.join(dir, script)}`, timeout: 10 }],
  });
  const isMesh = (e) => JSON.stringify(e).includes(MARK);

  for (const [event, script] of [['SessionStart', 'session-start.js'], ['SessionEnd', 'session-end.js']]) {
    const kept = (cfg.hooks[event] || []).filter((e) => !isMesh(e));
    cfg.hooks[event] = [...kept, entry(script)];
  }

  if (!dryRun) {
    if (fs.existsSync(file)) fs.copyFileSync(file, file + '.mesh-backup');
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  }
  // Codex trusts hooks by hash and skips changed ones until re-trusted, so an
  // update needs the user to approve them again in Codex.
  return { file, events: ['SessionStart', 'SessionEnd'], note: 'codex may ask you to re-trust these hooks' };
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

module.exports = { install, uninstall, installService, applyService, installSkill, installCodexHooks, codexHome, SETTINGS };
