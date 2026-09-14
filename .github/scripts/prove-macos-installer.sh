#!/usr/bin/env bash
#
# The real macOS installer, against a package this run has just built.
#
#   prove-macos-installer.sh <file.tar.gz> <version>
#
# Not a rehearsal of what the installer does -- the installer itself, on a real
# Mac, installing a real package. `--package` plus `--sha256` is the offline
# route it grew for exactly this.
#
# `--into` puts the installation somewhere disposable rather than in the runner's
# own Library, and `--no-start` is passed because a hosted Mac has no Docker
# daemon and bringing the stack up would prove nothing the package tests have not.
# What is under test is the installer's own decisions: refusals, architecture
# selection, the hash, extraction, where it puts things, and rerunning it.
#
# Nothing about AI17Z's own logic is mocked. One thing outside it is: a hosted
# Mac has no Docker Desktop and cannot be given one without a person, so the
# `docker` command is answered at the vendor boundary. See the note where that
# happens. Docker Desktop's own download, disk image, licence and first run are
# not reachable here and are not claimed.
set -uo pipefail

TARBALL="${1:?a tarball}"
VERSION="${2:?a version}"

HERE="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INSTALLER="$HERE/install-ai17z-macos.sh"
SHA="$(shasum -a 256 "$TARBALL" | awk '{print $1}')"
ARCH="$(uname -m)"; [ "$ARCH" = x86_64 ] && ARCH=x64

pass=0; fail=0
# What failed, repeated at the end.
#
# An annotation carries the last forty lines, and a failure forty lines up is a
# failure nobody reading the annotation can see. Keeping the labels and printing
# them last costs nothing and is the difference between a diagnosis and another
# round trip.
failures=""
ok()  { printf '  ok    %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  FAIL  %s\n' "$1"; fail=$((fail+1)); failures="$failures
    $1"; }
says() { if printf '%s' "$2" | grep -qi -- "$3"; then ok "$1"; else
  bad "$1"; printf '%s\n' "$2" | tail -12 | sed 's/^/        /'; fi; }

# A directory with a space in it, because the real one is "Application Support"
# and an unquoted variable anywhere in the chain only ever shows up there.
ROOM="${TMPDIR:-/tmp}/installer room"
rm -rf "$ROOM"; mkdir -p "$ROOM"
TARGET="$ROOM/AI17Z test"

# Docker, and only Docker.
#
# A hosted Mac has no Docker Desktop and cannot be given one: its installer is a
# disk image with a graphical setup and Docker's own licence to accept, and
# AI17Z must never accept that for somebody. Without it the installer stops at
# the Docker gate -- correctly -- and everything after that gate goes untested.
#
# So the vendor check is answered, at the narrowest point it can be: two
# commands on PATH that say what a working Docker says. Nothing of AI17Z's own
# logic is replaced; the installer runs exactly as it would, and what it does
# after finding Docker is the thing being tested.
#
# The real Docker Desktop path -- the download, the disk image, the licence, the
# first run -- is not reachable here and is not claimed.
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

echo "### the refusals, before anything is unpacked"

out="$(bash "$INSTALLER" --package "$TARBALL" --into "$TARGET" --yes --no-start 2>&1)"
says "--package without --sha256 is refused" "$out" "needs --sha256"

out="$(bash "$INSTALLER" --package "$TARBALL" --sha256 0000000000000000000000000000000000000000000000000000000000000000 --into "$TARGET" --yes --no-start 2>&1)"
says "a wrong hash is a hard failure" "$out" "does not match"
if [ -d "$TARGET/app" ]; then bad "it unpacked anyway"; else ok "and nothing was unpacked"; fi

out="$(bash "$INSTALLER" --package "$ROOM/not-here.tar.gz" --sha256 "$SHA" --into "$TARGET" --yes --no-start 2>&1)"
says "a package that is not there is refused" "$out" "no file at"

other="$([ "$ARCH" = arm64 ] && echo x64 || echo arm64)"
cp "$TARBALL" "$ROOM/AI17Z-macos-${other}-${VERSION}.tar.gz"
out="$(bash "$INSTALLER" --package "$ROOM/AI17Z-macos-${other}-${VERSION}.tar.gz" --sha256 "$SHA" --into "$TARGET" --yes --no-start 2>&1)"
says "a package for the other architecture is refused" "$out" "not for this Mac"

out="$(bash "$INSTALLER" --wibble 2>&1)"
says "an unknown option is reported rather than ignored" "$out" "Unknown option"

echo
echo "### no security control is touched"
# Asserted against what ran, not only against the source: a script can always
# grow a branch that shells out. These are the names that would appear.
for forbidden in 'spctl' 'xattr -d' 'master-disable' 'csrutil' 'codesign'; do
  if printf '%s' "$out" | grep -q -- "$forbidden"; then bad "it mentioned $forbidden"; fi
done
if grep -nE '^[^#]*\b(spctl|csrutil|codesign)\b' "$INSTALLER" | grep -q .; then
  bad "the installer has a line that runs a Gatekeeper tool"
  grep -nE '^[^#]*\b(spctl|csrutil|codesign)\b' "$INSTALLER" | sed 's/^/        /'
else
  ok "no spctl, csrutil or codesign anywhere that runs"
fi
if grep -nE '^[^#]*xattr[^|]*-d' "$INSTALLER" | grep -q .; then
  bad "the installer strips a quarantine attribute"
else
  ok "no quarantine attribute is stripped"
fi

echo
echo "### installing, for real"
out="$(bash "$INSTALLER" --package "$TARBALL" --sha256 "$SHA" --into "$TARGET" --yes --no-start 2>&1)"
printf '%s\n' "$out" | sed 's/^/    /' | tail -40
if [ -x "$TARGET/ai17z" ]; then ok "the launcher is there"; else bad "no launcher at $TARGET/ai17z"; fi
if [ -d "$TARGET/app" ] && [ -d "$TARGET/runtime" ]; then ok "app and runtime are there"; else bad "app or runtime missing"; fi
says "it said the hash matched" "$out" "SHA-256 matches"
says "it says the package is not signed or notarized" "$out" "notariz"

said="$("$TARGET/ai17z" version 2>&1)"
if [ "$said" = "$VERSION" ]; then ok "the launcher reports $said"; else bad "the launcher reports '$said'"; fi

echo
echo "### a path with a space in it, all the way through"
if "$TARGET/ai17z" node -p '1 + 1' >/dev/null 2>&1; then
  ok "the bundled node runs from a path with a space"
else
  bad "something in the chain lost a quote"
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
if [ -e "$TARGET/app/.env" ]; then bad "an .env was written into app/"; else ok "nothing of the owner's inside app/"; fi

echo
echo "### running it again over the top keeps the data"
printf 'a thing the owner made\n' > "$TARGET/data/owner.txt"
printf 'AI17Z_MASTER_KEY=pretend-key-that-must-survive\n' > "$TARGET/data/.env"
out="$(bash "$INSTALLER" --package "$TARBALL" --sha256 "$SHA" --into "$TARGET" --yes --no-start 2>&1)"
if [ -f "$TARGET/data/owner.txt" ]; then ok "the owner's file survived"; else bad "a rerun took the owner's file"; fi
if grep -q 'must-survive' "$TARGET/data/.env" 2>/dev/null; then
  ok "the master key survived"
else
  bad "a rerun took the master key"
fi
if [ -x "$TARGET/ai17z" ]; then ok "and the installation still works"; else bad "the rerun broke it"; fi

echo
echo "### uninstall keeps the data unless it is told otherwise"
set +e
"$TARGET/ai17z" uninstall --yes > "$ROOM/uninstall.txt" 2>&1
set -e
sed 's/^/    /' "$ROOM/uninstall.txt" | tail -20
if [ -f "$TARGET/data/owner.txt" ]; then
  ok "the owner's data is still there after an uninstall"
else
  bad "uninstall took the owner's data without being asked"
fi

rm -rf "$ROOM"
echo
[ "$fail" -eq 0 ] || printf '\n  what failed:%b\n' "$failures"
echo "  installer: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
