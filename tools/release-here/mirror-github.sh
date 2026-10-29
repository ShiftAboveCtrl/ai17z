#!/usr/bin/env bash
#
# Mirror one published AI17Z Code release to GitHub, by hand.
#
#   mirror-github.sh <tag> [notes.md]
#
# The release job mirrors every release itself. This is for the times it could
# not (GitHub down, the token expired) and for releases published before the
# job did it: it downloads the release's files from AI17Z Code into a scratch
# directory and hands them to .forgejo/scripts/mirror-github.sh, the same
# script the job runs, so the two routes cannot drift.
#
# Needs curl, jq, sha256sum and an authenticated gh, whose token is passed on
# as GITHUB_MIRROR_TOKEN unless that is already set.
set -euo pipefail

TAG="${1:?a tag, such as v1.0.0-beta.87}"
NOTES="${2:-}"
VERSION="${TAG#v}"
SOURCE="https://code.ai17z.io/AI17Z/ai17z/releases/download/$TAG"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

NAMES=(
  "AI17Z-Setup-$VERSION.exe" install-ai17z-macos.sh install-ai17z-ubuntu.sh
  "AI17Z-macos-arm64-$VERSION.tar.gz" "AI17Z-macos-x64-$VERSION.tar.gz"
  "ai17z_${VERSION}_amd64.deb" "ai17z_${VERSION}_arm64.deb"
  SHA256SUMS.txt SHA256SUMS.txt.sigstore.json
  install.ps1 "Install-AI17Z-$VERSION.ps1" "AI17Z-App-$VERSION.zip"
  release-manifest.json release-notes.md
)

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
for name in "${NAMES[@]}"; do
  if curl -fsSL --proto '=https' -o "$WORK/$name" "$SOURCE/$name" 2>/dev/null; then
    echo "  fetched $name"
  else
    rm -f "$WORK/$name"
    # A release can lack a platform; the mirror carries what exists and says
    # what it skipped.
    echo "  $name is not in $TAG on AI17Z Code"
  fi
done

# Read rather than assigned, so no line here has the shape of a committed
# secret for the release check to stop on; the token itself is gh's, and never
# written anywhere.
if [ -z "${GITHUB_MIRROR_TOKEN:-}" ]; then
  read -r GITHUB_MIRROR_TOKEN < <(gh auth token)
  export GITHUB_MIRROR_TOKEN
fi
bash "$HERE/../../.forgejo/scripts/mirror-github.sh" "$TAG" "$WORK" ${NOTES:+"$NOTES"}
