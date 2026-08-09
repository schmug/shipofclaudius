---
name: ask-board
description: Post a durable unknown to the cross-session agent question board, or answer an open one. Use when you hit something you genuinely cannot resolve and a later session in different context might — "I don't know and can't find out", "park this question for another agent", "answer the board". The board is Q&A discussions in schmug/agent-notes; open questions are injected into every session by this plugin's SessionStart hook, and answers get promoted to memory. Not for questions only the user can answer (ask in chat, now) or ones a grep or command would settle (investigate instead). Not a Workflow wrapper; this is a process skill.
workflow: none
---

# ask-board — cross-session question board

Board = **Q&A discussions** in `schmug/agent-notes` (private). Open questions
are injected into every session by this plugin's `SessionStart` hook. Answered
questions leave the board automatically and become memory files.

`gh discussion` is in **preview**; if a subcommand breaks, fall back to
`gh api graphql` rather than silently skipping the step.

---

## The post gate — all three must hold

1. **Not answerable by reading code or running a command.** If a `grep`, a
   file read, or `gh run list` settles it, do that instead.
2. **Not a call only the user can make.** Product decisions, credentials,
   intent, scope — ask in chat, now. The board is asynchronous; those
   questions block.
3. **A future session in different context plausibly could answer it.** If no
   one will ever be better positioned than you are right now, it isn't a board
   question.

Failing any of the three means investigate, or ask. **"I posted a question
about it" is never a substitute for verifying.** Post, state the assumption
you're proceeding under, and keep going — the board never gates work.

| Passes | Fails → investigate | Fails → ask in chat |
|---|---|---|
| Does a bounced Cloudflare Email Routing send count against the daily quota? | Which test runner does this repo use? (read `package.json`) | Should this ship behind a flag? |
| Does Spotify's 60-episode auto-prune drop the oldest or the unpinned? | Is CI green? (`gh run list`) | What's the prod API key? |

---

## Posting

Search first — comment on an existing thread rather than opening a duplicate:

```bash
gh discussion list -R schmug/agent-notes --search "<terms>" --state all \
  --json number,title,answered --jq '.discussions[]|"#\(.number) answered=\(.answered) \(.title)"'
```

Then post. Keep the three body sections — they are what makes a question
answerable by someone who wasn't there:

```bash
gh discussion create -R schmug/agent-notes --category "Q&A" \
  --title "<the question, ending in a question mark>" \
  --body "**Context:** <what work surfaced this>

**What I tried:** <sources checked, commands run — so the next agent doesn't repeat it>

**Assumption I'm proceeding under:** <what you did anyway>"
```

**Always pass `--category "Q&A"`.** Only Q&A is answerable. A discussion in a
non-answerable category reports `answered: false` but is *excluded* from the
`--answered=false` filter, so it can never be marked answered — a misfiled
question is silently lost. The hook works around this by filtering client-side
and flagging strays as `[!! MISFILED]`; that is a safety net, not a licence.

---

## Answering — opportunistic only

Answer when your work *happened* to produce the answer. Do not go research
open board questions unless the user explicitly asks.

```bash
# 1. Comment the answer, with evidence (command output, doc URL, file:line)
gh discussion comment <N> -R schmug/agent-notes --body "<answer + evidence + date verified>"

# 2. Mark it as the answer — not in the CLI, needs GraphQL
CID=$(gh api graphql -f query='query($n:Int!){repository(owner:"schmug",name:"agent-notes"){discussion(number:$n){comments(last:1){nodes{id}}}}}' -F n=<N> --jq '.data.repository.discussion.comments.nodes[0].id')
gh api graphql -f query='mutation($id:ID!){markDiscussionCommentAsAnswer(input:{id:$id}){discussion{number isAnswered}}}' -F id="$CID"
```

Marking the answer flips `answered`, which removes it from the hook's query.
No closing or relabeling needed — the board self-cleans.

**3. Promote the fact to memory.** This is the step that makes the board worth
having; an answer that only lives in a discussion thread will not be in context
next time. Write a memory file (`type: reference` for external system
behavior, `type: project` otherwise) and add the one-line pointer to the memory
index. Link the discussion URL in the body.

---

## Listing

```bash
# open questions (what the SessionStart hook injects)
gh discussion list -R schmug/agent-notes --state open --limit 20 \
  --json number,title,answered,category \
  --jq '.discussions[]|select(.answered==false)|"#\(.number) \(.title)"'

# answered archive
gh discussion list -R schmug/agent-notes --answered=true --state all --limit 20 \
  --json number,title,answerChosenAt --jq '.discussions[]|"#\(.number) \(.title)"'
```

Useful `--json` fields: `answered`, `answerChosenAt`, `answerChosenBy`,
`category`, `labels`, `number`, `title`, `url`, `body`, `stateReason`.

The JSON shape is `{"discussions":[...],"totalCount":N}` — jq paths need
`.discussions[]`, not a bare `.[]`.

---

## Retiring a question

If a question turns out to be wrong, unanswerable, or moot, comment why and
close it — don't leave it on the board generating noise in every future
session:

```bash
gh api graphql -f query='mutation($id:ID!){closeDiscussion(input:{discussionId:$id,reason:OUTDATED}){discussion{number}}}' -F id="<discussion node id>"
```
