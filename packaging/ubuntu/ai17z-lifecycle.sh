#!/usr/bin/env bash
#
# What `ai17z <command>` actually does on Ubuntu.
#
# One file rather than eight, because every command shares the same three
# questions -- where is this installation's data, which Node runs it, and which
# Docker project is it -- and eight copies of that is eight chances to disagree.
#
# Dispatched by /usr/bin/ai17z, which has already resolved the XDG paths and
# exported them. Never run directly.

set -euo pipefail

APP_ROOT="${AI17Z_APP_ROOT:-/usr/lib/ai17z/app}"
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

LOG_DIR="${AI17Z_STATE_HOME:-$AI17Z_DATA_DIR}/logs"
WORKER_PID="$AI17Z_STORAGE_DIR/native-worker.pid"
WORKER_LOG="$LOG_DIR/native-worker.log"

version_of() {
  [ -f "$APP_ROOT/BUILD_INFO.json" ] || { printf 'unknown'; return; }
  sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$APP_ROOT/BUILD_INFO.json" | head -1
}

api_port() { ai17z_env_value AI17Z_API_PORT 8787; }
web_port() { ai17z_env_value AI17Z_WEB_PORT 8080; }

require_env() {
  [ -f "$AI17Z_ENV_FILE" ] || oops \
    "AI17Z is not set up yet." \
    "Run 'ai17z start' -- it creates your configuration on first run."
}

require_docker() {
  command -v docker >/dev/null 2>&1 || oops "Docker is not installed." \
    "AI17Z needs it for the database. See https://docs.docker.com/engine/install/ubuntu/"
  docker info >/dev/null 2>&1 || oops "Docker is installed but not answering." \
    "Start it with: sudo systemctl start docker"
  docker compose version >/dev/null 2>&1 || oops "The Docker Compose plugin is missing." \
    "sudo apt install -y docker-compose-plugin"
}

# Whether a graphical session exists at all.
#
# Never DISPLAY=:0 and never a guessed Xauthority: a Wayland session has no
# DISPLAY, a remote session has a different one, and hard-coding either is how a
# worker starts talking to a screen nobody is sitting at.
has_graphical_session() {
  [ -n "${WAYLAND_DISPLAY:-}" ] || [ -n "${DISPLAY:-}" ]
}

chrome_binary() {
  for candidate in google-chrome google-chrome-stable; do
    command -v "$candidate" >/dev/null 2>&1 && { command -v "$candidate"; return 0; }
  done
  return 1
}

# ---------------------------------------------------------------------------
# first run
# ---------------------------------------------------------------------------
ensure_configured() {
  [ -f "$AI17Z_ENV_FILE" ] && return 0
  step "Setting up your configuration"
  mkdir -p "$AI17Z_DATA_DIR" "$AI17Z_STORAGE_DIR" "$AI17Z_BROWSER_PROFILES" "$LOG_DIR"
  chmod 700 "$AI17Z_DATA_DIR"
  ( cd "$APP_ROOT" && bash "$APP_ROOT/install-ai17z.sh" >"$LOG_DIR/setup.log" 2>&1 ) || {
    tail -20 "$LOG_DIR/setup.log" >&2
    oops "Setting up failed." "The log above says why. Full log: $LOG_DIR/setup.log"
  }
  good "Configuration created in $AI17Z_DATA_DIR"
}

# ---------------------------------------------------------------------------
# the native browser worker
#
# Only this one drives Chrome; the containerised worker takes everything else.
# Started after the backend is healthy, never as root, and never at all without
# both Chrome and a graphical session -- a worker that restarts for ever against
# a missing screen is worse than one that never started.
# ---------------------------------------------------------------------------
worker_running() {
  [ -f "$WORKER_PID" ] || return 1
  local pid; pid="$(cat "$WORKER_PID" 2>/dev/null || echo '')"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null
}

start_worker() {
  if worker_running; then
    good "Browser support already running (pid $(cat "$WORKER_PID"))"
    return 0
  fi
  # A stale pid file is not a running worker. Removed rather than believed.
  rm -f "$WORKER_PID"

  if ! has_graphical_session; then
    note "Browser support: not available (no graphical session)."
    note "Everything else runs. This is the normal state on a server."
    return 0
  fi
  local chrome
  if ! chrome="$(chrome_binary)"; then
    note "Browser support: not available (Google Chrome is not installed)."
    note "Install it and run 'ai17z restart' to enable browser-backed channels."
    return 0
  fi

  step "Starting browser support"
  mkdir -p "$AI17Z_STORAGE_DIR" "$LOG_DIR"
  local node; node="$(ai17z_node)"
  (
    cd "$APP_ROOT"
    AI17Z_WORKER_ROLE=browser \
    AI17Z_WORKER_ID="native-$(hostname)-$$" \
    AI17Z_CHROME_PATH="$chrome" \
    AI17Z_BROWSER_PROFILE_DIR="$AI17Z_BROWSER_PROFILES" \
      nohup "$node" "$APP_ROOT/node_modules/tsx/dist/cli.mjs" \
        "$APP_ROOT/scripts/supervise-worker.mts" \
        >"$WORKER_LOG" 2>"$WORKER_LOG.err" &
    echo $! > "$WORKER_PID"
  )
  sleep 2
  if worker_running; then
    good "Browser support running (pid $(cat "$WORKER_PID"))"
  else
    warn "Browser support exited immediately. See ${WORKER_LOG}.err"
    rm -f "$WORKER_PID"
  fi
}

stop_worker() {
  worker_running || { rm -f "$WORKER_PID"; return 0; }
  local pid; pid="$(cat "$WORKER_PID")"
  step "Stopping browser support"
  # The tree, not the pid: this starts tsx which starts the worker which spawns
  # Chrome, and killing only the recorded pid leaves the ones that matter.
  pkill -TERM -P "$pid" 2>/dev/null || true
  kill -TERM "$pid" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$pid" 2>/dev/null || break
    sleep 1
  done
  kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null || true
  rm -f "$WORKER_PID"
  good "Browser support stopped"
}

# ---------------------------------------------------------------------------
# commands
# ---------------------------------------------------------------------------
# What the images were built from, and what they should have been built from.
#
# `docker compose up -d` builds only when an image is *missing*. It has no idea
# the source changed, so an installation updated over the top went on serving
# the containers built for the version before it. Windows has had this since
# Beta 1.0.0 (8); neither Unix platform did, and their images were labelled
# `ai17z.built-from=unknown` on every machine. Found on a Mac, fixed here too
# because this file has the same shape and therefore had the same hole.
build_stamp() {
  [ -f "$APP_ROOT/BUILD_INFO.json" ] || { printf 'unknown'; return; }
  sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$APP_ROOT/BUILD_INFO.json" | head -1 | tr -d '\n'
  sed -n 's/.*"builtAt"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/-\1/p' "$APP_ROOT/BUILD_INFO.json" | head -1 | tr -d '\n'
}

image_stamp() { # image
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

  AI17Z_BUILD_STAMP="$(build_stamp)"
  AI17Z_VERSION="$(version_of)"
  export AI17Z_BUILD_STAMP AI17Z_VERSION
  # Which kind of installation this is, handed to the containers because the API
  # runs in one and cannot see the program directory at all.
  #
  # The launcher exports this too and always has. Repeated here so that a
  # lifecycle run directly still carries it. The update screen's wrong answer
  # was `updateMethodFrom` not recognising the value, not the value missing.
  AI17Z_INSTALL_CHANNEL=UBUNTU_DEB
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
    if curl -fsS -m 4 "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1; then ready=1; break; fi
    sleep 2
  done
  if [ "$ready" = "1" ]; then
    good "AI17Z is answering on ${port}"
  else
    warn "AI17Z did not answer within three minutes."
    note "See what it is doing:  ai17z logs"
    return 1
  fi

  start_worker
  printf '\n  %sAI17Z is ready.%s\n' "$GREEN" "$OFF"
  printf '  %shttp://127.0.0.1:%s%s\n\n' "$GREY" "$(web_port)" "$OFF"
}

cmd_stop() {
  printf '\n'
  stop_worker
  require_docker
  step "Stopping AI17Z"
  # Never `down --volumes` here: the volumes are the database.
  ai17z_compose down >/dev/null 2>&1 || true
  good "AI17Z stopped"
  printf '\n'
}

cmd_restart() { cmd_stop; cmd_start; }

cmd_launch() {
  cmd_start || true
  local url
  url="http://127.0.0.1:$(web_port)"
  if command -v xdg-open >/dev/null 2>&1 && has_graphical_session; then
    xdg-open "$url" >/dev/null 2>&1 &
  else
    note "Open $url"
  fi
}

cmd_status() {
  printf '\n  AI17Z %s\n\n' "$(version_of)"
  if docker info >/dev/null 2>&1 && [ -n "$(ai17z_compose ps -q 2>/dev/null)" ]; then
    good "Containers running"
  else
    note "Containers not running"
  fi
  if worker_running; then good "Browser support running (pid $(cat "$WORKER_PID"))"
  elif ! has_graphical_session; then note "Browser support not available (no graphical session)"
  elif ! chrome_binary >/dev/null; then note "Browser support not available (no Google Chrome)"
  else note "Browser support not running"; fi
  printf '\n'
}

cmd_logs() {
  require_docker
  if [ "${1:-}" = "worker" ]; then
    [ -f "$WORKER_LOG" ] || oops "No browser-support log yet." ""
    tail -n 100 -f "$WORKER_LOG"
  else
    ai17z_compose logs --tail 100 -f
  fi
}

cmd_doctor() { exec bash "$APP_ROOT/doctor-ai17z.sh" "$@"; }

cmd_uninstall() {
  printf '\n  %sRemoving AI17Z%s\n\n' "$YELLOW" "$OFF"
  if [ "${1:-}" = "--remove-data" ]; then
    printf '  This removes the program AND everything you have made:\n\n'
    printf '    %s\n' "$AI17Z_DATA_DIR"
    printf '    %s\n' "$AI17Z_STORAGE_DIR"
    printf '    %s\n' "$AI17Z_BROWSER_PROFILES"
    printf '    %s\n' "$LOG_DIR"
    printf '\n  That is your agents, their memories, the key your provider\n'
    printf '  credentials are sealed with, and your signed-in browser session.\n'
    printf '  %sIt cannot be undone.%s\n\n' "$RED" "$OFF"
    printf '  Type REMOVE to confirm: '
    local reply=""; read -r reply || true
    [ "$reply" = "REMOVE" ] || { note "Nothing was removed."; exit 0; }
    stop_worker
    docker info >/dev/null 2>&1 && ai17z_compose down --volumes >/dev/null 2>&1 || true
    rm -rf "$AI17Z_DATA_DIR" "$AI17Z_STORAGE_DIR" "$AI17Z_BROWSER_PROFILES" "$LOG_DIR"
    good "Your AI17Z data is removed"
  else
    stop_worker
    docker info >/dev/null 2>&1 && ai17z_compose down >/dev/null 2>&1 || true
    printf '  Your data is kept, in:\n\n'
    printf '    %s\n\n' "$AI17Z_DATA_DIR"
    printf '  To remove the program:\n'
    printf '    %ssudo apt remove ai17z%s\n\n' "$CYAN" "$OFF"
    printf '  To remove your data as well, afterwards:\n'
    printf '    %sai17z uninstall --remove-data%s\n\n' "$CYAN" "$OFF"
  fi
}

case "${1:-}" in
  start)     shift; cmd_start "$@" ;;
  stop)      shift; cmd_stop "$@" ;;
  restart)   shift; cmd_restart "$@" ;;
  launch)    shift; cmd_launch "$@" ;;
  status)    shift; cmd_status "$@" ;;
  logs)      shift; cmd_logs "$@" ;;
  doctor)    shift; cmd_doctor "$@" ;;
  uninstall) shift; cmd_uninstall "$@" ;;
  *) printf 'ai17z-lifecycle: unknown command: %s\n' "${1:-}" >&2; exit 2 ;;
esac
