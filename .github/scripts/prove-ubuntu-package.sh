#!/usr/bin/env bash
#
# Everything an installed Ubuntu package has to be able to do.
#
#   prove-ubuntu-package.sh <version> <arch>
#
# Run after the package is installed, on the machine that built it.
#
# A script rather than a dozen `run:` blocks, for two reasons. A failure inside
# a composite action reaches anybody who cannot read Actions logs as "Process
# completed with exit code 1" and nothing else, and one script can be run under
# `say-on-fail.sh` so its output arrives as an annotation. And a script can be
# run here, in a container, before a runner is ever asked -- which is how every
# fault in this file so far was actually found.
#
# @release-check-fixtures -- the `owner` home below belongs to a user this
# script creates on a disposable machine. It is nobody's.
set -uo pipefail

VERSION="${1:?a version}"
ARCH="${2:?amd64 or arm64}"

NODE=/usr/lib/ai17z/runtime/node/bin/node
APP=/usr/lib/ai17z/app
TSX="$APP/node_modules/tsx/dist/cli.mjs"
WANT_ARCH="$([ "$ARCH" = amd64 ] && echo x64 || echo arm64)"

pass=0; fail=0
ok()  { printf '  ok    %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  FAIL  %s\n' "$1"; fail=$((fail+1)); }

echo "### the bundled runtime"
if out="$("$NODE" --version 2>&1)"; then ok "node: $out"; else bad "node will not run: $out"; fi
if out="$("$NODE" -p 'process.arch' 2>&1)"; then
  if [ "$out" = "$WANT_ARCH" ]; then ok "node reports $out"; else bad "node reports $out, wanted $WANT_ARCH"; fi
else bad "node could not report its architecture"; fi
if out="$("$NODE" -p 'process.platform' 2>&1)"; then
  if [ "$out" = linux ]; then ok "node is a linux build"; else bad "node says $out"; fi
fi

echo
echo "### the binaries really are this architecture"
# `file` rather than the runtime's own opinion. The expensive mistake is a
# package built on the wrong machine: it installs, and fails on somebody else's
# with "cannot load".
says="$(file -b "$NODE")"
case "$ARCH:$says" in
  amd64:*x86-64*|arm64:*aarch64*) ok "node is $ARCH -- $says" ;;
  *) bad "node is not $ARCH: $says" ;;
esac

ESBUILD="$(find "$APP/node_modules/@esbuild" -type f -name esbuild -perm -u+x 2>/dev/null | head -1)"
if [ -z "$ESBUILD" ]; then
  bad "no runnable esbuild binary in the package"
  find "$APP/node_modules/@esbuild" -type f -name esbuild 2>/dev/null | while IFS= read -r found; do
    printf '        present but %s: %s\n' "$(stat -c '%a' "$found")" "$found"
  done
else
  says="$(file -b "$ESBUILD")"
  case "$ARCH:$says" in
    amd64:*x86-64*|arm64:*aarch64*) ok "esbuild is $ARCH" ;;
    *) bad "esbuild is not $ARCH: $says" ;;
  esac
  if out="$("$ESBUILD" --version 2>&1)"; then ok "esbuild runs: $out"; else bad "esbuild will not run: $out"; fi
fi

echo
echo "### TypeScript transforms, which every npm script an installed copy runs needs"
if out="$("$NODE" "$TSX" -e 'const n: number = 1; console.log(`tsx ok ${n}`)' 2>&1)"; then
  ok "tsx: $out"
else
  bad "tsx will not run"
  printf '%s\n' "$out" | sed 's/^/        /' | head -12
fi

echo
echo "### every workspace package loads"
# Importing is the test. A package can hold every file and still be one where
# nothing loads: a native module for the wrong architecture, a dependency
# pruned by name, an export that moved. None of that shows in a file listing.
#
# Static imports, not `await import(...)`: top-level await needs an ES module,
# and `tsx -e` decides which it is from the source it is handed.
if out="$(cd "$APP" && "$NODE" "$TSX" -e '
  import "@xbam/shared";
  import "@xbam/database";
  import "@xbam/jobs";
  import "@xbam/runtime";
  import "@xbam/channels";
  import "@xbam/models";
  import "@xbam/memory";
  import "@xbam/prompts";
  import "@xbam/tools";
  import "@xbam/persona";
  console.log("all of them");
' 2>&1)"; then
  ok "workspace packages: $out"
else
  bad "a workspace package will not load"
  printf '%s\n' "$out" | sed 's/^/        /' | head -20
fi

echo
echo "### BUILD_INFO says what this is"
if out="$("$NODE" -p "require('$APP/BUILD_INFO.json').version" 2>&1)"; then
  if [ "$out" = "$VERSION" ]; then ok "BUILD_INFO says $out"; else bad "BUILD_INFO says $out, wanted $VERSION"; fi
else
  bad "BUILD_INFO could not be read: $out"
fi

echo
echo "### the launcher, as an ordinary person"
id -u owner >/dev/null 2>&1 || sudo useradd -m -s /bin/bash owner
as_owner() { sudo -u owner -H bash -lc "$1" 2>&1; }

if out="$(as_owner 'ai17z version')"; then
  if [ "$out" = "$VERSION" ]; then ok "version: $out"; else bad "version says '$out'"; fi
else
  bad "the launcher would not run"
  printf '%s\n' "$out" | sed 's/^/        /' | head -12
fi

if out="$(as_owner "ai17z node -p 'process.arch'")"; then
  ok "the launcher's node: $out"
else
  bad "the launcher could not run its node"
  printf '%s\n' "$out" | sed 's/^/        /' | head -8
fi

if as_owner 'ai17z wibble' >/dev/null 2>&1; then
  bad "an unknown command was accepted"
else
  ok "an unknown command is refused"
fi

echo
echo "### root is refused"
if sudo -H bash -lc 'ai17z version' >/dev/null 2>&1; then
  bad "the launcher ran as root"
else
  ok "refused"
fi

echo
echo "### XDG layout, created private, overrides honoured"
as_owner 'ai17z doctor' > /tmp/doctor.txt 2>&1 || true
sed 's/^/        /' /tmp/doctor.txt | head -30
for dir in .config/ai17z .local/share/ai17z .local/state/ai17z; do
  if [ -d "/home/owner/$dir" ]; then
    mode="$(sudo -u owner stat -c '%a' "/home/owner/$dir")"
    if [ "$mode" = 700 ]; then ok "$dir is 700"; else bad "$dir is $mode"; fi
  else
    bad "$dir was not created"
  fi
done
as_owner 'XDG_CONFIG_HOME=/tmp/xc ai17z doctor >/dev/null 2>&1 || true' >/dev/null
if [ -d /tmp/xc/ai17z ]; then ok "XDG_CONFIG_HOME is honoured"; else bad "XDG_CONFIG_HOME was ignored"; fi

echo
echo "### a machine with no screen is a server, not a broken desktop"
if grep -qiE 'not available|unavailable' /tmp/doctor.txt; then
  ok "browser support reported as not available"
else
  bad "doctor did not report browser support as unavailable"
fi

echo
echo "### the compatibility gate answers, both ways"
. /etc/os-release
cat > /tmp/manifest.json <<JSON
{"schemaVersion":1,"version":"9.9.9","tag":"v9.9.9",
 "commit":"0000000000000000000000000000000000000000",
 "builtAt":"2026-01-01T00:00:00.000Z",
 "signed":{"windows":false,"macos":false,"ubuntu":false},
 "minimumUpdaterSchema":1,"installLayoutSchema":3,
 "platforms":{"ubuntu":{"supported":true,"architectures":["x64","arm64"],
   "methods":["UBUNTU_DEB"],
   "requirements":{"minimumDocker":"26.0.0","minimumChromeMajor":120,
     "bundledNode":"v22.23.2","os":{"releases":["${VERSION_ID}"]}}}},
 "artifacts":[],"migrations":{"latest":"probe","count":0}}
JSON
ask() { (cd "$APP" && "$NODE" "$TSX" packaging/preflight.mts /tmp/manifest.json ubuntu "$WANT_ARCH" "$@" 2>&1); }

said="$(ask "$VERSION_ID" 27.0.0 130)"
if [ "${said%%$'\n'*}" = OK ]; then ok "a machine it supports is accepted"; else bad "a supported machine was refused: $said"; fi
said="$(ask 18.04 27.0.0 130)"
if [ "${said%%$'\n'*}" = NO ]; then ok "an unsupported release is refused"; else bad "an unsupported release was accepted"; fi
said="$(ask "$VERSION_ID" 25.0.0 130)"
if [ "${said%%$'\n'*}" = NO ]; then ok "an old Docker is refused"; else bad "an old Docker was accepted"; fi
said="$(ask "$VERSION_ID" 27.0.0 '')"
if [ "${said%%$'\n'*}" = OK ]; then ok "no Chrome is a note, not a refusal"; else bad "no Chrome was treated as a refusal"; fi

echo
echo "### what silence means depends on how old this installation is"
decide() { (cd "$APP" && "$NODE" "$TSX" packaging/preflight.mts --decide "$1" "$2" 2>&1); }
said="$(decide 2 no-manifest)"
if [ "${said%%$'\n'*}" = GO ]; then ok "an installation from before the gate carries on"; else bad "a legacy installation was refused: $said"; fi
said="$(decide 3 no-manifest)"
if [ "${said%%$'\n'*}" = NO ]; then ok "a current installation refuses"; else bad "a current installation carried on: $said"; fi
said="$(decide 3 crashed)"
if [ "${said%%$'\n'*}" = NO ]; then ok "a crashed gate refuses"; else bad "a crashed gate carried on"; fi

echo
echo "### purge keeps the owner's data"
as_owner 'mkdir -p ~/.local/share/ai17z && printf "a thing the owner made\n" > ~/.local/share/ai17z/owner.txt' >/dev/null
sudo apt-get purge -y -qq ai17z >/dev/null 2>&1
if [ -d /usr/lib/ai17z ]; then bad "purge left the program behind"; else ok "the program is gone"; fi
if sudo -u owner test -f /home/owner/.local/share/ai17z/owner.txt; then
  ok "the owner's file is still there"
else
  bad "purge took the owner's data with it"
fi

echo
echo "  package: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
