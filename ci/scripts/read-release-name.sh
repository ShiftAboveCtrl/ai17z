#!/usr/bin/env bash
#
# Read the release name the Windows job wrote, without running the file.
#
#   read-release-name.sh <release.env>
#
# Prints the name and deletes the file. The Windows job writes one line,
# RELEASE_NAME='AI17Z Beta 0.89', into its artifact. The publish step used to
# source that file, which ran whatever it held in a shell that also held the
# release key, its password and the private identifier list. So it is read as
# text here: exactly one line, that one variable, single quoted, and a name made
# only of the characters a release name has. Anything else is refused and the
# step stops. The file is removed either way, so it can never be attached to a
# release. publish-release.sh derives the name again from releaseName() and
# refuses a release whose two names disagree, so this is a cross-check and not
# the source of the title.
set -euo pipefail
export LC_ALL=C

FILE="${1:?the release.env the Windows job wrote}"
[ -f "$FILE" ] || { echo "$FILE is missing" >&2; exit 1; }
refuse() { rm -f "$FILE"; echo "$FILE is not one RELEASE_NAME line; refusing to use it" >&2; exit 1; }

[ "$(grep -c '' "$FILE")" = 1 ] || refuse
line="$(head -n 1 "$FILE")"
case "$line" in
  "RELEASE_NAME='"*"'") ;;
  *) refuse ;;
esac
name="${line#RELEASE_NAME=\'}"
name="${name%\'}"
printf '%s\n' "$name" | grep -Eq '^AI17Z [A-Za-z0-9. ()]+$' || refuse
rm -f "$FILE"
printf '%s\n' "$name"
