#!/usr/bin/env bash
#
# What the macOS package is made of, checked on whatever machine is available.
#
#   docker run --rm -v "$PWD:/repo:ro" -w /repo ubuntu:24.04 bash /repo/packaging/macos/test-tarball.sh
#
# This is packaging, not behaviour. It builds the real tarball with the real
# script -- including fetching and verifying Node's darwin binaries against
# nodejs.org -- and checks the shape of what comes out.
#
# What it deliberately does NOT prove, and no Linux machine can:
#
#   * that the Mach-O binaries run;
#   * anything about Gatekeeper, quarantine or Terminal's paste protection;
#   * Docker Desktop or Chrome behaviour on macOS.
#
# Those need a Mac and are marked BLOCKED in the release validation report.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 1

pass=0; fail=0
ok()  { printf '  ok    %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  FAIL  %s\n' "$1"; fail=$((fail+1)); }

apt-get update -qq >/dev/null 2>&1
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates file >/dev/null 2>&1

VERSION="${VERSION:-1.0.0-beta.16}"
NODE_VERSION="${NODE_VERSION:-v22.23.2}"

STAGE=/tmp/macstage
rm -rf "$STAGE"; mkdir -p "$STAGE/packaging/macos" "$STAGE/packaging/unix" "$STAGE/node_modules"
cp packaging/macos/ai17z packaging/macos/ai17z-lifecycle.sh packaging/macos/ai17z-update.sh "$STAGE/packaging/macos/"
cp packaging/unix/ai17z-paths.sh "$STAGE/packaging/unix/"
cp packaging/preflight.mts "$STAGE/packaging/"
cp LICENSE "$STAGE/"
printf '{"version":"%s","name":"AI17Z Beta 1.0.0 (16)"}\n' "$VERSION" > "$STAGE/BUILD_INFO.json"
# A file with the executable bit set for no reason, to prove permissions are
# taken from what a file is rather than from what the build host said.
printf 'not a program\n' > "$STAGE/NOTES.md"; chmod 0777 "$STAGE/NOTES.md"

for ARCH in arm64 x64; do
  echo "### ${ARCH}"
  if bash packaging/macos/build-tarball.sh --stage "$STAGE" --version "$VERSION" \
       --arch "$ARCH" --node "$NODE_VERSION" --out /tmp/macout >/tmp/build-$ARCH.log 2>&1; then
    ok "the ${ARCH} package builds"
  else
    bad "the ${ARCH} package would not build"; tail -6 /tmp/build-$ARCH.log | sed 's/^/        /'; continue
  fi

  TAR="/tmp/macout/AI17Z-macos-${ARCH}-${VERSION}.tar.gz"
  [ -f "$TAR" ] && ok "named AI17Z-macos-${ARCH}-${VERSION}.tar.gz" || bad "wrong name"

  rm -rf /tmp/unpack; mkdir -p /tmp/unpack; tar -xzf "$TAR" -C /tmp/unpack
  R=/tmp/unpack/AI17Z
  for needed in ai17z app runtime/node/bin/node VERSION LICENSE; do
    [ -e "$R/$needed" ] && ok "carries $needed" || bad "missing $needed"
  done

  # The architecture is the whole reason two packages exist.
  SAYS="$(file -b "$R/runtime/node/bin/node")"
  case "$ARCH:$SAYS" in
    arm64:*arm64*) ok "the runtime really is arm64" ;;
    x64:*x86_64*)  ok "the runtime really is x86_64" ;;
    *) bad "the ${ARCH} package carries a ${SAYS} runtime" ;;
  esac

  [ -x "$R/ai17z" ] && ok "the launcher is executable" || bad "the launcher is not executable"
  if [ -x "$R/app/NOTES.md" ]; then bad "a data file kept its executable bit"; else ok "permissions come from what a file is"; fi
  [ -e "$R/runtime/node/lib/node_modules/corepack" ] && bad "corepack shipped" || ok "no corepack"
  find "$R/runtime/node" -name '*.ps1' | grep -q . && bad "Windows shims shipped" || ok "no Windows shims"
  [ "$(cat "$R/VERSION")" = "$VERSION" ] && ok "VERSION says ${VERSION}" || bad "VERSION disagrees"
done

echo
echo "### the checksum gate"
if bash packaging/macos/build-tarball.sh --stage "$STAGE" --version "$VERSION" \
     --arch arm64 --node "v22.0.0-not-a-release" --out /tmp/macout2 >/dev/null 2>&1; then
  bad "a runtime that cannot be verified was accepted"
else
  ok "a runtime that cannot be verified stops the build"
fi

echo
echo "### the installer refuses what it should, before touching anything"
grep -q 'uname -s.*Darwin\|\[ "\$(uname -s)" = "Darwin" \]' install-ai17z-macos.sh \
  && ok "refuses a machine that is not a Mac" || bad "no Darwin check"
grep -q 'MIN_MACOS_MAJOR=13' install-ai17z-macos.sh \
  && ok "holds macOS to the floor Chrome sets" || bad "no macOS version floor"
grep -q 'id -u.*!= "0"' install-ai17z-macos.sh \
  && ok "refuses to run as root" || bad "no root refusal"
code_of() { grep -vE '^[[:space:]]*#' install-ai17z-macos.sh; }
for forbidden in 'spctl' 'xattr -d' '--master-disable' 'codesign' 'sudo '; do
  if code_of | grep -q -- "$forbidden"; then bad "the installer runs $forbidden"; else ok "never runs $forbidden"; fi
done
grep -q 'not.*notarized\|not\*\* signed\|not signed' install-ai17z-macos.sh \
  && ok "says plainly that it is not signed or notarized" || bad "does not disclose signing status"

echo
echo "### nothing an owner made can reach a package"
# Planted where an unfiltered copy would pick them up. A deny-list is a promise
# to have thought of everything, and the thing nobody thinks of is the one that
# ships somebody's master key.
mkdir -p "$STAGE/apps/api/storage" "$STAGE/packages/secret"
printf 'AI17Z_MASTER_KEY=pretend-key\n' > "$STAGE/.env"
printf 'AI17Z_MASTER_KEY=pretend-key\n' > "$STAGE/packages/secret/.env"
printf 'a signed-in session\n' > "$STAGE/apps/api/storage/cookies"
printf 'keep me\n' > "$STAGE/.env.example"
bash packaging/macos/build-tarball.sh --stage "$STAGE" --version "$VERSION" \
  --arch arm64 --node "$NODE_VERSION" --out /tmp/macout3 >/dev/null 2>&1
rm -rf /tmp/unpack3; mkdir -p /tmp/unpack3
tar -xzf "/tmp/macout3/AI17Z-macos-arm64-${VERSION}.tar.gz" -C /tmp/unpack3
if find /tmp/unpack3 -name '.env' | grep -q .; then bad "a .env reached the package"; else ok "no .env anywhere in the package"; fi
if find /tmp/unpack3 -path '*/storage/*' | grep -q .; then bad "a storage directory reached the package"; else ok "no storage directory reached the package"; fi
if find /tmp/unpack3 -name '.env.example' | grep -q .; then ok ".env.example is kept, which the first run needs"; else bad ".env.example was filtered out; the first run cannot start without it"; fi
rm -f "$STAGE/.env" "$STAGE/packages/secret/.env"


echo
printf '  %s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
