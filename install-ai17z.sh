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

# Where this installation's data is. One resolver, shared with every other
# shipped script: AI17Z_ENV_FILE, then data-location.txt beside the program,
# then the .env beside this script for a checkout.
if [ -f "$(dirname "${BASH_SOURCE[0]:-$0}")/packaging/unix/ai17z-paths.sh" ]; then
  # shellcheck source=packaging/unix/ai17z-paths.sh
  . "$(dirname "${BASH_SOURCE[0]:-$0}")/packaging/unix/ai17z-paths.sh"
  ai17z_resolve_paths "$(dirname "${BASH_SOURCE[0]:-$0}")"
else
  echo "  packaging/unix/ai17z-paths.sh is missing from this installation." >&2
  exit 1
fi


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
if [ -f "$AI17Z_ENV_FILE" ]; then
  done_ ".env already exists, leaving it alone."
  warn "It holds the key your stored provider credentials are encrypted with."
else
  step "Creating .env with a fresh master key..."
  [ -f "$AI17Z_APP_DIR/.env.example" ] || stop_with_reason \
    ".env.example is missing." \
    "This installation looks incomplete. Install AI17Z again."

  # The directory first, and private before anything is written into it: the
  # first thing this file holds is the key every stored provider credential is
  # sealed with.
  mkdir -p "$AI17Z_DATA_DIR"
  chmod 700 "$AI17Z_DATA_DIR" 2>/dev/null || true

  # Generated here, never shipped. Every installation gets its own.
  key="$(head -c 32 /dev/urandom | base64 | tr -d '\n')"

  # The database password, likewise. A packaged installation publishes Postgres
  # on a loopback port, and a shipped default password would be the same one on
  # every machine that ever installed AI17Z.
  dbpass="$(head -c 24 /dev/urandom | base64 | tr -d '\n=+/' | head -c 32)"

  umask 077
  if grep -qE '^[[:space:]]*#?[[:space:]]*AI17Z_MASTER_KEY[[:space:]]*=' "$AI17Z_APP_DIR/.env.example"; then
    sed -E "s|^[[:space:]]*#?[[:space:]]*AI17Z_MASTER_KEY[[:space:]]*=.*|AI17Z_MASTER_KEY=${key}|" \
      "$AI17Z_APP_DIR/.env.example" > "$AI17Z_ENV_FILE"
  else
    cp "$AI17Z_APP_DIR/.env.example" "$AI17Z_ENV_FILE"
    printf '\nAI17Z_MASTER_KEY=%s\n' "$key" >> "$AI17Z_ENV_FILE"
  fi

  # Written once, and only into a new file. Regenerating either of these on an
  # update points a working installation at an empty database, which looks
  # exactly like having lost everything.
  if ! grep -qE '^[[:space:]]*POSTGRES_PASSWORD[[:space:]]*=[[:space:]]*[^[:space:]]' "$AI17Z_ENV_FILE"; then
    {
      echo
      echo "# This installation's own database password. Generated once."
      echo "POSTGRES_PASSWORD=$dbpass"
    } >> "$AI17Z_ENV_FILE"
  fi
  chmod 600 "$AI17Z_ENV_FILE" 2>/dev/null || true

  # Named after the folder it was installed into: the compose project name
  # decides which volumes an installation uses, and defaulting it to `xbam` for
  # everybody meant two checkouts silently shared one database and one signed-in
  # browser profile. Only ever written into a new .env, so updating in place
  # keeps the name -- and the data -- it already had.
  folder="$(basename "${AI17Z_INSTANCE_NAME:-$AI17Z_DATA_DIR}" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | sed 's/^-//;s/-$//')"
  [ -n "$folder" ] || folder="ai17z"
  if ! grep -qE '^[[:space:]]*AI17Z_INSTANCE[[:space:]]*=[[:space:]]*[^[:space:]]' "$AI17Z_ENV_FILE"; then
    {
      echo
      echo "# This installation's own Docker volumes and container names."
      echo "AI17Z_INSTANCE=$folder"
    } >> "$AI17Z_ENV_FILE"
  fi

  done_ ".env created. This installation is named '$folder'."
  warn "Its database and browser profiles are its own; no other checkout shares them."
  warn "Back it up. Losing the master key makes every stored provider credential unreadable."
fi

# -- Dependencies ------------------------------------------------------------
#
# A package brought its own, and must not be told to fetch them again.
#
# `BUILD_INFO.json` sits beside this script in a package and exists in no
# checkout, so it is the one honest way to tell the two apart. Reported from a
# real Mac: the first launch of an installed copy ran `npm install`, which died
# with
#
#     Cannot find module 'node-gyp/bin/node-gyp.js'
#
# because the build prunes node-gyp from the bundled runtime -- and npm resolves
# it before running any script at all, whether or not anything native is being
# built. The installation was complete and correct; the step that failed was one
# that should never have run. A packaged copy ships its node_modules, and
# reaching the network to reconcile them against package.json on somebody's
# machine is a different program from the one this is.
PACKAGED=0
[ -f "$(dirname "${BASH_SOURCE[0]:-$0}")/BUILD_INFO.json" ] && PACKAGED=1

if [ "${1:-}" = "--skip-install" ]; then
  warn "Skipping npm install, as asked."
elif [ "$PACKAGED" = "1" ]; then
  done_ "Dependencies came with this installation."
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
