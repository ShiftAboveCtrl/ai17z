#!/usr/bin/env bash
#
# A published AI17Z release, installed on a real Mac the way a stranger would.
#
#   qualify-published-macos.sh <tag> [<checkout-of-that-tag>]
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
# of the checkout, the package comes off the release over the network, and the
# hash it is checked against is the one the release published. Nothing here
# reads a build output, and the only thing it takes from the repository is the
# checkout it runs from -- which it uses to assert that the published installer
# is byte for byte the file this tag holds.
#
# `--no-start` because a hosted Mac has no Docker daemon, and `--into` because
# the runner's own Library is not a disposable place. The one thing stubbed is
# the answer to Docker's vendor check, at the narrowest point it can be: Docker
# Desktop's download, disk image, licence and first run are not reachable here
# and are not claimed. See prove-macos-installer.sh, which says the same and for
# the same reason.
set -uo pipefail

TAG="${1:?a tag, such as v1.0.0-beta.17}"
VERSION="${TAG#v}"
REPO="${GITHUB_REPOSITORY:-ShiftAboveCtrl/ai17z}"
DL="https://github.com/$REPO/releases/download/$TAG"

HERE="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# Where the tag's copy of the installer is. The same checkout unless the
# caller says otherwise, which is what makes running this by hand work.
TAGGED="${2:-$HERE}"
ARCH="$(uname -m)"; [ "$ARCH" = x86_64 ] && ARCH=x64

pass=0; fail=0
failures=""
ok()  { printf '  ok    %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  FAIL  %s\n' "$1"; fail=$((fail+1)); failures="$failures
    $1"; }
says() { if printf '%s' "$2" | grep -qi -- "$3"; then ok "$1"; else
  bad "$1"; printf '%s\n' "$2" | tail -15 | sed 's/^/        /'; fi; }

# A directory with a space in it, because the real one is "Application Support"
# and an unquoted variable anywhere in the chain only ever shows up there.
ROOM="${TMPDIR:-/tmp}/published release"
rm -rf "$ROOM"; mkdir -p "$ROOM"
TARGET="$ROOM/AI17Z published"

echo "### what the release published"
curl -fsSL -o "$ROOM/SHA256SUMS.txt" "$DL/SHA256SUMS.txt" \
  || { echo "::error::$TAG publishes no SHA256SUMS.txt"; exit 1; }
sed 's/^/    /' "$ROOM/SHA256SUMS.txt"

echo
echo "### the installer, as published"
curl -fsSL -o "$ROOM/install-ai17z-macos.sh" "$DL/install-ai17z-macos.sh" \
  || { echo "::error::$TAG publishes no install-ai17z-macos.sh"; exit 1; }

said="$(grep '  install-ai17z-macos.sh$' "$ROOM/SHA256SUMS.txt" | awk '{print $1}')"
got="$(shasum -a 256 "$ROOM/install-ai17z-macos.sh" | awk '{print $1}')"
if [ -n "$said" ] && [ "$said" = "$got" ]; then
  ok "the published installer matches the hash the release published"
else
  bad "the installer hashes $got and SHA256SUMS.txt says '${said:-nothing}'"
fi

# And that it is this tag's file rather than some other version of it. The
# release copies the repository's own script in; a difference means the release
# was assembled from something that is not this commit.
if diff -q "$ROOM/install-ai17z-macos.sh" "$TAGGED/install-ai17z-macos.sh" >/dev/null 2>&1; then
  ok "and is byte for byte the script this checkout holds"
else
  bad "the published installer differs from the one in the checkout"
  diff "$TAGGED/install-ai17z-macos.sh" "$ROOM/install-ai17z-macos.sh" | head -20 | sed 's/^/        /'
fi

echo
echo "### Docker, and only Docker"
# A hosted Mac has no Docker Desktop and cannot be given one: its installer is a
# disk image with a graphical setup and Docker's own licence to accept, and
# AI17Z must never accept that for somebody. Answered at the vendor boundary so
# that everything after that gate is reachable; nothing of AI17Z's own logic is
# replaced.
STUB="$ROOM/vendor-bin"
mkdir -p "$STUB"
cat > "$STUB/docker" <<'STUBBED'
#!/bin/sh
case "$1" in
  info)    echo "Server Version: 27.4.0"; exit 0 ;;
  version) echo "27.4.0"; exit 0 ;;
  compose) echo "Docker Compose version v2.30.0"; exit 0 ;;
  *)       exit 0 ;;
esac
STUBBED
chmod +x "$STUB/docker"
PATH="$STUB:$PATH"
export PATH
echo "  docker is stubbed at the vendor boundary: $(command -v docker)"

echo
echo "### installing $TAG from the network, as published"
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
  bash "$ROOM/install-ai17z-macos.sh" --release "$TAG" --into "$TARGET" --yes --no-start 2>&1
}
out="$(install_once)"
if printf '%s' "$out" | grep -qE '403|could not be read|could not be reached'; then
  echo "  GitHub refused that. Waiting ninety seconds and trying once more, which is"
  echo "  what the installer itself tells somebody to do."
  sleep 90
  out="$(install_once)"
  ok "it was refused once and retried"
fi
printf '%s\n' "$out" | sed 's/^/    /' | tail -40

says "it resolved this release" "$out" "$VERSION"
says "it checked the package against a published hash" "$out" "SHA-256 matches"
says "it said the package is not signed or notarized" "$out" "notariz"
# Which package it chose is asked of the bytes it installed, below, not of what
# it printed: the installer names the version and never the asset, so grepping
# the output for the architecture failed on both Macs while every check that
# actually matters passed. `file` on the bundled node and on esbuild is the
# stronger question anyway -- a package can be named anything.

if [ -x "$TARGET/ai17z" ]; then
  ok "the launcher is there"
else
  # The installer's own words, carried into the summary that is printed last.
  # An annotation holds the last forty lines, and the checks below fill them --
  # so a failed install arrived once as thirteen consequences and no cause.
  bad "nothing was installed. The installer said: $(printf '%s' "$out" | grep -v '^[[:space:]]*$' | tail -6 | tr '\n' '/')"
fi
if [ -d "$TARGET/app" ] && [ -d "$TARGET/runtime" ]; then ok "app and runtime are there"; else bad "app or runtime missing"; fi

echo
echo "### what was installed says what it is"
said="$("$TARGET/ai17z" version 2>&1)"
if [ "$said" = "$VERSION" ]; then ok "the launcher reports $said"; else bad "the launcher reports '$said', not $VERSION"; fi

if [ -f "$TARGET/app/BUILD_INFO.json" ]; then
  built="$("$TARGET/runtime/node/bin/node" -p "require('$TARGET/app/BUILD_INFO.json').version" 2>&1)"
  if [ "$built" = "$VERSION" ]; then
    ok "BUILD_INFO.json says $built"
  else
    # The defect this exists for: a package named after the tag and reporting
    # the version that happened to be in package.json. An installed copy reads
    # BUILD_INFO.json to decide whether it is up to date, so the two disagreeing
    # means an update that is offered for ever.
    bad "BUILD_INFO.json says '$built' and the package is named $VERSION"
  fi
else
  bad "there is no BUILD_INFO.json in the installed application"
fi

echo
echo "### the architecture, from the bytes rather than from the name"
node="$TARGET/runtime/node/bin/node"
says "node is a Mach-O for this Mac" "$(file -b "$node")" "$( [ "$ARCH" = arm64 ] && echo arm64 || echo x86_64 )"
esbuild="$(find "$TARGET/app/node_modules/@esbuild" -type f -name esbuild 2>/dev/null | head -1)"
if [ -n "$esbuild" ]; then
  says "esbuild is a Mach-O for this Mac" "$(file -b "$esbuild")" "$( [ "$ARCH" = arm64 ] && echo arm64 || echo x86_64 )"
else
  bad "the published package has no esbuild binary"
fi

echo
echo "### it runs"
if "$TARGET/ai17z" node -p '1 + 1' >/dev/null 2>&1; then
  ok "the bundled node runs, from a path with a space in it"
else
  bad "something in the chain lost a quote"
fi
if "$node" "$TARGET/app/node_modules/tsx/dist/cli.mjs" -e 'const n: number = 1; console.log(n)' >/dev/null 2>&1; then
  ok "tsx transforms TypeScript"
else
  bad "tsx cannot transform, so no npm script an installed copy runs would work"
fi

echo
echo "### the owner's directories, beside the program rather than inside it"
for dir in data logs browser-profiles; do
  if [ -d "$TARGET/$dir" ]; then
    mode="$(stat -f '%A' "$TARGET/$dir")"
    if [ "$mode" = 700 ]; then ok "$dir is 700"; else bad "$dir is $mode"; fi
  else
    bad "$dir was not created"
  fi
done

echo
echo "### a release that has no package for this Mac is refused, not half-installed"
out="$(bash "$ROOM/install-ai17z-macos.sh" --release v0.0.0-does-not-exist --into "$ROOM/nowhere" --yes --no-start 2>&1)"
if [ -d "$ROOM/nowhere/app" ]; then
  bad "it installed something from a release that does not exist"
else
  ok "nothing was installed"
fi
says "and it said why" "$out" "release"

echo
[ "$fail" -eq 0 ] || printf '\n  what failed:%b\n' "$failures"
echo "  published macOS $ARCH: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
