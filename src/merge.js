'use strict';
/**
 * merge.js — line-based three-way merge, so two agents can edit one shared doc
 * at the same time and both edits land (the way Apple Notes behaves), instead
 * of the second writer being refused or silently overwriting the first.
 *
 *   merge3(base, ours, theirs)
 *     base   - the version the writer started from
 *     ours   - the writer's edited text
 *     theirs - what the doc became meanwhile (someone else's edit)
 *   -> { ok: true, text }  or  { ok: false, conflicts: [{base, ours, theirs}] }
 *
 * Changes to different lines merge cleanly. Two writers inserting at the same
 * spot keep both (theirs first, it landed first). Only two writers changing
 * the SAME existing lines differently is a conflict.
 */

const MAX_CELLS = 8_000_000;   // LCS table budget; bigger diffs report a conflict

/** For each line of a, the index of its match in b (LCS), or -1. */
function lcsMatch(a, b) {
  const m = new Array(a.length).fill(-1);
  // Common prefix/suffix first: edits are usually small, so this keeps the
  // quadratic part tiny even on large docs.
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) { m[s] = s; s++; }
  let ea = a.length, eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; m[ea] = eb; }
  const n = ea - s, k = eb - s;
  if (!n || !k) return m;
  if (n * k > MAX_CELLS) return null;
  const w = k + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--)
    for (let j = k - 1; j >= 0; j--)
      dp[i * w + j] = a[s + i] === b[s + j]
        ? dp[(i + 1) * w + j + 1] + 1
        : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
  for (let i = 0, j = 0; i < n && j < k;) {
    if (a[s + i] === b[s + j]) { m[s + i] = s + j; i++; j++; }
    else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++;
    else j++;
  }
  return m;
}

const same = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);

function merge3(baseText, oursText, theirsText) {
  if (oursText === theirsText) return { ok: true, text: oursText };
  if (baseText === theirsText) return { ok: true, text: oursText };
  if (baseText === oursText) return { ok: true, text: theirsText };
  const B = baseText.split('\n'), O = oursText.split('\n'), T = theirsText.split('\n');
  const mo = lcsMatch(B, O), mt = lcsMatch(B, T);
  if (!mo || !mt) return { ok: false, conflicts: [{ base: '(too large to merge)', ours: '', theirs: '' }] };

  const out = [], conflicts = [];
  let i = 0, o = 0, t = 0;
  const chunk = (bi, oi, ti) => {
    const b = B.slice(i, bi), x = O.slice(o, oi), y = T.slice(t, ti);
    if (same(x, b)) out.push(...y);                    // only they changed it
    else if (same(y, b)) out.push(...x);               // only we changed it
    else if (same(x, y)) out.push(...x);               // both made the same change
    else if (!b.length) out.push(...y, ...x);          // both inserted here: keep both
    else conflicts.push({ base: b.join('\n'), ours: x.join('\n'), theirs: y.join('\n') });
  };
  for (let k = 0; k < B.length; k++) {
    // A base line both sides kept is a sync point; merge the gap before it.
    if (mo[k] < 0 || mt[k] < 0 || mo[k] < o || mt[k] < t) continue;
    chunk(k, mo[k], mt[k]);
    out.push(B[k]);
    i = k + 1; o = mo[k] + 1; t = mt[k] + 1;
  }
  chunk(B.length, O.length, T.length);
  return conflicts.length ? { ok: false, conflicts } : { ok: true, text: out.join('\n') };
}

/**
 * Replace the body of one markdown section (heading match is case-insensitive
 * and ignores the #s), or add it at the end if missing. The section runs to
 * the next heading of the same or a higher level. Lets each agent own its own
 * section so concurrent writers never touch the same lines.
 */
function setSection(doc, heading, body) {
  const want = String(heading).replace(/^#+\s*/, '').trim().toLowerCase();
  const level = (String(heading).match(/^(#+)\s/)?.[1].length) || 2;
  const lines = String(doc || '').split('\n');
  const isHead = (l) => /^(#{1,6})\s+(.*)$/.exec(l);
  let start = -1, lvl = level;
  for (let i = 0; i < lines.length; i++) {
    const h = isHead(lines[i]);
    if (h && h[2].trim().toLowerCase() === want) { start = i; lvl = h[1].length; break; }
  }
  const content = String(body ?? '').replace(/\s+$/, '');
  if (start < 0) {
    const cur = String(doc || '').replace(/\s+$/, '');
    return `${cur ? cur + '\n\n' : ''}${'#'.repeat(level)} ${String(heading).replace(/^#+\s*/, '').trim()}\n${content}\n`;
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const h = isHead(lines[i]);
    if (h && h[1].length <= lvl) { end = i; break; }
  }
  const after = lines.slice(end);
  return [...lines.slice(0, start + 1), content, ...(after.length ? [''] : []), ...after].join('\n')
    .replace(/\n*$/, '\n');
}

/**
 * A short +/- summary of what changed between two versions, for update
 * notifications: only changed lines, with "@@ line N" markers, capped.
 */
function summarizeDiff(before, after, maxLines = 40) {
  const A = String(before ?? '').split('\n'), B = String(after ?? '').split('\n');
  const m = lcsMatch(A, B);
  if (!m) return { text: '(change too large to summarise)', added: 0, removed: 0 };
  const out = [];
  let added = 0, removed = 0, i = 0, j = 0, lastOut = -2;
  const emit = (line, at) => {
    if (at !== lastOut + 1) out.push(`@@ line ${at + 1}`);
    out.push(line.length > 200 ? line.slice(0, 200) + ` ... (+${line.length - 200} chars)` : line);
    lastOut = at;
  };
  while (i < A.length || j < B.length) {
    if (i < A.length && m[i] === j) { i++; j++; continue; }
    if (i < A.length && (m[i] === -1 || j >= B.length)) { removed++; emit(`- ${A[i]}`, j); lastOut = j - 1; i++; continue; }
    added++; emit(`+ ${B[j]}`, j); j++;
  }
  const extra = out.length - maxLines;
  const text = (extra > 0 ? [...out.slice(0, maxLines), `... (${extra} more lines of changes)`] : out).join('\n');
  return { text, added, removed };
}

module.exports = { merge3, setSection, lcsMatch, summarizeDiff };
