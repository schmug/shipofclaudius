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
jq -nc --arg ts "$(date -u +%FT%TZ)" --arg cwd "$PWD" \
   --args '{ts:$ts,cwd:$cwd,concerns:$ARGS.positional}' \
   "first concern" "second concern" >> ~/.claude/concerns-spool.jsonl
```

**Do not retry in this session.** Do not escalate, and do not surface it to the
user as an error — never block or fail the turn over a concern that did not
land. A delayed write is fine; a lost concern is not.

## Draining the spool

Drain the spool the next time `gh issue create` succeeds. **Rotate first, then
read — never truncate in place:**

```bash
mv ~/.claude/concerns-spool.jsonl "~/.claude/concerns-spool.$(date -u +%Y%m%dT%H%M%SZ).jsonl"
```

`mv` on the same filesystem is atomic, so a concurrent session's in-flight
`O_APPEND` write either lands before the rename and rides along in the
rotated file, or starts a fresh live spool after it — never lost, never
caught mid-write. A truncate (`: > file`) has no such guarantee: a write
racing the truncate is silently destroyed. Read the rotated file, file its
lines as their own issue, then delete the rotated file. If that
`gh issue create` also fails, leave the rotated file where it is — do not
retry in this session.

**Rotated-file lifecycle.** A rotated file is deleted only by the drain that
successfully files its contents — the never-fail-the-turn guarantee (above),
applied one step later. An unfiled rotated file is picked up by the next
successful drain, from any session, or by the weekly triage as the final
backstop. Retention is therefore unbounded in principle but self-limiting in
practice: a rotated file exists only between its own rotate and its own
successful file-and-delete, and piles up only for as long as `gh` stays
unreachable across repeated drain attempts.

The weekly triage drains the same way, as a backstop.

## Then stop

Filing is the whole job. Do not summarize the concerns back to the user, do not
propose fixing them, and do not let the filing become the session's closing
message — the work the user asked for is what they should read last.
