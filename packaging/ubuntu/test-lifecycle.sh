#!/usr/bin/env bash
#
# What `ai17z <command>` does on a machine with no Docker and no screen.
#
#   docker run --rm -v "$PWD:/repo:ro" -w /repo ubuntu:24.04 bash /repo/packaging/ubuntu/test-lifecycle.sh
#
# A container is a server: no graphical session, no Chrome, and here no Docker
# either. That is not a broken machine -- it is the ordinary Ubuntu Server case,
# and the whole point is that AI17Z says so in those words rather than failing.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 1

pass=0; fail=0
ok()  { printf '  ok    %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  FAIL  %s\n' "$1"; fail=$((fail+1)); }
says() { # name output pattern
  if printf '%s' "$2" | grep -qi -- "$3"; then ok "$1"; else
    bad "$1"; printf '        wanted /%s/, got:\n' "$3"; printf '%s\n' "$2" | sed 's/^/        /' | head -6; fi
}

apt-get update -qq >/dev/null 2>&1
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates xz-utils sudo >/dev/null 2>&1

VERSION="${VERSION:-1.0.0-beta.16}"
NODE_VERSION="${NODE_VERSION:-v22.23.2}"
ARCH="$(dpkg --print-architecture)"

# A stand-in payload with the real scripts in it. What is under test is the
# lifecycle, not the application.
STAGE=/tmp/stage
rm -rf "$STAGE"; mkdir -p "$STAGE/packaging/ubuntu" "$STAGE/packaging/unix" "$STAGE/packaging/windows" "$STAGE/node_modules"
cp packaging/ubuntu/ai17z packaging/ubuntu/ai17z.desktop packaging/ubuntu/postinst \
   packaging/ubuntu/postrm packaging/ubuntu/ai17z-lifecycle.sh packaging/ubuntu/ai17z-update.sh "$STAGE/packaging/ubuntu/"
cp packaging/unix/ai17z-paths.sh "$STAGE/packaging/unix/"
cp packaging/windows/ai17z-256.png "$STAGE/packaging/windows/" 2>/dev/null || true
cp LICENSE README.md docker-compose.yml "$STAGE/" 2>/dev/null || true
printf '{"version":"%s","name":"AI17Z Beta 1.0.0 (16)"}\n' "$VERSION" > "$STAGE/BUILD_INFO.json"
printf '#!/usr/bin/env bash\necho setup ran\n' > "$STAGE/install-ai17z.sh"
printf '#!/usr/bin/env bash\necho "doctor ran for $AI17Z_ENV_FILE"\n' > "$STAGE/doctor-ai17z.sh"
chmod +x "$STAGE"/*.sh

bash packaging/ubuntu/build-deb.sh --stage "$STAGE" --version "$VERSION" --arch "$ARCH" \
  --node "$NODE_VERSION" --out /tmp/out >/dev/null 2>&1 || { echo "FAIL: package would not build"; exit 1; }
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "/tmp/out/ai17z_${VERSION}_${ARCH}.deb" >/dev/null 2>&1
id -u owner >/dev/null 2>&1 || useradd -m -s /bin/bash owner

as_owner() { su owner -c "$1" 2>&1; }

echo "### the commands exist and do not need a working machine to explain themselves"
says "help lists every command"      "$(as_owner 'ai17z --help')" "ai17z status"
says "version reads BUILD_INFO"      "$(as_owner 'ai17z version')" "$VERSION"
says "node is the bundled one"       "$(as_owner 'ai17z node --version')" "$NODE_VERSION"
says "an unknown command is refused" "$(as_owner 'ai17z wibble')" "Unknown command"

echo
echo "### a server has no Docker here, and is told so rather than crashing"
out="$(as_owner 'ai17z start')"
# Either branch is correct and which one depends on whether the CLI happens to
# be present. What must hold is that it stops on Docker, says so, and gives an
# action -- rather than starting half a stack or crashing.
says "start stops on Docker"         "$out" "Docker is not installed\|Docker is installed but not answering"
says "and says what to do about it"  "$out" "docs.docker.com\|systemctl start docker"

echo
echo "### status works without Docker, and names what is unavailable"
out="$(as_owner 'ai17z status')"
says "status reports the version"    "$out" "$VERSION"
says "browser support unavailable"   "$out" "not available"

echo
echo "### doctor is reached, with this installation's own environment file"
says "doctor runs against the owner's config" "$(as_owner 'ai17z doctor')" "[.]config/ai17z/[.]env$"

echo
echo "### uninstall explains before it removes, and keeps data by default"
out="$(as_owner 'ai17z uninstall')"
says "it names where the data stays" "$out" "[.]config/ai17z"
says "it does not remove it"         "$out" "apt remove ai17z"
if su owner -c 'test -d ~/.config/ai17z'; then ok "the data directory survived"; else bad "uninstall removed data by default"; fi

echo
echo "### the update refuses a downgrade and never touches data to find out"
printf '{"version":"99.0.0","name":"AI17Z 99"}\n' > /usr/lib/ai17z/app/BUILD_INFO.json
out="$(as_owner 'ai17z update --check' || true)"
says "a newer installed version is not downgraded" "$out" "not newer\|newest release"
printf '{"version":"%s","name":"AI17Z Beta 1.0.0 (16)"}\n' "$VERSION" > /usr/lib/ai17z/app/BUILD_INFO.json

echo
echo "### root is refused everywhere, not only at the front door"
says "the launcher refuses root" "$(ai17z start 2>&1 || true)" "runs as you, not as root"

echo
printf '  %s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
