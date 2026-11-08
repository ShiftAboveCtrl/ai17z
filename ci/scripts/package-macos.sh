#!/usr/bin/env bash
#
# Build and prove the macOS package.
#
#   package-macos.sh <version> <out> [arm64|x64]
#
# Stages, packages and then actually runs an AI17Z macOS package on the Mac that
# built it. One implementation, used by both the release pipeline and the
# packaging validation job, so that what validation proves is what a release
# ships.
#
# Each architecture on a Mac of that architecture: Apple silicon on an arm64
# runner, Intel on an x86_64 one. An Intel package built on Apple silicon would
# run under Rosetta, which is a relabelled architecture rather than a proved
# one, so the runner is checked before anything is built. The architecture
# defaults to arm64, which is what a Mac release runner was before GitHub
# carried both. See ARCHITECTURES_OF in packages/shared/src/releaseManifest.ts.
set -euo pipefail

VERSION="${1:?a version without the leading v}"
OUT="${2:?where the finished tarball goes}"
ARCH="${3:-arm64}"
case "$ARCH" in arm64) WANT=arm64 ;; x64) WANT=x86_64 ;; *) echo "unsupported architecture: $ARCH"; exit 2 ;; esac
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
[ "$actual" = "$WANT" ] || { echo "runner is $actual but this job builds $ARCH"; exit 1; }
# A shell under Rosetta reports x86_64 on Apple silicon. Asking the kernel
# rather than the process is what tells a real Intel Mac apart from one.
if [ "$ARCH" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
  echo "this shell is translated by Rosetta, so the runner is not an Intel Mac"; exit 1
fi
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
