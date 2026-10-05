#!/bin/sh
# SessionStart question-board hook script (invoked by hooks/hooks.json).
#
# Emits one of three distinguishable states in additionalContext, so a coverage
# audit can tell them apart:
#   live         - a fresh gh fetch succeeded (today's text, unchanged)
#   cached       - gh failed or timed out, but a cache written within TTL served
#                  the last known question list, with its age in whole minutes
#   unavailable  - no live fetch and no cache within TTL (an honest gap)
#
# The script always exits 0: a session-lifecycle hook that can exit non-zero
# wedges startup for every project the plugin is enabled in.
#
# The host kills the whole hook at hooks.json's `timeout: 10`, and macOS has no
# timeout(1), so the gh call runs under a portable alarm (perl's alarm survives
# exec, terminating the gh process when it fires): the 6 s alarm leaves time to
# fall back to the cache before the 10 s hook kill.

CACHE="${BOARD_CACHE_FILE:-$HOME/.claude/board-cache.json}"
# 15 min: the board changes a handful of times a week, so staleness risk is low,
# but a stale list that resurrects an already-answered question is worse than an
# honest gap, so keep it short. The observed failure pattern (the audit behind
# schmug/agent-notes#11) is short concurrent bursts, not sustained outages, and
# 15 min covers a burst window without meaningfully raising the stale-question
# risk.
TTL="${BOARD_CACHE_TTL:-900}"
T="${BOARD_GH_TIMEOUT:-6}"

q=$(perl -e 'alarm shift @ARGV; exec @ARGV' "$T" gh discussion list -R schmug/agent-notes --state open --limit 20 --json number,title,answered,category --jq '.discussions[]|select(.answered==false)|"#\(.number) \(.title)\(if .category.name!="Q&A" then "  [!! MISFILED in \(.category.name) - cannot be answered, move to Q&A]" else "" end)"' 2>/dev/null); rc=$?

state=unavailable age=
if [ "$rc" -eq 0 ]; then
  state=live
  case "$CACHE" in */*) mkdir -p "${CACHE%/*}";; esac  # parent dir only; a bare name needs none
  # Write the cache atomically. The temp file is mktemp'd in the cache's directory
  # (same filesystem, so mv is a plain rename) under umask 077 — a predictable
  # sibling like "$CACHE.tmp.$$" would follow a symlink planted at that path, so
  # neither the temp name nor its mode may be attacker-influenced. Write errors
  # are ignored on purpose: a read-only HOME must not fail the hook; if mktemp
  # fails the cache write is skipped entirely (the live text is still emitted).
  umask 077
  tmp=$(mktemp "${CACHE}.XXXXXX" 2>/dev/null) || tmp=
  if [ -n "$tmp" ]; then
    jq -nc --arg q "$q" --argjson t "$(date +%s)" '{fetched_at:$t,q:$q}' > "$tmp" \
      && mv -f "$tmp" "$CACHE" || rm -f "$tmp"
  fi
elif [ -s "$CACHE" ]; then
  # Serve from cache only if it parses and is no older than TTL. Validity is
  # checked with a sentinel while the value is read separately, because a cache
  # whose q is the EMPTY string is valid — the board can legitimately have had
  # no open questions when it was written — and a non-emptiness check would
  # reject it. fetched_at must be a whole number of seconds, and its age must be
  # non-negative: a timestamp in the future (a negative age) is bogus and is not
  # served.
  fa=$(jq -r 'if (.fetched_at|type)=="number" and .fetched_at==(.fetched_at|floor) then .fetched_at else empty end' "$CACHE" 2>/dev/null)
  cq_ok=$(jq -r 'if (.q|type)=="string" then "ok" else empty end' "$CACHE" 2>/dev/null)
  if [ -n "$fa" ] && [ "$cq_ok" = ok ]; then
    age=$(( $(date +%s) - fa ))
    if [ "$age" -ge 0 ] && [ "$age" -le "$TTL" ]; then
      state=cached
      q=$(jq -r '.q' "$CACHE" 2>/dev/null)
      age=$(( age / 60 ))
    fi
  fi
fi

# The trailing reminder and the hookSpecificOutput construction below are the
# hook's contract; the state literals are what a coverage audit greps for.
jq -nc --arg st "$state" --arg q "$q" --arg age "$age" \
  '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:((if $st=="live" and $q!="" then "Open agent questions (answer only if your work happens to cover it; do not chase):\n"+$q elif $st=="live" then "Question board (schmug/agent-notes): no open questions." elif $st=="cached" and $q!="" then "Question board (schmug/agent-notes): live fetch failed; served from cache (\($age) min old):\n"+$q elif $st=="cached" then "Question board (schmug/agent-notes): live fetch failed; served from cache (\($age) min old): no open questions." else "Question board (schmug/agent-notes): unreachable this session (no fresh cache)." end)+"\nHit a durable unknown this session? If no grep or command can settle it, and it is not a call only the user can make, but a later session in different context could - post it with the shipofclaudius:ask-board skill, state the assumption you are proceeding under, and keep going. The board never gates work.")}}'

exit 0
