---
name: track-findings
description: Deduped, preview-gated bridge that files a scan bundle's confirmed findings into a tracker — by-fingerprint create/reuse/skip, exact payload preview, draft-GHSA (public) vs security-issue (private) routing, serial file + readback. Stage-by-default; pass execute=true to actually file. Use after a scan to turn its findings into tracked work without re-filing duplicates. Not for producing findings in the first place (use deep-security-scan or security-diff-scan), not for deciding whether an external finding is actionable here (use triage-finding), and not for fixing one (use fix-finding).
---

Run the `track-findings` dynamic workflow bundled with this plugin by calling the Workflow tool with its bundled script path:

```
Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/.claude/workflows/track-findings.js", args: { /* fill from the request */ } })
```

Fill `args` from the user's request. Common args: `bundle` (the scan return OBJECT — `deep-security-scan`'s `reportable[]`, the #21 fingerprinted bundle, or `triage-finding`'s confirmed set) or `bundlePath` (a JSON file an agent reads), `repo` (`owner/name`, defaults to the current repo), and `execute` (default `false` = stage/preview only; `true` = actually file). For the full, current argument list, read the header comment / `meta` block in `${CLAUDE_PLUGIN_ROOT}/.claude/workflows/track-findings.js`, or the repo README "Arguments" table.

This is an OUTWARD, irreversible action: it is **stage-by-default**. A normal run dedups by fingerprint (create / reuse / skip), routes public repos to a draft GHSA and private/internal repos to a `security`-labeled issue, and returns the **exact payload previews** without writing anything. Only re-run with `execute: true` — the explicit human approval after reviewing the previews — to file each create serially, with a pre-write recheck and a readback to confirm. GHSA stays at draft (publish / CVE-request live in `/ghsa`, human-gated).
