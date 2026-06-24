---
name: fix-finding
description: Minimally remediate ONE confirmed security finding — or prove it is already fixed. Read-only reachability triage first, then a failing regression test, the smallest behavior-preserving fix, and an adversarial control-not-weakened review; opens a draft PR and never pushes to main.
---

Run the `fix-finding` dynamic workflow bundled with this plugin by calling the Workflow tool with its bundled script path:

```
Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/.claude/workflows/fix-finding.js", args: { finding: { /* the confirmed finding */ } } })
```

Fill `args.finding` from the confirmed finding you hold — a `deep-security-scan` / `triage-finding` confirmed-finding object (`file`, `line`, `vuln_class`, `evidence`, `attacker_story`, `fix`, `severity`) or a hand-supplied descriptor of the same shape. One finding per run (bulk remediation is out of scope). Other args: `branch?`, `base?` (default `main`), `repo?`, `key?`, `confidenceThreshold?`, `fresh?`, `readonlyAgent?`. For the full, current argument list, read the header comment / `meta` block in `${CLAUDE_PLUGIN_ROOT}/.claude/workflows/fix-finding.js`, or the repo README "Arguments" table.

**WRITES** — opens a draft PR; needs write scope. Do NOT run under a read-only token; see the workflow header for its safety gates (reachability-confirmed-first, failing-test-first, control-not-weakened, draft-PR-never-merge). `no_change` ("already fixed" / unreachable) is a first-class outcome that opens no PR.
