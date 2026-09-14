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
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1

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


GREEN=$'\033[32m'; RED=$'\033[31m'; YELLOW=$'\033[33m'; GREY=$'\033[90m'; OFF=$'\033[0m'
failures=(); todo=()

# Five states, because two of them lie.
#
#   PASS            it works
#   NOT CONFIGURED  it works, you have not set it up yet
#   NOT AVAILABLE   it cannot work here, and that is fine -- a server has no
#                   screen, and reporting that as a failure is how somebody
#                   concludes the software is broken when it is doing its job
#   NEEDS ACTION    you have to do something, and it says what
#   UNSUPPORTED     this machine is outside what AI17Z supports
#   FAIL            it is broken, and here is what to do
#
# Only FAIL and NEEDS ACTION are counted against the installation.
row() { # name status detail
  local colour="$GREY"
  case "$2" in
    PASS) colour="$GREEN" ;;
    FAIL|UNSUPPORTED) colour="$RED" ;;
    "NOT CONFIGURED"|"NOT RUNNING"|"NEEDS ACTION") colour="$YELLOW" ;;
    "NOT AVAILABLE") colour="$GREY" ;;
  esac
  printf '  %-18s%s%-16s%s%s\n' "$1" "$colour" "$2" "$OFF" "${GREY}$3${OFF}"
}

# What this machine is, and how AI17Z got here. Printed first, because every
# answer below is conditional on it and somebody reading a pasted report needs
# to know which platform produced it.
ai17z_platform() {
  case "$(uname -s)" in
    Darwin) printf 'macos' ;;
    Linux) printf 'ubuntu' ;;
    *) printf 'unknown' ;;
  esac
}

ai17z_os_description() {
  case "$(uname -s)" in
    Darwin) printf 'macOS %s' "$(sw_vers -productVersion 2>/dev/null || echo '?')" ;;
    Linux) if [ -r /etc/os-release ]; then
             ( . /etc/os-release && printf '%s' "${PRETTY_NAME:-Linux}" )
           else printf 'Linux'; fi ;;
    *) uname -s ;;
  esac
}

# Whether a browser could be driven here at all. A machine with no graphical
# session is not a broken desktop.
ai17z_has_screen() {
  case "$(uname -s)" in
    Darwin) launchctl print "gui/$(id -u)" >/dev/null 2>&1 ;;
    *) [ -n "${WAYLAND_DISPLAY:-}" ] || [ -n "${DISPLAY:-}" ] ;;
  esac
}

ai17z_chrome() {
  case "$(uname -s)" in
    Darwin)
      for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
               "$HOME/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; do
        [ -x "$c" ] && { printf '%s' "$c"; return 0; }
      done ;;
    *)
      for c in google-chrome google-chrome-stable; do
        command -v "$c" >/dev/null 2>&1 && { command -v "$c"; return 0; }
      done ;;
  esac
  return 1
}

env_value() { # key
  ai17z_env_value "$1" ""
}

echo
printf '  %sAI17Z%s\n\n' "$GREEN" "$OFF"

row "Machine" "PASS" "$(ai17z_os_description) ($(uname -m))"

# How this copy got here, and what it therefore updates with. Read from the
# marker beside the program; absent means a checkout, which is the honest answer
# rather than a guess.
# The launcher of a packaged installation says so outright, and on Ubuntu that
# is the only way it can: the program directory is root-owned, so nothing there
# is written by the person running this. A marker file beside the program is how
# Windows records it, and is read when there is one. Absent both, this is a
# checkout -- which is the honest answer rather than a guess.
_install_method="${AI17Z_INSTALL_CHANNEL:-}"
if [ -z "$_install_method" ] && [ -f "$AI17Z_APP_DIR/INSTALL_INFO.json" ]; then
  _install_method="$(sed -n 's/.*"\(channel\|installMethod\)"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\2/p' \
    "$AI17Z_APP_DIR/INSTALL_INFO.json" | head -1)"
fi
_install_method="${_install_method:-checkout}"
row "Install" "PASS" "$_install_method"

if [ -f "$AI17Z_APP_DIR/BUILD_INFO.json" ]; then
  row "Version" "PASS" "$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$AI17Z_APP_DIR/BUILD_INFO.json" | head -1)"
else
  row "Version" "NOT CONFIGURED" "no BUILD_INFO.json; this looks like a checkout"
fi

# The private runtime, which is what a packaged installation runs. A checkout
# has none and uses whatever the developer has, which is the point of a
# checkout rather than a fault.
if [ -n "${AI17Z_RUNTIME_NODE:-}" ] && [ -x "${AI17Z_RUNTIME_NODE}" ]; then
  row "Runtime" "PASS" "bundled Node $("$AI17Z_RUNTIME_NODE" --version 2>/dev/null)"
elif command -v node >/dev/null 2>&1; then
  row "Runtime" "PASS" "system Node $(node --version 2>/dev/null) (checkout)"
else
  row "Runtime" "FAIL" "no Node runtime found"
  failures+=("Runtime: this installation has no Node. Install AI17Z again.")
fi

row "Data" "PASS" "$AI17Z_DATA_DIR"

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

# Node is reported once, by the Runtime row above.
#
# It used to be checked again here, against whatever is on PATH -- which on a
# packaged installation is nothing at all, because the package carries its own.
# That reported a failure for a machine working exactly as designed. The runtime
# an installation actually uses is the only one worth asking about.

# -- Configuration -----------------------------------------------------------
if [ -f "$AI17Z_ENV_FILE" ]; then
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

# -- Where those services can be reached from --------------------------------
#
# AI17Z holds the keys to every provider configured, a database of everything
# the agents know, and a browser profile signed in to somebody's accounts. The
# default is loopback so that none of it is on a network interface, and the
# documentation says so. Anything else is a deliberate decision, and one worth
# being reminded of every time this runs.
bind_host="$(env_value AI17Z_BIND_HOST)"; bind_host="${bind_host:-127.0.0.1}"
case "$bind_host" in
  127.0.0.1|localhost|::1)
    row "Reachable from" "PASS" "This machine only (${bind_host})." ;;
  *)
    row "Reachable from" "NEEDS ACTION"       "Published on ${bind_host}, not just this machine."
    todo+=("Network: AI17Z's interface, API and database are published on ${bind_host}. Anyone who can reach that address can reach them. Set AI17Z_BIND_HOST=127.0.0.1 and use an SSH tunnel instead, unless you meant this.") ;;
esac

# -- Browser support ---------------------------------------------------------
#
# Three states, and only one of them is a fault.
#
# A machine with no graphical session cannot drive a browser and never will --
# that is Ubuntu Server, and a headless Mac over ssh, and reporting it as FAIL
# is how somebody concludes AI17Z is broken when it is working exactly as
# intended. It is NOT AVAILABLE: everything else runs, and browser-backed
# channels do not.
#
# Chromium is not Google Chrome, and AI17Z never substitutes one for the other.
_screen=no; ai17z_has_screen && _screen=yes
chrome="$(ai17z_chrome || true)"

if [ "$_screen" = "no" ]; then
  row "Graphical session" "NOT AVAILABLE" "No screen. AI17Z runs backend-only."
  row "Google Chrome" "NOT AVAILABLE" "Not useful without a graphical session."
  row "Browser support" "NOT AVAILABLE" "Expected on a server. Everything else works."
elif [ -z "$chrome" ]; then
  row "Graphical session" "PASS" "${WAYLAND_DISPLAY:-${DISPLAY:-yes}}"
  row "Google Chrome" "NEEDS ACTION" "Not installed."
  row "Browser support" "NOT AVAILABLE" "Needs Google Chrome."
  todo+=("Google Chrome: install the real thing from google.com/chrome to use X and other browser-backed channels. Chromium is a different browser and is not used as a substitute. Everything else works without it.")
else
  row "Graphical session" "PASS" "${WAYLAND_DISPLAY:-${DISPLAY:-yes}}"
  row "Google Chrome" "PASS" "$("$chrome" --version 2>/dev/null | head -1)"
  if [ -f "$AI17Z_STORAGE_DIR/native-worker.pid" ] \
     && kill -0 "$(cat "$AI17Z_STORAGE_DIR/native-worker.pid" 2>/dev/null)" 2>/dev/null; then
    row "Browser support" "PASS" "Running. This is the worker that can see Chrome."
  else
    row "Browser support" "NOT RUNNING" "Not started."
    todo+=("Browser support: run 'ai17z start'. Without it browser-backed channels cannot be used -- a container cannot drive a browser on your machine.")
  fi
fi

# Where the signed-in session lives. Under the data directory, never beside the
# program: the program directory is replaced on every update.
if [ -d "$AI17Z_BROWSER_PROFILES" ]; then
  row "Browser profile" "PASS" "$AI17Z_BROWSER_PROFILES"
else
  row "Browser profile" "NOT CONFIGURED" "Created when a browser account is first connected."
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

# -- Database and what is configured -----------------------------------------
#
# The Windows doctor has checked these since it was written and this one never
# did, so the same installation could be called ready by one and unexamined by
# the other. A newcomer following the Ubuntu path got less help than one
# following the Windows path, for no reason anybody chose.
#
# Read out of the health endpoint rather than by talking to Postgres directly,
# because that is the same answer the application itself acts on, and it needs
# no database client installed.
health="$(curl -fsS -m 6 "http://localhost:${api_port}/api/health" 2>/dev/null || true)"
if [ -n "$health" ]; then
  if printf '%s' "$health" | grep -q '"name":"Database","status":"healthy"'; then
    row "Database" "PASS" "Reachable from the API."
  else
    row "Database" "FAIL" "The API cannot reach Postgres."
    failures+=("Database: check the container with 'docker compose ps' and 'docker compose logs postgres'.")
  fi

  # Counted by what each component is. Reading the `optional` flag as "is a
  # provider" is what made the Windows doctor report one AI provider on an
  # installation that had none: the browser is optional too.
  providers="$(printf '%s' "$health" | grep -o '"kind":"provider"' | wc -l | tr -d ' ')"
  if [ "$providers" = "0" ]; then
    row "AI providers" "NOT CONFIGURED" "None yet. An agent cannot think without one."
    todo+=("AI providers: open http://localhost:${web_port}, go to Settings, add a provider.")
  else
    row "AI providers" "PASS" "$providers configured."
  fi

  accounts="$(printf '%s' "$health" | grep -o '"kind":"account"' | wc -l | tr -d ' ')"
  if [ "$accounts" = "0" ]; then
    row "Accounts" "NOT CONFIGURED" "None yet. Nothing to read or reply to."
    todo+=("Accounts: create an agent, then connect an account to it.")
  else
    row "Accounts" "PASS" "$accounts connected."
  fi
else
  row "Database" "NOT RUNNING" "API is down, so this could not be checked."
  row "AI providers" "NOT RUNNING" "API is down, so this could not be checked."
  row "Accounts" "NOT RUNNING" "API is down, so this could not be checked."
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
