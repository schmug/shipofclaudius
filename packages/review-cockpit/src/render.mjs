// Render a collected bundle into ONE self-contained HTML file.
//
// Everything is server-rendered with escaping at every interpolation; the only script is a
// small tab/route switcher (plus an inlined graph library when one was available at build
// time). A strict CSP meta blocks every network fetch except the Try-it iframes, so the
// file opens offline and attacker text in the diff cannot load anything even if an
// escaping bug let markup through.

import { hunkId, fileId } from './diff.mjs'

export const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
const safeJson = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
const httpUrl = (u) => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.toString() : '' } catch { return '' } }
const dataPng = (s) => (typeof s === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(s) ? s : '')

// The summary comes from a model that read untrusted text. Keep only the known fields, as
// strings, bounded, so a hostile summary cannot smuggle structure into the renderer.
export function sanitizeSummary(o) {
  if (!o || typeof o !== 'object') return null
  const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '')
  return {
    summary: str(o.summary, 6000),
    focus: Array.isArray(o.focus) ? o.focus.slice(0, 12).map((f) => str(f, 400)).filter(Boolean) : [],
    injection_suspected: o.injection_suspected === true,
    injection_notes: str(o.injection_notes, 1500),
  }
}

export const TABS = [
  ['try', 'Try it'], ['visual', 'Visual'], ['code', 'Code'], ['blast', 'Blast radius'], ['why', 'Why'], ['approve', 'Approve'],
]

// ---------- tiny highlighter: tokenize the RAW text, escape each token ----------
const KW = 'const|let|var|function|return|if|else|elif|for|while|do|switch|case|break|continue|import|export|from|as|class|new|await|async|try|catch|finally|throw|def|self|None|True|False|null|undefined|true|false|type|interface|extends|implements|public|private|protected|static|fn|pub|struct|impl|enum|package|func|go|defer|yield|lambda|with|in|of|not|and|or|is'
const HASH_COMMENT = /\.(py|sh|bash|zsh|ya?ml|toml|rb|pl|r|conf|ini|dockerfile)$|(^|\/)(Dockerfile|Makefile|\.gitignore|\.env[\w.-]*)$/i
export function highlight(s, path) {
  const comment = HASH_COMMENT.test(path || '') ? '#.*$' : '\\/\\/.*$|\\/\\*.*?\\*\\/'
  const re = new RegExp(`(${comment})|("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|\`(?:[^\`\\\\]|\\\\.)*\`)|\\b(\\d+(?:\\.\\d+)?)\\b|\\b(${KW})\\b`, 'g')
  let out = ''
  let last = 0
  for (const m of s.matchAll(re)) {
    out += esc(s.slice(last, m.index))
    const cls = m[1] ? 'tc' : m[2] ? 'ts' : m[3] ? 'tn' : 'tk'
    out += `<span class="${cls}">${esc(m[0])}</span>`
    last = m.index + m[0].length
  }
  return out + esc(s.slice(last))
}

const link = (hunk, label) => (hunk ? `<a href="#${esc(hunk)}" data-tab="code">${esc(label)}</a>` : esc(label))
const empty = (title, body) => `<div class="empty"><strong>${esc(title)}</strong><p>${body}</p></div>`

// ---------- tabs ----------
function tryIt(b) {
  const before = httpUrl(b.tryIt.beforeUrl)
  const after = httpUrl(b.tryIt.afterUrl)
  if (!before && !after) return empty('No URLs provided', 'Pass <code>beforeUrl</code> (production) and <code>afterUrl</code> (preview, staging or localhost) to compare the running app side by side.')
  const routes = b.tryIt.routes.map((r) => `<option value="${esc(r)}">${esc(r)}</option>`).join('')
  const pane = (label, url) => `<div class="pane"><div class="pane-h"><strong>${label}</strong> <a class="ext" data-base="${esc(url)}" href="${esc(url)}" target="_blank" rel="noopener noreferrer">open in new tab ↗</a></div>${url ? `<iframe data-base="${esc(url)}" src="${esc(url)}" sandbox="allow-scripts allow-same-origin allow-forms" referrerpolicy="no-referrer" loading="lazy"></iframe>` : '<div class="empty">not provided</div>'}</div>`
  return `<div class="toolbar"><label>Route <select id="route">${routes}</select></label>
  <span class="seg"><button type="button" class="vp on" data-vp="desktop">Desktop</button><button type="button" class="vp" data-vp="mobile">Mobile</button></span></div>
  <p class="note">Sites that send <code>X-Frame-Options</code> or a CSP <code>frame-ancestors</code> header refuse to load in a frame. If a pane stays blank, use its <em>open in new tab</em> link. The two panes share the route picker but do not sync scrolling or clicks.</p>
  <div class="panes" id="panes">${pane('Before', before)}${pane('After', after)}</div>`
}

function visual(b) {
  const v = b.visual
  if (v.skipped) return empty('Visual capture skipped', esc(v.skipped))
  if (!v.shots.length) return empty('No screenshots', 'Capture ran but produced nothing.')
  return v.shots.map((s) => {
    const img = (x, label) => (dataPng(x.png) ? `<figure><img alt="${esc(label)}" src="${dataPng(x.png)}"><figcaption>${esc(label)}</figcaption></figure>` : `<figure class="miss"><div>${esc(x.error || 'no image')}</div><figcaption>${esc(label)}</figcaption></figure>`)
    const pct = s.diff.changedPct == null ? 'n/a' : `${s.diff.changedPct}% of pixels changed`
    return `<section class="shot"><h3>${esc(s.route)} <span class="tag">${esc(s.viewport)}</span> <span class="muted">${esc(pct)}</span></h3>
    <div class="trio">${img(s.before, 'Before')}${img(s.after, 'After')}${img({ png: s.diff.png, error: 'diff unavailable' }, 'Pixel diff')}</div></section>`
  }).join('')
}

function code(b) {
  if (!b.files.length) return empty('Empty diff', 'The base and head are identical.')
  const toc = b.files.map((f, i) => `<li><a href="#${fileId(i)}" data-tab="code">${esc(f.path)}</a> <span class="add">+${f.additions}</span> <span class="del">-${f.deletions}</span></li>`).join('')
  const body = b.files.map((f, i) => {
    const rows = f.binary ? '<div class="muted pad">binary file</div>' : f.hunks.map((h, hi) => {
      const lines = h.lines.map((l) => `<tr class="l${l.t === '+' ? 'a' : l.t === '-' ? 'd' : 'c'}"><td class="n">${l.oldNo ?? ''}</td><td class="n">${l.newNo ?? ''}</td><td class="s"><span class="m">${esc(l.t)}</span>${highlight(l.s, f.path)}</td></tr>`).join('')
      return `<div class="hunk" id="${hunkId(i, hi)}"><div class="hh">${esc(h.header)}</div><table>${lines}</table></div>`
    }).join('')
    const total = f.additions + f.deletions
    return `<details class="file" id="${fileId(i)}"${total <= 400 ? ' open' : ''}><summary><span class="tag st-${esc(f.status)}">${esc(f.status)}</span> ${esc(f.path)}${f.status === 'renamed' ? ` <span class="muted">← ${esc(f.oldPath)}</span>` : ''} <span class="add">+${f.additions}</span> <span class="del">-${f.deletions}</span></summary>${rows}</details>`
  }).join('')
  return `<details class="toc"><summary>${b.files.length} files changed</summary><ul>${toc}</ul></details>${body}`
}

function graphSvg(g) {
  const cols = [0, 1, 2].map((h) => g.nodes.filter((n) => n.hop === h))
  const colW = 330
  const rowH = 26
  const pos = new Map()
  cols.forEach((c, ci) => c.forEach((n, ri) => pos.set(n.id, { x: 10 + ci * colW, y: 30 + ri * rowH })))
  const height = 40 + Math.max(1, ...cols.map((c) => c.length)) * rowH
  const edges = g.edges.filter((e) => pos.has(e.from) && pos.has(e.to)).map((e) => {
    const a = pos.get(e.from)
    const t = pos.get(e.to)
    // Importers sit to the right of what they import; draw from the target's right edge.
    return `<path class="edge" d="M${t.x + 300},${t.y + 9} C${t.x + 315},${t.y + 9} ${a.x - 15},${a.y + 9} ${a.x},${a.y + 9}"/>`
  }).join('')
  const nodes = g.nodes.filter((n) => pos.has(n.id)).map((n) => {
    const p = pos.get(n.id)
    const label = n.id.length > 44 ? `…${n.id.slice(-43)}` : n.id
    return `<g class="node ${n.changed ? 'changed' : ''} ${n.test ? 'test' : ''}"><title>${esc(n.id)}</title><rect x="${p.x}" y="${p.y}" width="300" height="18" rx="4"/><text x="${p.x + 6}" y="${p.y + 13}">${esc(label)}</text></g>`
  }).join('')
  const heads = ['Changed', 'References a changed file (hop 1)', 'References hop 1 (hop 2)'].map((t, i) => `<text class="colh" x="${10 + i * colW}" y="16">${esc(t)}</text>`).join('')
  return `<div class="graphwrap"><svg role="img" aria-label="Dependency graph" width="${10 + 3 * colW}" height="${height}" viewBox="0 0 ${10 + 3 * colW} ${height}">${heads}${edges}${nodes}</svg></div>`
}

function blast(b, graphLib) {
  const g = b.graph
  const label = `<p class="note"><strong>Heuristic.</strong> ${g.skipped ? esc(g.skipped) : `Built with ${esc(g.tool)} over the head working tree: a file counts as an importer when a line names a changed file's stem in an import/require/from/include/use statement, or quotes a path ending in its filename. Expect false positives on common names and misses on dynamic imports.`}${g.truncated ? ' <strong>Truncated</strong> at the node cap.' : ''}</p>`
  const legend = '<p class="legend"><span class="sw changed"></span> changed <span class="sw"></span> importer <span class="sw test"></span> test</p>'
  const graph = graphLib
    ? `<div id="cy" class="cy"></div><script>${graphLib.replace(/<\/script/gi, '<\\/script')}</script><script>(function(){var g=${safeJson({ nodes: g.nodes, edges: g.edges })};try{cytoscape({container:document.getElementById('cy'),elements:g.nodes.map(function(n){return{data:{id:n.id,label:n.id.split('/').pop(),hop:n.hop},classes:(n.changed?'changed ':'')+(n.test?'test':'')}}).concat(g.edges.map(function(e,i){return{data:{id:'e'+i,source:e.from,target:e.to}}})),layout:{name:'breadthfirst',directed:true,spacingFactor:1.1},style:[{selector:'node',style:{label:'data(label)','font-size':10,'background-color':'#8a94a6',color:'#444'}},{selector:'.changed',style:{'background-color':'#d9480f'}},{selector:'.test',style:{'background-color':'#2f9e44',shape:'diamond'}},{selector:'edge',style:{width:1,'line-color':'#bbb','target-arrow-shape':'triangle','target-arrow-color':'#bbb','curve-style':'bezier'}}]})}catch(e){document.getElementById('cy').textContent='graph library failed: '+e.message}})()</script>`
    : graphSvg(g)
  const tests = g.tests.length
    ? `<ul>${g.tests.map((t) => `<li>${esc(t.path)} <span class="tag">${t.changed ? 'changed' : `hop ${t.hop}`}</span></li>`).join('')}</ul>`
    : '<p class="muted">No test files were changed or found referencing the change.</p>'
  return `${label}${legend}${graph}<h3>Touched tests</h3>${tests}`
}

function why(b) {
  const w = b.why
  if (!w.sessions.length) return empty('No session provenance', `${esc(w.note || 'No matching session found.')}<br>Searched: <code>${esc(w.searched)}</code>. Transcripts live on the machine that ran Claude Code, so run the cockpit there to fill this tab.`)
  return w.sessions.map((s, si) => {
    const prompts = s.prompts.length ? `<ol class="prompts">${s.prompts.map((p) => `<li><span class="muted">${esc(p.ts)}</span><pre>${esc(p.text)}</pre></li>`).join('')}</ol>` : '<p class="muted">none</p>'
    const plan = s.plan.length ? s.plan.map((p) => `<details><summary>${esc(p.tool)} <span class="muted">${esc(p.ts)}</span></summary><pre>${esc(p.text)}</pre></details>`).join('') : '<p class="muted">No plan or checklist tool calls.</p>'
    const edits = s.edits.length ? `<table class="grid"><tr><th>When</th><th>Tool</th><th>File</th><th>Diff hunks</th><th>New text</th></tr>${s.edits.map((e) => `<tr class="${e.inDiff ? '' : 'faint'}"><td>${esc(e.ts.slice(11, 19))}</td><td>${esc(e.tool)}</td><td>${esc(e.file)}${e.inDiff ? '' : ' <span class="tag">not in diff</span>'}</td><td>${e.hunks.length ? e.hunks.map((h) => link(h, h.replace(/^h-/, '#'))).join(' ') : '<span class="muted">unmapped</span>'}</td><td><details><summary>show</summary><pre>${esc(e.snippet)}</pre></details></td></tr>`).join('')}</table>` : '<p class="muted">No file edits recorded.</p>'
    const reads = s.readNotChanged.length ? `<ul class="cols">${s.readNotChanged.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : '<p class="muted">none</p>'
    const cmds = s.commands.length ? `<table class="grid"><tr><th>Result</th><th>Command</th><th>Output tail</th></tr>${s.commands.map((c) => `<tr><td><span class="badge ${esc(c.status)}">${esc(c.status)}</span></td><td><code>${esc(c.command)}</code></td><td><details><summary>show</summary><pre>${esc(c.output)}</pre></details></td></tr>`).join('')}</table>` : '<p class="muted">No test/build/lint commands recorded.</p>'
    return `<section class="session"><h3>${si === 0 ? 'Primary session' : `Session ${si + 1}`}: ${esc(s.title || s.sessionId)}</h3>
    <p class="muted">${esc(s.sessionId)} · ${esc(s.start)} → ${esc(s.end)} · branch ${esc(s.branches.join(', ') || '?')}</p>
    <h4>User prompts</h4>${prompts}<h4>Plan &amp; checklists</h4>${plan}<h4>Edits</h4>${edits}<h4>Read but not changed</h4>${reads}<h4>Tests &amp; builds run</h4>${cmds}</section>`
  }).join('') + `<p class="note">Transcript text is redacted and shown as data. Edits made through shell commands (sed, heredocs) are not tracked.</p>`
}

function verdictBlock(v) {
  if (!v) return '<p class="muted">No external reviewer verdict was supplied (pass <code>verdict</code> to include one).</p>'
  const head = v.verdict || v.decision || v.status || (v.pass === true ? 'pass' : v.pass === false ? 'fail' : '')
  return `${head ? `<p><span class="badge ${/pass|approve|ok|green/i.test(String(head)) ? 'pass' : 'fail'}">${esc(head)}</span> ${esc(v.reviewer || v.provider || '')}</p>` : ''}<pre>${esc(JSON.stringify(v, null, 2))}</pre>`
}

function approve(b, summary, verdict) {
  const sum = summary
    ? `<div class="summary"><div class="sumh">MODEL-GENERATED SUMMARY. This is not evidence; check every claim against the Code tab.</div><p>${esc(summary.summary).replace(/\n/g, '<br>')}</p>${Array.isArray(summary.focus) && summary.focus.length ? `<h4>Suggested focus</h4><ul>${summary.focus.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}${summary.injection_suspected ? `<p class="warn">The summarizer also suspected prompt-injection content: ${esc(summary.injection_notes)}</p>` : ''}</div>`
    : '<div class="summary"><div class="sumh">No model summary</div><p class="muted">Built without the summarize step (CLI <code>build</code>). Run the workflow to include one.</p></div>'
  const risks = b.risks.length
    ? b.risks.map((r) => `<div class="risk"><label><input type="checkbox"> <strong>${esc(r.title)}</strong></label><p>${esc(r.ask)}</p><ul>${r.hits.slice(0, 12).map((h) => `<li>${link(h.hunk, `${h.file}${h.line ? `:${h.line}` : ''}`)} <span class="muted">${esc(h.reason)}</span></li>`).join('')}${r.hits.length > 12 ? `<li class="muted">…and ${r.hits.length - 12} more</li>` : ''}</ul></div>`).join('')
    : '<p>The diff touches none of the tracked risk categories (auth, data access, dependencies, secrets/config, CI, permissions/hooks).</p>'
  const inj = b.injection.length
    ? `<div class="warn"><strong>Possible prompt-injection content (${b.injection.length})</strong>: added lines that read as text addressed to an AI. Repos that write prompts trip this legitimately; read each one.<ul>${b.injection.map((i) => `<li>${link(i.hunk, `${i.file}:${i.line}`)} <code>${esc(i.text)}</code></li>`).join('')}</ul></div>`
    : '<p class="muted">No added line reads as text addressed to an AI.</p>'
  const red = b.redactions.length
    ? `<table class="grid"><tr><th>Source</th><th>Kind</th><th>Count</th></tr>${b.redactions.map((r) => `<tr><td>${esc(r.source)}</td><td>${esc(r.kind)}</td><td>${r.count}</td></tr>`).join('')}</table>`
    : '<p class="muted">Nothing was redacted.</p>'
  const s = b.why.sessions[0]
  const checks = s && s.commands.length
    ? `<ul>${s.commands.slice(-8).map((c) => `<li><span class="badge ${esc(c.status)}">${esc(c.status)}</span> <code>${esc(c.command.slice(0, 140))}</code></li>`).join('')}</ul>`
    : '<p class="muted">No checks recorded in the session transcript.</p>'
  return `${sum}<h3>Risk checklist <span class="muted">(only categories this diff touches)</span></h3>${risks}<h3>Prompt-injection flag</h3>${inj}<h3>External reviewer verdict</h3>${verdictBlock(verdict)}<h3>Checks the session ran (last 8)</h3>${checks}<h3>Redaction report</h3>${red}`
}

const CSS = `:root{--bg:#fff;--fg:#1d2125;--mut:#6b7280;--bd:#e3e6ea;--pan:#f6f7f9;--add:#e6ffec;--del:#ffebe9;--acc:#2b59c3;--warn:#fff4e5;--warnb:#f59f00}
@media (prefers-color-scheme:dark){:root{--bg:#15171a;--fg:#e6e8eb;--mut:#9aa1ab;--bd:#2c3036;--pan:#1d2024;--add:#11301b;--del:#3a1517;--acc:#7aa2ff;--warn:#33270f;--warnb:#f59f00}}
*{box-sizing:border-box}body{margin:0;font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;background:var(--bg);color:var(--fg)}
header{position:sticky;top:0;z-index:5;background:var(--bg);border-bottom:1px solid var(--bd);padding:10px 16px}
h1{font-size:16px;margin:0 0 4px}h3{margin:18px 0 8px}h4{margin:14px 0 6px}main{padding:12px 16px 60px;max-width:1500px}
nav{display:flex;flex-wrap:wrap;gap:4px;margin-top:8px}nav button,.seg button,.rawbtn{border:1px solid var(--bd);background:var(--pan);color:var(--fg);padding:5px 11px;border-radius:6px;cursor:pointer;font:inherit}
nav button.on,.seg button.on{background:var(--acc);border-color:var(--acc);color:#fff}.rawbtn{float:right;font-weight:600}
.muted{color:var(--mut)}.note{background:var(--pan);border:1px solid var(--bd);border-radius:6px;padding:8px 10px}.tag{font-size:11px;border:1px solid var(--bd);border-radius:10px;padding:0 6px;color:var(--mut)}
.add{color:#2f9e44}.del{color:#e03131}section.tab{display:none}section.tab.on{display:block}
.empty{border:1px dashed var(--bd);border-radius:8px;padding:24px;text-align:center;color:var(--mut)}.empty strong{color:var(--fg)}
.toolbar{display:flex;gap:12px;align-items:center;margin-bottom:8px}.panes{display:grid;grid-template-columns:1fr 1fr;gap:10px}.pane{border:1px solid var(--bd);border-radius:6px;overflow:hidden}
.pane-h{padding:6px 8px;background:var(--pan);border-bottom:1px solid var(--bd)}.pane iframe{width:100%;height:70vh;border:0;background:#fff;display:block;margin:0 auto}.panes.mobile iframe{width:390px;max-width:100%}
.trio{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}figure{margin:0}figure img{width:100%;border:1px solid var(--bd)}figure.miss div{border:1px dashed var(--bd);padding:20px;color:var(--mut)}figcaption{font-size:12px;color:var(--mut)}
details.file{border:1px solid var(--bd);border-radius:6px;margin:8px 0;overflow:hidden}details.file>summary{padding:6px 10px;background:var(--pan);cursor:pointer;font-family:ui-monospace,Menlo,monospace;font-size:13px}
.hh{background:var(--pan);color:var(--mut);font:12px ui-monospace,Menlo,monospace;padding:2px 10px;border-top:1px solid var(--bd)}
table{border-collapse:collapse;width:100%}.hunk td{font:12px/1.5 ui-monospace,Menlo,monospace;vertical-align:top}.hunk td.n{width:1%;min-width:40px;padding:0 6px;text-align:right;color:var(--mut);user-select:none}.hunk td.s{white-space:pre-wrap;word-break:break-all;padding-right:8px}
tr.la{background:var(--add)}tr.ld{background:var(--del)}.m{display:inline-block;width:14px;color:var(--mut)}.tc{color:#6a737d;font-style:italic}.ts{color:#0a7d33}.tn{color:#b35900}.tk{color:#8250df}
@media (prefers-color-scheme:dark){.ts{color:#7ee787}.tn{color:#ffa657}.tk{color:#d2a8ff}}
.hunk:target,.file:target{outline:2px solid var(--acc)}.graphwrap{overflow:auto;border:1px solid var(--bd);border-radius:6px;padding:6px}.cy{height:520px;border:1px solid var(--bd);border-radius:6px}
.node rect{fill:var(--pan);stroke:#8a94a6}.node.changed rect{fill:#ffe8d9;stroke:#d9480f}.node.test rect{stroke:#2f9e44;stroke-width:2}.node text{font:11px ui-monospace,Menlo,monospace;fill:#1d2125}.colh{font-weight:600;fill:var(--mut);font-size:12px}.edge{fill:none;stroke:#b5bcc6}
.legend .sw{display:inline-block;width:12px;height:12px;border:1px solid #8a94a6;background:var(--pan);vertical-align:middle;margin:0 4px 0 10px}.legend .sw.changed{background:#ffe8d9;border-color:#d9480f}.legend .sw.test{border:2px solid #2f9e44}
pre{white-space:pre-wrap;word-break:break-word;background:var(--pan);border:1px solid var(--bd);border-radius:6px;padding:8px;font:12px ui-monospace,Menlo,monospace;max-height:420px;overflow:auto}
.grid td,.grid th{border:1px solid var(--bd);padding:4px 6px;text-align:left;vertical-align:top}.grid pre{max-height:240px}tr.faint{opacity:.6}ul.cols{columns:2}
.badge{font-size:11px;font-weight:600;border-radius:4px;padding:1px 6px;background:#e9ecef;color:#495057}.badge.pass{background:#d3f9d8;color:#2b8a3e}.badge.fail{background:#ffe3e3;color:#c92a2a}
.summary{border:2px dashed var(--warnb);border-radius:8px;padding:10px 12px}.sumh{font-weight:700;font-size:12px;letter-spacing:.03em;color:#b35900}
.warn{background:var(--warn);border:1px solid var(--warnb);border-radius:6px;padding:8px 10px}.risk{border:1px solid var(--bd);border-radius:6px;padding:8px 10px;margin:8px 0}.risk p{margin:4px 0}
.banner{margin-top:6px;font-size:13px}dialog{width:min(1200px,96vw);height:90vh;border:1px solid var(--bd);border-radius:8px;background:var(--bg);color:var(--fg);padding:0}dialog pre{max-height:none;height:calc(90vh - 52px);margin:0;border:0;border-radius:0}
.sr{position:absolute;left:-9999px}.dlg-h{display:flex;justify-content:space-between;align-items:center;padding:8px 12px;border-bottom:1px solid var(--bd)}
@media (max-width:760px){.panes,.trio{grid-template-columns:1fr}.rawbtn{float:none;margin-bottom:6px}ul.cols{columns:1}}`

const JS = `(function(){
var tabs=[].slice.call(document.querySelectorAll('nav button'));
function show(id){tabs.forEach(function(b){b.classList.toggle('on',b.dataset.t===id)});[].forEach.call(document.querySelectorAll('section.tab'),function(s){s.classList.toggle('on',s.id==='tab-'+id)});}
tabs.forEach(function(b){b.addEventListener('click',function(){show(b.dataset.t);history.replaceState(null,'','#tab-'+b.dataset.t)})});
document.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a[data-tab]');if(!a)return;show(a.dataset.tab);var t=document.getElementById(a.getAttribute('href').slice(1));if(t){var d=t.closest('details');if(d)d.open=true;if(t.tagName==='DETAILS')t.open=true;var dl=document.getElementById('raw');if(dl&&dl.open)dl.close();}});
var h=location.hash.replace('#tab-','');show(tabs.some(function(b){return b.dataset.t===h})?h:'${'code'}');
var raw=document.getElementById('raw');document.getElementById('rawbtn').addEventListener('click',function(){raw.showModal?raw.showModal():raw.setAttribute('open','')});document.getElementById('rawclose').addEventListener('click',function(){raw.close?raw.close():raw.removeAttribute('open')});
var r=document.getElementById('route');function go(){var v=r.value;[].forEach.call(document.querySelectorAll('[data-base]'),function(el){try{var u=new URL(el.dataset.base);u.pathname=(u.pathname.replace(/\\/$/,'')+v).replace(/\\/{2,}/g,'/');if(el.tagName==='IFRAME')el.src=u.toString();else el.href=u.toString();}catch(e){}})}
if(r)r.addEventListener('change',go);
[].forEach.call(document.querySelectorAll('.vp'),function(b){b.addEventListener('click',function(){[].forEach.call(document.querySelectorAll('.vp'),function(x){x.classList.toggle('on',x===b)});document.getElementById('panes').classList.toggle('mobile',b.dataset.vp==='mobile')})});
})()`

/**
 * @param {object} b  bundle from collect()
 * @param {{ summary?: object|null, verdict?: object|null, graphLib?: string }} [opt]
 */
export function renderHtml(b, opt = {}) {
  const short = b.range.head.slice(0, 7)
  const anyUrl = httpUrl(b.tryIt.beforeUrl) || httpUrl(b.tryIt.afterUrl)
  const csp = `default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-src ${anyUrl ? 'http: https:' : "'none'"}; base-uri 'none'; form-action 'none'`
  const banner = [
    b.injection.length ? `<span class="badge fail">possible prompt-injection content: ${b.injection.length} line(s)</span>` : '',
    b.redactions.length ? `<span class="badge">redacted ${b.redactions.reduce((n, r) => n + r.count, 0)} value(s)</span>` : '',
    b.risks.length ? `<span class="badge">risk areas: ${b.risks.map((r) => esc(r.key)).join(', ')}</span>` : '',
  ].filter(Boolean).join(' ')
  const sections = {
    try: tryIt(b), visual: visual(b), code: code(b), blast: blast(b, opt.graphLib), why: why(b), approve: approve(b, sanitizeSummary(opt.summary), opt.verdict),
  }
  const title = b.range.pr ? `PR #${b.range.pr.number}: ${b.range.pr.title}` : `${b.range.headLabel} vs ${b.range.baseLabel}`
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="referrer" content="no-referrer">
<title>Review cockpit ${esc(short)}</title><style>${CSS}</style></head><body>
<header><button type="button" class="rawbtn" id="rawbtn" title="Open the raw unified diff">Raw diff</button>
<h1>Review cockpit: ${esc(title)}</h1>
<div class="muted">${esc(b.repo.slug || b.repo.root)} · ${esc(b.range.base.slice(0, 7))}..${esc(short)} · ${b.stats.files} files <span class="add">+${b.stats.additions}</span> <span class="del">-${b.stats.deletions}</span> · generated ${esc(b.generatedAt)}</div>
${banner ? `<div class="banner">${banner}</div>` : ''}
<nav>${TABS.map(([id, label]) => `<button type="button" data-t="${id}">${esc(label)}</button>`).join('')}</nav></header>
<main>${TABS.map(([id, label]) => `<section class="tab" id="tab-${id}"><h2 class="sr">${esc(label)}</h2>${sections[id]}</section>`).join('\n')}</main>
<dialog id="raw"><div class="dlg-h"><strong>Raw diff</strong><span><a download="cockpit-${esc(short)}.diff" href="data:text/x-diff;charset=utf-8,${encodeURIComponent(b.rawDiff)}">download</a> <button type="button" class="rawbtn" id="rawclose">Close</button></span></div><pre>${esc(b.rawDiff)}</pre></dialog>
<script>${JS}</script></body></html>
`
}
