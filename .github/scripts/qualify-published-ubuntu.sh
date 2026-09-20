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

# One implementation of what a failed attempt meant, shared with the macOS
# qualifier and exercised by tests/unit/qualifyAttemptVerdict.test.ts.
. "$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)/qualify-attempt-verdict.sh"

# The summary, reachable from anywhere that has established there is nothing
# further worth asking.
#
# Everything after the install asks the installed copy about itself, so there
# has to be one. Without a way to stop, a runner that could not reach GitHub
# reports the same fact a dozen times over: no version, no architecture, no
# launcher, no directories. Measured on Beta 4.7, where the arm64 Mac running
# the equivalent script reported "5 passed, 14 failed" for a release the Intel
# Mac beside it installed perfectly from the same URLs.
#
# A cause is worth more than its consequences, so this stops at the cause.
finish() {
  echo
  [ "$fail" -eq 0 ] || printf '\n  what failed:%b\n' "$failures"
  echo "  published Ubuntu $ARCH: $pass passed, $fail failed"
  [ "$fail" -eq 0 ]
  exit $?
}

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
#
# The retry turns on the attempt having failed, never on what it printed. A
# condition written as a text match only fires for the wordings somebody thought
# of, and the Windows half of this workflow proved how that ends: it matched on
# (403), (409) and (429) in output that was empty on every run, so the retry it
# appears to have could never once have happened. An exit status is there
# whatever the failure was and whatever it managed to say about it.
#
# Two attempts, and no more. What it printed is still read, but only to describe
# what happened once both of them have failed.

# Both attempts failed, and the report has to name which kind of failure it is
# rather than assume one. A shared runner's hourly API ceiling says nothing
# about the release; anything else is a finding about what was published.
# Either way this fails.
why_it_failed() {
  if printf '%s' "$2" | grep -qE '403|429|rate limit|could not be read|could not be reached'; then
    printf 'this runner could not reach the GitHub API after a retry (the second attempt exited %s). That is the sixty-an-hour ceiling on an address it shares, not something about the release.' "$1"
  else
    printf 'the published installer failed twice, ninety seconds apart, exiting %s the second time. Everything else in this run reached the same release from the same URLs, so this is a finding about what was published rather than about this runner.' "$1"
  fi
}
# How long to wait before the second attempt, asked of GitHub rather than guessed.
#
# Ninety seconds was a guess, and the comment above already admitted it could
# not clear an hourly ceiling. Measured across three releases: the macOS arm64
# runner was refused twice, ninety seconds apart, on two of them, while the
# Intel Mac beside it installed the same release from the same URLs.
#
# GitHub says when the ceiling resets, in `/rate_limit`, and that endpoint is
# free: it is explicitly not counted against the limit it reports. So this asks,
# and waits the stated time when that is short enough to be worth waiting, and
# otherwise waits the ninety seconds it always did.
#
# Bounded on both sides. Never longer than MAX_CEILING_WAIT, because a job that
# sits for most of an hour is worse than a job that says it was rate limited,
# and still exactly two attempts either way.
MAX_CEILING_WAIT=600

wait_for_the_ceiling() {
  local reset now left
  reset="$(curl -fsS -H 'User-Agent: ai17z-qualification' https://api.github.com/rate_limit 2>/dev/null \
    | tr ',' '\n' | grep -m1 '"reset"' | tr -dc '0-9')"
  now="$(date +%s)"
  if [ -z "$reset" ] || [ -z "$now" ]; then
    echo "  GitHub did not say when its ceiling resets. Waiting ninety seconds."
    sleep 90
    return
  fi
  left=$((reset - now + 5))
  if [ "$left" -le 0 ]; then
    echo "  GitHub says its ceiling has already reset. Trying again now."
    return
  fi
  if [ "$left" -gt "$MAX_CEILING_WAIT" ]; then
    echo "  GitHub says its ceiling resets in ${left}s, which is longer than this job will wait."
    echo "  Waiting ninety seconds and trying once more anyway."
    sleep 90
    return
  fi
  echo "  GitHub says its ceiling resets in ${left}s. Waiting that long and trying once more."
  sleep "$left"
}

install_once() {
  bash "$ROOM/install-ai17z-ubuntu.sh" --release "$TAG" --yes --no-start 2>&1
}

# The package, taken by its exact address rather than looked up.
#
# This is the gate, and it touches no API. The asset name is composed by
# `releaseManifest.ts`, the release publishes it at a path containing the tag,
# and the hash comes from the SHA256SUMS.txt already fetched from that same tag.
#
# It used to be answered by running the published installer, which resolves the
# release through `api.github.com` without a token because that is what a
# stranger runs. That made package correctness depend on a sixty-an-hour budget
# shared with whoever else was on the runner.
PACKAGE="ai17z_${VERSION}_${ARCH}.deb"
echo
echo "### the package for this machine, by its exact address"
if curl -fsSL -o "$ROOM/$PACKAGE" "$DL/$PACKAGE"; then
  ok "fetched $PACKAGE from the tag"
else
  bad "$TAG publishes no $PACKAGE"
  finish
fi

want="$(grep "  $PACKAGE\$" "$ROOM/SHA256SUMS.txt" | awk '{print $1}')"
got="$(sha256sum "$ROOM/$PACKAGE" | awk '{print $1}')"
if [ -n "$want" ] && [ "$want" = "$got" ]; then
  ok "it matches the hash the release published"
else
  bad "the package hashes $got and SHA256SUMS.txt says '${want:-nothing}'"
  finish
fi

echo
echo "### installing that exact package, with no network lookup at all"
out="$(sudo dpkg -i "$ROOM/$PACKAGE" 2>&1)"
code=$?
if [ "$code" -ne 0 ]; then
  bad "the published package would not install (exit $code). $(printf '%s' "$out" | grep -v '^[[:space:]]*$' | tail -4 | tr '\n' '/')"
  printf '%s\n' "$out" | sed 's/^/    /' | tail -30
  finish
fi
ok "it installed from the published bytes"

echo
echo "### and the anonymous route a stranger actually takes"
# Kept, because it is the route people use, and reported rather than trusted.
# Not a gate: the package is already proved above from the tag's own bytes, so
# a runner that cannot reach the anonymous API says something about the runner.
smoke="$(bash "$ROOM/install-ai17z-ubuntu.sh" --release "$TAG" --yes --no-start 2>&1)"
smoke_code=$?
if [ "$smoke_code" -ne 0 ]; then
  wait_for_the_ceiling
  smoke="$(bash "$ROOM/install-ai17z-ubuntu.sh" --release "$TAG" --yes --no-start 2>&1)"
  smoke_code=$?
fi
case "$(attempt_verdict "$smoke_code" "$smoke")" in
  OK)
    ok "the published installer resolved $TAG and installed it unauthenticated"
    ;;
  CEILING)
    echo "  note  GitHub refused this runner's anonymous API twice. That is the shared hourly"
    echo "        ceiling rather than anything about $TAG, which installed from its own bytes above."
    ;;
  *)
    bad "the published installer failed for something other than the API ceiling (exit $smoke_code). $(printf '%s' "$smoke" | grep -v '^[[:space:]]*$' | tail -4 | tr '\n' '/')"
    ;;
esac

printf '%s\n' "$out" | sed 's/^/    /' | tail -40

says "the installed copy names this version" "$out" "$VERSION"
says "it checked the bytes against the hash it was given" "$out" "SHA-256"
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
  finish
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

finish
