#!/usr/bin/env bash
#
# Say something under a heading of its own in the job log.
#
#   <something that prints> | say-out.sh '<title>'
#
# The other half of `say-on-fail.sh`. A rehearsal of a release is the case this
# exists for: it builds every package, assembles the checksums and the
# manifest, publishes nothing, and its whole value is in what it printed. Job
# logs on a public project are public, so the log is the place; this gives the
# finding a collapsible group of its own (Forgejo Actions' `::group::`), so it
# is not lost among the lines of whatever ran before it.
set -uo pipefail

TITLE="${1:?a title}"

printf '::group::==== %s ====\n' "$TITLE"
cat
printf '::endgroup::\n'
