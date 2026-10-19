// Redaction pass for everything the cockpit embeds (diff, transcript text, command output).
//
// The cockpit is a file a human may forward, so nothing that looks like a credential may
// reach it. The rules lean toward over-redaction: a false positive costs a reviewer one
// "[REDACTED:...]" marker, a false negative leaks a key. Every hit is counted by kind and
// source so the Approve tab can report exactly what was removed.

const PLACEHOLDER = /^(\[REDACTED|\$\{|<|%|\{\{|your|example|changeme|placeholder|dummy|test|xxx|\*{3})/i

// [kind, regex, replacer]. Order matters: the specific token shapes run before the generic
// `name = "value"` assignment rule so a GitHub token is reported as one, not as "assignment".
export const RULES = [
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g],
  ['aws-access-key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{22,})\b/g],
  ['api-key', /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g],
  ['slack-token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/g],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['stripe-key', /\b[rs]k_(?:live|test)_[0-9a-zA-Z]{16,}\b/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  ['bearer-token', /\b(Bearer\s+)[A-Za-z0-9._~+/-]{20,}=*/g, (_, p) => `${p}[REDACTED:bearer-token]`],
  ['url-credentials', /\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/'"]+:)[^\s@/'"]+@/gi, (_, p) => `${p}[REDACTED:url-credentials]@`],
  ['assignment',
    /\b([A-Za-z0-9_.-]*(?:secret|token|passw(?:or)?d|api[_-]?key|access[_-]?key|private[_-]?key|auth[_-]?key)[A-Za-z0-9_.-]*["']?\s*[:=]\s*)(["'])([^"'\s]{8,})\2/gi,
    (m, lhs, q, v) => (PLACEHOLDER.test(v) ? m : `${lhs}${q}[REDACTED:assignment]${q}`)],
  ['env-line', /^([+ -]?\s*(?:export\s+)?[A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|ACCESS_KEY|PRIVATE_KEY)[A-Z0-9_]*\s*=\s*)(?!\[REDACTED)([^\s'"$][^\s]{7,})$/gm,
    (m, lhs, v) => (PLACEHOLDER.test(v) ? m : `${lhs}[REDACTED:env-line]`)],
  ['email', /\b[A-Za-z0-9._%+-]+@(?!example\.(?:com|org)\b|users\.noreply\.github\.com\b|anthropic\.com\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g],
]

/**
 * Redact one string. `report` (a Map) accumulates `${source}:${kind}` -> count.
 * @param {string} text
 * @param {string} source  e.g. "diff", "transcript", "command-output"
 * @param {Map<string, number>} [report]
 */
export function redact(text, source = 'text', report = new Map()) {
  let out = String(text == null ? '' : text)
  for (const [kind, re, fn] of RULES) {
    out = out.replace(re, (...m) => {
      const replaced = fn ? fn(...m) : `[REDACTED:${kind}]`
      if (replaced !== m[0]) report.set(`${source}:${kind}`, (report.get(`${source}:${kind}`) || 0) + 1)
      return replaced
    })
  }
  return out
}

/** Deep-redact every string inside a JSON-shaped value. */
export function redactDeep(value, source, report) {
  if (typeof value === 'string') return redact(value, source, report)
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, source, report))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, source, report)
    return out
  }
  return value
}

/** Turn the accumulated Map into a sorted, render-ready list. */
export const reportToList = (report) =>
  [...report.entries()].map(([key, count]) => {
    const [source, kind] = key.split(':')
    return { source, kind, count }
  }).sort((a, b) => a.source.localeCompare(b.source) || a.kind.localeCompare(b.kind))
