# `dependabot` Front-Door Skill — Design Spec

**Date:** 2026-06-25
**Repo:** `schmug/shipofclaudius`
**Status:** Design approved (brainstorming); pending written-spec review → implementation plan.

---

## 1. Problem & goal

The plugin can already triage external security findings against the current repo via
`triage-finding` (a SARIF file, a scanner report, a CVE/GHSA reference, or an inline descriptor
list → `confirmed` / `not_actionable` / `needs_review` with a `/ghsa`- or `/issue`-ready handoff).
But there is **no front door for GitHub Dependabot alerts**: a user has to hand-fetch alerts and
hand-shape them into descriptors before `triage-finding` can do anything with them.

**Goal:** a discoverable, Dependabot-named skill that, in one command, fetches a repo's open
Dependabot alerts, normalizes each into a `triage-finding` descriptor, and **rides the existing
triage engine all the way to a handoff**. The new, fallible surface is kept to a single
normalization function that is unit-tested offline.

**Non-goals (YAGNI):**
- No version-bumping or fix-PRs — that is `fix-finding`.
- No auto-filing of issues/advisories — that is `track-findings`.
- No consuming GitHub's existing Dependabot *pull requests*.
- No reachability logic beyond what `triage-finding` already performs.
- No new triage/judgment logic of any kind. This skill is **intake only**; `triage-finding` owns
  judgment.

---

## 2. Approach: a 1:1 wrapper trio that delegates to `triage-finding`

Add one skill↔workflow pair plus its sim test, satisfying the plugin's strict 1:1 invariant
(`tests/plugin-integrity.test.mjs:44-57` — every `skills/<name>/` must have its own
`.claude/workflows/<name>.js`, and each `SKILL.md` must reference *its own* bundled script).

```
skills/dependabot/SKILL.md            → thin wrapper, triggers on Dependabot phrasing
.claude/workflows/dependabot.js       → fetch open alerts → normalize → delegate
tests/dependabot-sim.test.mjs         → offline sim of the deterministic scaffolding
```

`triage-finding.js` is consumed **as-is** through its primary `findings` input (an inline
descriptor array). It mints its own nonce and fences every descriptor as untrusted, so the
adapter does not re-implement any of that.

**Why a dedicated workflow rather than a new arg on `triage-finding`:** the 1:1 integrity test
forbids a skill that points at another skill's script, so a discoverable `dependabot` skill
*requires* a `dependabot.js`. The alert→descriptor mapping is also genuinely Dependabot-specific
(the `triage-finding` ingest relay knows CVE/GHSA/SARIF, not the Dependabot alerts endpoint), so
it earns its own home and its own test.

---

## 3. Files touched

- **New:** `skills/dependabot/SKILL.md`, `.claude/workflows/dependabot.js`,
  `tests/dependabot-sim.test.mjs`.
- **Edited:** `README.md` — Workflows table row, Arguments-table row, Security-model paragraph
  (dependabot joins the untrusted-text group), Layout tree, Tests list.
- **Untouched:** `triage-finding.js`; `tests/plugin-integrity.test.mjs` (auto-discovers the new
  trio — its 1:1 and wrapper assertions pass for free once the three files exist).

---

## 4. `dependabot.js` — arguments

Parse-guarded: `const A = (typeof args === 'string') ? JSON.parse(args) : (args || {})`.

| arg | default | role |
|---|---|---|
| `repo` | gh-resolved (`gh repo view --json nameWithOwner`) | which repo's alerts to read |
| `state` | `"open"` | alert state filter (`open` is the triage-relevant default) |
| `minSeverity` | none | drop alerts below `low` / `medium` / `high` / `critical` |
| `scope` | `"all"` | `runtime` / `development` / `all` (dev-deps are often deprioritized) |
| `ecosystem` | none | optional narrowing (e.g. `npm`, `pip`) |
| `package` | none | optional narrowing to a single package |
| `max` | `200` | cap alerts triaged; **`log()` when truncated** (no silent cap) |
| `target` | `"."` | repo root the findings are triaged against (passthrough) |
| `handoff` | `"auto"` | passthrough to `triage-finding` (`ghsa` / `issue` / `auto`) |
| `notes` | none | passthrough context into each triage prompt |
| `batchSize` | `8` | passthrough triage wave size |
| `readonlyAgent` | `"Explore"` | read-only agentType for the ingest agent **and** passthrough |
| `triageScriptPath` | injected by `SKILL.md` | resolved path to sibling `triage-finding.js` |

---

## 5. `dependabot.js` — control flow

`meta` phases: **Ingest**, then **Triage** (delegated — `triage-finding`'s own phases render under
a nested group).

1. **Phase 1 — Ingest** (one read-only agent, `StructuredOutput`-schema'd):
   resolves the repo, runs `gh api --paginate /repos/{owner}/{repo}/dependabot/alerts` projecting
   **only the needed fields**, and returns them as a compact array
   (`{ alerts[], repoResolved, totalOpen, note }`). The agent only *fetches & projects* — it does
   **not** transform. It runs under `readonlyAgent` so a successful injection still can't write.

2. **Deterministic mapping (pure JS in the script):** filter the returned alerts by
   `state` / `minSeverity` / `scope` / `ecosystem` / `package`, map each survivor → a descriptor
   (§6), then truncate to `max`, `log()`-ing any drop. The map lives in plain JS — not in the
   agent — so it is directly unit-testable, matching this repo's "the sim tests are the real
   parser" philosophy.

3. **Phase 2 — Delegate:**
   `await workflow({ scriptPath: A.triageScriptPath }, { findings, target, repo, handoff, notes, batchSize, readonlyAgent })`.
   Return `triage-finding`'s result plus a dependabot summary (counts: total open / included /
   by-severity / `confirmed`·`not_actionable`·`needs_review`).

4. **Empty case:** zero matching alerts → clean early return, no delegation.

5. **Graceful fallback (A→B at runtime):** if delegation throws (nesting unsupported / bad path),
   `log()` a warning and return `{ findings, delegated: false, note: "run triage-finding with these findings" }`.
   The skill degrades to intake-only **without changing its surface**. This branch is kept
   deliberately (resilient; the cost is one extra code path the sim test covers).

---

## 6. The normalization (the crux — what the sim test pins)

A Dependabot alert has no single `file:line`; its "location" is a manifest + a package + a version
range. Each alert maps to a `triage-finding` descriptor as:

| descriptor field | source |
|---|---|
| `id` | `ghsa_id` ‖ `cve_id` ‖ `"dependabot-alert-<number>"` — **script-assigned and authoritative**, never an agent echo |
| `title` | `"<GHSA/CVE> in <package> (<vulnerable_version_range>)"` |
| `file` | `dependency.manifest_path` (e.g. `package-lock.json`) |
| `vuln_class` / `cwe` | from `security_advisory.cwes` |
| `severity` | alert severity, passed through |
| `description` | advisory `summary` + `"first patched: <version | none>"` + `"scope: runtime|development"` + `html_url` |
| `source` | `"dependabot"` |

---

## 7. `SKILL.md`

Mirrors `triage-finding`'s wrapper. Frontmatter `name: dependabot`, description tuned to trigger on
*"dependabot", "dependabot alerts", "vulnerable dependencies", "dependency vulnerabilities"*. Body:

```
Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/.claude/workflows/dependabot.js",
           args: { triageScriptPath: "${CLAUDE_PLUGIN_ROOT}/.claude/workflows/triage-finding.js",
                   /* + optional filters from the request */ } })
```

States plainly that it **delegates to `triage-finding`**, is **read-only**, and **never files**.

---

## 8. Security model & token scope

The ingest agent reads GitHub-hosted advisory text (summaries, package names) — external,
attacker-influenceable text — so it runs under `readonlyAgent`; the descriptors it produces are
nonce-fenced downstream by `triage-finding`; nothing is filed (handoff to `/ghsa` or `/issue`
stays a separate, explicitly-gated step). dependabot is added to the README "Security model" group
alongside `triage-finding`.

**Token scope note (stricter than the other read-only workflows):** reading Dependabot alerts
requires a token with **Dependabot-alerts / security-events read** permission (repo admin or the
dedicated security read scope). This is documented in the Security-model section so a read-scoped
`gh` token used for the GitHub fan-outs is explicitly widened just enough to include alert reads.

---

## 9. Tests & validation

`tests/dependabot-sim.test.mjs` — Node built-ins only, zero-token, stubbing `agent` / `workflow` /
`phase` / `log`. Assertions:

- arg parse-guard (string `args` is `JSON.parse`d);
- repo-default resolution path;
- the **alert→descriptor map**: `title` format, `file` = `manifest_path`, `vuln_class` from CWE,
  `description` carries first-patched + scope, `id` precedence (GHSA → CVE → synthetic);
- `state` / `minSeverity` / `scope` / `ecosystem` / `package` filters;
- `max` truncation **and** the truncation `log()`;
- empty-alert early return (no delegation);
- delegation is called with the right `findings` array + passthrough args;
- the fallback branch when `workflow()` throws.

**Validation discipline (per project memory):** validate with the sim test, **not** `node --check`
(which mis-reports "illegal return" on these scripts); keep the test zero-dependency so CI stays
zero-dep; and **hand-sync** the finished workflow to `~/.claude/workflows/dependabot.js` (the
machine-wide copy that does not auto-update from the repo).

---

## 10. Open risk

The single real risk is whether `workflow({ scriptPath })` nesting composes correctly from inside a
bundled workflow and resolves the injected sibling path. **Mitigation:** the path is injected by the
`SKILL.md` via the same `${CLAUDE_PLUGIN_ROOT}` mechanism every wrapper already uses, and the
fallback in §5 (step 5) degrades to intake-only if nesting fails — so the failure mode is "two-step
instead of one-step," never a broken skill.
