---
name: factory-build
description: The software factory's build step — implement ONE approved spec as up to four candidate Cloudflare Workers, each built in its own scratch clone of the project repo, deployed to an Access-gated preview hostname via its own wrangler.preview.<key>.jsonc, and opened as a draft PR. Returns the preview URLs for the factory-intake skill to score and present; it never waits for certificates, never merges, and never deploys production. Not a front door — with no candidates it returns needs_args and points at factory-intake, which is what to run for "build me this idea".
---

Run the `factory-build` dynamic workflow bundled with this plugin by calling the Workflow tool with its bundled script path:

```
Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/.claude/workflows/factory-build.js",
           args: { slug, repo, spec_path, previewDomain,
                   candidates: [{ key, brief, direction }] } })
```

`slug` (`^[a-z0-9][a-z0-9-]{1,23}$`), `repo` (`owner/name`), `spec_path` (the approved spec inside that repo), and `previewDomain` (e.g. `preview.example.com`, the suffix every candidate hostname hangs under) are required. `candidates` is 1–4 entries; each `key` (`^[a-z0-9]{1,8}$`) becomes branch `factory/<key>`, Worker `factory-<slug>-<key>`, and hostname `<slug>-<key>.<previewDomain>`. Optional: `base?` (default `main`), `iterate?: { key, branch, feedback }` (rebuild one candidate on its existing branch — `branch` must equal `factory/<key>` — and redeploy the same hostname), `fresh?` (bypass the open-PR preflight), `readonlyAgent?`, `fenceNonce?` (a caller-minted fresh nonce for the feedback fence, `^[0-9a-f-]{8,64}$`; without it the nonce is content-derived and predictable). For the full, current argument list, read the header comment / `meta` block in `${CLAUDE_PLUGIN_ROOT}/.claude/workflows/factory-build.js`, or the repo README "Arguments" table.

**WRITES** — each build agent clones the project repo into `${TMPDIR:-/tmp}/factory/<slug>/<key>/`, commits, pushes a branch, runs `wrangler deploy --config wrangler.preview.<key>.jsonc` (never the production config), and opens a **draft** PR. Needs a write-scoped `gh` login and a `wrangler` login with Workers write scope. Its write ladder ends at the draft PR: the certificate wait, the smoke, the critic, the approval question, the gated merge, and the production deploy all belong to `factory-intake`.
