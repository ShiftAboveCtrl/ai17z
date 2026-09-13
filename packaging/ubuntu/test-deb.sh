#!/usr/bin/env bash
# Builds and exercises the AI17Z .deb on real Ubuntu.
#
# Run from the repository root, on a machine with Docker:
#
#   docker run --rm -v "$PWD:/repo:ro" -w /repo ubuntu:24.04 bash /repo/packaging/ubuntu/test-deb.sh
#
set -euo pipefail
cd /repo

VERSION="${VERSION:-1.0.0-beta.16}"
NODE_VERSION="${NODE_VERSION:-v22.23.2}"
ARCH="$(dpkg --print-architecture)"

echo "### environment: Ubuntu $(. /etc/os-release && echo "$VERSION_ID") / $ARCH"

apt-get update -qq >/dev/null
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates xz-utils lintian file >/dev/null
echo "### tools installed"

# A stand-in payload with the shape the real stage has.
STAGE=/tmp/stage
rm -rf "$STAGE"; mkdir -p "$STAGE/packaging/ubuntu" "$STAGE/packaging/windows" "$STAGE/apps" "$STAGE/node_modules"
cp packaging/ubuntu/ai17z packaging/ubuntu/ai17z.desktop packaging/ubuntu/postinst \
   packaging/ubuntu/postrm "$STAGE/packaging/ubuntu/"
cp packaging/windows/ai17z-256.png "$STAGE/packaging/windows/" 2>/dev/null || true
cp LICENSE README.md "$STAGE/"
printf '{"version":"%s","name":"AI17Z Beta 1.0.0 (16)"}\n' "$VERSION" > "$STAGE/BUILD_INFO.json"
for target in lifecycle update; do
  printf '#!/usr/bin/env bash\necho "ai17z %s ran: $1"\necho "env=$AI17Z_ENV_FILE"\necho "node=$AI17Z_RUNTIME_NODE"\n' "$target" \
    > "$STAGE/packaging/ubuntu/ai17z-$target.sh"
  chmod +x "$STAGE/packaging/ubuntu/ai17z-$target.sh"
done

# Taken from the launcher rather than from memory. The stub list used to be one
# script per command, which is what the launcher dispatched to before the
# lifecycle was consolidated into a single file. Nothing noticed, because every
# case after the install ran against a launcher that could not find anything and
# this file had no pass/fail accounting -- its exit code was whatever happened to
# run last.
for wanted in $(grep -o 'packaging/ubuntu/ai17z-[a-z]*\.sh' packaging/ubuntu/ai17z | sort -u); do
  [ -f "$STAGE/$wanted" ] || { echo "FAIL: the launcher execs $wanted and the stage has no such file"; exit 1; }
done

echo "### building the package"
bash packaging/ubuntu/build-deb.sh --stage "$STAGE" --version "$VERSION" --arch "$ARCH" \
  --node "$NODE_VERSION" --out /tmp/out

DEB="/tmp/out/ai17z_${VERSION}_${ARCH}.deb"
[ -f "$DEB" ] || { echo "FAIL: no package produced"; exit 1; }

echo
echo "### the checksum gate actually refuses a bad runtime"
if bash packaging/ubuntu/build-deb.sh --stage "$STAGE" --version "$VERSION" --arch "$ARCH" \
     --node "v22.0.0-not-a-release" --out /tmp/out2 >/tmp/bad.log 2>&1; then
  echo "FAIL: a nonexistent Node version was accepted"; exit 1
fi
echo "  ok    a runtime that cannot be verified stops the build"

echo
echo "### lintian"
lintian --no-tag-display-limit "$DEB" 2>&1 | sed 's/^/  /' || true
ERRORS="$(lintian "$DEB" 2>/dev/null | grep -c '^E:' || true)"
echo "  errors: ${ERRORS:-0}"

echo
echo "### contents and ownership"
dpkg-deb -c "$DEB" | awk '{print $1, $2, $6}' | grep -E "usr/bin/ai17z$|usr/lib/ai17z/runtime/node/bin/node$|desktop$|copyright$|changelog" | sed 's/^/  /'

echo
echo "### installing with apt, the way the installer does"
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$DEB" >/dev/null
echo "  installed: $(dpkg-query -W -f='${Package} ${Version} ${Architecture}' ai17z)"

echo
echo "### the bundled runtime is real, and is the right architecture"
/usr/lib/ai17z/runtime/node/bin/node --version
file -b /usr/lib/ai17z/runtime/node/bin/node | cut -c1-60

echo
echo "### it refuses to run as root"
if ai17z start >/tmp/root.log 2>&1; then
  echo "FAIL: ran as root"; cat /tmp/root.log; exit 1
fi
grep -q "runs as you, not as root" /tmp/root.log && echo "  ok    refused, with a reason"

echo
echo "### as an ordinary user"
useradd -m -s /bin/bash owner 2>/dev/null || true
# Checked rather than printed. The launcher reaching its lifecycle script is the
# one thing an installed package has to be able to do, and printing the failure
# without failing is how it went unnoticed through several releases.
if su - owner -c 'ai17z doctor' 2>&1 | tee /tmp/doctor.out | sed 's/^/  /'; then :; fi
if grep -q 'lifecycle ran' /tmp/doctor.out; then
  echo "  ok    the launcher reached its lifecycle script"
else
  echo "  FAIL  the installed launcher could not run a command"
  BROKEN=1
fi

echo
echo "### XDG layout, created as the user, and private"
su - owner -c 'stat -c "%a %U %n" ~/.config/ai17z ~/.local/share/ai17z ~/.local/state/ai17z' | sed 's/^/  /'

echo
echo "### XDG overrides are honoured"
su - owner -c 'XDG_CONFIG_HOME=/tmp/xc ai17z doctor >/dev/null && stat -c "%a %n" /tmp/xc/ai17z' | sed 's/^/  /'

echo
echo "### removing the package leaves the owner's data alone"
DEBIAN_FRONTEND=noninteractive apt-get purge -y -qq ai17z >/dev/null
[ -d /usr/lib/ai17z ] && { echo "FAIL: program files survived a purge"; exit 1; }
su - owner -c 'test -d ~/.config/ai17z && test -d ~/.local/share/ai17z' \
  && echo "  ok    purge removed the program and kept every owner directory"

echo
echo "### DONE"

echo
if [ "${BROKEN:-0}" = "1" ]; then
  echo "  something above failed"
  exit 1
fi
echo "  the package built, installed, ran and purged"
