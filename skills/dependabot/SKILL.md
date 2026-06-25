---
name: dependabot
description: Front door for GitHub Dependabot alerts. A read-only agent fetches a repo's open Dependabot alerts via `gh api`, the workflow normalizes each into a triage-finding descriptor (id, manifest, package/version-range, CWE, severity, first-patched, runtime-vs-dev scope), and the array is delegated to the `triage-finding` engine for disprove-first triage against THIS repo + a `/ghsa`- (public) or `/issue`-ready handoff payload. Intake only — it adds no triage logic and never files. Use whenever the user wants to triage, review, or act on Dependabot alerts / vulnerable dependencies / dependency vulnerabilities; not for bumping a version (use fix-finding) or filing (use track-findings).
---

Run the `dependabot` dynamic workflow bundled with this plugin by calling the Workflow tool with its bundled script path:

```
Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/.claude/workflows/dependabot.js",
           args: { triageScriptPath: "${CLAUDE_PLUGIN_ROOT}/.claude/workflows/triage-finding.js", /* + optional filters */ } })
```

Always pass `triageScriptPath: "${CLAUDE_PLUGIN_ROOT}/.claude/workflows/triage-finding.js"` so the workflow can delegate to its sibling engine; if it is omitted the workflow falls back to the saved-workflow name `triage-finding`. Other args (all optional): `repo` (`owner/name`, defaults to the gh-resolved repo), `state` (default `"open"`), `minSeverity` (`low`|`medium`|`high`|`critical`), `scope` (`runtime`|`development`|`all`, default `all`), `ecosystem`, `package`, `max` (default 200), and the passthroughs `target` (default `"."`), `handoff` (`ghsa`|`issue`|`auto`), `notes`, `batchSize`, `readonlyAgent` (default `Explore`). For the full, current argument list, read the header comment / `meta` block in `${CLAUDE_PLUGIN_ROOT}/.claude/workflows/dependabot.js`, or the repo README "Arguments" table.

This is INTAKE ONLY and READ-ONLY: the ingest agent runs under a read-only `agentType` and only fetches/projects the alerts; the descriptors are nonce-fenced as UNTRUSTED data by `triage-finding` downstream, which classifies them and assembles the handoff payload — it never files. Filing a confirmed item to `/ghsa` or `/issue` is a separate, explicitly-gated step. Reading Dependabot alerts needs a `gh` token with Dependabot-alerts / security-events READ scope (stricter than the other read-only fan-outs — see README "Security model").
