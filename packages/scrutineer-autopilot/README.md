# scrutineer-autopilot

Model-free Node package (zero dependencies) that drives the Scrutineer finding lifecycle
from a periodic tick. Design: `docs/specs/2026-10-26-scrutineer-lifecycle-autopilot-design.md`.
Audience: agents maintaining this repo. It states constraints, not onboarding.

## Config

Read from `~/.claude/scrutineer-autopilot/config.json` by `loadConfig`. Every key is optional.

| Key | Meaning | Default |
|---|---|---|
| `owner` | GitHub owner, lowercased | `gh api user --jq .login` |
| `baseUrl` | Scrutineer URL; host must be `127.0.0.1`, `localhost` or `::1`, else `normalizeConfig` throws | loopback, port 8080 |
| `tokenPath` | file holding the operator token, read at call time, never logged | `~/scrutineer/data/operator-token` |
| `allowlist` | `owner/name` repos the autopilot may touch | `[]` |
| `repoPolicy` | `owner/name` to `auto`, `stop` or `exclude` | `{}` |
| `budget` | overrides for the spec §7 numbers (`DEFAULTS.budget`) | spec values |
| `stateDir` | ledger, run and held-fix directory | `~/.claude/scrutineer-autopilot` |

Policy: a repo off the allowlist is `exclude`; an allowlisted repo is `auto` unless
`repoPolicy` says otherwise. There is no built-in `stop` list. Keep Scrutineer's own per-repo
scan schedule off.

No personal values (owner, paths, port, repo names) belong in shipped files.
