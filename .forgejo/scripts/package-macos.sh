#!/usr/bin/env bash
#
# Build and prove the macOS package.
#
#   package-macos.sh <version> <out>
#
# Stages, packages and then actually runs an AI17Z macOS package on the Mac that
# built it. One implementation, used by both the release pipeline and the
# packaging validation job, so that what validation proves is what a release
# ships.
#
# Apple silicon only. AI17Z's Mac release runners are Apple silicon, and an Intel
# package built on one would run under Rosetta: a relabelled architecture, not
# a proved one. See ARCHITECTURES_OF in packages/shared/src/releaseManifest.ts.
set -euo pipefail

VERSION="${1:?a version without the leading v}"
OUT="${2:?where the finished tarball goes}"
ARCH=arm64
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="${TMPDIR:-/tmp}/ai17z-macos-$$"
TARBALL="$OUT/AI17Z-macos-${ARCH}-${VERSION}.tar.gz"
trap 'echo "line $LINENO failed: $BASH_COMMAND"' ERR

echo "--- the architecture this runner really is"
# Asserted rather than assumed. A runner that is not what the job expects would
# otherwise ship a mislabelled package, which installs happily and fails on
# somebody else's Mac with "cannot load", and nothing in the build log says so.
[ "$(uname -s)" = Darwin ] || { echo "not a Mac: $(uname -s)"; exit 1; }
actual="$(uname -m)"
[ "$actual" = arm64 ] || { echo "runner is $actual but this job builds arm64"; exit 1; }
echo "runner is $actual, as expected"
sw_vers
echo "node $(node -v), npm $(npm -v)"

echo "--- stage the application"
# AI17Z_VERSION so the staged BUILD_INFO.json and the package's name come from
# one place, as on Ubuntu.
AI17Z_VERSION="$VERSION" bash "$HERE/say-on-fail.sh" 'staging' -- \
  npm run package:unix -- --platform macos --stage "$TMP/stage"

echo "--- build the package"
bash "$HERE/say-on-fail.sh" 'build-tarball.sh' -- \
  bash packaging/macos/build-tarball.sh \
    --stage "$TMP/stage" \
    --version "$VERSION" \
    --arch "$ARCH" \
    --node "$(node -p "require('./packaging/node-runtime.json').version")" \
    --out "$OUT"

echo "--- run what was built"
bash "$HERE/say-on-fail.sh" 'the package itself' -- \
  bash "$HERE/prove-macos-package.sh" "$TARBALL" "$VERSION" "$ARCH"

echo "--- nothing of an owner's is in the package"
bash "$HERE/say-on-fail.sh" 'the privacy scan' -- bash "$HERE/scan-artifact.sh" "$TARBALL" macos

echo "--- what this package is"
ls -l "$TARBALL"
shasum -a 256 "$TARBALL"
