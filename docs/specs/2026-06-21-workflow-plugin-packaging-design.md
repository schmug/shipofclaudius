# Zero-Copy Workflow-Plugin Packaging — Design Spec

**Date:** 2026-06-21
**Repo:** `schmug/shipofclaudius`
**Status:** Design approved (brainstorming); pending written-spec review → implementation plan.

---

## 1. Problem & goal

The nine workflows already auto-load inside this repo from the project-level `.claude/workflows/`
(no copy, no sync). The only friction is using them **outside** this repo: today that means
cloning the repo into another project, or `cp`/`ln -s`-ing the `.js` files into
`~/.claude/workflows/` for machine-wide use.

**Goal:** nicer install ergonomics with the **lowest ongoing maintenance** — a one-step install
that makes the workflows available in every project, with **no file copies that can drift**. The
prior idea of a "copy the files to a chosen dir" installer was rejected because copying
reintroduces exactly the snapshot-drift the project-level model eliminated.

**Non-goals:** changing any workflow's behavior; changing the in-repo auto-load (it stays); a
public-marketplace distribution push (this is personal-ergonomics-first, though the package is
marketplace-shaped so it *can* be shared later).

---

## 2. Approach: the repo IS a zero-copy wrapper-skill plugin

Package the repo itself as a Claude Code **plugin**. Because a plugin cannot register Workflow
scripts as a first-class component type, we bridge with thin **wrapper skills**: each skill tells
the model to run its workflow **in place** from the plugin directory via the Workflow tool's
`scriptPath`, referenced through `${CLAUDE_PLUGIN_ROOT}`.

```
claude plugin install shipofclaudius   # once
→ /shipofclaudius:deep-security-scan, … available in EVERY project
→ each runs ${CLAUDE_PLUGIN_ROOT}/.claude/workflows/<name>.js — the bundled copy
→ zero copy, zero drift, zero per-update step
```

**Single source of truth:** the workflows stay in `.claude/workflows/`. The plugin references them
there; there is no second copy of the `.js` inside the repo to drift. In-repo use is unchanged
(project `.claude/workflows/` still auto-loads as bare `/<name>`).

### Why this is the lowest-maintenance shape
- **No copies** → nothing to refresh or keep in sync (vs. a copy-installer).
- **No symlinks** → nothing to dangle when the plugin updates (vs. a symlink-installer):
  `${CLAUDE_PLUGIN_ROOT}` is **re-substituted into the skill at every load**, so it always points
  at the current installed version's directory.
- **Read-only, run-in-place** files → the documented "`${CLAUDE_PLUGIN_ROOT}` is ephemeral, don't
  write state here" caveat does not apply (we never write there).

---

## 3. Mechanics — verified

Confirmed both empirically (installed plugins on disk) and against the official docs
(code.claude.com/docs/en/plugins, .../plugins-reference, .../tools-reference, .../workflows):

- **`${CLAUDE_PLUGIN_ROOT}` is substituted inline in skill content** by Claude Code at load time
  (also in commands, agents, hooks, monitors, MCP/LSP configs; and exported as `$CLAUDE_PLUGIN_ROOT`
  to subprocesses).
- **Precedent on this machine:** the `clodcast` plugin's skill resolves and runs
  `${CLAUDE_PLUGIN_ROOT}/skills/daily-podcast/render.py`; `security-guidance` hooks reference
  `${CLAUDE_PLUGIN_ROOT}/hooks/...`. The "skill points at a bundled file via the plugin root"
  pattern is proven in the wild.
- **Arbitrary bundled files are fine** — the whole plugin directory is on disk at the root.
- **`Workflow({ scriptPath })` accepts any on-disk path**; no documented sandbox/path restriction.
  (Tool contract: *"Path to a workflow script file on disk."*)
- **Minimal manifest:** `{ name, description, version }`.

**Unconfirmed (mitigated):** the docs don't *explicitly* exercise `Workflow` + a
`${CLAUDE_PLUGIN_ROOT}` path in a worked example — but no blocker exists and the `clodcast`
precedent (skill → run a bundled script via the plugin root) is the same mechanic. Verify with one
smoke test during implementation (§7).

---

## 4. Components

```
shipofclaudius/                          # repo root == plugin root
├── .claude-plugin/
│   ├── plugin.json                     # { name, version, description, … }
│   └── marketplace.json                # so it's `claude plugin install`-able
├── skills/
│   ├── deep-security-scan/SKILL.md     # one thin wrapper per workflow (×9)
│   ├── pr-triage-fanout/SKILL.md
│   └── …
├── .claude/workflows/*.js              # UNCHANGED — the canonical, bundled scripts
└── tests/…                             # + a new plugin-integrity test (§7)
```

### 4.1 `plugin.json`
```json
{
  "name": "shipofclaudius",
  "version": "0.1.0",
  "description": "Curated dynamic workflows (triage / research / impl / merge / security) as run-in-place wrapper skills."
}
```

### 4.2 Wrapper skill (one per workflow) — shape
Each `skills/<name>/SKILL.md` is a thin, declarative wrapper:
- **Frontmatter `description`** mirrors the workflow's purpose (lifted from `meta.description` /
  the README) so natural-language triggering still works (*"triage my open PRs"* → the skill).
- **Body** instructs: call
  `Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/.claude/workflows/<name>.js", args: { … } })`,
  and includes that workflow's **argument reference** (from the README "Arguments" table) so the
  model fills `args` correctly. It carries the same security/usage caveats the README documents
  (e.g. read-scoped `gh` token for the read-only fan-outs; `args.execute:true` to land for
  `stacked-merge-walk`).

The wrapper adds **no logic** — it is a stable indirection to the canonical script. When a workflow
gains an arg, only its wrapper's arg reference needs a one-line touch.

### 4.3 Path-reference decision
Wrappers reference `${CLAUDE_PLUGIN_ROOT}/.claude/workflows/<name>.js` (the canonical location).
**Open detail to verify in implementation:** that a `.claude/` directory nested *inside* a plugin
is treated as inert bundled files (not re-scanned as nested project config). If it is not clean,
the fallback is a top-level `workflows/` directory populated from `.claude/workflows/` at release
time (a copy step in a release script or a checked-in symlink) — still single-authored, the copy
is build-time not user-time. Decided during §7's smoke test; does not change the user-facing design.

---

## 5. Naming & UX

- Plugin name `shipofclaudius` → skills are namespaced `/shipofclaudius:<name>`. The explicit slash
  form is verbose, but **NL triggering by `description` is unaffected** and is the primary UX the
  README already promotes.
- All **nine** workflows get a wrapper (no subset) for completeness and parity with the in-repo
  experience.

---

## 6. Out of scope

- A copy/symlink installer skill (rejected — drift / dangle).
- Any change to workflow behavior, return shapes, or the in-repo project-level auto-load.
- Submitting to a public marketplace (the package is marketplace-shaped; actually submitting is a
  later, separate decision).

---

## 7. Testing & definition of done

Keep the repo's offline, zero-token test ethos. Add `tests/plugin-integrity.test.mjs` (Node
built-ins only) asserting:
1. `.claude-plugin/plugin.json` is valid JSON with `name`/`version`/`description`.
2. **Every** `.claude/workflows/*.js` (by `meta.name`) has exactly one `skills/<name>/SKILL.md`
   wrapper, and vice-versa (no orphan wrappers, no unwrapped workflows).
3. Each wrapper references `${CLAUDE_PLUGIN_ROOT}/.claude/workflows/<name>.js` for its own workflow
   (path correctness) and a non-empty `description`.
4. (If present) `marketplace.json` is valid JSON.

**Manual smoke test (the one runtime verification):** install the plugin locally
(`claude plugin install` from a local dir / `--plugin-dir`), invoke one wrapper (e.g.
`/shipofclaudius:pr-triage-fanout`), and confirm the Workflow runs from the plugin path. This
resolves the §4.3 open detail.

**Done when:** plugin.json + marketplace.json added; nine wrappers present and path-correct;
`tests/plugin-integrity.test.mjs` green and wired into `npm test` (suite count only goes up);
`claude plugin validate` passes; the smoke test confirms a wrapper runs its workflow in place;
README gains a short "Install as a plugin" subsection; opened as a PR (not `main`), conventional
commit, `Co-Authored-By: Claude`.
