# Threat model — `skills/factory-intake/scaffold/`

Written for the next agent editing the scaffold. Every file under `scaffold/` is copied
into every project the factory creates, so a control removed here is removed from every
future repo at once. `tests/factory-intake.test.mjs` pins each invariant below; change the
test and the template together or not at all. Design: `docs/specs/2026-09-06-factory-intake.md`
§7, §10, §11 (the scaffold) and §5, §8–§11 (the skill, invariants 7 and 8 below). This file sits
beside `scaffold/`, not inside it, so it is not copied.

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
| The **build agent** (a model, in a scratch clone) | untrusted | every file in the project except the Access token, which it never receives; a change to the files the skill executes is caught by invariant 8 before anything runs |
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

### 7. The skill half (`SKILL.md`, `references/`) keeps the write ladder behind a human answer

The skill runs in the user's session with the user's tools, so its controls are text the
model follows plus the static checks that keep that text load-bearing. Nothing under it is
copied into a project. **Pinned:** the five `factory-intake:` tests in
`tests/factory-intake.test.mjs`, the `factory-intake:` and `sanitized` tests in
`tests/policy-skills.test.mjs`, and the process-skill rules in `tests/plugin-integrity.test.mjs`.

- **Write ladder.** Phase 5 opens draft PRs only (via the `factory-build` skill, by name).
  Phase 9 runs `gh pr ready` and then `merge-pr-with-gate` with `execute: true` only **after**
  the Ship answer; a run marked **ungated** in Phase 4 stops at the ready PR and names the
  missing gate. `--admin` appears only as a prohibition. The one push to `main` is the
  scaffold's, into the repository the run just created. Pinned: `gh pr ready`,
  `execute: true`, "never" within 80 chars before the first `--admin`.
- **Stop deletes nothing.** Phase 11 lists the delete commands
  (`npx wrangler delete --name factory-<slug>-<key> --force`) instead of running them;
  deletions run only in Phase 9 step 6, after Ship. Pinned: the delete-command string and the
  `nothing is deleted` sentence.
- **The service token never leaves `process.env`.** `SKILL.md` names `CF_ACCESS_CLIENT_ID` /
  `CF_ACCESS_CLIENT_SECRET` only to say which two scripts read them and that they are never
  printed; no secret goes through a prompt, a PR body, or a commit (invariant 1 covers the
  scripts). Pinned: the four environment names are present, so the contract cannot drift
  silently.
- **Research output is data.** `references/research-brief.md` mints a fresh
  `crypto.randomUUID()` nonce per run, confines verbatim web text to the
  `<<<UNTRUSTED_WEB_<nonce>>>>` fence, and Phase 3 writes the spec with links only — nothing
  from inside the fence is copied. The research agent is read-only (`Explore`). Same
  three-part defense as the fetch relays in `.claude/workflows/`.
- **Configuration is environment-only.** Domains arrive as `FACTORY_PREVIEW_DOMAIN` /
  `FACTORY_PROD_DOMAIN`; the owner defaults to `gh api user --jq .login`. Pinned: the
  personal-name grep in `tests/factory-intake.test.mjs` and the `sanitized` policy test.
- **Exactly four check-ins.** Anything the autonomy paragraph does not pre-approve — a new
  credential, a Cloudflare setting beyond one Worker, a push to an existing repository's
  `main`, `--admin` — is reported, not done. Pinned: the policy test counts the bolded
  `**name** (Phase N)` check-ins between the autonomy sentence and `## Phase 0` and requires 4.

Residual: these are instructions to a model, not mechanical gates. The mechanical gates are
the required-check ruleset (invariant 4) that `merge-pr-with-gate` reads, the scripts'
`process.env`-only token handling (invariant 1), and the tamper guard (invariant 8) that runs
before any project file executes in the session. The static tests keep the text load-bearing;
they do not make it enforced.

### 8. Candidate-authored files never execute with the service token in the environment

The build agent is untrusted (row 1 above) and can commit anything on its branch, including a
rewritten `scripts/smoke.mjs`. The skill runs `smoke.mjs` and `critic.mjs` in its own session,
where `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` live, so a candidate-authored script
would receive the secret — invariant 1 holds for the scripts as shipped, not as rewritten. The
guard: Phase 4 records `SCAFFOLD_SHA=$(git rev-parse HEAD)` right after the scaffold push, and
the skill runs

    git diff --quiet "$SCAFFOLD_SHA" HEAD -- scripts/ package.json package-lock.json wrangler.jsonc wrangler.preview.template.jsonc .github/ || echo TAMPERED

at two points before anything from a clone executes: **Phase 7**, in the candidate's scratch
clone (`HEAD` = the candidate branch), before `smoke.mjs` / `critic.mjs`; and **Phase 9 step
4**, in the release clone (`HEAD` = merged `main`), before `npm ci && npx wrangler deploy`. The
guarded set is every file that executes in the session or decides what does: the two scripts
and the critic prompt under `scripts/`, the dependency manifest and lockfile (`npm ci` runs
install scripts), both wrangler configs (`build.command` runs a shell), and `.github/` (the
check the ruleset requires). `TAMPERED` in Phase 7 skips both scripts and presents the candidate
as **unverified: candidate modified factory scripts or config**, not selectable for Ship; in
Phase 9 it stops before the deploy and reports. **Pinned:** `SCAFFOLD_SHA=$(git rev-parse
HEAD)`, the guard command with its path set at least twice in `SKILL.md`, the unverified
label, and the ordering (first guard before `node scripts/smoke.mjs`, last guard before the
production `npm ci && npx wrangler deploy`).

Residual: the comparison is mechanical, but the instruction to run it before the scripts is
text the model follows. Files outside the set (`src/`, `public/`, `test/`) are the candidate's
to change; they run only inside the Worker or under CI's read-only token, never in the session.

## What is deliberately not here

- `devDependencies`: the skill installs `wrangler@latest` and `playwright@latest` at
  scaffold time so the project's lockfile, not this template, pins them.
- The skill half (`SKILL.md`, `references/`) sits beside this directory, not inside it —
  see invariant 7; nothing from it is copied into a project.
