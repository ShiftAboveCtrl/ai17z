#!/usr/bin/env bash
#
# Say something under a heading of its own in the job log.
#
#   <something that prints> | say-out.sh '<title>'
#
# The other half of `say-on-fail.sh`. A rehearsal of a release is the case this
# exists for: it builds every package, assembles the checksums and the
# manifest, publishes nothing, and its whole value is in what it printed. GitLab
# job logs on a public project are public, so the log is the place; this gives
# the finding a collapsible section of its own, so it is not lost among the
# lines of whatever ran before it.
set -uo pipefail

TITLE="${1:?a title}"
SECTION="say_$(date +%s)_$$"

printf '\e[0Ksection_start:%s:%s\r\e[0K==== %s ====\n' "$(date +%s)" "$SECTION" "$TITLE"
cat
printf '\e[0Ksection_end:%s:%s\r\e[0K\n' "$(date +%s)" "$SECTION"
