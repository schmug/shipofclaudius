# Security Policy

`shipofclaudius` is a collection of **dynamic workflow scripts** for the Claude Code Workflow tool, packaged as a Claude Code plugin. There is no running service — the deliverables are the `.claude/workflows/*.js` scripts, their wrapper skills, and the plugin manifests. This policy covers vulnerabilities *in those artifacts*.

## Reporting a vulnerability

**Please report privately — do not open a public issue.** A public issue discloses the vulnerability before a fix is available.

Report through GitHub's private vulnerability reporting:

- **[Report a vulnerability](https://github.com/schmug/shipofclaudius/security/advisories/new)** (Security tab → *Report a vulnerability*)

This opens a private advisory visible only to you and the maintainers. Please include:

- which workflow / file / manifest is affected,
- a description of the issue and its impact,
- steps to reproduce (a minimal `args` payload or crafted input, where relevant).

## In scope

- The workflow scripts in [`.claude/workflows/`](.claude/workflows/) — especially **prompt-injection** weaknesses in the workflows that read attacker-writable text (issue/PR bodies, comments, reviews, diffs, external findings/SARIF/CVE/GHSA, Dependabot alerts). See the **Security model** in [README.md](README.md) for the intended three-part defense; a bypass of that defense is in scope.
- The wrapper skills in [`skills/`](skills/) and the plugin manifests in [`.claude-plugin/`](.claude-plugin/) — e.g. a script/skill mismatch or manifest issue that could cause the wrong code to run.

## Out of scope

- Vulnerabilities in Claude Code, the Workflow runtime, or any tool a workflow invokes (`gh`, `git`, third-party scanners) — report those to their respective projects.
- Findings that require the operator to already have write access, or to run a workflow against input they control and trust.
- The offline test simulators in [`tests/`](tests/), which use only Node built-ins and run no untrusted input.

## Response timeline

This is a volunteer-maintained project, so timelines are best-effort:

- **Acknowledgement:** within ~7 days.
- **Assessment & fix plan:** within ~30 days of acknowledgement.

We'll keep you updated through the advisory thread and credit you in the fix (unless you'd prefer to remain anonymous).
