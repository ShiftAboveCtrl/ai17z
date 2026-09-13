#!/usr/bin/env bash
#
# Does the package this project publishes actually work on the Ubuntu it claims?
#
# @release-check-fixtures -- the `owner` and `installer` homes below belong to
# users these scripts create inside a disposable container. They are nobody's.
#
#   prove-ubuntu-release.sh <path/to/ai17z_<version>_amd64.deb>
#
# Run inside a bare `ubuntu:<release>` container, once per release in the
# supported matrix. A support claim in a document is not evidence; this is the
# evidence. If a release genuinely cannot run the package, the honest options
# are to fix the package or to stop claiming the release -- never to leave the
# claim standing and the test out.
#
# Nothing here needs a screen, Docker, or a network beyond apt. Everything that
# does is proven on the hosted runners instead.
set -uo pipefail

DEB="${1:?a .deb to install}"

pass=0; fail=0
ok()  { printf '  ok    %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  FAIL  %s\n' "$1"; fail=$((fail+1)); }

. /etc/os-release
echo "### Ubuntu ${VERSION_ID} (${VERSION_CODENAME:-?}), $(dpkg --print-architecture)"

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null 2>&1
# Only what the installer itself needs. Installing more would hide a missing
# dependency, which is exactly the thing an older release is most likely to have.
apt-get install -y -qq sudo curl ca-certificates file >/dev/null 2>&1

echo
echo "### the package installs, with only its declared dependencies"
if apt-get install -y -qq "$DEB" >/tmp/install.log 2>&1; then
  ok "installed"
else
  bad "would not install"
  sed 's/^/        /' /tmp/install.log | tail -25
  echo
  echo "  $pass passed, $fail failed"
  exit 1
fi

echo
echo "### the bundled runtime, on this release's libc"
NODE=/usr/lib/ai17z/runtime/node/bin/node
# The thing most likely to break on an older Ubuntu: Node is built against a
# glibc floor, and a release older than that floor gets "GLIBC_2.xx not found"
# at exec time rather than at install time.
if out="$("$NODE" --version 2>&1)"; then
  ok "node runs: $out"
else
  bad "the bundled node will not run here"
  printf '        %s\n' "$out"
  printf '        this release: %s\n' "$(ldd --version 2>&1 | head -1)"
fi

if out="$("$NODE" -p 'process.arch + " " + process.platform' 2>&1)"; then
  ok "node reports: $out"
else
  bad "node could not report its own architecture"
fi

echo
echo "### TypeScript transforms, which every npm script an installed copy runs needs"
if out="$("$NODE" /usr/lib/ai17z/app/node_modules/tsx/dist/cli.mjs -e 'const n: number = 1; console.log(`tsx ok ${n}`)' 2>&1)"; then
  ok "tsx: $out"
else
  bad "tsx will not run here"
  printf '%s\n' "$out" | sed 's/^/        /' | head -10
fi

echo
echo "### esbuild's native binary"
ESBUILD="$(find /usr/lib/ai17z/app/node_modules/@esbuild -type f -name esbuild -perm -u+x 2>/dev/null | head -1)"
if [ -n "$ESBUILD" ] && out="$("$ESBUILD" --version 2>&1)"; then
  ok "esbuild: $out"
else
  bad "esbuild will not run here"
fi

echo
echo "### the shared modules the updater and the runtime import"
if out="$(cd /usr/lib/ai17z/app && "$NODE" node_modules/tsx/dist/cli.mjs -e '
  import { preflight, INSTALL_LAYOUT_SCHEMA } from "@xbam/shared";
  if (typeof preflight !== "function") throw new Error("preflight is not callable");
  console.log(`schema ${INSTALL_LAYOUT_SCHEMA}`);
' 2>&1)"; then
  ok "@xbam/shared loads: $out"
else
  bad "@xbam/shared will not load here"
  printf '%s\n' "$out" | sed 's/^/        /' | head -10
fi

echo
echo "### the launcher, as an ordinary person"
id -u owner >/dev/null 2>&1 || useradd -m -s /bin/bash owner
if out="$(su owner -c 'ai17z version' 2>&1)"; then
  if [ "$out" = "${WANT_VERSION:-$out}" ]; then ok "version: $out"; else bad "version says $out, wanted ${WANT_VERSION:-?}"; fi
else
  bad "the launcher would not run"
  printf '%s\n' "$out" | sed 's/^/        /' | head -6
fi

if su owner -c 'ai17z wibble' >/dev/null 2>&1; then
  bad "an unknown command was accepted"
else
  ok "an unknown command is refused"
fi

echo
echo "### root is refused"
if ai17z version >/dev/null 2>&1; then
  bad "the launcher ran as root"
else
  ok "refused"
fi

echo
echo "### XDG layout, created private, overrides honoured"
su owner -c 'ai17z doctor' >/tmp/doctor.txt 2>&1 || true
for dir in .config/ai17z .local/share/ai17z .local/state/ai17z; do
  if [ -d "/home/owner/$dir" ]; then
    mode="$(stat -c '%a' "/home/owner/$dir")"
    if [ "$mode" = 700 ]; then ok "$dir is 700"; else bad "$dir is $mode"; fi
  else
    bad "$dir was not created"
  fi
done
su owner -c 'XDG_CONFIG_HOME=/tmp/xc ai17z doctor >/dev/null 2>&1 || true'
if [ -d /tmp/xc/ai17z ]; then ok "XDG_CONFIG_HOME is honoured"; else bad "XDG_CONFIG_HOME was ignored"; fi

echo
echo "### a machine with no screen is a server, not a broken desktop"
if grep -qiE 'not available|unavailable' /tmp/doctor.txt; then
  ok "browser support reported as not available"
else
  bad "doctor did not report browser support as unavailable"
  sed 's/^/        /' /tmp/doctor.txt | head -20
fi

echo
echo "### the compatibility gate runs here"
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
ask() { (cd /usr/lib/ai17z/app && "$NODE" node_modules/tsx/dist/cli.mjs \
  packaging/preflight.mts /tmp/manifest.json ubuntu x64 "$@" 2>&1); }

said="$(ask "$VERSION_ID" 27.0.0 130)"
if [ "${said%%$'\n'*}" = OK ]; then ok "this release is accepted"; else bad "this release was not accepted: ${said%%$'\n'*}"; fi
said="$(ask 18.04 27.0.0 130)"
if [ "${said%%$'\n'*}" = NO ]; then ok "an unsupported release is refused"; else bad "an unsupported release was not refused"; fi

echo
echo "### removal keeps the owner's data"
su owner -c 'printf "a thing the owner made\n" > ~/.local/share/ai17z/owner.txt'
if apt-get purge -y -qq ai17z >/dev/null 2>&1; then
  if [ -d /usr/lib/ai17z ]; then bad "purge left the program behind"; else ok "the program is gone"; fi
  if [ -f /home/owner/.local/share/ai17z/owner.txt ]; then ok "the owner's data is not"; else bad "purge took the owner's data"; fi
else
  bad "purge failed"
fi

echo
echo "  Ubuntu ${VERSION_ID}: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
