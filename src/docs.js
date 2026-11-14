'use strict';
/**
 * docs.js — shared documents kept on the registry.
 *
 * Agents on different machines cannot see each other's disks (the web agent
 * on the server has no copy of the app repo on the mac mini), so a plan they
 * work on together lives here: one markdown file per name, readable and
 * writable by every agent on the mesh.
 *
 *   names   lowercase path-like slugs: "mms/push-rollout", "plan-x.md" -> "plan-x"
 *   put     replace the whole doc; pass ifVersion to refuse clobbering a
 *           newer edit (409 + the current version)
 *   append  add a section at the end - safe for several writers at once
 *   history the previous MAX_HISTORY versions are kept as name.~N.md
 *
 * Text only, MAX_DOC bytes each. Files sit beside the registry state, so on
 * the server they are plain .md files an operator can read or back up.
 */
const fs = require('fs');
const path = require('path');
const { merge3, setSection } = require('./merge.js');

const MAX_DOC     = Number(process.env.MESH_MAX_DOC  || 512 * 1024);
const MAX_DOCS    = Number(process.env.MESH_MAX_DOCS || 500);
const MAX_HISTORY = 20;   // also how far back a concurrent edit can still be merged

/** "MMS/Push Rollout.md" -> "mms/push-rollout"; '' if nothing usable is left. */
function slugName(v) {
  const parts = String(v ?? '').trim().toLowerCase().replace(/\.md$/, '')
    .split('/')
    .map((s) => s.replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, ''))
    .filter(Boolean);
  if (!parts.length || parts.length > 4) return '';
  const name = parts.join('/');
  return name.length <= 120 ? name : '';
}

function createStore(dir) {
  const index = new Map();   // name -> {name, version, size, updatedAt, updatedBy, createdAt, createdBy, title}
  const file = (name, v) => path.join(dir, `${name}${v ? `.~${v}` : ''}.md`);
  const indexFile = path.join(dir, 'index.json');

  try {
    for (const m of JSON.parse(fs.readFileSync(indexFile, 'utf8')).docs || [])
      if (m?.name && fs.existsSync(file(m.name))) index.set(m.name, m);
  } catch {}

  const saveIndex = () => {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = indexFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, docs: [...index.values()] }), { mode: 0o600 });
    fs.renameSync(tmp, indexFile);
  };
  const atomicWrite = (f, body) => {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f + '.tmp', body, { mode: 0o600 });
    fs.renameSync(f + '.tmp', f);
  };
  // First markdown heading, so `doc list` says what a doc is about.
  const titleOf = (body) => (String(body).match(/^#{1,3}\s+(.+)$/m)?.[1] || '').trim().slice(0, 100);

  function write(name, body, by, prev) {
    if (!prev) {
      // A name re-created after rm restarts at v1: drop the old doc's history
      // so `get --v N` cannot return a different document's text.
      const base = path.basename(name);
      try {
        for (const f of fs.readdirSync(path.dirname(file(name))))
          if (f.startsWith(base + '.~') && /^\.~\d+\.md$/.test(f.slice(base.length))) fs.rmSync(path.join(path.dirname(file(name)), f), { force: true });
      } catch {}
    }
    if (prev) {
      // Keep a short history so a bad overwrite can be undone.
      try { fs.copyFileSync(file(name), file(name, prev.version)); } catch {}
      const drop = prev.version - MAX_HISTORY;
      if (drop > 0) fs.rmSync(file(name, drop), { force: true });
    }
    atomicWrite(file(name), body);
    const now = Date.now();
    const meta = {
      name,
      version: (prev?.version || 0) + 1,
      size: Buffer.byteLength(body),
      title: titleOf(body),
      createdAt: prev?.createdAt || now,
      createdBy: prev?.createdBy || by,
      updatedAt: now,
      updatedBy: by,
    };
    index.set(name, meta);
    saveIndex();
    return meta;
  }

  const err = (status, error, extra = {}) => ({ status, error, ...extra });

  return {
    list(prefix = '') {
      const p = slugName(prefix);
      return [...index.values()]
        .filter((m) => !p || m.name === p || m.name.startsWith(p + '/'))
        .sort((a, b) => b.updatedAt - a.updatedAt);
    },

    get(rawName, version) {
      const name = slugName(rawName);
      const meta = index.get(name);
      if (!meta) return err(404, `no doc '${name || rawName}' - see: claude-mesh doc list`);
      const v = Number(version || 0);
      if (v && v !== meta.version) {
        try { return { meta: { ...meta, version: v }, body: fs.readFileSync(file(name, v), 'utf8') }; }
        catch { return err(404, `version ${v} of '${name}' is not kept (only the last ${MAX_HISTORY})`); }
      }
      return { meta, body: fs.readFileSync(file(name), 'utf8') };
    },

    put(rawName, body, by, ifVersion) {
      const name = slugName(rawName);
      if (!name) return err(400, 'bad doc name - use letters, digits, - _ . and / (e.g. mms/push-plan)');
      body = String(body ?? '');
      if (Buffer.byteLength(body) > MAX_DOC) return err(413, `doc too large (max ${MAX_DOC} bytes)`);
      const prev = index.get(name);
      if (!prev && index.size >= MAX_DOCS) return err(507, `doc store full (${MAX_DOCS} docs) - remove old ones`);
      const hasBase = ifVersion !== undefined && ifVersion !== null && ifVersion !== '';
      const base = hasBase ? Number(ifVersion) : null;
      if (hasBase && base === 0 && prev)
        return err(409, `'${name}' already exists (v${prev.version}) - read it first (claude-mesh doc get ${name}), ` +
                        'edit, then put; or add to it with append / section', { meta: prev });
      if (hasBase && base !== (prev?.version || 0) && prev) {
        // Someone else saved since this writer read it. Merge both edits, like
        // a notes app, rather than refusing or clobbering. Only overlapping
        // changes to the same lines are sent back.
        let baseText;
        try { baseText = base > 0 && base < prev.version ? fs.readFileSync(file(name, base), 'utf8') : null; } catch { baseText = null; }
        if (baseText === null)
          return err(409, `'${name}' changed since you read it and v${base} is too old to merge - get it again and redo your edit`, { meta: prev });
        const theirs = fs.readFileSync(file(name), 'utf8');
        const m = merge3(baseText, body, theirs);
        if (!m.ok)
          return err(409, `'${name}' was edited by ${prev.updatedBy} at the same lines you changed ` +
                          `(you had v${base}, it is now v${prev.version}). Their edits elsewhere were kept; ` +
                          'get it again and reapply only your conflicting change (or use section/append):\n' +
                          m.conflicts.slice(0, 5).map((c, i) =>
                            `--- conflict ${i + 1}\n[original]\n${c.base}\n[yours]\n${c.ours}\n[theirs]\n${c.theirs}`).join('\n'),
                     { meta: prev, conflicts: m.conflicts.slice(0, 20) });
        if (Buffer.byteLength(m.text) > MAX_DOC) return err(413, `merged doc would exceed ${MAX_DOC} bytes`);
        return { meta: { ...write(name, m.text, by, prev), merged: true, mergedWith: prev.updatedBy } };
      }
      return { meta: write(name, body, by, prev) };
    },

    append(rawName, text, by) {
      const name = slugName(rawName);
      if (!name) return err(400, 'bad doc name - use letters, digits, - _ . and / (e.g. mms/push-plan)');
      const prev = index.get(name);
      const cur = prev ? fs.readFileSync(file(name), 'utf8') : '';
      const stamp = `<!-- ${by || 'unknown'} @ ${new Date().toISOString()} -->`;
      const add = `${cur && !cur.endsWith('\n') ? '\n' : ''}${cur ? '\n' : ''}${stamp}\n${String(text ?? '').replace(/\s+$/, '')}\n`;
      const body = cur + add;
      if (Buffer.byteLength(body) > MAX_DOC) return err(413, `doc would exceed ${MAX_DOC} bytes`);
      if (!prev && index.size >= MAX_DOCS) return err(507, `doc store full (${MAX_DOCS} docs) - remove old ones`);
      return { meta: write(name, body, by, prev) };
    },

    /** Replace (or add) one `## heading` section, atomically. */
    section(rawName, heading, text, by) {
      const name = slugName(rawName);
      if (!name) return err(400, 'bad doc name - use letters, digits, - _ . and / (e.g. mms/push-plan)');
      if (!String(heading || '').replace(/^#+/, '').trim()) return err(400, 'section needs --heading "<title>"');
      const prev = index.get(name);
      if (!prev && index.size >= MAX_DOCS) return err(507, `doc store full (${MAX_DOCS} docs) - remove old ones`);
      const body = setSection(prev ? fs.readFileSync(file(name), 'utf8') : '', heading, text);
      if (Buffer.byteLength(body) > MAX_DOC) return err(413, `doc would exceed ${MAX_DOC} bytes`);
      return { meta: write(name, body, by, prev) };
    },

    remove(rawName) {
      const name = slugName(rawName);
      const meta = index.get(name);
      if (!meta) return err(404, `no doc '${name || rawName}'`);
      // History is kept: a removed doc can still be recovered by an operator.
      try { fs.renameSync(file(name), file(name, meta.version)); } catch {}
      index.delete(name);
      saveIndex();
      return { meta };
    },
  };
}

module.exports = { createStore, slugName, MAX_DOC };
