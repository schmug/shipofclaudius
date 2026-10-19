// Risk categories and the prompt-injection flag, both computed from the parsed diff.
//
// Deliberately heuristic: path patterns plus keywords on CHANGED lines only. A category
// appears in the Approve checklist only when the diff actually touches it, and every
// entry carries the file/hunk it came from so the reviewer lands on the evidence.

import { hunkId } from './diff.mjs'

const base = (p) => p.split('/').pop() || p

export const CATEGORIES = [
  {
    key: 'auth', title: 'Authentication & authorization',
    ask: 'Does every new or changed path still check who the caller is and what they may do?',
    path: /(^|\/)(auth|authn|authz|login|logout|session|sessions|oauth|sso|jwt|passport|rbac|acl|middleware)(\/|\.|$)/i,
    line: /\b(authenticat\w*|authori[sz]\w*|jwt|oauth|session|passw(or)?d|bcrypt|argon2|csrf|login|isAdmin|role[sd]?|permission[s]?|verifyToken|access[_-]?token)\b/i,
  },
  {
    key: 'data', title: 'Data access',
    ask: 'Are queries parameterized, scoped to the caller, and bounded? Any migration reversible?',
    path: /(^|\/)(db|database|migrations?|models?|schema|repositor(y|ies)|dao|queries)(\/|\.|$)|\.(sql|prisma)$/i,
    line: /\b(SELECT\b[\s\S]*\bFROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|DROP\s+TABLE|ALTER\s+TABLE)\b|\.(query|exec|execute|prepare|raw)\(|\b(prisma|knex|sequelize|mongoose|drizzle)\b/i,
  },
  {
    key: 'deps', title: 'Dependencies & lockfiles',
    ask: 'Is each added or bumped package expected, maintained, and pinned? Do lockfile changes match the manifest?',
    file: /^(package(-lock)?\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|requirements[\w.-]*\.txt|Pipfile(\.lock)?|poetry\.lock|pyproject\.toml|uv\.lock|go\.(mod|sum)|Cargo\.(toml|lock)|Gemfile(\.lock)?|composer\.(json|lock)|[\w.-]+\.csproj|packages\.lock\.json|deno\.json|deno\.lock)$/,
  },
  {
    key: 'secrets', title: 'Secrets & configuration',
    ask: 'Is any value here a credential, a production endpoint, or a setting that changes behaviour in prod?',
    path: /(^|\/)(\.env[\w.-]*|\.dev\.vars[\w.-]*|[\w.-]+\.(pem|key|p12|pfx)|wrangler[\w.-]*\.(json|jsonc|toml)|\.npmrc|\.pypirc|config(\/|\.[a-z]+$)|[\w.-]*\.config\.[a-z]+$|settings(\.local)?\.json$|secrets?[\w./-]*)$/i,
    line: /\b(process\.env|os\.environ|getenv|import\.meta\.env|secret|credential|api[_-]?key)\b|\[REDACTED:/i,
  },
  {
    key: 'ci', title: 'CI / build pipeline',
    ask: 'Does this change what runs in CI, with which permissions, or on which triggers (pull_request_target, secrets in forks)?',
    path: /^(\.github\/(workflows|actions)\/|\.gitlab-ci\.yml$|\.circleci\/|Jenkinsfile$|azure-pipelines\.ya?ml$|\.buildkite\/|\.github\/dependabot\.ya?ml$|\.factory\/)/,
  },
  {
    key: 'perms', title: 'Permissions, hooks & agent config',
    ask: 'Does this widen what an agent, hook, or token may do, or run code automatically on someone else\'s machine?',
    path: /(^|\/)(\.claude\/(settings[\w.-]*\.json|agents\/|hooks\/)|hooks\/|hooks\.json$|\.husky\/|\.pre-commit-config\.ya?ml$|\.mcp\.json$|\.claude-plugin\/|CODEOWNERS$)/,
    line: /\b(permissions\s*:|chmod\s+[0-7]*7|sudo\b|setuid|allowedTools|dangerously|--no-verify|bypassPermissions|contents:\s*write|pull_request_target)\b/i,
  },
]

/**
 * @param {import('./diff.mjs').DiffFile[]} files
 * @returns {{ key: string, title: string, ask: string, hits: { file: string, fileIndex: number, hunk: string|null, line: number|null, reason: string }[] }[]}
 */
export function riskCategories(files) {
  const out = []
  for (const cat of CATEGORIES) {
    const hits = []
    files.forEach((f, fi) => {
      const pathHit = (cat.file && cat.file.test(base(f.path))) || (cat.path && (cat.path.test(f.path) || cat.path.test(f.oldPath)))
      if (pathHit) hits.push({ file: f.path, fileIndex: fi, hunk: f.hunks.length ? hunkId(fi, 0) : null, line: null, reason: 'path matches' })
      if (!cat.line) return
      let perFile = 0
      f.hunks.forEach((h, hi) => {
        for (const l of h.lines) {
          if (l.t === ' ' || perFile >= 5) continue
          const m = l.s.match(cat.line)
          if (!m) continue
          hits.push({ file: f.path, fileIndex: fi, hunk: hunkId(fi, hi), line: l.newNo ?? l.oldNo, reason: `${l.t === '+' ? 'adds' : 'removes'} "${m[0].slice(0, 40)}"` })
          perFile++
        }
      })
    })
    if (hits.length) out.push({ key: cat.key, title: cat.title, ask: cat.ask, hits })
  }
  return out
}

// Text addressed to an AI. Matching ADDED lines only: a diff that deletes an injection is
// not adding one. False positives are expected in repos that write prompts (this one), so
// the flag says "possible" and points at the lines; it never blocks anything.
export const INJECTION_PATTERNS = [
  /\b(ignore|disregard|forget)\s+(all\s+|any\s+)?(the\s+|your\s+)?(previous|prior|above|earlier|preceding)\s+(instructions?|prompts?|rules|directions)/i,
  /\byou\s+are\s+(now\s+)?(an?\s+|the\s+)?(ai|assistant|language\s+model|llm|chat\s?bot|claude|gpt|copilot|codex|reviewer\s+bot)\b/i,
  /\b(as\s+an\s+ai|dear\s+(ai|assistant|llm|claude|copilot|model|reviewer\s+bot)|note\s+to\s+(the\s+)?(ai|llm|model|agent|assistant|reviewer\s+bot))\b/i,
  /\b(ai|llm|assistant|claude|copilot|codex|gpt|agent)s?\s*[:,]\s*(please\s+)?(you\s+must|ignore|do\s+not|don't|approve|merge|run|execute)\b/i,
  /<\|im_(start|end)\|>|\[\/?INST\]|<\/?(system|assistant)>|^\s*(system|assistant)\s*:/im,
  /\b(approve|merge|lgtm)\s+(this|the)\s+(pr|pull\s+request|change|diff)\s+(without|immediately|now)\b/i,
  /\bdo\s+not\s+(tell|inform|alert|mention\s+(this\s+)?to)\s+(the\s+)?(user|human|reviewer|maintainer)/i,
  /\b(new|updated|override)\s+(system\s+)?instructions?\s*:/i,
]

/** @returns {{ file: string, fileIndex: number, hunk: string, line: number, text: string }[]} */
export function injectionFlags(files) {
  const out = []
  files.forEach((f, fi) => f.hunks.forEach((h, hi) => {
    for (const l of h.lines) {
      if (l.t !== '+') continue
      if (INJECTION_PATTERNS.some((re) => re.test(l.s))) {
        out.push({ file: f.path, fileIndex: fi, hunk: hunkId(fi, hi), line: l.newNo, text: l.s.trim().slice(0, 200) })
        if (out.length >= 50) return
      }
    }
  }))
  return out
}
