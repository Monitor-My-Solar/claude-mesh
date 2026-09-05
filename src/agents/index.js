'use strict';
/**
 * Agent adapters.
 *
 * The mesh addresses sessions as group/name and does not care what is behind
 * one: a Claude Code session and a Codex thread are peers of equal standing.
 * Each adapter knows how to enumerate its own live sessions and how to push a
 * message into one.
 */
const claude = require('./claude.js');
const codex = require('./codex.js');

const ADAPTERS = [claude, codex];
const byKind = new Map(ADAPTERS.map((a) => [a.KIND, a]));

/** Every live session on this machine, across every agent we support. */
function allSessions() {
  const out = [];
  for (const a of ADAPTERS) {
    try { out.push(...a.sessions()); }
    catch (e) { console.error(`[mesh] ${a.KIND} discovery failed: ${e.message}`); }
  }
  return out;
}

function adapterFor(kind) {
  return byKind.get(kind) || claude;      // default keeps older routes working
}

module.exports = { allSessions, adapterFor, ADAPTERS };
