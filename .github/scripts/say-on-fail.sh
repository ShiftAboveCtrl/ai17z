#!/usr/bin/env bash
#
# Run something, and if it fails, say what it said.
#
#   say-on-fail.sh <label> -- <command> [args...]
#
# Actions logs need admin rights on the repository to read, through the API and
# in the web interface both. An `::error::` line becomes an annotation, and
# annotations are public -- so this is how the output of a failing command
# reaches anybody who did not write the workflow.
#
# The output is still printed normally as well. This adds a copy where it can be
# read, it does not move it.
set -uo pipefail

LABEL="${1:?a label}"
shift
[ "${1:-}" = "--" ] && shift

OUT="$(mktemp)"
trap 'rm -f "$OUT"' EXIT

# Captured directly, not after an `if`. The exit status of an `if` whose
# condition was false is 0, so `code=$?` on the line after the block reports
# success for a command that failed -- and then this helper would swallow every
# failure it exists to report.
"$@" > "$OUT" 2>&1
code=$?

cat "$OUT"
[ "$code" -eq 0 ] && exit 0

# Annotations are one line. Newlines go through as %0A, and the percent signs
# and carriage returns that would otherwise be eaten are escaped first.
detail="$(tail -40 "$OUT" | sed -e 's/%/%25/g' -e 's/\r/%0D/g' | awk '{ printf "%s%%0A", $0 }')"
printf '::error::%s failed (exit %s): %s\n' "$LABEL" "$code" "$detail"
exit "$code"
