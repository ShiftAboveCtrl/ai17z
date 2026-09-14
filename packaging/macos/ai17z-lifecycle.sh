#!/usr/bin/env bash
#
# What `ai17z <command>` does on macOS.
#
# The Mac arrangement, which is not the Linux one and must not be confused with
# it: Docker Desktop supplies its own Linux VM and runs the database, API, web
# and jobs worker; a native worker on the Mac itself owns Chrome, because a
# container cannot drive a browser on somebody's screen. There is no WSL here,
# no Ubuntu, and nothing wants Homebrew.

set -euo pipefail

APP_ROOT="${AI17Z_APP_ROOT:?run this through the ai17z launcher}"
# shellcheck source=../unix/ai17z-paths.sh
. "$APP_ROOT/packaging/unix/ai17z-paths.sh"
ai17z_resolve_paths "$APP_ROOT"

if [ -t 1 ]; then
  GREEN=$'\033[32m'; RED=$'\033[31m'; YELLOW=$'\033[33m'; CYAN=$'\033[36m'; GREY=$'\033[90m'; OFF=$'\033[0m'
else
  GREEN=""; RED=""; YELLOW=""; CYAN=""; GREY=""; OFF=""
fi
step() { printf '  %s%s%s\n' "$CYAN" "$1" "$OFF"; }
good() { printf '  %s+ %s%s\n' "$GREEN" "$1" "$OFF"; }
note() { printf '  %s%s%s\n' "$GREY" "$1" "$OFF"; }
warn() { printf '  %s! %s%s\n' "$YELLOW" "$1" "$OFF"; }
oops() { printf '\n  %s%s%s\n' "$RED" "$1" "$OFF"; [ -n "${2:-}" ] && printf '  %s%s%s\n' "$GREY" "$2" "$OFF"; printf '\n'; exit 1; }

LOG_DIR="${AI17Z_STATE_DIR:-$AI17Z_DATA_DIR/logs}"
WORKER_PID="$AI17Z_STORAGE_DIR/native-worker.pid"
WORKER_LOG="$LOG_DIR/native-worker.log"

api_port() { ai17z_env_value AI17Z_API_PORT 8787; }
web_port() { ai17z_env_value AI17Z_WEB_PORT 8080; }
version_of() {
  [ -f "$APP_ROOT/BUILD_INFO.json" ] || { printf 'unknown'; return; }
  sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$APP_ROOT/BUILD_INFO.json" | head -1
}

# Real Google Chrome, in the two places macOS actually puts an application.
# Never Chromium: AI17Z attaches to real Chrome over a loopback debug port and a
# substitution would be a different browser wearing the name.
chrome_app() {
  for candidate in \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "$HOME/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; do
    [ -x "$candidate" ] && { printf '%s' "$candidate"; return 0; }
  done
  return 1
}

# Docker Desktop, which is a Mac application rather than a service.
#
# Its being installed proves nothing: the engine is in a VM that may not be
# running. `docker info` answering is the only thing that counts, and this waits
# for it rather than starting AI17Z against a socket nothing is listening on.
docker_ready() { docker info >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; }

wait_for_docker() { # seconds
  local deadline=$(( $(date +%s) + ${1:-120} ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    docker_ready && return 0
    sleep 3
  done
  return 1
}

require_docker() {
  if docker_ready; then good "Docker is answering"; return 0; fi
  if [ -d "/Applications/Docker.app" ]; then
    step "Starting Docker Desktop"
    note "Docker takes a minute to bring its virtual machine up."
    open -a Docker 2>/dev/null || true
    if wait_for_docker 180; then good "Docker is answering"; return 0; fi
    oops "Docker Desktop is installed but its engine did not answer." \
      "If Docker is asking you to accept its terms or finish setting up, do that
  and run 'ai17z start' again. AI17Z will not accept a vendor's agreement for you."
  fi
  oops "Docker Desktop is not installed." \
    "AI17Z needs it for the database. Install it from https://www.docker.com/products/docker-desktop/
  then run 'ai17z start' again."
}

has_screen() {
  # A Mac running a user session has one. Over plain ssh with no console, it
  # does not, and a browser worker there would drive a screen nobody is at.
  [ -n "${AI17Z_FORCE_BROWSER:-}" ] && return 0
  launchctl print "gui/$(id -u)" >/dev/null 2>&1
}

ensure_configured() {
  [ -f "$AI17Z_ENV_FILE" ] && return 0
  step "Setting up your configuration"
  mkdir -p "$AI17Z_DATA_DIR" "$AI17Z_STORAGE_DIR" "$AI17Z_BROWSER_PROFILES" "$LOG_DIR"
  chmod 700 "$AI17Z_DATA_DIR"
  ( cd "$APP_ROOT" && bash "$APP_ROOT/install-ai17z.sh" >"$LOG_DIR/setup.log" 2>&1 ) || {
    tail -20 "$LOG_DIR/setup.log" >&2
    oops "Setting up failed." "Full log: $LOG_DIR/setup.log"
  }
  good "Configuration created"
}

worker_running() {
  [ -f "$WORKER_PID" ] || return 1
  local pid; pid="$(cat "$WORKER_PID" 2>/dev/null || echo '')"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

start_worker() {
  if worker_running; then good "Browser support already running"; return 0; fi
  rm -f "$WORKER_PID"
  if ! has_screen; then
    note "Browser support: not available (no graphical session)."
    return 0
  fi
  local chrome
  if ! chrome="$(chrome_app)"; then
    note "Browser support: not available (Google Chrome is not installed)."
    note "Install Chrome from https://www.google.com/chrome/ then 'ai17z restart'."
    return 0
  fi
  step "Starting browser support"
  mkdir -p "$AI17Z_STORAGE_DIR" "$LOG_DIR"
  # Appended to, not truncated.
  #
  # `>` here meant the next start erased why the last one failed -- and the
  # thing somebody does after a browser-support failure is start it again. So
  # the evidence was gone by the time anybody went looking for it, every time.
  # Kept to a size instead: a log nobody can read because it is enormous is the
  # other way to lose it.
  for stream in "$WORKER_LOG" "$WORKER_LOG.err"; do
    if [ -f "$stream" ] && [ "$(wc -c <"$stream" 2>/dev/null || echo 0)" -gt 5000000 ]; then
      mv -f "$stream" "$stream.1" 2>/dev/null || true
    fi
    printf '\n--- started %s ---\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >>"$stream"
  done
  local node; node="$(ai17z_node)"
  (
    cd "$APP_ROOT"
    AI17Z_WORKER_ROLE=browser AI17Z_WORKER_ID="native-$(hostname -s)-$$" \
    AI17Z_CHROME_PATH="$chrome" AI17Z_BROWSER_PROFILE_DIR="$AI17Z_BROWSER_PROFILES" \
      nohup "$node" "$APP_ROOT/node_modules/tsx/dist/cli.mjs" \
        "$APP_ROOT/scripts/supervise-worker.mts" \
        >>"$WORKER_LOG" 2>>"$WORKER_LOG.err" &
    echo $! > "$WORKER_PID"
  )
  sleep 2
  if worker_running; then good "Browser support running"; else
    warn "Browser support exited immediately. See ${WORKER_LOG}.err"
    rm -f "$WORKER_PID"
  fi
}

stop_worker() {
  worker_running || { rm -f "$WORKER_PID"; return 0; }
  local pid; pid="$(cat "$WORKER_PID")"
  step "Stopping browser support"
  # The tree: this starts tsx which starts the worker which spawns Chrome.
  pkill -TERM -P "$pid" 2>/dev/null || true
  kill -TERM "$pid" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
  kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null || true
  rm -f "$WORKER_PID"
  good "Browser support stopped"
}

# What the images were built from, and what they should have been built from.
#
# `docker compose up -d` builds only when an image is *missing*. It has no idea
# the source changed, so an installation updated over the top went on serving
# the containers built for the version before it -- somebody installs a fix,
# starts AI17Z, and meets the same fault with nothing anywhere saying why.
# Windows has had this since Beta 1.0.0 (8); macOS never did, and its images
# were labelled `ai17z.built-from=unknown` on every machine.
#
# Asked of the images rather than remembered in a file beside them: a file can
# claim an image somebody has since deleted, and an image cannot be wrong about
# what it holds.
build_stamp() {
  # A package has no repository. Its version plus the moment it was built is a
  # value that changes exactly when the installed source does.
  [ -f "$APP_ROOT/BUILD_INFO.json" ] || { printf 'unknown'; return; }
  sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$APP_ROOT/BUILD_INFO.json" | head -1 | tr -d '\n'
  sed -n 's/.*"builtAt"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/-\1/p' "$APP_ROOT/BUILD_INFO.json" | head -1 | tr -d '\n'
}

image_stamp() { # image
  # The quoted-template trap is PowerShell's, not this shell's, so the simple
  # form is safe here.
  docker inspect --format '{{index .Config.Labels "ai17z.built-from"}}' "$1" 2>/dev/null || printf ''
}

images_are_stale() {
  local project want built
  want="$(build_stamp)"
  [ -n "$want" ] || return 1
  project="$(ai17z_compose config 2>/dev/null | sed -n 's/^name: //p' | head -1)"
  [ -n "$project" ] || return 0
  for service in api worker web; do
    built="$(image_stamp "${project}-${service}")"
    [ "$built" = "$want" ] || {
      note "The ${service} image holds '${built:-nothing}' and this is '${want}'."
      return 0
    }
  done
  return 1
}

cmd_start() {
  printf '\n  %sAI17Z%s\n\n' "$GREEN" "$OFF"
  require_docker
  ensure_configured

  # Handed to compose, which labels each image with it and shows the version on
  # the health screen. Without the version there, an installed copy reported
  # "source unknown" and there was no way to tell which build was serving.
  AI17Z_BUILD_STAMP="$(build_stamp)"
  AI17Z_VERSION="$(version_of)"
  export AI17Z_BUILD_STAMP AI17Z_VERSION
  # Which kind of installation this is, handed to the containers because the API
  # runs in one and cannot see the program directory at all.
  #
  # The launcher exports this too and always has. Repeated here so that a
  # lifecycle run directly still carries it -- the updater starts AI17Z that
  # way, immediately after swapping the application. The Mac that was told to
  # run a PowerShell script was not missing this value; `updateMethodFrom` did
  # not recognise it.
  AI17Z_INSTALL_CHANNEL=MACOS_PKG
  export AI17Z_INSTALL_CHANNEL

  if images_are_stale; then
    step "Rebuilding the containers for this version"
    ai17z_compose build >"$LOG_DIR/compose-build.log" 2>&1 || {
      tail -30 "$LOG_DIR/compose-build.log" >&2
      oops "The containers would not build." "Full log: $LOG_DIR/compose-build.log"
    }
    good "Containers rebuilt"
  fi

  step "Starting AI17Z"
  ai17z_compose up -d >"$LOG_DIR/compose.log" 2>&1 || {
    tail -20 "$LOG_DIR/compose.log" >&2
    oops "The containers would not start." "Full log: $LOG_DIR/compose.log"
  }
  good "Containers up"
  step "Waiting for AI17Z to answer"
  local port ready=0; port="$(api_port)"
  for _ in $(seq 1 90); do
    curl -fsS -m 4 "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1 && { ready=1; break; }
    sleep 2
  done
  [ "$ready" = "1" ] && good "AI17Z is answering on ${port}" || {
    warn "AI17Z did not answer within three minutes."; note "ai17z logs"; return 1; }
  start_worker
  printf '\n  %sAI17Z is ready.%s\n  %shttp://127.0.0.1:%s%s\n\n' "$GREEN" "$OFF" "$GREY" "$(web_port)" "$OFF"
}

cmd_stop() {
  printf '\n'; stop_worker
  if docker_ready; then step "Stopping AI17Z"; ai17z_compose down >/dev/null 2>&1 || true; good "AI17Z stopped"
  else note "Docker is not running; nothing to stop."; fi
  printf '\n'
}

cmd_restart() { cmd_stop; cmd_start; }
cmd_launch() { cmd_start || true; open "http://127.0.0.1:$(web_port)" 2>/dev/null || note "Open http://127.0.0.1:$(web_port)"; }

cmd_status() {
  printf '\n  AI17Z %s\n\n' "$(version_of)"
  if docker_ready && [ -n "$(ai17z_compose ps -q 2>/dev/null)" ]; then good "Containers running"; else note "Containers not running"; fi
  if worker_running; then good "Browser support running"
  elif ! has_screen; then note "Browser support not available (no graphical session)"
  elif ! chrome_app >/dev/null; then note "Browser support not available (no Google Chrome)"
  else note "Browser support not running"; fi
  printf '\n'
}

cmd_logs() {
  if [ "${1:-}" = "worker" ]; then
    [ -f "$WORKER_LOG" ] || oops "No browser-support log yet." ""
    tail -n 100 -f "$WORKER_LOG"
  else
    docker_ready || oops "Docker is not running." ""
    ai17z_compose logs --tail 100 -f
  fi
}

cmd_doctor() { exec bash "$APP_ROOT/doctor-ai17z.sh" "$@"; }

cmd_uninstall() {
  local here; here="$(dirname "$APP_ROOT")"
  printf '\n  %sRemoving AI17Z%s\n\n' "$YELLOW" "$OFF"
  if [ "${1:-}" = "--remove-data" ]; then
    printf '  This removes everything, including what you have made:\n\n'
    printf '    %s\n\n' "$here"
    printf '  That is your agents, their memories, the key your provider credentials\n'
    printf '  are sealed with, and your signed-in browser session.\n'
    printf '  %sIt cannot be undone.%s\n\n' "$RED" "$OFF"
    printf '  Type REMOVE to confirm: '
    local reply=""; read -r reply || true
    [ "$reply" = "REMOVE" ] || { note "Nothing was removed."; exit 0; }
    stop_worker
    docker_ready && ai17z_compose down --volumes >/dev/null 2>&1 || true
    # Deliberately not `rm -rf "$here"` from inside it: the shell's cwd is in
    # there. The directory is named for the owner to remove.
    note "Stopped, and the containers and volumes are gone."
    printf '\n  Remove the last of it with:\n    %srm -rf %q%s\n\n' "$CYAN" "$here" "$OFF"
  else
    stop_worker
    docker_ready && ai17z_compose down >/dev/null 2>&1 || true
    printf '  AI17Z is stopped. Everything is still in:\n\n    %s\n\n' "$here"
    printf '  To remove the program but keep your agents and keys, delete:\n'
    printf '    %s%s/app%s\n    %s%s/runtime%s\n\n' "$CYAN" "$here" "$OFF" "$CYAN" "$here" "$OFF"
    printf '  To remove everything:\n    %sai17z uninstall --remove-data%s\n\n' "$CYAN" "$OFF"
  fi
}

case "${1:-}" in
  start) shift; cmd_start "$@" ;;
  stop) shift; cmd_stop "$@" ;;
  restart) shift; cmd_restart "$@" ;;
  launch) shift; cmd_launch "$@" ;;
  status) shift; cmd_status "$@" ;;
  logs) shift; cmd_logs "$@" ;;
  doctor) shift; cmd_doctor "$@" ;;
  uninstall) shift; cmd_uninstall "$@" ;;
  *) printf 'ai17z-lifecycle: unknown command: %s\n' "${1:-}" >&2; exit 2 ;;
esac
