---
name: file-concerns
description: File this session's unresolved concerns to schmug/agent-notes. Use when the Stop hook blocks and asks for concerns to be recorded, or when you are wrapping up and something is unresolved — a completion claim you never actually verified, a scope cut you did not state plainly, a question that never got answered, a doubt about whether the change is right. There is no bar; if it nagged, it counts. Not for durable technical unknowns a later session could answer (use ask-board) and not for friction with the tooling itself (use the vent tool). Not a Workflow wrapper; this is a process skill.
workflow: none
---

# file-concerns — record what this session left unresolved

**There is no bar.** Do not decide whether a concern is worth filing; that
decision happens at triage. If it nagged, it counts. Filing something trivial
costs a line in a weekly review. Filing nothing costs the concern.

**Do not classify.** Everything goes to one sink. Routing — to the question
board, to the working repo, to the vent log, or to the bin — happens weekly, not
now. Deciding at write time is exactly the gate that left the question board at
0 posts across 965 transcripts.

## What counts

| Shape | Example |
|---|---|
| A completion claim resting on a check never run | "Said the merge gate blocks unsigned commits; never ran it against a scratch repo." |
| A scope cut never stated plainly | "Dropped Windows path handling from `src/scan.ts` and did not say so." |
| A question raised and never answered | "Asked which timezone the cron assumes; moved on without an answer." |
| A doubt about whether the change is right | "Tests pass, but I don't think the retry actually preserves ordering." |

Not this skill's job: a durable unknown a later session in different context
could answer (that is `ask-board`), or friction with the tooling itself (that is
the vent tool).

## File it

**One issue per session** — never one per concern. Five issues out of a single
session is what the question board produced on 2026-08-29, and it is the wrong
shape for review.

```bash
gh issue create -R schmug/agent-notes \
  --title "concerns: <repo-or-cwd> $(date +%F)" \
  --label concern \
  --body "- [ ] <first concern>
- [ ] <second concern>

Session: <session id>
Transcript: <transcript path>"
```

Write each line so it stands alone. A week from now nobody remembers the
session: say what was claimed, what was not checked, and where the code is.
"Unsure about the gate" is not a concern, it is a mood.

## When `gh` fails

`gh` can be unauthenticated, offline, or rate limited. On any failure append one
line to `~/.claude/concerns-spool.jsonl` and carry on:

```bash
jq -nc \
  --arg ts "$(date -u +%FT%TZ)" \
  --arg session "<session id>" \
  --arg cwd "$PWD" \
  --arg repo "$(git remote get-url origin 2>/dev/null | sed -E 's#\.git$##; s#^.*[:/]([^/]+/[^/]+)$#\1#')" \
  --args '{ts:$ts,session:$session,cwd:$cwd,repo:(if $repo=="" then null else $repo end),concerns:$ARGS.positional}' \
  "first concern" "second concern" >> ~/.claude/concerns-spool.jsonl
```

**Do not retry in this session.** Do not escalate, and do not surface it to the
user as an error — never block or fail the turn over a concern that did not
land. A delayed write is fine; a lost concern is not.

### If a spooled concern resolves itself

The spool is append-only (§4.5 of the design spec) — there is no in-place edit.
If a concern you already spooled this session turns out to be moot before the
session ends, append a **retraction record** rather than rewriting or deleting
the earlier line: the same envelope, with `retracts` in place of `concerns`:

```bash
jq -nc \
  --arg ts "$(date -u +%FT%TZ)" \
  --arg session "<session id>" \
  --arg cwd "$PWD" \
  --arg repo "$(git remote get-url origin 2>/dev/null | sed -E 's#\.git$##; s#^.*[:/]([^/]+/[^/]+)$#\1#')" \
  --args '{ts:$ts,session:$session,cwd:$cwd,repo:(if $repo=="" then null else $repo end),retracts:$ARGS.positional}' \
  "first concern" >> ~/.claude/concerns-spool.jsonl
```

Each entry in `retracts` must match a `concerns` entry **verbatim** — exact
string equality is the only link between the two lines, so quote the concern
back exactly as spooled. A retraction carries no reason, severity, or category
(both are out of scope, see §8 of the design spec); it is a lifecycle marker,
not a classification.

Drain the spool the next time `gh issue create` succeeds: file the backlogged
lines as their own issue, then truncate the file. Before filing, drop any
`concerns` entry that has a matching `retracts` entry (exact string match) — a
retracted concern is not filed as an open concern. The weekly triage drains it
too, as a backstop, and applies the same rule.

Two lines predate this schema and do not parse this way — they carry ad-hoc
keys instead of `concerns`/`retracts`. Parse leniently: read whatever free-text
fields a non-conforming line holds and treat it as a single concern (or, for a
line that already says a prior one resolved, as a retraction) rather than
discarding it. A line that will not parse as JSON at all gets filed by hand
from its raw text. Do not let one unparseable line block the drain of the
lines around it.

## Then stop

Filing is the whole job. Do not summarize the concerns back to the user, do not
propose fixing them, and do not let the filing become the session's closing
message — the work the user asked for is what they should read last.
