# Threat model — `skills/factory-intake/scaffold/`

Written for the next agent editing the scaffold. Every file under `scaffold/` is copied
into every project the factory creates, so a control removed here is removed from every
future repo at once. `tests/factory-intake.test.mjs` pins each invariant below; change the
test and the template together or not at all. Design: `docs/specs/2026-09-06-factory-intake.md`
§7, §10, §11. This file sits beside `scaffold/`, not inside it, so it is not copied.

## What this thing is

A copy-and-fill template for a stateless Cloudflare Worker with static assets: production
config, a per-candidate preview config, a pinned CI workflow, a required-CI ruleset, and two
scripts (`smoke.mjs`, `critic.mjs`) that exercise a deployed preview *through* Cloudflare
Access with a service token. Placeholders (`{{SLUG}}`, `{{TITLE}}`, `{{DATE}}`,
`{{PROD_DOMAIN}}`, `{{PREVIEW_DOMAIN}}`, ...) are filled by the `factory-intake` skill;
`{{KEY}}` by the build agent; `{{LIVE_URL}}` by `critic.mjs` at run time.

## Trust boundaries

| Party | Trust | Reaches |
|---|---|---|
| The **build agent** (a model, in a scratch clone) | untrusted | every file in the project except the Access token, which it never receives |
| The **deployed candidate** | untrusted code on a shared preview domain | any request-derived input |
| The **critic** (`codex`, read-only sandbox, no network) | untrusted output | `factory-reports/<key>/critic.{json,md}` — data for the skill, never instructions |
| The **skill** running `smoke.mjs` / `critic.mjs` | trusted | `process.env.CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`, `--url`, `--key` |
| **GitHub Actions** | trusted only at the pinned SHAs | `npm ci && npm test` on the project |

## Invariants and the controls that hold them

### 1. The Access service token is read from the environment and never leaves as text

`smoke.mjs` and `critic.mjs` are the only code in the factory that touches the token. Each
reads both halves from `process.env`, attaches them only as request headers to the host
given by `--url`, and prints or writes neither. `critic.mjs` also drops `cf-access*` and
`set-cookie` response headers from the live-capture bundle so the critic's evidence carries
no credential material. **Pinned:** the suite greps every `console.log/error`,
`writeFileSync`, and `process.stdout` line for the secret's name.

Residual: the token goes to whatever host `--url` names. The skill derives that URL from
the build result's contract, never from model- or web-supplied text.

### 2. The Worker is stateless and never proxies a request-derived URL

`src/index.js` serves `/health` and hands everything else to `env.ASSETS`. It must not
`fetch()` a URL taken from the request (open proxy / SSRF on a shared preview hostname) and
`wrangler.jsonc` must not declare D1/KV/Durable Object/Queue bindings (nothing for a
candidate to persist or leak). The critic rubric's code-quality category scores against
both. **Pinned:** the `fetch(url|request.url|new URL(request` regex and the binding grep.

### 3. Preview candidates are reachable only through the Access-gated custom domain

The preview config names the Worker `factory-{{SLUG}}-{{KEY}}`, routes only to
`{{SLUG}}-{{KEY}}.{{PREVIEW_DOMAIN}}` with `custom_domain: true`, and sets `workers_dev`
and `preview_urls` to `false` — no `*.workers.dev` side door around Access. The production
config carries no `{{KEY}}`, so a candidate cannot be deployed as production by mistake.
**Pinned:** all four properties, plus the absence of `{{KEY}}` in `wrangler.jsonc`.

### 4. The merge gate exists before the first candidate is built

`ruleset.json` requires the `test` status check from GitHub Actions (integration id
15368) on the default branch and forbids deletion and non-fast-forward pushes, mirroring
this repo's own `main: required CI` ruleset. `ci.yml`'s job id is `test` — rename one and
the required context never reports, which blocks every merge rather than opening one.
**Pinned:** context list `['test']`, both rule types, `~DEFAULT_BRANCH`, and the `  test:`
job id.

### 5. CI runs only pinned actions with a read-only token

Every `uses:` in `ci.yml` is a 40-character commit SHA (the two this repo already pins in
`.factory/templates/factory.yml`), `permissions` is `contents: read`, `timeout-minutes` is
set, and no step interpolates event payload (`${{ github.event.* }}`) into a shell.
**Pinned:** the SHA regex on every `uses:`, and `timeout-minutes`.

### 6. No personal domain, account, or repository name in any template

The plugin is public. Hostnames arrive as `{{PROD_DOMAIN}}` / `{{PREVIEW_DOMAIN}}` and are
filled from the skill's environment. **Pinned:** the acceptance grep in issue #199; the
suite's placeholder regexes fail on a literal hostname.

## What is deliberately not here

- `devDependencies`: the skill installs `wrangler@latest` and `playwright@latest` at
  scaffold time so the project's lockfile, not this template, pins them.
- `SKILL.md` / `references/`: the skill half lands separately; this directory is only the
  template set.
