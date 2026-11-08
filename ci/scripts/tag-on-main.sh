#!/usr/bin/env bash
#
# Refuse to release a tag whose commit is not on main.
#
#   tag-on-main.sh <tag name> <commit> [main ref]
#
# Anybody with write access can push a v* tag from any branch, and the release
# workflow publishes whatever a v* tag points at. A release must be something
# main has already been through review and CI for, so a v* tag whose commit is
# not an ancestor of main (origin/main in a workflow checkout, which needs the
# whole history) is refused. A rehearsal-v* tag publishes nothing and may be
# cut from any branch, which is what makes rehearsing a release branch useful.
set -euo pipefail

TAG="${1:?the tag being released}"
COMMIT="${2:?the commit the tag points at}"
MAIN="${3:-origin/main}"

case "$TAG" in
  rehearsal-*) echo "$TAG is a rehearsal and publishes nothing; any branch may cut one"; exit 0 ;;
esac
git rev-parse --verify --quiet "$MAIN^{commit}" >/dev/null \
  || { echo "$MAIN is not in this checkout; fetch the whole history to check $TAG" >&2; exit 1; }
if git merge-base --is-ancestor "$COMMIT" "$MAIN"; then
  echo "$TAG points at a commit on main"
else
  echo "$TAG points at $COMMIT, which is not on main; a release is cut from main only" >&2
  exit 1
fi
