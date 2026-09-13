#!/usr/bin/env bash
#
# What the Ubuntu installer refuses, and why.
#
#   docker run --rm -v "$PWD:/repo:ro" -w /repo ubuntu:24.04 bash /repo/packaging/ubuntu/test-installer.sh
#
# Every case here stops before the network. They are the decisions that protect
# somebody from a half-installed machine, and each one has to be reachable
# without a release existing.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 1
REPO="$PWD"
INSTALLER="$REPO/install-ai17z-ubuntu.sh"

pass=0; fail=0
ok()  { printf '  ok    %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  FAIL  %s\n' "$1"; fail=$((fail+1)); }

# What the installer checks for before it checks anything interesting: sudo,
# then curl. A bare ubuntu image has neither, so without this the run stops at
# "sudo is not installed" and every case below it reports a refusal that is real
# but is not the one being tested.
#
# This file used to pass only when something else had installed them first --
# test-lifecycle.sh does, and running the two in one container hid it. A suite
# whose result depends on what ran before it will one day say "passed" about
# code nobody exercised.
apt-get update -qq >/dev/null 2>&1
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq sudo curl ca-certificates >/dev/null 2>&1
for tool in sudo curl sha256sum; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "FAIL: this container has no ${tool}, so nothing below would be testing what it says"
    exit 1
  }
done

# The installer reads /etc/os-release directly, which a test cannot replace. So
# a copy is made with that one read pointed at a fixture, and nothing else about
# it is changed. Done here, as root, because the sandbox is not writable by the
# unprivileged user the cases actually run as.
make_runner() { # room
  sed "s#^\. /etc/os-release#. \"$1/os-release\"#; s#^\[ -r /etc/os-release \]#[ -r \"$1/os-release\" ]#" \
    "$INSTALLER" > "$1/installer.sh"
  chmod 0755 "$1/installer.sh"
}

# An unprivileged user, because every check after the first one is behind the
# root refusal. Running the whole suite as root would prove only that one works.
id -u tester >/dev/null 2>&1 || useradd -m -s /bin/bash tester

run_case() { # name os_release expect_pattern [as_root]
  local name="$1" body="$2" want="$3" as_root="${4:-}"
  local room; room="$(mktemp -d)"; chmod 755 "$room"
  printf '%s\n' "$body" > "$room/os-release"
  make_runner "$room"
  chmod -R a+rX "$room"
  local out code
  if [ -n "$as_root" ]; then
    out="$(bash "$room/installer.sh" 2>&1)"
  else
    out="$(su tester -c "bash '$room/installer.sh'" 2>&1)"
  fi
  code=$?
  if [ "$code" -eq 0 ]; then
    bad "$name (exited 0; it should have refused)"
  elif printf '%s' "$out" | grep -qi "$want"; then
    ok "$name"
  else
    bad "$name"
    printf '        wanted /%s/, got:\n' "$want"
    printf '%s\n' "$out" | sed 's/^/        /' | head -6
  fi
  rm -rf "$room"
}

UBUNTU_2404='NAME="Ubuntu"
ID=ubuntu
VERSION_ID="24.04"
VERSION_CODENAME=noble
UBUNTU_CODENAME=noble
PRETTY_NAME="Ubuntu 24.04.1 LTS"'

echo "### refusals that protect somebody from a half-installed machine"

run_case "refuses to run as root" "$UBUNTU_2404" "as yourself, not with sudo" root

run_case "refuses an unsupported Ubuntu" 'NAME="Ubuntu"
ID=ubuntu
VERSION_ID="20.04"
VERSION_CODENAME=focal
PRETTY_NAME="Ubuntu 20.04 LTS"' "supports Ubuntu 22.04, 24.04, 26.04"

run_case "refuses a derivative rather than guessing" 'NAME="Linux Mint"
ID=linuxmint
ID_LIKE=ubuntu
VERSION_ID="21"
PRETTY_NAME="Linux Mint 21"' "built and tested for Ubuntu"

# An os-release that names nothing leaves ID empty, which lands in the same
# refusal a derivative gets: this is not Ubuntu as far as anything can tell.
run_case "refuses a machine it cannot identify" '' "built and tested for Ubuntu"

echo
echo "### the release tag is checked before it becomes a URL"
room="$(mktemp -d)"; chmod 755 "$room"; printf '%s\n' "$UBUNTU_2404" > "$room/os-release"
make_runner "$room"; chmod -R a+rX "$room"
out="$(su tester -c "bash '$room/installer.sh' --release not-a-version" 2>&1)"
if printf '%s' "$out" | grep -qi "not a release version\|as yourself"; then
  ok "a tag that is not a version is refused before any request"
else
  bad "a tag that is not a version was not refused"; printf '%s\n' "$out" | head -4 | sed 's/^/        /'
fi
rm -rf "$room"

echo
echo "### the allow-list is real"
if grep -q 'ALLOWED_HOSTS="api.github.com github.com objects.githubusercontent.com release-assets.githubusercontent.com"' "$INSTALLER"; then
  ok "only GitHub's own hosts are reachable"
else
  bad "the host allow-list changed shape"
fi
# Comments are where the reasons live, and several of them name the thing being
# avoided. Only lines that would actually run are searched.
code_of() { grep -vE '^[[:space:]]*#' "$INSTALLER"; }
for forbidden in 'get.docker.com' 'apt-key' -- '--no-sandbox' 'spctl' 'ufw '; do
  [ "$forbidden" = "--" ] && continue
  if code_of | grep -q -- "$forbidden"; then
    bad "the installer runs $forbidden"
  else
    ok "never runs $forbidden"
  fi
done
if code_of | grep -q 'accept-license\|--accept-'; then
  bad "the installer accepts a vendor licence on somebody's behalf"
else
  ok "no vendor licence is accepted for the owner"
fi
if grep -q 'usermod -aG docker' "$INSTALLER" && grep -q 'equivalent to root' "$INSTALLER"; then
  ok "the docker group is explained before it is offered"
else
  bad "the docker group is added without explaining what it grants"
fi
if grep -q 'sha256sum' "$INSTALLER" && grep -q 'does not match its published SHA-256' "$INSTALLER"; then
  ok "the package is checked before it is installed"
else
  bad "no checksum gate"
fi
if grep -q 'dpkg --compare-versions' "$INSTALLER"; then
  ok "a downgrade is refused rather than attempted"
else
  bad "nothing refuses a downgrade"
fi

echo
printf '  %s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
