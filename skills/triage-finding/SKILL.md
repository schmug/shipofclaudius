---
name: triage-finding
description: Triage external findings (a SARIF file, a scanner report, a CVE/GHSA reference, or a list of finding descriptors) against the CURRENT repo into confirmed | not_actionable | needs_review — each with an exploitability rank + evidence, disprove-first and trace-only. Confirmed items yield a /ghsa- (public) or /issue-ready handoff payload. Use to burn down a security-finding backlog; not for triaging your own PRs/issues (use pr-/issue-triage-fanout) or authoring detection rules.
---

Run the `triage-finding` dynamic workflow bundled with this plugin by calling the Workflow tool with its bundled script path:

```
Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/.claude/workflows/triage-finding.js", args: { /* fill from the request */ } })
```

A findings source is REQUIRED — fill `args` from the user's request with exactly one of: `findings` (an inline array of descriptors), `sarif` (path), `report` (path), `cve`, or `ghsa`. Other common args: `target` (default `"."`), `repo` (`owner/name`), `handoff` (`ghsa` | `issue` | `auto`, default `auto`), `notes`, `batchSize` (default 8), `readonlyAgent` (default `Explore`). For the full, current argument list, read the header comment / `meta` block in `${CLAUDE_PLUGIN_ROOT}/.claude/workflows/triage-finding.js`, or the repo README "Arguments" table.

External findings text is UNTRUSTED: it is nonce-fenced and every subagent runs under a read-only `agentType`, so the workflow only classifies + assembles handoff payloads — it never files. Filing a confirmed item to `/ghsa` or `/issue` is a separate, explicitly-gated step the orchestrator runs after, with your confirmation. Run against a remote with a read-scoped `gh` token (see README "Security model").
