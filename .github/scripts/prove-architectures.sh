#!/usr/bin/env bash
#
# Every package in a directory carries the architecture its name claims.
#
#   prove-architectures.sh <dist>
#
# The expensive mistake this exists to prevent: an arm64 package assembled on an
# x86_64 machine carries the wrong native modules under the right name. It
# installs happily and fails on somebody else's machine with "cannot load", and
# nothing in the build log says so. The build asserts its runner, which is the
# first line of defence; this is the second, over the finished files, after they
# have been through an artifact upload and a download.
set -uo pipefail

DIST="${1:?a directory of packages}"
# Which kinds must be there. A directory holding only one platform's packages is
# a legitimate thing to check -- one job's output, before the two are gathered --
# and "no macOS packages at all" is a finding only when macOS packages were
# expected. Saying so explicitly beats a glob that quietly matches nothing.
shift || true
EXPECT="${*:-macos ubuntu}"
wanted() { printf '%s' " $EXPECT " | grep -q " $1 "; }

pass=0; fail=0
ok()  { printf '  ok    %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  FAIL  %s\n' "$1"; fail=$((fail+1)); }

ROOM="$(mktemp -d)"
trap 'rm -rf "$ROOM"' EXIT

if wanted macos; then
echo "### macOS packages"
for tarball in "$DIST"/AI17Z-macos-*.tar.gz; do
  [ -f "$tarball" ] || { bad "no macOS packages at all"; break; }
  name="$(basename "$tarball")"
  claimed="$(printf '%s' "$name" | sed -E 's/^AI17Z-macos-([a-z0-9]+)-.*/\1/')"
  rm -rf "$ROOM/m"; mkdir -p "$ROOM/m"
  tar -xzf "$tarball" -C "$ROOM/m" AI17Z/runtime/node/bin/node 2>/dev/null \
    || { bad "$name has no bundled node"; continue; }
  says="$(file -b "$ROOM/m/AI17Z/runtime/node/bin/node")"
  case "$claimed:$says" in
    arm64:*arm64*|x64:*x86_64*) ok "$name really is $claimed -- $says" ;;
    *) bad "$name claims $claimed and is: $says" ;;
  esac
done
fi

if wanted ubuntu; then
echo
echo "### Ubuntu packages"
for deb in "$DIST"/ai17z_*.deb; do
  [ -f "$deb" ] || { bad "no Ubuntu packages at all"; break; }
  name="$(basename "$deb")"
  claimed="$(printf '%s' "$name" | sed -E 's/^ai17z_.*_([a-z0-9]+)\.deb$/\1/')"
  said="$(dpkg-deb -f "$deb" Architecture)"
  if [ "$claimed" != "$said" ]; then
    bad "$name is named $claimed and its metadata says $said"
    continue
  fi
  rm -rf "$ROOM/u"; mkdir -p "$ROOM/u"
  dpkg-deb -x "$deb" "$ROOM/u"
  node="$ROOM/u/usr/lib/ai17z/runtime/node/bin/node"
  [ -f "$node" ] || { bad "$name has no bundled node"; continue; }
  says="$(file -b "$node")"
  case "$claimed:$says" in
    amd64:*x86-64*|arm64:*aarch64*) ok "$name really is $claimed -- $says" ;;
    *) bad "$name claims $claimed and is: $says" ;;
  esac
  # And the native module that shipped wrong four times.
  esbuild="$(find "$ROOM/u/usr/lib/ai17z/app/node_modules/@esbuild" -type f -name esbuild 2>/dev/null | head -1)"
  if [ -n "$esbuild" ]; then
    says="$(file -b "$esbuild")"
    case "$claimed:$says" in
      amd64:*x86-64*|arm64:*aarch64*) ok "$name's esbuild is $claimed" ;;
      *) bad "$name's esbuild is: $says" ;;
    esac
  else
    bad "$name has no esbuild binary"
  fi
done
fi

echo
echo "  architectures: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
