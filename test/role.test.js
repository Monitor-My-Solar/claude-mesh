'use strict';
/** .mesh.json: discovery, validation, and the envelope's autonomy line. */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { test, run, assert } = require('./helpers.js');
const { readRole, normalize } = require('../src/role.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-role-'));
const repo = path.join(tmp, 'repo');
fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
fs.mkdirSync(path.join(repo, 'src', 'deep'), { recursive: true });

test('finds .mesh.json from a subdirectory of the repo', () => {
  fs.writeFileSync(path.join(repo, '.mesh.json'), JSON.stringify({ role: 'MMS Web', owns: 'backend' }));
  const r = readRole(path.join(repo, 'src', 'deep'));
  assert.strictEqual(r.role, 'mms-web');
  assert.strictEqual(r.autonomy, 'requests', 'defaults to accepting change requests');
});

test('stops at the repo root rather than using a parent directory file', () => {
  const outer = path.join(tmp, 'outer');
  fs.mkdirSync(path.join(outer, 'inner', '.git'), { recursive: true });
  fs.writeFileSync(path.join(outer, '.mesh.json'), JSON.stringify({ role: 'wrong' }));
  assert.strictEqual(readRole(path.join(outer, 'inner')), null);
});

test('rejects junk and keeps fields bounded', () => {
  assert.strictEqual(normalize({ owns: 'no role' }), null);
  const r = normalize({ role: 'x', autonomy: 'anything', askFor: 'one', owns: 'y'.repeat(999) });
  assert.strictEqual(r.autonomy, 'requests');
  assert.deepStrictEqual(r.askFor, ['one']);
  assert.ok(r.owns.length <= 300);
});

test('a broken .mesh.json is ignored, not fatal', () => {
  const bad = path.join(tmp, 'bad');
  fs.mkdirSync(path.join(bad, '.git'), { recursive: true });
  fs.writeFileSync(path.join(bad, '.mesh.json'), '{ not json');
  const err = console.error; console.error = () => {};
  try { assert.strictEqual(readRole(bad), null); } finally { console.error = err; }
});

test('the envelope tells the recipient what its role lets it do', () => {
  process.env.MESH_REGISTRY = 'http://127.0.0.1:1';
  const { envelopeFor } = require('../src/relay.js');
  const base = { id: 'abc', from: 'g/a', fromAddr: 'g/a', intent: 'request', body: 'do it' };
  const open = envelopeFor({ ...base, toRole: { role: 'mms-app', owns: 'the app', autonomy: 'requests' } });
  assert.ok(/YOUR ROLE: mms-app - owns the app.*act on change requests/.test(open), open);
  const strict = envelopeFor({ ...base, toRole: { role: 'infra', autonomy: 'questions' } });
  assert.ok(/check with your user before acting/.test(strict), strict);
  assert.ok(!/YOUR ROLE/.test(envelopeFor(base)), 'no role, no role line');
});

test('role init creates the file at the repo root, then add/set/remove edit it', () => {
  const { writeRole } = require('../src/role.js');
  const r2 = path.join(tmp, 'r2');
  fs.mkdirSync(path.join(r2, '.git'), { recursive: true });
  fs.mkdirSync(path.join(r2, 'pkg'), { recursive: true });
  assert.throws(() => writeRole(path.join(r2, 'pkg'), { add: { askFor: ['x'] } }), /no \.mesh\.json here yet/);
  const made = writeRole(path.join(r2, 'pkg'), { create: true, set: { role: 'mms-app', owns: 'app' } });
  assert.strictEqual(made.file, path.join(r2, '.mesh.json'), 'lands at the repo root, not the subdir');
  writeRole(r2, { add: { askFor: ['flows', 'flows'], noAccessTo: ['db -> ask mms-web'] } });
  writeRole(r2, { add: { askFor: ['builds'] } });
  writeRole(r2, { set: { autonomy: 'questions' }, remove: { askFor: ['flows'] } });
  const d = JSON.parse(fs.readFileSync(made.file, 'utf8'));
  assert.deepStrictEqual(d.askFor, ['builds']);
  assert.deepStrictEqual(d.noAccessTo, ['db -> ask mms-web']);
  assert.strictEqual(d.autonomy, 'questions');
  assert.strictEqual(readRole(r2).autonomy, 'questions', 'readers see the edit at once');
  assert.throws(() => writeRole(r2, { create: true, set: { role: 'y' } }), /already exists/);
  assert.throws(() => writeRole(r2, { set: { autonomy: 'yolo' } }), /autonomy must be/);
});

run('roles (.mesh.json)').then((f) => process.exit(f ? 1 : 0));
