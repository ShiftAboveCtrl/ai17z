#!/usr/bin/env bash
#
# Build a package for a machine this runner is not, and prove it.
#
#   package-assembled.sh <macos|ubuntu> <arm64|x64> <version> <out>
#
# For the platforms AI17Z Code has no runner of: macOS (both processors) and
# arm64 Ubuntu. The stage is made with npm selecting that platform's prebuilt
# packages (`--target-arch`), the platform's own Node is fetched from nodejs.org
# and checked against its published SHA-256, and then the package is refused
# unless every native file in it is byte-identical to the natively built and
# tested reference pinned in .forgejo/native-references.json.
#
# What this does not do is run the package on its platform. Its JavaScript ran
# here (the stager's transform and update gate), and every native file it has
# has already run on a machine of that platform, inside the reference. A
# release built this way says so in its notes.
set -euo pipefail

PLATFORM="${1:?macos or ubuntu}"
ARCH="${2:?arm64 or x64}"
VERSION="${3:?a version without the leading v}"
OUT="${4:?where the finished package goes}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="${TMPDIR:-/tmp}/ai17z-assembled-$$"
trap 'echo "line $LINENO failed: $BASH_COMMAND"' ERR

case "$PLATFORM:$ARCH" in
  macos:arm64|macos:x64) PACKAGE="$OUT/AI17Z-macos-${ARCH}-${VERSION}.tar.gz"; KEY="macos-${ARCH}" ;;
  ubuntu:arm64) PACKAGE="$OUT/ai17z_${VERSION}_arm64.deb"; KEY="ubuntu-arm64" ;;
  *) echo "nothing is assembled for $PLATFORM $ARCH: build it on its own runner"; exit 2 ;;
esac
mkdir -p "$OUT" "$TMP"

echo "--- the reference this package is proved against"
REF_RELEASE="$(node -p "require('./.forgejo/native-references.json')['$KEY'].release")"
REF_ASSET="$(node -p "require('./.forgejo/native-references.json')['$KEY'].asset")"
REF_SHA="$(node -p "require('./.forgejo/native-references.json')['$KEY'].sha256")"
# The forge this job runs on, so a rehearsal against a test forge reads that
# forge's copy. The hash is what makes any copy acceptable.
FORGE="${GITHUB_SERVER_URL:-https://code.ai17z.io}/${GITHUB_REPOSITORY:-AI17Z/ai17z}"
curl -fsSL --retry 3 -o "$TMP/$REF_ASSET" "$FORGE/releases/download/$REF_RELEASE/$REF_ASSET"
got="$(sha256sum "$TMP/$REF_ASSET" | cut -d' ' -f1)"
[ "$got" = "$REF_SHA" ] || { echo "$REF_ASSET is $got, pinned $REF_SHA"; exit 1; }
echo "$REF_ASSET from $REF_RELEASE, ${got:0:12}, as pinned"

echo "--- stage the application for $PLATFORM $ARCH"
AI17Z_VERSION="$VERSION" bash "$HERE/say-on-fail.sh" 'staging' -- \
  npm run package:unix -- --platform "$PLATFORM" --target-arch "$ARCH" --stage "$TMP/stage"

NODE_VERSION="$(node -p "require('./packaging/node-runtime.json').version")"
echo "--- build the package"
if [ "$PLATFORM" = macos ]; then
  bash "$HERE/say-on-fail.sh" 'build-tarball.sh' -- \
    bash packaging/macos/build-tarball.sh --stage "$TMP/stage" --version "$VERSION" \
      --arch "$ARCH" --node "$NODE_VERSION" --out "$OUT"
else
  bash "$HERE/say-on-fail.sh" 'build-deb.sh' -- \
    bash packaging/ubuntu/build-deb.sh --stage "$TMP/stage" --version "$VERSION" \
      --arch "$ARCH" --node "$NODE_VERSION" --out "$OUT"
  echo "--- lintian"
  bash "$HERE/say-on-fail.sh" 'lintian' -- lintian --fail-on error "$PACKAGE"
fi

echo "--- every native file is one its platform built and ran"
bash "$HERE/say-on-fail.sh" 'the native files' -- bash "$HERE/prove-natives.sh" "$PACKAGE" "$TMP/$REF_ASSET"

echo "--- the architecture its name claims"
mkdir -p "$TMP/one"; cp "$PACKAGE" "$TMP/one/"
bash "$HERE/say-on-fail.sh" 'the architecture' -- bash "$HERE/prove-architectures.sh" "$TMP/one" "$PLATFORM"

echo "--- nothing of an owner's is in the package"
bash "$HERE/say-on-fail.sh" 'the privacy scan' -- bash "$HERE/scan-artifact.sh" "$PACKAGE" "$PLATFORM"

rm -rf "$TMP"
ls -l "$PACKAGE"
sha256sum "$PACKAGE"
