#!/usr/bin/env bash
#
# Say something where it can actually be read.
#
#   <something that prints> | say-out.sh '<title>'
#
# The other half of `say-on-fail.sh`, and for the same reason: Actions logs need
# admin rights on the repository to read, through the API and in the web
# interface both. An `::error::` line becomes an annotation and annotations are
# public -- and so does `::notice::`, which is what a step that *succeeded* has
# to use if anybody is to see what it found.
#
# A rehearsal of a release is the case this exists for. It builds every package,
# assembles the checksums and the manifest, publishes nothing, and its whole
# value is in what it printed. Left in the log, that is readable by one person.
#
# The input is printed normally as well. This adds a copy where it can be read;
# it does not move it.
set -uo pipefail

TITLE="${1:?a title}"

OUT="$(mktemp)"
trap 'rm -f "$OUT"' EXIT
cat > "$OUT"
cat "$OUT"

# Annotations are one line. Newlines go through as %0A, and the percent signs
# and carriage returns that would otherwise be eaten are escaped first. The same
# encoding say-on-fail.sh uses, because it is the same constraint.
body="$(sed -e 's/%/%25/g' -e 's/\r/%0D/g' "$OUT" | awk '{ printf "%s%%0A", $0 }')"
printf '::notice title=%s::%s\n' "$TITLE" "$body"
