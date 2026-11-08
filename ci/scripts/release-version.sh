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
#
# The tag comes from RELEASE_TAG when a caller names one, and otherwise from the
# ref this Actions run was started by, when that ref is a tag.
set -euo pipefail

TAG="${RELEASE_TAG:-}"
if [ -z "$TAG" ] && [ "${GITHUB_REF_TYPE:-}" = tag ]; then TAG="${GITHUB_REF_NAME:-}"; fi
if [ -n "$TAG" ]; then
  v="${TAG#rehearsal-}"
  v="${v#qualify-}"
  v="${v#v}"
else
  v="$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' package.json | head -1)"
fi
# A broad v* trigger is only routing. Validate before a version crosses jobs.
if [[ ! "$v" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$ ]]; then
  echo 'the release tag is not strict semver' >&2; exit 1
fi
if [[ "$v" == *-* ]]; then
  IFS='.' read -r -a identifiers <<< "${v#*-}"
  for identifier in "${identifiers[@]}"; do
    if [[ "$identifier" =~ ^0[0-9]+$ ]]; then
      echo 'numeric prerelease identifiers cannot have leading zeroes' >&2; exit 1
    fi
  done
fi
printf '%s\n' "$v"
