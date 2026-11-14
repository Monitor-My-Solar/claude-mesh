'use strict';
/** Three-way merge and section edits behind concurrent shared-doc writes. */
const { test, run, assert } = require('./helpers.js');
const { merge3, setSection } = require('../src/merge.js');

const base = '# Plan\n\n## Web\nweb todo\n\n## App\napp todo\n';

test('edits to different sections both land', () => {
  const ours = base.replace('web todo', 'web DONE');
  const theirs = base.replace('app todo', 'app DONE');
  const m = merge3(base, ours, theirs);
  assert.ok(m.ok);
  assert.strictEqual(m.text, '# Plan\n\n## Web\nweb DONE\n\n## App\napp DONE\n');
});

test('both adding lines at the same spot keeps both', () => {
  const m = merge3(base, base + '- ours\n', base + '- theirs\n');
  assert.ok(m.ok, JSON.stringify(m));
  assert.ok(m.text.includes('- ours') && m.text.includes('- theirs'));
});

test('the same change on both sides is not a conflict', () => {
  const x = base.replace('web todo', 'same');
  assert.deepStrictEqual(merge3(base, x, x), { ok: true, text: x });
});

test('a deletion on one side and an edit elsewhere merge', () => {
  const ours = base.replace('\n## App\napp todo\n', '\n');
  const theirs = base.replace('# Plan', '# Plan v2');
  const m = merge3(base, ours, theirs);
  assert.ok(m.ok);
  assert.ok(m.text.startsWith('# Plan v2') && !m.text.includes('app todo'));
});

test('changing the same line differently is a conflict with both sides shown', () => {
  const m = merge3(base, base.replace('web todo', 'A'), base.replace('web todo', 'B'));
  assert.ok(!m.ok);
  assert.strictEqual(m.conflicts[0].base, 'web todo');
  assert.strictEqual(m.conflicts[0].ours, 'A');
  assert.strictEqual(m.conflicts[0].theirs, 'B');
});

test('setSection replaces only its own section', () => {
  const out = setSection(base, 'web', 'new web\nline 2');
  assert.strictEqual(out, '# Plan\n\n## Web\nnew web\nline 2\n\n## App\napp todo\n');
});

test('setSection on the last section and a missing one', () => {
  assert.strictEqual(setSection(base, '## App', 'x'), '# Plan\n\n## Web\nweb todo\n\n## App\nx\n');
  assert.strictEqual(setSection(base, 'Ops', 'y'), base.trimEnd() + '\n\n## Ops\ny\n');
  assert.strictEqual(setSection('', 'Ops', 'y'), '## Ops\ny\n');
});

test('setSection keeps subsections of other sections intact', () => {
  const d = '## A\na\n### A1\nsub\n## B\nb\n';
  assert.strictEqual(setSection(d, 'A', 'new'), '## A\nnew\n\n## B\nb\n');
  assert.strictEqual(setSection(d, 'A1', 'n'), '## A\na\n### A1\nn\n\n## B\nb\n');
});

(async () => process.exit(await run('merge (shared doc concurrency)') ? 1 : 0))();
