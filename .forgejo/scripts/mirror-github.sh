#!/usr/bin/env bash
#
# Mirror one published AI17Z release to GitHub, from a directory holding its
# files.
#
#   mirror-github.sh <tag> <directory> [notes.md]
#
# Run by the release job's publish step, straight after publish-release.sh,
# with the directory it published from; and by tools/release-here/
# mirror-github.sh, with a directory it downloaded from AI17Z Code. Either way
# the bytes are checked against that release's own SHA256SUMS.txt before one
# of them leaves this machine, so the mirror can only ever carry what the
# release published.
#
# The installers and updaters ask GitHub first and AI17Z Code second, so
# GitHub carries every file they fetch, not only the ones people click:
#
#   AI17Z-Setup-<v>.exe, install-ai17z-macos.sh, install-ai17z-ubuntu.sh,
#   AI17Z-macos-{arm64,x64}-<v>.tar.gz, ai17z_<v>_{amd64,arm64}.deb,
#   SHA256SUMS.txt, SHA256SUMS.txt.sigstore.json        what people download
#   install.ps1, Install-AI17Z-<v>.ps1, AI17Z-App-<v>.zip,
#   release-manifest.json, release-notes.md            what the installers fetch
#
# The per-file signatures and the setup audit stay on AI17Z Code only.
#
# **Published the way publish-release.sh publishes: never edited in place.**
# A new GitHub release is created as a draft, every file is attached once, the
# attachments are compared with the files by name and size both ways, and only
# then is it published and marked Latest. GitHub's immutable releases are on
# for this repository, so a published release cannot be changed afterwards,
# and a draft is the only state in which the mirror can be made complete.
#
# A release published before immutable releases were turned on may still be
# open to edits; it is completed in place, and nothing already on it is removed
# unless it is not one of the files above.
#
# The page text is the release's own release-notes.md unless a notes file is
# given, which is how a release published before this script can be given the
# page the current notes script writes.
#
# Needs curl, jq, sha256sum, and GITHUB_MIRROR_TOKEN: a fine-grained GitHub
# token for ShiftAboveCtrl/ai17z with Contents read and write, and nothing else.
set -euo pipefail

TAG="${1:?a tag, such as v1.0.0-beta.88}"
DIR="$(cd "${2:?the directory holding the release files}" && pwd)"
PAGE="${3:-}"
[ -z "$PAGE" ] || PAGE="$(cd "$(dirname "$PAGE")" && pwd)/$(basename "$PAGE")"
REPO="ShiftAboveCtrl/ai17z"
API="https://api.github.com/repos/$REPO"
UPLOADS="https://uploads.github.com/repos/$REPO"
VERSION="${TAG#v}"

[ -n "${GITHUB_MIRROR_TOKEN:-}" ] || {
  echo "GITHUB_MIRROR_TOKEN is not set, so $TAG was not mirrored to GitHub."
  echo "It is published on AI17Z Code, and installs take it from there until it is mirrored:"
  echo "  tools/release-here/mirror-github.sh $TAG"
  exit 1
}
auth=(-H "Authorization: Bearer $GITHUB_MIRROR_TOKEN" -H 'Accept: application/vnd.github+json' -H 'X-GitHub-Api-Version: 2022-11-28')
say() { printf '\n==== %s ====\n' "$1"; }

# The release's own name, rendered the way the GitHub page shows it: beta.87 is
# beta-v9.7. Nothing parses it back; the tag is the number.
case "$VERSION" in
  *-beta.*) N="${VERSION##*-beta.}"; TITLE="AI17Z beta-v$((N / 10 + 1)).$((N % 10))" ;;
  *) TITLE="AI17Z $TAG" ;;
esac

# Every file GitHub carries, in the order the release notes list them.
WANTED=(
  "AI17Z-Setup-$VERSION.exe"
  install-ai17z-macos.sh
  install-ai17z-ubuntu.sh
  "AI17Z-macos-arm64-$VERSION.tar.gz"
  "AI17Z-macos-x64-$VERSION.tar.gz"
  "ai17z_${VERSION}_amd64.deb"
  "ai17z_${VERSION}_arm64.deb"
  SHA256SUMS.txt
  SHA256SUMS.txt.sigstore.json
  install.ps1
  "Install-AI17Z-$VERSION.ps1"
  "AI17Z-App-$VERSION.zip"
  release-manifest.json
  release-notes.md
)
# Without these an installer that asks GitHub first cannot finish from it.
# A missing platform package is a release without that platform, which the
# notes already say; a missing one of these is a release that is not finished.
REQUIRED=(SHA256SUMS.txt release-manifest.json release-notes.md install.ps1 "Install-AI17Z-$VERSION.ps1" "AI17Z-App-$VERSION.zip")

cd "$DIR"
[ -n "$PAGE" ] || PAGE="$DIR/release-notes.md"
say "the files, checked against $TAG's SHA256SUMS.txt"
for name in "${REQUIRED[@]}"; do
  [ -f "$name" ] || { echo "  $name is missing from $DIR; nothing was mirrored"; exit 1; }
done
FILES=()
for name in "${WANTED[@]}"; do
  if [ -f "$name" ]; then FILES+=("$name"); else echo "  $name is not in this release, skipped"; fi
done
# Every file that has a published hash must match it. The checksums, their
# signature and the notes are not in the list they would have to be in to check
# themselves, and the signature is what vouches for the checksums.
hashed=()
for name in "${FILES[@]}"; do
  if grep -qE "^[0-9a-f]{64}[[:space:]]+\*?${name//./\\.}\$" SHA256SUMS.txt; then hashed+=("$name"); fi
done
grep -F -f <(printf '  %s\n' "${hashed[@]}") SHA256SUMS.txt | sha256sum --check --strict -
echo "  ${#hashed[@]} files match their published hash"

say "the GitHub release"
status="$(curl -sS -o release.json -w '%{http_code}' "${auth[@]}" "$API/releases/tags/$TAG")"
RELEASE_ID=""
if [ "$status" = 200 ]; then
  RELEASE_ID="$(jq -r '.id' release.json)"
  if [ "$(jq -r '.immutable // false' release.json)" = true ]; then
    # Published and sealed. Complete or not, it cannot be changed, and that is
    # the property being bought.
    echo "  $TAG is already published and immutable on GitHub; comparing only"
  else
    echo "  $TAG already exists on GitHub (release $RELEASE_ID); completing it"
  fi
elif [ "$status" = 404 ]; then
  jq -n --arg tag "$TAG" --arg name "$TITLE" --rawfile notes "$PAGE" \
    '{tag_name: $tag, name: $name, body: $notes, draft: true, prerelease: false}' > release-request.json
  curl -fsS --retry 3 "${auth[@]}" -H 'Content-Type: application/json' --data @release-request.json "$API/releases" > release.json
  RELEASE_ID="$(jq -r '.id' release.json)"
  echo "  draft release $RELEASE_ID for $TAG"
else
  echo "  GitHub answered $status for $TAG; nothing was mirrored"
  exit 1
fi
[ "$RELEASE_ID" -gt 0 ] 2>/dev/null || { echo "  no release id came back"; exit 1; }

attached() {
  curl -fsS "${auth[@]}" "$API/releases/$RELEASE_ID/assets?per_page=100" | jq -r '.[] | "\(.name)\t\(.size)\t\(.id)"' | sort
}

if [ "$(jq -r '.immutable // false' release.json)" != true ]; then
  say "attach every file, once"
  have="$(attached)"
  for name in "${FILES[@]}"; do
    size="$(stat -c %s "$name")"
    if printf '%s\n' "$have" | awk -F'\t' -v n="$name" -v s="$size" '$1 == n && $2 == s { found = 1 } END { exit !found }'; then
      echo "  $name already attached"; continue
    fi
    # A same-named file of another size is replaced rather than joined.
    old="$(printf '%s\n' "$have" | awk -F'\t' -v n="$name" '$1 == n { print $3 }')"
    [ -n "$old" ] && curl -fsS -X DELETE "${auth[@]}" "$API/releases/assets/$old" >/dev/null
    curl -fsS --retry 3 "${auth[@]}" -H 'Content-Type: application/octet-stream' --data-binary "@$name" \
      "$UPLOADS/releases/$RELEASE_ID/assets?name=$name" >/dev/null
    echo "  attached $name"
  done
  # Anything else on the release is not something this release published.
  printf '%s\n' "$(attached)" | while IFS=$'\t' read -r name _ id; do
    [ -n "$name" ] || continue
    keep=0; for wanted in "${FILES[@]}"; do [ "$name" = "$wanted" ] && keep=1; done
    if [ "$keep" = 0 ]; then curl -fsS -X DELETE "${auth[@]}" "$API/releases/assets/$id" >/dev/null; echo "  removed $name"; fi
  done
fi

say "the attachments are exactly the files"
attached | cut -f1,2 > attached.tsv
for name in "${FILES[@]}"; do printf '%s\t%s\n' "$name" "$(stat -c %s "$name")"; done | sort > expected.tsv
if ! diff expected.tsv attached.tsv; then
  echo "  GitHub does not hold exactly this release's files. A draft stays a draft; nothing more is published."
  exit 1
fi
echo "  $(wc -l < attached.tsv) files, each once, each its published size"

say "publish"
jq -n --arg name "$TITLE" --rawfile notes "$PAGE" \
  '{name: $name, body: $notes, draft: false, prerelease: false, make_latest: "true"}' > release-request.json
if [ "$(jq -r '.immutable // false' release.json)" = true ]; then
  echo "  already published"
else
  curl -fsS --retry 3 -X PATCH "${auth[@]}" -H 'Content-Type: application/json' --data @release-request.json \
    "$API/releases/$RELEASE_ID" | jq -r '"  \(.name) at \(.html_url), marked Latest"'
fi
rm -f release.json release-request.json attached.tsv expected.tsv
