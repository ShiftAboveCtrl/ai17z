#!/usr/bin/env bash
#
# The version this pipeline builds, without the leading v.
#
#   release-version.sh
#
# From the tag on a release (`v1.2.3`), a rehearsal (`rehearsal-v1.2.3`) or a
# qualification (`qualify-v1.2.3`), so a rehearsal builds the version it names;
# otherwise this checkout's own package.json. One implementation, because every
# job that names a package has to name it the same way.
set -euo pipefail

if [ -n "${CI_COMMIT_TAG:-}" ]; then
  v="${CI_COMMIT_TAG#rehearsal-}"
  v="${v#qualify-}"
  v="${v#v}"
else
  v="$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' package.json | head -1)"
fi
case "$v" in
  [0-9]*.[0-9]*.[0-9]*) printf '%s\n' "$v" ;;
  *) echo "no version could be determined (tag '${CI_COMMIT_TAG:-}')" >&2; exit 1 ;;
esac
