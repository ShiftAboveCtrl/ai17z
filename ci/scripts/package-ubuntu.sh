#!/usr/bin/env bash
#
# Build and prove the Ubuntu package.
#
#   package-ubuntu.sh <version> <amd64|arm64> <out>
#
# Stages, packages, installs and then actually runs an AI17Z .deb on the
# machine that built it. One implementation, used by both the release pipeline
# and the packaging validation jobs, so that what validation proves is what a
# release ships.
#
# Runs as root in a CI job container, where there is no sudo and none is
# needed, or as an ordinary user anywhere else, where there is.
set -euo pipefail

VERSION="${1:?a version without the leading v}"
ARCH="${2:?amd64 or arm64}"
OUT="${3:?where the finished .deb goes}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="${TMPDIR:-/tmp}/ai17z-ubuntu-$$"
DEB="$OUT/ai17z_${VERSION}_${ARCH}.deb"
# A prefix rather than a function, because say-on-fail.sh runs its command in
# a process of its own, where a function defined here does not exist.
SUDO=""; [ "$(id -u)" -eq 0 ] || SUDO="sudo"
trap 'echo "line $LINENO failed: $BASH_COMMAND"' ERR

echo "--- the architecture this runner really is"
# An arm64 package assembled on an x86_64 machine carries the wrong native
# modules under the right name. It installs, and fails on somebody else's
# machine with "cannot load".
actual="$(dpkg --print-architecture)"
[ "$actual" = "$ARCH" ] || { echo "runner is $actual, job builds $ARCH"; exit 1; }
echo "runner is $actual, as expected"
# In a subshell: /etc/os-release defines VERSION too, and sourcing it here
# replaced the version being built with "24.04.4 LTS (Noble Numbat)".
( . /etc/os-release && echo "on Ubuntu ${VERSION_ID}" )
echo "node $(node -v), npm $(npm -v)"

echo "--- stage the application"
# AI17Z_VERSION so the staged BUILD_INFO.json and the package's name come from
# one place. The build script is handed the version as a flag; the stager would
# otherwise read package.json, and a release tagged before package.json was
# bumped would name a package one version and have it report another.
AI17Z_VERSION="$VERSION" bash "$HERE/say-on-fail.sh" 'staging' -- \
  npm run package:unix -- --platform ubuntu --stage "$TMP/stage"

echo "--- build the package"
bash "$HERE/say-on-fail.sh" 'build-deb.sh' -- \
  bash packaging/ubuntu/build-deb.sh \
    --stage "$TMP/stage" \
    --version "$VERSION" \
    --arch "$ARCH" \
    --node "$(node -p "require('./packaging/node-runtime.json').version")" \
    --out "$OUT"

echo "--- lintian"
$SUDO apt-get update -qq
$SUDO apt-get install -y -qq lintian file
# Errors fail. Warnings are printed rather than suppressed wholesale: the ones
# that are upstream Node being upstream Node have named overrides inside the
# package, each with its reason.
bash "$HERE/say-on-fail.sh" 'lintian' -- lintian --fail-on error "$DEB"

echo "--- what the package says it is"
dpkg -I "$DEB"
said="$(dpkg-deb -f "$DEB" Architecture)"
[ "$said" = "$ARCH" ] || { echo "the package says $said"; exit 1; }
said="$(dpkg-deb -f "$DEB" Version)"
[ "$said" = "$VERSION" ] || { echo "the package says version $said"; exit 1; }
echo "metadata agrees: $ARCH $VERSION"

echo "--- install it"
bash "$HERE/say-on-fail.sh" 'apt install' -- $SUDO apt-get install -y "$DEB"

echo "--- run what was installed"
bash "$HERE/say-on-fail.sh" 'the installed package' -- \
  bash "$HERE/prove-ubuntu-package.sh" "$VERSION" "$ARCH"

echo "--- nothing of an owner's is in the package"
bash "$HERE/say-on-fail.sh" 'the privacy scan' -- bash "$HERE/scan-artifact.sh" "$DEB" ubuntu

echo "--- what this package is"
ls -l "$DEB"
sha256sum "$DEB"
