#!/usr/bin/env bash
#
# A published AI17Z release, installed on real Ubuntu the way a stranger would.
#
#   qualify-published-ubuntu.sh <tag> [<checkout-of-that-tag>]
#
# The second argument is what the published installer is compared against,
# and it defaults to this script's own checkout. The workflow passes them
# separately on purpose: the tooling should be the current one, so a fault in
# *this* file can be fixed and re-run against a release that already exists,
# while the thing being compared still comes from the tag. With one checkout
# for both, a bad assertion here was frozen at the tag and could only ever be
# fixed for the next release.
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
# Where the tag's copy of the installer is. The same checkout unless the
# caller says otherwise, which is what makes running this by hand work.
TAGGED="${2:-$HERE}"
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
if diff -q "$ROOM/install-ai17z-ubuntu.sh" "$TAGGED/install-ai17z-ubuntu.sh" >/dev/null 2>&1; then
  ok "and is byte for byte the script this checkout holds"
else
  bad "the published installer differs from the one in the checkout"
  diff "$TAGGED/install-ai17z-ubuntu.sh" "$ROOM/install-ai17z-ubuntu.sh" | head -20 | sed 's/^/        /'
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
# GitHub allows sixty API requests an hour to an address that is not signed in,
# and a hosted runner shares its address with whoever else is on that machine.
# The published installer is unauthenticated by design -- that is what a
# stranger runs, and giving it a token here would be testing something nobody
# else can run. So this does what the installer's own advice says to do: waits,
# and tries once more. One refusal is the ceiling being shared. A second one,
# ninety seconds later, is a finding.
#
# Seen for real: `curl: (56) The requested URL returned error: 403` from the
# macOS arm64 runner, while the Intel one beside it installed fine.
install_once() {
  bash "$ROOM/install-ai17z-ubuntu.sh" --release "$TAG" --yes --no-start 2>&1
}
out="$(install_once)"
if printf '%s' "$out" | grep -qE '403|could not be read|could not be reached'; then
  echo "  GitHub refused that. Waiting ninety seconds and trying once more, which is"
  echo "  what the installer itself tells somebody to do."
  sleep 90
  out="$(install_once)"
  if printf '%s' "$out" | grep -qE '403|could not be read|could not be reached'; then
    # Twice. The ceiling is an hour long, so ninety seconds was never going to
    # clear it -- and this has to be unmistakable rather than look like a
    # finding about the release. Everything else in this run installed the same
    # release from the same URLs.
    bad "this runner could not reach the GitHub API after a retry. That is the sixty-an-hour ceiling on an address it shares, not something about the release."
  else
    ok "it was refused once and the retry worked"
  fi
fi
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
  # The installer's own words, carried into the summary that is printed last: an
  # annotation holds the last forty lines and the checks fill them, so a failed
  # install would otherwise arrive as consequences with no cause.
  bad "the package was not installed. The installer said: $(printf '%s' "$out" | grep -v '^[[:space:]]*$' | tail -6 | tr '\n' '/')"
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
