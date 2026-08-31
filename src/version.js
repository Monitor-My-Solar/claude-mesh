'use strict';
/**
 * version.js — what this install actually is.
 *
 * Reports the package version plus the git commit when installed from a clone,
 * so a roster can show which machines are behind without anyone ssh-ing around
 * to compare checksums.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function pkgVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '0.0.0'; }
  catch { return '0.0.0'; }
}

/** Short commit sha, read from .git directly so we never shell out. */
function gitSha() {
  try {
    const head = fs.readFileSync(path.join(ROOT, '.git', 'HEAD'), 'utf8').trim();
    if (head.startsWith('ref: ')) {
      const ref = head.slice(5).trim();
      const p = path.join(ROOT, '.git', ref);
      if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim().slice(0, 7);
      // packed refs
      const packed = fs.readFileSync(path.join(ROOT, '.git', 'packed-refs'), 'utf8');
      const line = packed.split('\n').find((l) => l.endsWith(' ' + ref));
      if (line) return line.slice(0, 7);
      return '';
    }
    return head.slice(0, 7);
  } catch { return ''; }
}

const version = pkgVersion();
const sha = gitSha();

module.exports = {
  version,
  sha,
  full: sha ? `${version}+${sha}` : version,
  root: ROOT,
};
