#!/usr/bin/env bash
#
# Run a command as an ordinary person on this machine, the way a stranger who
# installs AI17Z is one.
#
#   as-stranger.sh <command> [args...]
#
# A CI job runs as root in a container, and the installers refuse root, as
# they should: nobody installs AI17Z as root. So this makes the account a real
# installation has, with sudo, and hands the command to it, keeping the CI
# variables that say which project and release this is.
set -euo pipefail

id -u stranger >/dev/null 2>&1 || useradd -m -s /bin/bash stranger
echo 'stranger ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/stranger
chmod 0440 /etc/sudoers.d/stranger
# The checkout is root's; the stranger reads it and works in its own home.
chmod -R a+rX "${GITHUB_WORKSPACE:-$PWD}"

exec sudo -u stranger -H \
  env GITHUB_REPOSITORY="${GITHUB_REPOSITORY:-}" GITHUB_SERVER_URL="${GITHUB_SERVER_URL:-}" \
      DOCKER_HOST="${DOCKER_HOST:-}" \
      PATH="/usr/local/bin:/usr/bin:/bin" \
  "$@"
