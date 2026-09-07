---
name: fix-finding
description: Minimally remediate ONE confirmed security finding — or prove it is already fixed. Read-only reachability triage first, then a failing regression test, the smallest behavior-preserving fix, and an adversarial control-not-weakened review; opens a draft PR and never pushes to main. Use once triage has confirmed a finding is really exploitable here and you want the narrowest safe patch — fix this vulnerability, patch this CVE in our code, bump this vulnerable dependency. Not for deciding whether a finding is actionable in the first place (use triage-finding, or dependabot for alert intake), not for discovering findings (use deep-security-scan or security-diff-scan), and not for filing them (use track-findings).
---

Run the `fix-finding` dynamic workflow bundled with this plugin. `Workflow({ scriptPath })` only accepts a path already under the session's working directory (or an added directory) — a plugin-cache path is refused even after being `Read` in-session (see `CLAUDE.md` "Wrapper shape"; reproduced in [#213](https://github.com/schmug/shipofclaudius/issues/213)). So: `Read` `${CLAUDE_PLUGIN_ROOT}/.claude/workflows/fix-finding.js`, then call the Workflow tool with its exact contents as `script`:

```
Workflow({ script: "<the file's exact contents>", args: { finding: { /* the confirmed finding */ } } })
```

Fill `args.finding` from the confirmed finding you hold — a `deep-security-scan` / `triage-finding` confirmed-finding object (`file`, `line`, `vuln_class`, `evidence`, `attacker_story`, `fix`, `severity`) or a hand-supplied descriptor of the same shape. One finding per run (bulk remediation is out of scope). Other args: `branch?`, `base?` (default `main`), `repo?`, `key?`, `confidenceThreshold?`, `fresh?`, `readonlyAgent?`. For the full, current argument list, read the header comment / `meta` block in `${CLAUDE_PLUGIN_ROOT}/.claude/workflows/fix-finding.js`, or the repo README "Arguments" table.

**WRITES** — opens a draft PR; needs write scope. Do NOT run under a read-only token; see the workflow header for its safety gates (reachability-confirmed-first, failing-test-first, control-not-weakened, draft-PR-never-merge). `no_change` ("already fixed" / unreachable) is a first-class outcome that opens no PR.
