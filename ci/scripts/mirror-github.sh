#!/usr/bin/env bash
# Recover a gated emergency release from a trusted directory to GitHub.
#   mirror-github.sh <tag> <directory> [notes.md]
# Never used by primary CI. Every file is copied, and an existing release is refused.
set -euo pipefail
TAG="${1:?a release tag}"
DIR="$(cd "${2:?a directory holding every release asset}" && pwd)"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
VERSION="${TAG#v}"
[ -z "${3:-}" ] || { echo 'Use the original release-notes.md; rewritten notes are not a release copy'; exit 2; }
: "${GITHUB_MIRROR_TOKEN:?a token scoped to the destination repository}"
cd "$DIR"
mapfile -t FILES < <(find . -maxdepth 1 -type f -printf '%f\n' | sort)
[ "${#FILES[@]}" -gt 0 ] || exit 1
bash "$HERE/private-identifiers.sh" files "${FILES[@]}"
TITLE="$(cd "$ROOT" && npx tsx tools/release-name.mts "$VERSION" page)"
COMMIT="$(jq -er '.commit' release-manifest.json)"
export RELEASE_TOKEN="${GITHUB_MIRROR_TOKEN}"
bash "$HERE/publish-github.sh" "$TAG" "$TITLE" "$COMMIT" release-notes.md "${FILES[@]}"
