// One POST to the OpenAI Responses API, using Node's built-in fetch (no SDK, no deps).
import { SEVERITIES, CONFIDENCES } from './config.mjs'

export const MAX_FINDINGS = 25
const clip = (v, n) => (typeof v === 'string' ? (v.length > n ? v.slice(0, n) + '…' : v) : '')
// Error text from the endpoint (or a proxy at OPENAI_BASE_URL) and refusal text from the
// model both end up in messages Claude reads unfenced, so only a code-shaped token is kept.
const code = (v) => (typeof v === 'string' && /^[a-z0-9_.-]{1,64}$/i.test(v) ? ` (${v})` : '')

// The model's JSON is validated, clamped and re-built field by field: it is derived from
// untrusted input, so nothing in it is passed through by reference or trusted for shape.
export function validateReview(obj) {
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.findings)) throw new Error('review JSON has no findings array')
  const findings = []
  for (const f of obj.findings) {
    if (!f || typeof f !== 'object') continue
    if (!SEVERITIES.includes(f.severity) || !CONFIDENCES.includes(f.confidence)) continue
    findings.push({
      severity: f.severity,
      confidence: f.confidence,
      cwe: /^CWE-\d{1,5}$/.test(f.cwe) ? f.cwe : '',
      file: clip(f.file, 300),
      line: Number.isSafeInteger(f.line) && f.line > 0 ? f.line : 0,
      title: clip(f.title, 200),
      explanation: clip(f.explanation, 1500),
      fix: clip(f.fix, 1000),
    })
    if (findings.length >= MAX_FINDINGS) break
  }
  return { summary: clip(obj.summary, 1500), findings }
}

export function parseResponse(json) {
  if (!json || typeof json !== 'object') throw new Error('empty response body')
  if (json.error) throw new Error(`OpenAI error${code(json.error.code) || code(json.error.type)}`)
  if (json.status && json.status !== 'completed') {
    throw new Error(`response ${code(json.status) ? json.status : 'not completed'}${code(json.incomplete_details?.reason)}`)
  }
  let text = ''
  for (const item of json.output || []) {
    if (item?.type !== 'message') continue
    for (const c of item.content || []) {
      if (c?.type === 'refusal') throw new Error('model refused to review this change')
      if (c?.type === 'output_text' && typeof c.text === 'string') text += c.text
    }
  }
  if (!text) throw new Error('response contained no output_text')
  let obj
  try { obj = JSON.parse(text) } catch { throw new Error('model output was not valid JSON') }
  return { review: validateReview(obj), usage: json.usage || null }
}

export async function callResponses(body, cfg, fetchImpl = globalThis.fetch) {
  if (!cfg.apiKey) throw new Error('OPENAI_API_KEY is not set')
  let res
  try {
    res = await fetchImpl(`${cfg.baseUrl}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    })
  } catch (e) {
    throw new Error(e?.name === 'TimeoutError' ? `timed out after ${Math.round(cfg.timeoutMs / 1000)}s` : `request failed: ${e?.message || e}`)
  }
  const raw = await res.text()
  let json = null
  try { json = JSON.parse(raw) } catch { /* fall through */ }
  if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}${code(json?.error?.code) || code(json?.error?.type)}`)
  return parseResponse(json)
}

// USD per 1M tokens, from the published GPT-6 Luna price sheet (Sept 2026). Long-context
// requests (> 272K input tokens) bill 2x input and 1.5x output. Other models: no estimate.
const PRICES = { 'gpt-6-luna': { input: 0.10, cached: 0.01, output: 0.50 } }
export function estimateCost(usage, model) {
  const p = PRICES[model]
  if (!p || !usage) return null
  const inTok = usage.input_tokens || 0
  const cached = usage.input_tokens_details?.cached_tokens || 0
  const outTok = usage.output_tokens || 0
  const long = inTok > 272_000
  const usd = ((inTok - cached) * p.input * (long ? 2 : 1) + cached * p.cached * (long ? 2 : 1) +
    outTok * p.output * (long ? 1.5 : 1)) / 1e6
  return Math.round(usd * 10000) / 10000
}
