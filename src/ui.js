'use strict';
/**
 * ui.js — a read-only dashboard served by the registry.
 *
 * Deliberately a single self-contained page with no build step and no
 * dependencies: it exists to answer "who is online and what is out of date"
 * at a glance, which is otherwise an ssh-and-compare-checksums job.
 */
function page(token) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>claude-mesh</title>
<style>
  :root{--bg:#0f1115;--card:#171a21;--line:#252a34;--fg:#e6e8ec;--dim:#8b93a3;
        --ok:#3fb950;--warn:#d29922;--bad:#f85149;--acc:#58a6ff;color-scheme:dark}
  @media(prefers-color-scheme:light){:root{--bg:#f6f7f9;--card:#fff;--line:#e3e6ea;
        --fg:#1c2024;--dim:#606a76;color-scheme:light}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);
       font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
  header{padding:18px 22px;border-bottom:1px solid var(--line);display:flex;
         align-items:baseline;gap:14px;flex-wrap:wrap}
  h1{font-size:15px;margin:0;letter-spacing:.02em}
  .dim{color:var(--dim)}
  main{padding:18px 22px;max-width:1100px}
  .grp{margin-bottom:22px}
  .grp h2{font-size:13px;margin:0 0 8px;color:var(--acc);font-weight:600}
  table{width:100%;border-collapse:collapse;background:var(--card);
        border:1px solid var(--line);border-radius:8px;overflow:hidden}
  th,td{text-align:left;padding:7px 11px;border-bottom:1px solid var(--line);
        white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  th{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);font-weight:600}
  tr:last-child td{border-bottom:0}
  .pill{display:inline-block;padding:1px 7px;border-radius:20px;font-size:11px}
  .idle{background:#3fb95022;color:var(--ok)}
  .busy{background:#58a6ff22;color:var(--acc)}
  .waiting{background:#d2992222;color:var(--warn)}
  .stale{background:#f8514922;color:var(--bad)}
  .old{color:var(--warn)}
  .cur{color:var(--dim)}
  .named::after{content:"*";color:var(--acc);margin-left:3px}
  .cwd{color:var(--dim);max-width:340px}
  .empty{color:var(--dim);padding:26px;text-align:center;
         border:1px dashed var(--line);border-radius:8px}
</style></head><body>
<header>
  <h1>claude-mesh</h1>
  <span class="dim" id="meta">loading…</span>
  <span class="dim" style="margin-left:auto" id="tick"></span>
</header>
<main id="out"></main>
<script>
const TOKEN = ${JSON.stringify(token || '')};
const ago = ms => { const s = Math.round(ms/1000);
  return s < 60 ? s+'s' : s < 3600 ? Math.round(s/60)+'m' : Math.round(s/3600)+'h'; };

async function load(){
  const h = TOKEN ? {'X-Mesh-Token': TOKEN} : {};
  let peers = [], health = {};
  try {
    [peers, health] = await Promise.all([
      fetch('peers', {headers:h}).then(r=>r.json()).then(d=>d.peers||[]),
      fetch('health', {headers:h}).then(r=>r.json()),
    ]);
  } catch(e){ document.getElementById('meta').textContent = 'registry unreachable'; return; }

  // The newest version anyone reports is treated as current, so machines that
  // are behind stand out without hardcoding a release number here.
  const versions = peers.map(p=>p.version).filter(Boolean).concat(health.version||[]);
  const newest = versions.sort().pop() || '';

  document.getElementById('meta').textContent =
    'registry ' + (health.version||'?') + ' · ' + peers.length + ' session' +
    (peers.length===1?'':'s') + ' · ' +
    new Set(peers.map(p=>p.group)).size + ' machine(s)';

  const groups = {};
  for (const p of peers) (groups[p.group] ||= []).push(p);

  const out = document.getElementById('out');
  if (!peers.length){ out.innerHTML = '<div class="empty">No sessions registered.<br>' +
      'Check that each machine is running <code>claude-mesh service</code>.</div>'; return; }

  out.innerHTML = Object.keys(groups).sort().map(g => {
    const rows = groups[g]
      .sort((a,b)=> (b.named-a.named) || (b.seen-a.seen))
      .map(p => {
        const age = Date.now() - p.seen;
        const stale = age > 60000;
        const st = stale ? 'stale' : (p.status||'idle');
        const behind = p.version && newest && p.version !== newest;
        return '<tr>' +
          '<td class="'+(p.named?'named':'')+'">'+esc(p.name)+'</td>' +
          '<td><span class="pill '+st+'">'+(stale?'stale':esc(p.status||'—'))+'</span></td>' +
          '<td class="'+(behind?'old':'cur')+'">'+esc(p.version||'—')+(behind?' ↑':'')+'</td>' +
          '<td class="cwd">'+esc(p.cwd||'—')+'</td>' +
          '<td class="dim">'+ago(age)+'</td></tr>';
      }).join('');
    return '<section class="grp"><h2>'+esc(g)+'</h2><table>' +
      '<tr><th>session</th><th>status</th><th>version</th><th>cwd</th><th>seen</th></tr>' +
      rows + '</table></section>';
  }).join('');
}
function esc(s){ return String(s).replace(/[&<>"]/g, c =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

let n = 0;
setInterval(()=>{ document.getElementById('tick').textContent = 'refreshed '+(++n?ago(0):''); }, 1e9);
load(); setInterval(load, 5000);
</script></body></html>`;
}

module.exports = { page };
