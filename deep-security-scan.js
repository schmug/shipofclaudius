// Reusable deep (higher-recall) security audit workflow.
// The deterministic, fan-out expression of a "deep security scan": rather than one
// discovery pass, it runs K INDEPENDENT discovery workers in parallel, each with its
// own threat-model LENS, then semantically merges their candidates, validates each
// surviving candidate (disprove-first), and synthesizes ONE report. The recall win
// comes from diverse independent framings + a merge — one pass gets unlucky and misses
// things; N lenses don't miss the same things.
//
// Repository / scoped-path audits only (for a diff/PR, use the security-diff-scan skill).
// This is the heavyweight sibling of the security-scan skill and reuses its HTML report
// template at ~/.claude/skills/security-scan/assets/report-template.html.
//
// Run:  Workflow({ scriptPath: "~/.claude/workflows/deep-security-scan.js",
//                  args: { target: ".", scope: "the whole repo", rounds: 4 } })
//   - args.target:    repo root or subpath to audit (default ".").
//   - args.scope:     human description of scope (default: the whole repo at target).
//   - args.rounds:    number of independent discovery workers (default 4, or budget-scaled).
//   - args.lenses:    optional array of custom threat-model lenses (overrides defaults).
//   - args.threshold: min severity to report — critical|high|medium|low|info (default "low").
//   - args.tools:     deterministic prefilter tools to run before discovery
//                     (default ['foxguard']; [] disables Phase 0). Fail-open:
//                     a missing tool is logged + reported, never fatal.
//   - args.toolSeverity: severity floor passed to the tool (default "low" —
//                     independent of the report threshold).
//
// Cost: ~rounds discovery agents + one validation agent per unique candidate + one
// report agent. Deliberately more expensive than a single pass — that's the recall trade.
//
// Design notes baked in: args may arrive as a JSON string (parse-guard); two barriers
// are intentional (dedup needs ALL discovery; the report needs ALL validation); no
// Date.now in scripts, so the report agent stamps the output dir via `date -u`.
//
// Phase 0 runs a deterministic scanner (foxguard: SAST taint rules, secrets, OSV
// SCA, PQC) whose findings enter the same merge ahead of agent candidates, so
// exact-line tool findings win dedup ties. Validators are TRACE-ONLY (no builds/
// tests/servers — concurrent builds stalled the gitdot run, 2026-06-09) and run
// in chunks of 8.

export const meta = {
  name: 'deep-security-scan',
  description: 'Higher-recall repo security audit: K independent threat-model-lensed discovery workers -> semantic merge -> disprove-first validation -> one HTML+md report',
  whenToUse: 'Repository or scoped-path security audit where recall matters and a single pass risks missing things. Not for diffs/PRs (use security-diff-scan).',
  phases: [
    { title: 'Tools', detail: 'deterministic prefilter (foxguard: SAST, secrets, SCA) — zero-token candidates' },
    { title: 'Discovery', detail: 'K independent workers, each a distinct threat-model lens, find candidates in parallel' },
    { title: 'Validate', detail: 'one disprove-first validator per unique candidate after semantic merge' },
    { title: 'Report', detail: 'synthesize one HTML + markdown report from confirmed, reportable findings' },
  ],
}

const A = (typeof args === 'string') ? JSON.parse(args) : (args || {})
const TARGET = A.target || '.'
const SCOPE = A.scope || `the entire repository at ${TARGET}`
const THRESHOLD = (A.threshold || 'low').toLowerCase()
const HAS_BUDGET = (typeof budget !== 'undefined' && budget && budget.total)
const ROUNDS = A.rounds || (HAS_BUDGET ? Math.max(3, Math.min(8, Math.floor(budget.total / 120000))) : 4)
const TOOLS = Array.isArray(A.tools) ? A.tools : ['foxguard']
const TOOL_SEVERITY = (A.toolSeverity || 'low').toLowerCase()

// Diverse default lenses — each worker hunts hardest within its lens, which is what makes
// the independent passes find DIFFERENT things instead of redundantly re-finding the same.
const DEFAULT_LENSES = [
  'Injection & untrusted-input flow: SQL/NoSQL/OS-command/LDAP injection, XSS & template injection, SSRF, path traversal, insecure deserialization, and missing output encoding. Trace attacker-controlled input to dangerous sinks.',
  'AuthN/AuthZ & multi-tenancy: missing or broken access control, IDOR, privilege escalation, session/token/cookie handling, and tenant-isolation breaks. Look for enforcement gaps on real entry points.',
  'Secrets, crypto & supply chain: hardcoded secrets/keys/tokens, secrets in logs, weak or hand-rolled crypto, insecure randomness, and risky/outdated/tampered dependencies (manifests + lockfiles). (If a deterministic tool pass ran, it already caught literal secret patterns and known-CVE manifests — hunt the remainder: secrets flowing into logs/telemetry, crypto misuse, and whether vulnerable dependencies are reachable in how the code actually uses them.)',
  'Resource, concurrency & logic: unbounded input / DoS, race conditions & TOCTOU, business-logic flaws, unsafe defaults, insecure file/temp handling, and dangerous configuration.',
]
const LENSES = Array.isArray(A.lenses) && A.lenses.length ? A.lenses : DEFAULT_LENSES

// Build exactly ROUNDS worker lenses: named lenses first, then generalist fresh passes
// (varied by index, since Math.random is unavailable) to fill out the count.
const WORKERS = Array.from({ length: ROUNDS }, (_, i) =>
  i < LENSES.length
    ? { id: i, lens: LENSES[i] }
    : { id: i, lens: `Fresh generalist pass #${i - LENSES.length + 1}: independently re-audit ${SCOPE} for anything the lens-specialized workers might miss. Do not assume earlier workers were thorough; start from your own threat model.` }
)

const CANDIDATE_ITEM = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'file', 'line', 'vuln_class', 'why'],
  properties: {
    title: { type: 'string', description: 'One-line description of the suspected vulnerability.' },
    file: { type: 'string', description: 'Repo-relative file path.' },
    line: { type: 'integer', description: 'Best-guess line number of the sink/issue (0 if unknown).' },
    vuln_class: { type: 'string', description: 'e.g. sql-injection, xss, ssrf, idor, missing-authz, hardcoded-secret, vulnerable-dependency, weak-crypto, path-traversal, deserialization, race-condition, dos.' },
    source: { type: 'string', description: 'The attacker-controlled input — or, for tool findings, "<tool>:<rule-id>".' },
    sink: { type: 'string', description: 'The dangerous operation reached, if applicable.' },
    why: { type: 'string', description: '1-2 sentences: why this is plausibly exploitable, citing the code.' },
  },
}

const CANDIDATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['threat_model', 'candidates'],
  properties: {
    threat_model: { type: 'string', description: 'Short lens-specific threat model: product surfaces, trust boundaries, attacker-controlled inputs, and invariants that matter for THIS lens — anchored in the repo\'s own established security patterns.' },
    files_reviewed: { type: 'integer', description: 'Approximate count of source files this worker actually opened and reviewed.' },
    candidates: {
      type: 'array',
      description: 'Technically-plausible candidate vulnerabilities found through this lens. Low bar — include anything worth ruling out. Empty array is valid.',
      items: CANDIDATE_ITEM,
    },
  },
}

const TOOL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ran', 'tool_version', 'files_scanned', 'note', 'candidates'],
  properties: {
    ran: { type: 'boolean', description: 'True iff the tool executed and produced output. False if not installed or it errored.' },
    tool_version: { type: 'string', description: 'Tool version string; empty if ran=false.' },
    files_scanned: { type: 'integer', description: 'Files scanned per the tool output; 0 if unknown.' },
    note: { type: 'string', description: 'ran=false: the exact reason (not installed / error summary). ran=true: one-line run summary.' },
    candidates: { type: 'array', description: 'Tool findings mapped to candidates. Empty array is valid.', items: CANDIDATE_ITEM },
  },
}

const VALIDATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['disposition', 'severity', 'reportable', 'rationale'],
  properties: {
    disposition: { type: 'string', enum: ['confirmed', 'refuted', 'needs-info'], description: 'confirmed=evidence shows with >80% confidence it is real, reachable, and exploitable; refuted=a guard defeats it / input not attacker-controlled / not reachable; needs-info=could not prove or disprove within bounded effort (anything under the 80% bar lands here, never in confirmed).' },
    severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'], description: 'Calibrated from impact x reachability x preconditions. Use info for refuted/non-issues.' },
    reportable: { type: 'boolean', description: `True iff disposition=confirmed AND severity meets the ${THRESHOLD} threshold AND it is in scope. Refuted and needs-info are NOT reportable.` },
    rationale: { type: 'string', description: 'Concise justification for the disposition: the decisive reason it is confirmed / refuted / needs-info.' },
    attacker_story: { type: 'string', description: 'How the issue is reached and abused, in concrete terms.' },
    evidence: { type: 'string', description: 'The proof: the attacker-input -> sink trace naming each guard on the path and why it does/does not defeat the input.' },
    proof_gap: { type: 'string', description: 'For needs-info: the exact missing piece (service, input, infra). Empty otherwise.' },
    fix: { type: 'string', description: 'Concrete remediation.' },
    cvss_vector: { type: 'string', description: 'Optional CVSS 3.1 vector; must match the prose severity. Empty if not assessed.' },
  },
}

// ---- Phase 0: deterministic prefilter (zero-token findings before any agent spend) ----
let toolReport = null
if (TOOLS.includes('foxguard')) {
  phase('Tools')
  log(`Phase 0: deterministic prefilter (foxguard, severity floor ${TOOL_SEVERITY}).`)
  toolReport = await agent(
    `You are the deterministic-prefilter worker for a deep security scan of ${SCOPE} (repo at "${TARGET}").

1. Check availability: \`command -v foxguard\`. If missing, return ran=false, note="foxguard not installed" — do NOT install anything.
2. Capture the version NUMBER only from \`foxguard --version\` (e.g. "0.8.1", not the full "foxguard 0.8.1" string) into tool_version — the report prepends the tool name itself.
3. Run \`foxguard --format json --severity ${TOOL_SEVERITY} "${TARGET}"\`, saving stdout to a temp file. Exit code 0 = clean; exit code 1 with a JSON array on stdout = findings detected — both are SUCCESS (verified against foxguard 0.8.1). Only a nonzero exit with no parseable JSON output is a tool error: return ran=false with a one-line stderr summary in note.
4. Map EVERY finding to a candidate: title = the rule message; file = repo-relative path; line; vuln_class mapped onto the standard taxonomy (secret rules -> hardcoded-secret, dependency CVEs -> vulnerable-dependency, taint/injection rules -> sql-injection/xss/path-traversal/etc., crypto + PQC rules -> weak-crypto); source = "foxguard:<rule-id>"; sink if the rule names one; why = one sentence citing the matched code. Collapse exact duplicates (same rule+file+line).
5. files_scanned: the JSON format omits the scan count, so capture it from a quick second pass in the default terminal format — \`foxguard --severity ${TOOL_SEVERITY} "${TARGET}" 2>&1 | grep -oE 'Scanned [0-9]+ files'\` — and report that integer. If the line is absent, use 0.

Do NOT validate, filter, or fix — mapping only; skeptical validation happens downstream. Return the structured object.`,
    { label: 'tools:foxguard', phase: 'Tools', schema: TOOL_SCHEMA }
  )
}
const toolCandidates = (toolReport && toolReport.ran && Array.isArray(toolReport.candidates)) ? toolReport.candidates : []
const TOOL_NOTE = (toolReport && toolReport.ran)
  ? `

NOTE: a deterministic scanner (foxguard ${toolReport.tool_version}) already swept this target for pattern-matchable issues — secret patterns, known-CVE dependencies (OSV), taint-rule SAST, weak/legacy-crypto API calls — and its ${toolCandidates.length} findings are already in the pipeline. Do not spend depth re-finding those classes; go deep on what tools cannot see: authorization gaps, business logic, tenant isolation, multi-step chains, and semantic misuse of otherwise-sound primitives.`
  : ''
const TOOL_COVERAGE = !TOOLS.includes('foxguard')
  ? 'Deterministic prefilter disabled (args.tools=[]).'
  : (toolReport && toolReport.ran)
    ? `Deterministic prefilter: foxguard ${toolReport.tool_version}, severity floor ${TOOL_SEVERITY}, ${toolReport.files_scanned > 0 ? `${toolReport.files_scanned} files scanned` : 'files-scanned count not reported by tool'}, ${toolCandidates.length} findings ingested as candidates.`
    : `Deterministic prefilter SKIPPED: ${toolReport ? toolReport.note : 'tool agent returned no result'}.`

// ---- Phase 1: independent lensed discovery (barrier: dedup needs all of it) ----
phase('Discovery')
log(`Deep scan of ${SCOPE} — ${WORKERS.length} independent discovery workers (threshold=${THRESHOLD}).`)

const discoveries = await parallel(
  WORKERS.map((w) => () =>
    agent(
      `You are independent security discovery worker #${w.id} auditing ${SCOPE}. Work from the repo at "${TARGET}".

Your assigned threat-model LENS:
${w.lens}${TOOL_NOTE}

Do this:
1. FIRST learn the repo's own established security patterns (how it does auth, input validation, sanitization, secrets handling), then build a short threat model THROUGH YOUR LENS (product surfaces, trust boundaries, attacker-controlled inputs, invariants). Return it in threat_model. Deviations from the repo's own conventions are first-class candidates — not just generic checklist hits.
2. Enumerate and risk-rank the in-scope source files (skip vendored/generated/lockfiles for review, but note dependency manifests for supply-chain). Use Read/Grep/Glob/Bash. Review highest-risk first.
3. Find technically-plausible candidate vulnerabilities in your lens. Keep the bar LOW — record anything worth ruling out; validation happens later. Follow attacker-input chains across files. Trust the code, not comments.
4. For each candidate give a file, best-guess line, vuln_class, source/sink, and a concrete "why". Do NOT validate or fix here.

You are ONE of several independent workers with different lenses; do not try to cover everything — go DEEP on yours. Report files_reviewed honestly. Return the structured object.`,
      { label: `discover:lens-${w.id}`, phase: 'Discovery', schema: CANDIDATE_SCHEMA }
    )
  )
)

// ---- Semantic merge + dedup (plain JS; the justified barrier) ----
const clean = discoveries.filter(Boolean)
const filesReviewed = clean.reduce((s, d) => s + (d.files_reviewed || 0), 0)
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '')
const seen = new Map()
let nextId = 1
const addCandidate = (c) => {
  // Collapse the same issue found by multiple lenses: same file + class + ~line bucket.
  const key = `${norm(c.file)}|${norm(c.vuln_class)}|${Math.round((c.line || 0) / 8)}`
  const altKey = `${norm(c.file)}|${norm(c.title)}`
  if (seen.has(key) || seen.has(altKey)) return
  const entry = { id: `f${nextId++}`, ...c }
  seen.set(key, entry)
  seen.set(altKey, entry)
}
// Tool candidates enter FIRST: insertion order is dedup precedence, and an
// exact-line deterministic finding beats a fuzzier agent guess at the same spot.
for (const c of toolCandidates) addCandidate(c)
for (const d of clean) for (const c of (d.candidates || [])) addCandidate(c)
const unique = [...new Set(seen.values())]
log(`Discovery merged: ${clean.length}/${WORKERS.length} workers, ~${filesReviewed} file-reviews, ${toolCandidates.length} tool candidates -> ${unique.length} unique after dedup.`)

if (unique.length === 0) {
  return {
    target: TARGET, scope: SCOPE, rounds: WORKERS.length,
    files_reviewed: filesReviewed, candidates: 0, reportable: [],
    tool_coverage: TOOL_COVERAGE,
    note: 'No candidate vulnerabilities surfaced across the independent discovery workers. Treat as "covered these lenses, found nothing" — see workers\' threat models for coverage.',
    worker_threat_models: clean.map((d, i) => ({ worker: i, threat_model: d.threat_model })),
  }
}

// ---- Phase 2: disprove-first validation (barrier: report needs all verdicts) ----
phase('Validate')
// Chunked: dozens of concurrent validators thrashed a large workspace and
// tripped the no-progress watchdog (gitdot, 2026-06-09). 8 at a time is the
// proven-safe ceiling; the report barrier below is unaffected.
const VALIDATE_CHUNK = 8
const validated = []
for (let i = 0; i < unique.length; i += VALIDATE_CHUNK) {
  const chunk = unique.slice(i, i + VALIDATE_CHUNK)
  log(`Validating candidates ${i + 1}-${i + chunk.length} of ${unique.length}.`)
  const results = await parallel(
    chunk.map((c) => () =>
      agent(
        `You are an independent, SKEPTICAL security validator. Your default is "false positive until the evidence shows otherwise." Work from the repo at "${TARGET}".

Candidate to validate:
- title: ${c.title}
- file:  ${c.file}:${c.line || '?'}
- class: ${c.vuln_class}
- source/sink: ${c.source || '?'} -> ${c.sink || '?'}
- finder's reasoning: ${c.why}

Try hard to DISPROVE it:
1. Open the cited file and the code it reaches. Never conclude on a location you have not read.
2. TRACE-ONLY validation: do NOT build, test, or run the project — no cargo build/test/check/run, no npm/pnpm/yarn/bun install/build/test/dev, no server starts, no migrations (concurrent builds have stalled this pipeline before). Validate by reading code: trace attacker-input -> sink, naming EVERY guard on the path and whether it truly defeats the input, plus the preconditions an attacker needs. Read-only shell (rg, ls, git grep) is fine.
3. Decide disposition: confirmed ONLY if you are >80% confident it is real, reachable, and exploitable; refuted (a guard defeats it / input not attacker-controlled / not reachable — say why); or needs-info (state the EXACT proof gap; anything under the 80% bar is needs-info, never confirmed).
4. If confirmed, calibrate severity from impact x reachability x preconditions, and set reportable per the ${THRESHOLD} threshold + in-scope. Give an attacker story, the evidence, and a concrete fix.

Return the structured object.`,
        { label: `validate:${c.id}`, phase: 'Validate', schema: VALIDATION_SCHEMA }
      ).then((v) => (v ? { ...c, ...v } : null))
    )
  )
  validated.push(...results)
}

const verdicts = validated.filter(Boolean)
const reportable = verdicts.filter((v) => v.reportable && v.disposition === 'confirmed')
const sevRank = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }
reportable.sort((a, b) => (sevRank[a.severity] ?? 9) - (sevRank[b.severity] ?? 9))
const counts = reportable.reduce((m, v) => ((m[v.severity] = (m[v.severity] || 0) + 1), m), {})
const appendix = verdicts.filter((v) => !v.reportable) // refuted / needs-info / below-threshold
log(`Validation: ${reportable.length} reportable, ${appendix.length} reviewed-not-reported. Severity: ${JSON.stringify(counts)}.`)

// ---- Phase 3: one synthesized report ----
phase('Report')
// The workflow runtime blocks subagents from WRITING report files it treats as "findings
// text" — report.md is rejected ("Subagents should return findings as text, not write
// report files"), while report.html (an artifact) is allowed. Align with that guardrail
// instead of fighting it: write ONLY report.html, embed the markdown base64-encoded inside
// it (recoverable with zero caller action), and RETURN the full markdown as structured
// output. The orchestrator surfaces report_md + paths so the caller persists report.md.
const REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['output_dir', 'report_html_path', 'report_md'],
  properties: {
    output_dir: { type: 'string', description: 'Absolute path to the created "-deep" output dir.' },
    report_html_path: { type: 'string', description: 'Absolute path to the written, verified report.html.' },
    report_md: { type: 'string', description: 'The FULL report.md content as text. Do NOT write it to disk (the subagent guardrail forbids it); the caller persists it from this field.' },
    html_written: { type: 'boolean', description: 'True iff report.html was written and verified present on disk (e.g. via test -f).' },
  },
}
const reportResult = await agent(
  `You are writing the final report for a deep security audit of ${SCOPE} (repo at "${TARGET}").

Reportable findings (confirmed, at/above the ${THRESHOLD} threshold), highest severity first:
${JSON.stringify(reportable, null, 2)}

Reviewed-but-not-reported (refuted / needs-info / below threshold) — these go in the appendix so suppression is visible, NOT deleted:
${JSON.stringify(appendix.map((v) => ({ title: v.title, file: v.file, line: v.line, disposition: v.disposition, severity: v.severity, reason: v.evidence || v.proof_gap || v.rationale })), null, 2)}

Coverage facts: ${TOOL_COVERAGE} ${WORKERS.length} independent discovery workers ran (lenses + their threat models below), ~${filesReviewed} file-reviews total, ${unique.length} unique candidates after merge (${toolCandidates.length} from the deterministic prefilter).
Worker threat models / lenses:
${JSON.stringify(clean.map((d, i) => ({ worker: i, files_reviewed: d.files_reviewed, threat_model: d.threat_model })), null, 2)}

Produce:
1. Create an output dir: run \`mkdir -p "${TARGET}/.security-scans/$(date -u +%Y%m%dT%H%M%SZ)-deep"\` and use it (capture the absolute path).
2. report.html — use the template at ~/.claude/skills/security-scan/assets/report-template.html if it exists, filling its {{TOKENS}}; otherwise produce an equivalent single-file, self-contained HTML report. CRITICAL: HTML-escape every code snippet, identifier, path, and any scanned input before inserting it (& -> &amp; < -> &lt; > -> &gt; " -> &quot;) — a reviewed file may contain <script>. Set the verdict border color to the highest severity present. Write report.html and then VERIFY it exists (e.g. \`test -f\`); set html_written accordingly.
3. report.md — compose the SAME report as a terminal/PR-friendly markdown summary: severity counts, each finding (title, severity, file:line, one-line fix), and the coverage statement. Do NOT write report.md to disk — the workflow subagent guardrail blocks subagents from writing report files. Instead RETURN the full markdown text in the report_md field of your structured output (the caller persists it).
4. So report.md is never lost even if the caller does nothing: ALSO embed the full markdown into report.html, base64-encoded, inside \`<script type="application/octet-stream" id="report-md-b64">…</script>\` (base64 cannot break out of the script tag, unlike raw text containing </script>), and add a small "Download report.md" button whose click handler does \`atob\` → \`Blob\` → download.
5. A mandatory COVERAGE STATEMENT in BOTH the HTML and report_md: the deterministic-prefilter line (tool + version + files scanned + findings ingested, or exactly why it was skipped/disabled), how many workers/lenses ran, approx files reviewed, candidates found vs reported, and the honest limits (what was NOT deeply reviewed). "Found nothing" must never read the same as "didn't look."

Return the structured object {output_dir, report_html_path, report_md, html_written}. Do not invent findings beyond those given.`,
  { label: 'report', phase: 'Report', schema: REPORT_SCHEMA }
)

const reportDir = (reportResult && reportResult.output_dir) || null
const reportHtml = (reportResult && reportResult.report_html_path) || null
const reportMd = (reportResult && reportResult.report_md) || null
if (reportMd) log(`report.html at ${reportDir}. report.md content is in the return's report_md field — the CALLER must write it to ${reportDir || '<output_dir>'}/report.md (workflow subagents cannot write .md). Also embedded base64 in report.html ("Download report.md").`)

return {
  target: TARGET,
  scope: SCOPE,
  rounds: WORKERS.length,
  files_reviewed: filesReviewed,
  tool_coverage: TOOL_COVERAGE,
  candidates: unique.length,
  counts,
  reportable,
  appendix_count: appendix.length,
  // First-class so the caller can persist report.md deterministically (subagents can't write it):
  report_dir: reportDir,
  report_html: reportHtml,
  report_md: reportMd,
  report: reportResult,
}
