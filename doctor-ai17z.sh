#!/usr/bin/env bash
#
# Checks whether this machine can run AI17Z, and says what is missing.
#
# Three outcomes, deliberately distinguished:
#
#   PASS            it works
#   NOT CONFIGURED  it works, you have not set it up yet
#   FAIL            it is broken, and here is what to do
#
# A fresh installation with no X account and no AI provider is not broken. It is
# a fresh installation. Reporting that as an error is how somebody concludes the
# software does not work and stops.
#
# Reads only. Starts nothing, changes nothing.

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

GREEN=$'\033[32m'; RED=$'\033[31m'; YELLOW=$'\033[33m'; GREY=$'\033[90m'; OFF=$'\033[0m'
failures=(); todo=()

row() { # name status detail
  local colour="$GREY"
  case "$2" in
    PASS) colour="$GREEN" ;;
    FAIL) colour="$RED" ;;
    "NOT CONFIGURED"|"NOT RUNNING") colour="$YELLOW" ;;
  esac
  printf '  %-16s%s%-16s%s%s\n' "$1" "$colour" "$2" "$OFF" "${GREY}$3${OFF}"
}

env_value() { # key
  [ -f .env ] || return 0
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" .env | head -1 | tr -d '"' | tr -d "'"
}

echo
echo "AI17Z Doctor"
echo

instance="$(env_value AI17Z_INSTANCE)"
row "Instance" "INFO" "${instance:-xbam (default)}"

# -- Docker ------------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  row "Docker" "FAIL" "Not installed."
  failures+=("Docker: install it from docs.docker.com/engine/install/ubuntu/")
elif ! docker info >/dev/null 2>&1; then
  row "Docker" "FAIL" "Installed but not reachable."
  failures+=("Docker: start it with 'sudo systemctl start docker', and add yourself to the docker group.")
else
  row "Docker" "PASS" "Running."
  if docker compose version >/dev/null 2>&1; then
    row "Compose" "PASS" "Available."
  else
    row "Compose" "FAIL" "docker compose is not available."
    failures+=("Compose: install the docker-compose-plugin package.")
  fi
fi

# -- Node --------------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  row "Node" "FAIL" "Not installed."
  failures+=("Node: AI17Z needs Node 20 or newer for the worker that drives Chrome.")
else
  node_major="$(node --version | sed 's/^v//' | cut -d. -f1)"
  if [ "$node_major" -lt 20 ]; then
    row "Node" "FAIL" "$(node --version) is too old."
    failures+=("Node: AI17Z needs Node 20 or newer.")
  else
    row "Node" "PASS" "$(node --version)"
  fi
fi

# -- Configuration -----------------------------------------------------------
if [ -f .env ]; then
  row "Configuration" "PASS" ".env present."
else
  row "Configuration" "NOT CONFIGURED" "No .env file yet."
  todo+=("Configuration: run ./install-ai17z.sh, which creates one with a fresh master key.")
fi

master_key="$(env_value AI17Z_MASTER_KEY)"
[ -n "$master_key" ] || master_key="$(env_value XBAM_MASTER_KEY)"
if [ -z "$master_key" ]; then
  row "Master key" "NOT CONFIGURED" "Not set."
  todo+=("Master key: run ./install-ai17z.sh. Provider keys cannot be stored without one.")
else
  # Length only. The value is never printed and never logged.
  key_bytes="$(printf '%s' "$master_key" | base64 -d 2>/dev/null | wc -c || echo 0)"
  if [ "$key_bytes" -eq 32 ]; then
    row "Master key" "PASS" "Present, 32 bytes."
  else
    row "Master key" "FAIL" "Decodes to $key_bytes bytes, not 32."
    failures+=("Master key: replace it only if nothing is stored yet -- an existing key cannot be changed without losing every saved provider credential.")
  fi
fi

# -- Services ----------------------------------------------------------------
api_port="$(env_value AI17Z_API_PORT)"; api_port="${api_port:-8787}"
web_port="$(env_value AI17Z_WEB_PORT)"; web_port="${web_port:-8080}"

if curl -fsS -m 6 "http://localhost:${api_port}/api/health" >/dev/null 2>&1; then
  row "API" "PASS" "Answering on ${api_port}."
else
  row "API" "NOT RUNNING" "Nothing on ${api_port}."
  todo+=("API: run ./start-ai17z.sh.")
fi

if curl -fsS -m 6 "http://localhost:${web_port}" >/dev/null 2>&1; then
  row "Web" "PASS" "Serving on ${web_port}."
else
  row "Web" "NOT RUNNING" "Nothing on ${web_port}."
  todo+=("Web: run ./start-ai17z.sh.")
fi

# -- Native worker -----------------------------------------------------------
if [ -f storage/native-worker.pid ] && kill -0 "$(cat storage/native-worker.pid 2>/dev/null)" 2>/dev/null; then
  row "Native worker" "PASS" "Running. This is the one that can see Chrome."
else
  row "Native worker" "NOT RUNNING" "Not started."
  todo+=("Native worker: run ./start-ai17z.sh. Without it X accounts cannot be used -- a container cannot drive a browser on your machine.")
fi

# -- Google Chrome -----------------------------------------------------------
# Chromium is not Google Chrome, and AI17Z never substitutes one for the other.
chrome=""
for candidate in /usr/bin/google-chrome /usr/bin/google-chrome-stable /opt/google/chrome/chrome; do
  [ -x "$candidate" ] && chrome="$candidate" && break
done
if [ -n "$chrome" ]; then
  row "Google Chrome" "PASS" "$("$chrome" --version 2>/dev/null | head -1)"
else
  row "Google Chrome" "FAIL" "Not found."
  failures+=("Google Chrome: install the real thing from google.com/chrome. Chromium is a different browser and is not used as a substitute.")
fi

# -- Display -----------------------------------------------------------------
# Signing in to X means somebody types a password into a real window. Saying so
# here is better than letting an account connection fail mysteriously later.
if [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ]; then
  row "Display" "PASS" "${DISPLAY:-$WAYLAND_DISPLAY}"
else
  row "Display" "NOT CONFIGURED" "No display detected."
  todo+=("Display: connecting an X account opens a real Chrome window for you to sign in. On a headless server that needs a desktop session, X forwarding or a virtual display.")
fi

# -- Storage -----------------------------------------------------------------
profile_root="$(env_value XBAM_BROWSER_PROFILE_DIR)"
profile_root="${profile_root:-./storage/browser-profiles}"
if mkdir -p "$profile_root" 2>/dev/null && touch "$profile_root/.doctor-write-probe" 2>/dev/null; then
  rm -f "$profile_root/.doctor-write-probe"
  row "Storage" "PASS" "Writable: $profile_root"
else
  row "Storage" "FAIL" "Cannot write to $profile_root"
  failures+=("Storage: check permissions, or set XBAM_BROWSER_PROFILE_DIR to a writable location.")
fi

# -- Report ------------------------------------------------------------------
echo
if [ ${#failures[@]} -gt 0 ]; then
  echo "  ${RED}Needs fixing before AI17Z can run:${OFF}"
  for f in "${failures[@]}"; do echo "    ${YELLOW}${f}${OFF}"; done
  echo
  exit 1
fi

if [ ${#todo[@]} -gt 0 ]; then
  echo "  ${YELLOW}Nothing is broken. Still to do:${OFF}"
  for t in "${todo[@]}"; do echo "    ${GREY}${t}${OFF}"; done
  echo
  exit 0
fi

echo "  ${GREEN}AI17Z is ready.${OFF}"
echo
exit 0
