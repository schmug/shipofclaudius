#!/bin/sh
# Status-line renderer (spec §5). Does exactly two things: read `session_id` from the
# stdin JSON, and read the matching cache file. It never computes, never calls the
# network, never shells out to git -- it runs on every conversation update.
#
# Every failure path prints NOTHING and exits 0 (spec §8: a missing cache file renders an
# empty field, not an error string). A status line that can fail is a status line that
# can make a whole session look broken.
set -u

input=$(cat)
command -v jq >/dev/null 2>&1 || exit 0

dir="${SPECIFICITY_DIR:-$HOME/.claude/specificity}"
sid=$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null) || exit 0
[ -n "$sid" ] || exit 0

# `session_id` comes from the host, but it is still untrusted input being interpolated
# into a filesystem path. Reject anything that is not a plain id rather than sanitizing
# it; this mirrors isSafeSessionId() in src/cache.mjs, and the two must stay in step.
case "$sid" in
  *[!A-Za-z0-9_-]*) exit 0 ;;
esac

cache="$dir/$sid.json"
[ -f "$cache" ] || exit 0

# §5.4: current-turn identity. The status-line payload DOES carry `prompt_id`, so when it
# is present staleness is an exact comparison against the record's own prompt_id and no
# heuristic is involved.
#
# The mtime comparison below is kept strictly as a FALLBACK, for the case where the
# installed version does not send the field (the spec's own advice is to dump the raw
# stdin once and confirm before depending on any of it). BSD and GNU stat disagree on
# flags; try both, and treat "no idea" as "not stale" rather than crying wolf.
cur_pid=$(printf '%s' "$input" | jq -r '.prompt_id // empty' 2>/dev/null)
#
# GNU and BSD `stat` are not merely different, they COLLIDE: on GNU, `-f` means
# --file-system, so `stat -f %m FILE` prints filesystem information for FILE on stdout and
# only fails on the `%m` operand. Chaining it as `stat -f %m ... || stat -c %Y ...` then
# concatenates that text with the epoch, and the result is garbage that silently disables
# staleness. So each variant is tried and its output VALIDATED as digits before use,
# rather than trusting exit status.
tp=$(printf '%s' "$input" | jq -r '.transcript_path // empty' 2>/dev/null)
mtime=""
if [ -n "$tp" ] && [ -f "$tp" ]; then
  mtime=$(stat -c %Y "$tp" 2>/dev/null)                          # GNU
  case "$mtime" in ''|*[!0-9]*) mtime=$(stat -f %m "$tp" 2>/dev/null) ;; esac   # BSD/macOS
fi
case "$mtime" in ''|*[!0-9]*) mtime=0 ;; esac

grace="${SPECIFICITY_STALE_GRACE:-60}"
case "$grace" in ''|*[!0-9]*) grace=60 ;; esac

jq -r --argjson mtime "$mtime" --argjson grace "$grace" --arg cur_pid "${cur_pid:-}" \
   -f "$(dirname "$0")/render.jq" "$cache" 2>/dev/null || exit 0
exit 0
