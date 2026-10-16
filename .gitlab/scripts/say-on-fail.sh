#!/usr/bin/env bash
#
# Run something, and if it fails, say what it said, last.
#
#   say-on-fail.sh <label> -- <command> [args...]
#
# GitLab job logs on a public project are public, so unlike Actions there is no
# second place output has to be copied to for a stranger to read it. What is
# left is position: a failing command's own words can be hundreds of lines
# above the line that says the job failed. So its output is printed as it came,
# and if it failed, the last forty lines are printed again under one heading
# that names what failed and its exit code, where the eye lands.
set -uo pipefail

LABEL="${1:?a label}"
shift
[ "${1:-}" = "--" ] && shift

OUT="$(mktemp)"
trap 'rm -f "$OUT"' EXIT

# Captured directly, not after an `if`. The exit status of an `if` whose
# condition was false is 0, so `code=$?` on the line after the block reports
# success for a command that failed, and then this helper would swallow every
# failure it exists to report.
"$@" > "$OUT" 2>&1
code=$?

cat "$OUT"
[ "$code" -eq 0 ] && exit 0

printf '\n==== FAILED: %s (exit %s) ====\n' "$LABEL" "$code"
tail -40 "$OUT"
printf '==== end of %s ====\n' "$LABEL"
exit "$code"
