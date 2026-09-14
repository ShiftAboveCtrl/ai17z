#!/usr/bin/env bash
#
# The real Ubuntu installer, against a package this run has just built.
#
# @release-check-fixtures -- the `owner` and `installer` homes below belong to
# users these scripts create inside a disposable container. They are nobody's.
#
#   prove-ubuntu-installer.sh <file.deb> <version> <arch>
#
# Not a rehearsal of what the installer does -- the installer itself, on a real
# machine, installing a real package. `--package` plus `--sha256` is the offline
# route it grew for exactly this: without it, the only way to exercise an
# installer is to publish a release first, which is what this whole workflow
# exists to stop.
#
# `--no-start` is passed because a hosted runner has no screen and bringing the
# whole stack up proves nothing the package tests have not already proved. What
# is under test here is the installer's own decisions: refusals, architecture,
# the hash, the install, and rerunning it.
#
# Nothing mocks AI17Z's own logic. The only thing stubbed is the answer to
# Docker's and Chrome's vendor prompts, and only by declining them: a hosted
# runner already has Docker, and installing Chrome there would be installing
# vendor software to test somebody else's installer.
set -uo pipefail

DEB="${1:?a .deb}"
VERSION="${2:?a version}"
ARCH="${3:?an architecture}"

INSTALLER="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/install-ai17z-ubuntu.sh"
SHA="$(sha256sum "$DEB" | awk '{print $1}')"

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

# An ordinary person, with sudo, which is what the documented route assumes.
id -u installer >/dev/null 2>&1 || sudo useradd -m -s /bin/bash installer
echo 'installer ALL=(ALL) NOPASSWD:ALL' | sudo tee /etc/sudoers.d/installer >/dev/null

# And able to reach Docker, which the owner of a real machine is and which this
# machine's own user already is.
#
# Without it the installer correctly stops at "Docker works for root but not for
# you", adds the user to the group, and says to log in again -- which is the
# right behaviour and leaves everything after that point untested. Adding the
# user to the group here is setting up the machine, not changing the installer.
# The group that actually owns the socket, not the one called "docker". They
# are usually the same and are not always: a socket bind-mounted from another
# machine carries that machine's group id.
DOCKER_GROUP=""
if [ -S /var/run/docker.sock ]; then
  DOCKER_GROUP="$(getent group "$(stat -c %g /var/run/docker.sock)" 2>/dev/null | cut -d: -f1)"
fi
[ -n "$DOCKER_GROUP" ] || DOCKER_GROUP="$(getent group docker >/dev/null 2>&1 && echo docker || echo '')"
if [ -n "$DOCKER_GROUP" ]; then
  sudo usermod -aG "$DOCKER_GROUP" installer
  echo "  installer is in the '$DOCKER_GROUP' group, which owns the docker socket"
else
  echo "  this machine has no docker group; the installer will say so itself"
fi
# Under its real name. The installer reads the version out of the filename --
# deliberately, so that a file somebody renamed cannot claim to be a version it
# is not -- and a harness that copies it to `package.deb` is testing the name
# check rather than the install.
NAME="ai17z_${VERSION}_${ARCH}.deb"
sudo cp "$DEB" "/tmp/$NAME"
sudo cp "$INSTALLER" /tmp/install-ai17z-ubuntu.sh
sudo chmod a+r "/tmp/$NAME" /tmp/install-ai17z-ubuntu.sh

# A correctly named copy whose bytes do not match the hash that will be claimed
# for it. The name check runs first and would otherwise be what refuses this,
# which would leave the hash check untested -- and the hash check is the one
# that matters.
sudo mkdir -p /tmp/tampered
sudo cp "$DEB" "/tmp/tampered/$NAME"
printf 'not the same bytes\n' | sudo tee -a "/tmp/tampered/$NAME" >/dev/null
sudo chmod -R a+rX /tmp/tampered

INSTALLER_HOME="$(getent passwd installer | cut -d: -f6)"
# HOME named rather than left to `sudo -H`, which on a hosted runner did not
# take: the launcher ran as `installer` with HOME still pointing at the
# runner's own, and tried to create its XDG directories somewhere it could not
# write.
as_installer() {
  sudo -u installer -H env -u XDG_CONFIG_HOME -u XDG_DATA_HOME -u XDG_STATE_HOME -u XDG_CACHE_HOME \
    "HOME=$INSTALLER_HOME" bash -c "$1" 2>&1
}

echo "### the refusals, before anything is installed"

out="$(sudo -H bash /tmp/install-ai17z-ubuntu.sh --package "/tmp/$NAME" --sha256 "$SHA" --yes --no-start 2>&1)"
says "running the whole installer as root is refused" "$out" "as yourself, not with sudo"

out="$(as_installer "bash /tmp/install-ai17z-ubuntu.sh --package /tmp/$NAME --yes --no-start")"
says "--package without --sha256 is refused" "$out" "needs --sha256"

out="$(as_installer "bash /tmp/install-ai17z-ubuntu.sh --package /tmp/tampered/$NAME --sha256 $SHA --yes --no-start")"
says "a package whose bytes do not match its hash is refused" "$out" "does not match"
if dpkg-query -W -f='${Status}' ai17z 2>/dev/null | grep -q "install ok installed"; then
  bad "a package with the wrong hash was installed anyway"
else
  ok "and nothing was installed"
fi

out="$(as_installer "bash /tmp/install-ai17z-ubuntu.sh --package /tmp/nothing-here.deb --sha256 $SHA --yes --no-start")"
says "a package that is not there is refused" "$out" "no file at"

# A package for the other architecture, by name only: the check is on the name,
# and building a real one for the other architecture here is not possible.
other="$([ "$ARCH" = amd64 ] && echo arm64 || echo amd64)"
sudo cp "$DEB" "/tmp/ai17z_${VERSION}_${other}.deb"
sudo chmod a+r "/tmp/ai17z_${VERSION}_${other}.deb"
out="$(as_installer "bash /tmp/install-ai17z-ubuntu.sh --package /tmp/ai17z_${VERSION}_${other}.deb --sha256 $SHA --yes --no-start")"
says "a package for another architecture is refused" "$out" "not for this computer"

out="$(as_installer "bash /tmp/install-ai17z-ubuntu.sh --wibble")"
says "an unknown option is reported rather than ignored" "$out" "Unknown option"

echo
echo "### installing, for real"
out="$(as_installer "bash /tmp/install-ai17z-ubuntu.sh --package /tmp/$NAME --sha256 $SHA --yes --no-start")"
printf '%s\n' "$out" | sed 's/^/    /' | tail -40
if dpkg-query -W -f='${Status}' ai17z 2>/dev/null | grep -q "install ok installed"; then
  ok "ai17z is installed"
else
  bad "the installer did not install it"
fi
said="$(dpkg-query -W -f='${Version}' ai17z 2>/dev/null || echo '')"
if [ "$said" = "$VERSION" ]; then ok "the installed version is $said"; else bad "installed version is $said, wanted $VERSION"; fi
says "it said the hash matched" "$out" "SHA-256 matches"
says "it never accepted a vendor agreement" "$out" "AI17Z"
if printf '%s' "$out" | grep -qiE 'accept.*(licen[cs]e|terms|agreement)'; then
  bad "something accepted a vendor agreement"
else
  ok "no vendor agreement was accepted"
fi

echo
echo "### what the installed copy does"
out="$(as_installer 'ai17z version')"
if [ "$out" = "$VERSION" ]; then ok "the launcher reports $out"; else bad "the launcher reports '$out'"; fi

echo
echo "### running it again over the top"
out="$(as_installer "bash /tmp/install-ai17z-ubuntu.sh --package /tmp/$NAME --sha256 $SHA --yes --no-start")"
if dpkg-query -W -f='${Status}' ai17z 2>/dev/null | grep -q "install ok installed"; then
  ok "the same version installs again without complaint"
else
  bad "a second run broke the installation"
  printf '%s\n' "$out" | tail -20 | sed 's/^/        /'
fi

echo
echo "### a downgrade is refused rather than attempted"
# The name carries the version, so an older name over a newer installation is
# the case. apt would take it, and an older application against a database it
# has already migrated is a failure with no good ending.
sudo cp "$DEB" /tmp/ai17z_0.0.1_${ARCH}.deb
sudo chmod a+r /tmp/ai17z_0.0.1_${ARCH}.deb
older_sha="$(sha256sum /tmp/ai17z_0.0.1_${ARCH}.deb | awk '{print $1}')"
out="$(as_installer "bash /tmp/install-ai17z-ubuntu.sh --package /tmp/ai17z_0.0.1_${ARCH}.deb --sha256 $older_sha --yes --no-start")"
says "an older version over a newer one is refused" "$out" "not newer"
said="$(dpkg-query -W -f='${Version}' ai17z 2>/dev/null || echo '')"
if [ "$said" = "$VERSION" ]; then ok "and the newer one is still installed"; else bad "the installation is now $said"; fi

echo
echo "### the owner's data outlives the program"
as_installer 'mkdir -p ~/.local/share/ai17z && printf "a thing the owner made\n" > ~/.local/share/ai17z/owner.txt' >/dev/null
sudo apt-get purge -y -qq ai17z >/dev/null 2>&1
if [ -d /usr/lib/ai17z ]; then bad "purge left the program behind"; else ok "the program is gone"; fi
if sudo -u installer test -f "$INSTALLER_HOME"/.local/share/ai17z/owner.txt; then
  ok "the owner's file is still there"
else
  bad "purge took the owner's data with it"
fi

sudo rm -f /etc/sudoers.d/installer
echo
[ "$fail" -eq 0 ] || printf '\n  what failed:%b\n' "$failures"
echo "  installer: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
