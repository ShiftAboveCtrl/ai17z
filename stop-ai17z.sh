#!/usr/bin/env bash
#
# Stops AI17Z.
#
# Data survives this. Postgres, stored files and browser profiles live in named
# Docker volumes and in ./storage, and none of it is touched. Starting again
# picks up where this left off.
#
#   ./stop-ai17z.sh                stop the worker and the containers
#   ./stop-ai17z.sh --keep-stack   stop only the native worker
#   ./stop-ai17z.sh --volumes      also delete every volume. Asks first.
#
# Chrome is left running on purpose. It was spawned rather than launched by the
# automation, so it outlives the worker -- which means restarting AI17Z does not
# close a window somebody is signing into.

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

GREEN=$'\033[32m'; RED=$'\033[31m'; YELLOW=$'\033[33m'; CYAN=$'\033[36m'; OFF=$'\033[0m'
step() { echo "  ${CYAN}$1${OFF}"; }
done_() { echo "  ${GREEN}$1${OFF}"; }
warn() { echo "  ${YELLOW}$1${OFF}"; }

keep_stack=0
volumes=0
for arg in "$@"; do
  case "$arg" in
    --keep-stack) keep_stack=1 ;;
    --volumes) volumes=1 ;;
    *) warn "Ignoring unknown option: $arg" ;;
  esac
done

PID_FILE="storage/native-worker.pid"

echo
echo "AI17Z"
echo

# -- The native worker -------------------------------------------------------
if [ -f "$PID_FILE" ]; then
  worker_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "$worker_pid" ] && kill -0 "$worker_pid" 2>/dev/null; then
    step "Stopping the native worker (pid $worker_pid)..."
    # The whole group. npm starts tsx, which starts the worker: killing only the
    # recorded pid leaves the one that matters running, and every start/stop
    # cycle then leaks a worker that still polls and still opens browsers.
    kill -TERM -- "-$(ps -o pgid= "$worker_pid" 2>/dev/null | tr -d ' ')" 2>/dev/null \
      || kill -TERM "$worker_pid" 2>/dev/null
    sleep 2
    kill -KILL "$worker_pid" 2>/dev/null || true
    done_ "Native worker stopped."
  else
    warn "No native worker was running under pid $worker_pid."
  fi
  rm -f "$PID_FILE"
else
  warn "No native worker recorded."
fi

# Belt and braces: a worker from an earlier cycle that outlived its pid file is
# still a worker.
strays="$(pgrep -f 'apps/worker' 2>/dev/null || true)"
if [ -n "$strays" ]; then
  step "Stopping leftover worker process(es)..."
  # shellcheck disable=SC2086
  kill -TERM $strays 2>/dev/null || true
  sleep 1
  # shellcheck disable=SC2086
  kill -KILL $strays 2>/dev/null || true
  done_ "Leftovers stopped."
fi

# -- The stack ---------------------------------------------------------------
if [ "$keep_stack" -eq 1 ]; then
  done_ "Leaving the containers running."
elif [ "$volumes" -eq 1 ]; then
  echo
  warn "This deletes the database, every stored provider key, every browser"
  warn "session and every agent. There is no undo."
  printf '  Type DELETE to confirm: '
  read -r confirmation
  if [ "$confirmation" = "DELETE" ]; then
    docker compose down --volumes
    done_ "Containers and volumes removed."
  else
    warn "Nothing deleted."
    docker compose down
    done_ "Containers stopped; volumes kept."
  fi
else
  step "Stopping the containers..."
  docker compose down
  done_ "Containers stopped. Data kept."
fi

echo
echo "  ${GREEN}Stopped.${OFF}"
echo
