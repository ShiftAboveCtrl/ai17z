#!/usr/bin/env bash
#
# Make a bare Ubuntu job container able to build and prove AI17Z.
#
#   setup-ubuntu-job.sh
#
# A CI runner runs a Linux job inside the image it names, as root, with nothing in
# it. The packages AI17Z ships are for Ubuntu, so the jobs that build and prove
# them run on Ubuntu itself rather than on a Node image, which is Debian. Node
# is the version every package carries, from nodejs.org, checked against its
# published SHASUMS256.txt: the same rule the packages follow, because a build
# tool fetched unchecked is the one link nobody looks at.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
# sudo: the proofs act as a separate, ordinary owner account, which is what a
# real installation has, and switch to it with sudo.
# unzip: the publish job's privacy scan unpacks the Windows application zip.
apt-get install -y -qq --no-install-recommends ca-certificates curl xz-utils git jq sudo file unzip >/dev/null

VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\(v[0-9.]*\)".*/\1/p' packaging/node-runtime.json | head -1)"
[ -n "$VERSION" ] || { echo "packaging/node-runtime.json names no Node version"; exit 1; }
case "$(uname -m)" in
  x86_64) ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) echo "no Node for $(uname -m)"; exit 1 ;;
esac
NAME="node-${VERSION}-linux-${ARCH}.tar.xz"
WORK="$(mktemp -d)"
curl -fsSL --proto '=https' --tlsv1.2 -o "$WORK/$NAME" "https://nodejs.org/dist/${VERSION}/${NAME}"
curl -fsSL --proto '=https' --tlsv1.2 -o "$WORK/SHASUMS256.txt" "https://nodejs.org/dist/${VERSION}/SHASUMS256.txt"
EXPECTED="$(grep -E "  ${NAME}\$" "$WORK/SHASUMS256.txt" | awk '{print $1}')"
ACTUAL="$(sha256sum "$WORK/$NAME" | awk '{print $1}')"
[ -n "$EXPECTED" ] && [ "$EXPECTED" = "$ACTUAL" ] || { echo "Node $NAME does not match nodejs.org's published hash"; exit 1; }
tar -xJf "$WORK/$NAME" -C /usr/local --strip-components=1
rm -rf "$WORK"
echo "node $(node -v), npm $(npm -v), checked against nodejs.org"

# A job that runs the installer has a Docker engine beside it, the Docker-in-
# Docker service, reached through DOCKER_HOST: a real machine has a running
# engine and the installer rightly stops without one. The proofs act as an
# ordinary account through sudo, which resets the environment, so sudo is told
# to keep that one variable. Setting up the machine, not changing the installer.
if [ -n "${DOCKER_HOST:-}" ]; then
  echo 'Defaults env_keep += "DOCKER_HOST"' > /etc/sudoers.d/docker-host
  chmod 0440 /etc/sudoers.d/docker-host
  # And the client a machine with Docker has: the CLI and the Compose plugin,
  # from Ubuntu's own archive. A hosted VM came with both; a bare container has
  # neither, and the installer rightly refuses a Docker without Compose.
  apt-get install -y -qq --no-install-recommends docker.io docker-compose-v2 >/dev/null
  echo "Docker engine at $DOCKER_HOST: $(docker version --format '{{.Server.Version}}'), $(docker compose version --short)"
fi
