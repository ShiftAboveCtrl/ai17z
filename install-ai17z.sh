#!/usr/bin/env bash
#
# Prepares this machine to run AI17Z.
#
# Checks what is needed, creates a configuration file with a freshly generated
# master key, and installs dependencies. It does not install Docker, Node or
# Chrome for you -- it says what is missing and where to get it, because
# silently installing software on somebody's machine is not a thing a setup
# script should do.
#
# Safe to run more than once. It never overwrites an existing .env, because that
# file holds the key your stored provider credentials are encrypted with.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

GREEN=$'\033[32m'; RED=$'\033[31m'; YELLOW=$'\033[33m'; CYAN=$'\033[36m'; GREY=$'\033[90m'; OFF=$'\033[0m'

step() { echo "  ${CYAN}$1${OFF}"; }
done_() { echo "  ${GREEN}$1${OFF}"; }
warn() { echo "  ${YELLOW}$1${OFF}"; }

stop_with_reason() { # message fix
  echo
  echo "  ${RED}$1${OFF}"
  [ -n "${2:-}" ] && echo "  ${YELLOW}$2${OFF}"
  echo
  exit 1
}

echo
echo "AI17Z setup"
echo

step "Checking what this machine has..."

command -v docker >/dev/null 2>&1 || stop_with_reason \
  "Docker is not installed." \
  "Install it: https://docs.docker.com/engine/install/ubuntu/ then run this again."

docker info >/dev/null 2>&1 || stop_with_reason \
  "Docker is installed but not reachable." \
  "Start it with 'sudo systemctl start docker', and add yourself to the docker group: 'sudo usermod -aG docker \$USER' then log out and back in."

done_ "Docker is running."

command -v node >/dev/null 2>&1 || stop_with_reason \
  "Node.js is not installed." \
  "AI17Z needs Node 22 or newer for the worker that drives Chrome. See https://nodejs.org."

node_major="$(node --version | sed 's/^v//' | cut -d. -f1)"
[ "$node_major" -ge 22 ] || stop_with_reason \
  "Node $(node --version) is too old." \
  "AI17Z needs Node 22 or newer."
done_ "Node $(node --version) is fine."

# Not fatal: everything except connecting an X account works without a browser,
# and somebody may be setting up before installing one.
chrome=""
for candidate in /usr/bin/google-chrome /usr/bin/google-chrome-stable /opt/google/chrome/chrome; do
  [ -x "$candidate" ] && chrome="$candidate" && break
done
if [ -n "$chrome" ]; then
  done_ "Google Chrome found: $("$chrome" --version 2>/dev/null | head -1)"
else
  warn "Google Chrome was not found."
  warn "AI17Z will install and run, but connecting an X account needs real Chrome."
  warn "Chromium is a different browser and is not used as a substitute."
fi

# -- Configuration -----------------------------------------------------------
if [ -f .env ]; then
  done_ ".env already exists, leaving it alone."
  warn "It holds the key your stored provider credentials are encrypted with."
else
  step "Creating .env with a fresh master key..."
  [ -f .env.example ] || stop_with_reason \
    ".env.example is missing." \
    "This checkout looks incomplete. Clone the repository again."

  # Generated here, never shipped. Every installation gets its own.
  key="$(head -c 32 /dev/urandom | base64 | tr -d '\n')"

  if grep -qE '^[[:space:]]*#?[[:space:]]*AI17Z_MASTER_KEY[[:space:]]*=' .env.example; then
    sed -E "s|^[[:space:]]*#?[[:space:]]*AI17Z_MASTER_KEY[[:space:]]*=.*|AI17Z_MASTER_KEY=${key}|" .env.example > .env
  else
    cp .env.example .env
    printf '\nAI17Z_MASTER_KEY=%s\n' "$key" >> .env
  fi

  done_ ".env created."
  warn "Back it up. Losing the master key makes every stored provider credential unreadable."
fi

# -- Dependencies ------------------------------------------------------------
if [ "${1:-}" = "--skip-install" ]; then
  warn "Skipping npm install, as asked."
else
  step "Installing dependencies (this takes a few minutes the first time)..."
  npm install || stop_with_reason \
    "npm install failed." \
    "The output above says why. A stale node_modules is the usual cause: remove it and run this again."
  done_ "Dependencies installed."
fi

echo
echo "  ${GREEN}Setup finished.${OFF}"
echo
# Started from here when asked, so somebody can install and run in one command
# rather than reading which script comes next. Both are idempotent.
if [ "${START_AFTER:-0}" = "1" ] || [ "${1:-}" = "--start" ]; then
  exec ./start-ai17z.sh
fi

echo "  Next:"
echo "    ${GREY}./start-ai17z.sh     start everything${OFF}"
echo "    ${GREY}./doctor-ai17z.sh    check it over${OFF}"
echo
