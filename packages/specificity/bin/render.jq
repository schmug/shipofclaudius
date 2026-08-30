# render.jq — one cache record (spec §6) -> one status line (spec §5.3).
#
# Pure: no I/O beyond the record on stdin and the two --argjson values. The status line
# re-renders on every conversation update (at most every 300ms), so it must never
# compute, shell out, or touch the network. All of that already happened in the hook.
#
# Expects: $cur_pid (the current turn's prompt_id, "" if the host did not send one),
# $mtime (transcript mtime, epoch seconds, 0 if unknown), $grace (staleness tolerance in
# seconds).

def clampi($n): if $n < 0 then 0 elif $n > 8 then 8 else $n end;

# 8-char bar, `delta` (or the fast-path grounding ratio) normalized 0-1. ROUNDS, not
# floors: §5.3's worked examples are .74 -> 6 cells, .61 -> 5 and .21 -> 2, all of which
# floor one cell short.
def bar($v):
  ((($v // 0) * 8) | round) as $raw
  | clampi($raw) as $n
  | (if $n > 0 then ("▓" * $n) else "" end)
    + (if (8 - $n) > 0 then ("░" * (8 - $n)) else "" end);

# Same value, numeric, two decimals without a leading zero: .74 / .05 / 1.0.
def dec($v):
  (((($v // 0) * 100) | round)) as $p
  | if $p >= 100 then "1.0"
    elif $p <= 0 then ".00"
    elif $p < 10 then ".0" + ($p | tostring)
    else "." + ($p | tostring)
    end;

def paint($code; $s): "\u001b[" + $code + "m" + $s + "\u001b[0m";

# Green carried, dim redundant, yellow underspec, red conflict. Conflict is the one state
# worth making loud: a turn can look highly specific in isolation while fighting a
# constraint already settled in context.
def state_style($state):
  if   $state == "carried"        then ["32", "carried"]
  elif $state == "redundant"      then ["2",  "redundant"]
  elif $state == "underspecified" then ["33", "underspec"]
  elif $state == "conflicting"    then ["31", "conflict"]
  else ["2", ($state | tostring)]
  end;

. as $r
| ($r.fast // null) as $f
| ($r.sampled // null) as $s
| ($r.phase // "error") as $phase
| (if $f == null then 0 else ($f.unresolved // 0) end) as $unres
| (if $f == null then 0 else ($f.ambiguous // 0) end) as $amb
| (if $f == null then 0 else ($f.grounded // 0) end) as $grnd
# SCORED referents only. Indeterminate pronouns are excluded from the denominator: the
# index cannot tell which entity a pronoun points at, so counting them either way would be
# a number we did not measure. A turn whose only referents are pronouns therefore renders
# the neutral marker, not a score.
| ($grnd + $unres + $amb) as $total
# Fast-path grounding ratio. This is NOT the delta -- it is what the bar shows before the
# sampler has landed (or, in M1, at all), and §8 requires a fast-only render to exist.
| (if $total == 0 then 1 else ($grnd / $total) end) as $ground
# Staleness, exact where possible. Both the hook payload and the status-line payload
# carry `prompt_id`, so when both sides have one the answer is a comparison, not a guess.
# The mtime window is the fallback for hosts that do not send the field; it is the reason
# §5.4 existed at all, and it is now the second choice rather than the only one.
| (if ($cur_pid != "") and (($r.prompt_id // "") != "")
   then ($cur_pid != $r.prompt_id)
   else ($mtime > 0) and (($r.written_at // 0) > 0) and (($mtime - $r.written_at) > $grace)
   end) as $is_stale
| (if $is_stale then " " + paint("2"; "(stale)") else "" end) as $stale
| (if $unres > 0 then " " + paint("33"; "⟂" + ($unres | tostring)) else "" end) as $flag
| (if $phase == "sampling" then "spec " + paint("2"; "░░░░░░░░  ·  sampling")
   elif $phase == "error"  then "spec " + paint("2"; "░░░░░░░░  ·  error")
   elif ($s != null) and (($s.state // null) != null) then
     (state_style($s.state)) as $st
     | "spec " + bar($s.delta_normalized) + " " + dec($s.delta_normalized) + " " + paint($st[0]; $st[1]) + $flag
   elif $total == 0 then
     # A turn with no referents at all measured NOTHING. Rendering it as a full bar at 1.0
     # claims perfect grounding, which is a confident lie -- and it is not rare: 24.4% of
     # real turns in a 1,915-turn corpus carry zero referents. Use the same "no value"
     # marker as the sampling placeholder.
     "spec " + paint("2"; "░░░░░░░░  ·  no refs")
   else
     # Fast phase only: show grounding, and say so rather than borrowing a sampled state
     # word the sampler never produced.
     (if ($unres + $amb) > 0 then "33" else "2" end) as $code
     | "spec " + bar($ground) + " " + dec($ground) + " " + paint($code; "fast") + $flag
   end) + $stale
