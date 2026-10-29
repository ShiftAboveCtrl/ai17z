#!/usr/bin/env bash
#
# Mirror one published AI17Z Code release to GitHub, with only the files a
# person downloads.
#
#   mirror-github.sh <tag> [notes.md]
#
# Needs curl, sha256sum and an authenticated gh. The notes default to the
# release's own release-notes.md. Every file is fetched from AI17Z Code and
# checked against that release's SHA256SUMS.txt before it is uploaded, so the
# mirror can only ever carry bytes the release published.
#
# The GitHub release is titled "AI17Z beta-vX.Y" (beta.87 is beta-v9.7), marked
# Latest, and holds the files below. Anything else already attached is removed:
# the installers read AI17Z Code, never GitHub, so the files they fetch
# themselves and the per-file signatures only make the download list harder to
# read here.
set -euo pipefail

TAG="${1:?a tag, such as v1.0.0-beta.87}"
NOTES="${2:-}"
REPO="ShiftAboveCtrl/ai17z"
SOURCE="https://code.ai17z.io/AI17Z/ai17z/releases/download/$TAG"
VERSION="${TAG#v}"

case "$VERSION" in
  *-beta.*) N="${VERSION##*-beta.}"; TITLE="AI17Z beta-v$((N / 10 + 1)).$((N % 10))" ;;
  *) TITLE="AI17Z $TAG" ;;
esac

KEEP=(
  "AI17Z-Setup-$VERSION.exe"
  install-ai17z-macos.sh
  install-ai17z-ubuntu.sh
  "AI17Z-macos-arm64-$VERSION.tar.gz"
  "AI17Z-macos-x64-$VERSION.tar.gz"
  "ai17z_${VERSION}_amd64.deb"
  "ai17z_${VERSION}_arm64.deb"
  SHA256SUMS.txt
  SHA256SUMS.txt.sigstore.json
)

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"

curl -fsSL --proto '=https' -o SHA256SUMS.txt "$SOURCE/SHA256SUMS.txt"
present=()
for name in "${KEEP[@]}"; do
  if curl -fsSL --proto '=https' -o "$name" "$SOURCE/$name"; then
    present+=("$name")
  else
    # A release can lack a platform (no macOS package that time); the notes
    # already say so, and the mirror carries what exists.
    echo "  $name is not in $TAG, skipped"
  fi
done
# Every hashed file must match. The checksums and their signature are not in
# the list they would have to be in to check themselves.
grep -F -f <(printf '  %s\n' "${present[@]}") SHA256SUMS.txt | sha256sum --check --strict -
if [ -z "$NOTES" ]; then
  curl -fsSL --proto '=https' -o release-notes.md "$SOURCE/release-notes.md"
  NOTES="$WORK/release-notes.md"
fi

if gh release view "$TAG" -R "$REPO" >/dev/null 2>&1; then
  gh release edit "$TAG" -R "$REPO" --title "$TITLE" --notes-file "$NOTES" --prerelease=false --latest
else
  gh release create "$TAG" -R "$REPO" --verify-tag --title "$TITLE" --notes-file "$NOTES" --latest
fi

gh release upload "$TAG" -R "$REPO" --clobber "${present[@]}"
gh release view "$TAG" -R "$REPO" --json assets -q '.assets[].name' | while read -r name; do
  keep=0
  for wanted in "${present[@]}"; do [ "$name" = "$wanted" ] && keep=1; done
  if [ "$keep" = 0 ]; then
    gh release delete-asset "$TAG" "$name" -R "$REPO" --yes
    echo "  removed $name"
  fi
done
echo "$TITLE: $(gh release view "$TAG" -R "$REPO" --json assets -q '.assets | length') files, marked Latest"
