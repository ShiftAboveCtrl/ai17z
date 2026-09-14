#!/usr/bin/env bash
#
# A published AI17Z release, installed on real Ubuntu the way a stranger would.
#
#   qualify-published-ubuntu.sh <tag>
#
# Everything before this proves the package a run has just built. This proves
# the one that was published: the script comes off the release rather than out
# of the checkout, the `.deb` comes off the release over the network, and the
# hash it is checked against is the one the release published.
#
# `--no-start` because bringing the whole stack up on a hosted runner proves
# nothing the package tests have not, and takes ten minutes to do it. What is
# under test is the published route: resolve, download, check, install, and what
# the installed thing then says about itself.
set -uo pipefail

TAG="${1:?a tag, such as v1.0.0-beta.17}"
VERSION="${TAG#v}"
REPO="${GITHUB_REPOSITORY:-ShiftAboveCtrl/ai17z}"
DL="https://github.com/$REPO/releases/download/$TAG"

HERE="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ARCH="$(dpkg --print-architecture)"

pass=0; fail=0
failures=""
ok()  { printf '  ok    %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  FAIL  %s\n' "$1"; fail=$((fail+1)); failures="$failures
    $1"; }
says() { if printf '%s' "$2" | grep -qi -- "$3"; then ok "$1"; else
  bad "$1"; printf '%s\n' "$2" | tail -15 | sed 's/^/        /'; fi; }

ROOM="$(mktemp -d)"

echo "### what the release published"
curl -fsSL -o "$ROOM/SHA256SUMS.txt" "$DL/SHA256SUMS.txt" \
  || { echo "::error::$TAG publishes no SHA256SUMS.txt"; exit 1; }
sed 's/^/    /' "$ROOM/SHA256SUMS.txt"

echo
echo "### the installer, as published"
curl -fsSL -o "$ROOM/install-ai17z-ubuntu.sh" "$DL/install-ai17z-ubuntu.sh" \
  || { echo "::error::$TAG publishes no install-ai17z-ubuntu.sh"; exit 1; }

said="$(grep '  install-ai17z-ubuntu.sh$' "$ROOM/SHA256SUMS.txt" | awk '{print $1}')"
got="$(sha256sum "$ROOM/install-ai17z-ubuntu.sh" | awk '{print $1}')"
if [ -n "$said" ] && [ "$said" = "$got" ]; then
  ok "the published installer matches the hash the release published"
else
  bad "the installer hashes $got and SHA256SUMS.txt says '${said:-nothing}'"
fi

# And that it is this tag's file rather than some other version of it. The
# release copies the repository's own script in; a difference means the release
# was assembled from something that is not this commit.
if diff -q "$ROOM/install-ai17z-ubuntu.sh" "$HERE/install-ai17z-ubuntu.sh" >/dev/null 2>&1; then
  ok "and is byte for byte the script this checkout holds"
else
  bad "the published installer differs from the one in the checkout"
  diff "$HERE/install-ai17z-ubuntu.sh" "$ROOM/install-ai17z-ubuntu.sh" | head -20 | sed 's/^/        /'
fi

echo
echo "### it refuses to run as root, before anything is fetched"
out="$(sudo bash "$ROOM/install-ai17z-ubuntu.sh" --release "$TAG" --yes --no-start 2>&1)"
says "root is refused" "$out" "root"
if dpkg -s ai17z >/dev/null 2>&1; then bad "it installed anyway"; else ok "and nothing was installed"; fi

echo
echo "### installing $TAG from the network, as published"
# As the runner's own user, which is an ordinary person with sudo and is already
# able to reach Docker -- which is what the documented route assumes. Adding a
# user to that group is setting up a machine, not changing the installer, and
# this machine's user is already in it.
out="$(bash "$ROOM/install-ai17z-ubuntu.sh" --release "$TAG" --yes --no-start 2>&1)"
printf '%s\n' "$out" | sed 's/^/    /' | tail -40

says "it resolved this release" "$out" "$VERSION"
says "it checked the package against a published hash" "$out" "SHA-256"
says "it chose the package for this machine" "$out" "$ARCH"

echo
echo "### what apt now has"
if dpkg -s ai17z >/dev/null 2>&1; then
  ok "ai17z is installed"
  said="$(dpkg -s ai17z | awk '/^Version:/ {print $2}')"
  if [ "$said" = "$VERSION" ]; then ok "dpkg says $said"; else bad "dpkg says '$said', not $VERSION"; fi
  said="$(dpkg -s ai17z | awk '/^Architecture:/ {print $2}')"
  if [ "$said" = "$ARCH" ]; then ok "dpkg says $said"; else bad "dpkg says '$said', not $ARCH"; fi
else
  bad "the published installer did not install the package"
fi

echo
echo "### and the deep proof, against what the release put on this machine"
# The same script the packaging workflow runs against a package it has just
# built, pointed at the one that was published instead.
if bash "$HERE/.github/scripts/prove-ubuntu-package.sh" "$VERSION" "$ARCH"; then
  ok "the published package passed the full proof"
else
  bad "the published package failed the full proof"
fi

echo
echo "### a release that has no package for this machine is refused"
out="$(bash "$ROOM/install-ai17z-ubuntu.sh" --release v0.0.0-does-not-exist --yes --no-start 2>&1)"
says "it said why" "$out" "release"

echo
[ "$fail" -eq 0 ] || printf '\n  what failed:%b\n' "$failures"
echo "  published Ubuntu $ARCH: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
