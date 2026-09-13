#!/usr/bin/env bash
#
# Starts AI17Z: the Docker stack, then the native worker that can see Chrome.
#
# Two workers, on purpose. A container cannot drive a browser on your machine,
# so the containerised worker takes everything that needs no browser and a
# native one -- started here, pinned to role=browser -- owns Chrome. They divide
# the work rather than competing for it.
#
# Running this twice is safe. It converges on the same state rather than
# starting a second copy of anything.

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

stop_with_reason() {
  echo
  echo "  ${RED}$1${OFF}"
  [ -n "${2:-}" ] && echo "  ${YELLOW}$2${OFF}"
  echo
  exit 1
}

PID_FILE="$AI17Z_STORAGE_DIR/native-worker.pid"
LOG_FILE="$AI17Z_STORAGE_DIR/native-worker.log"

echo
echo "AI17Z"
echo

command -v docker >/dev/null 2>&1 || stop_with_reason \
  "Docker is not installed." "Run ./install-ai17z.sh first."
docker info >/dev/null 2>&1 || stop_with_reason \
  "Docker is installed but not running." "Start it with 'sudo systemctl start docker', then run this again."

[ -f "$AI17Z_ENV_FILE" ] || stop_with_reason \
  "No .env file." "Run ./install-ai17z.sh first -- it creates one with a fresh master key."

# -- Ports -------------------------------------------------------------------
# Checked before Docker is asked to bind them. The alternative is "Bind for
# 127.0.0.1:55433 failed: port is already allocated" from a daemon, which tells
# somebody running a second installation nothing they can act on.
env_port() { # key default
  ai17z_env_value "$1" "$2"
}

port_taken() {
  if command -v ss >/dev/null 2>&1; then ss -ltn 2>/dev/null | grep -q ":$1 "
  elif command -v lsof >/dev/null 2>&1; then lsof -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
  else return 1
  fi
}

# Ports held by this installation are not a conflict.
if [ -z "$(ai17z_compose ps -q 2>/dev/null)" ]; then
  taken=""
  for pair in "API:AI17Z_API_PORT:8787" "Web:AI17Z_WEB_PORT:8080" "Postgres:POSTGRES_PORT:55432"; do
    name="${pair%%:*}"; rest="${pair#*:}"; key="${rest%%:*}"; def="${rest##*:}"
    p="$(env_port "$key" "$def")"
    if port_taken "$p"; then taken="${taken}    ${name} wants ${p}. Set ${key} in .env to something else.
"; fi
  done
  if [ -n "$taken" ]; then
    stop_with_reason "Something is already using ports AI17Z needs." "$(printf "%b" "$taken")
  If that something is another AI17Z, give this one its own name too:
    AI17Z_INSTANCE=second"
  fi
fi

# -- The stack ---------------------------------------------------------------
step "Starting the containers..."
ai17z_compose up -d
done_ "Containers up."

api_port="$(env_port AI17Z_API_PORT 8787)"
web_port="$(env_port AI17Z_WEB_PORT 8080)"

# Wait for the API to actually answer, not merely for the container to exist.
step "Waiting for the API..."
ready=0
for _ in $(seq 1 60); do
  if curl -fsS -m 4 "http://localhost:${api_port}/api/health" >/dev/null 2>&1; then ready=1; break; fi
  sleep 2
done
if [ "$ready" -eq 1 ]; then
  done_ "API is answering on ${api_port}."
else
  warn "The API did not answer within two minutes."
  warn "Check it with: ai17z logs"
fi

# -- The native worker -------------------------------------------------------
if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE" 2>/dev/null)" 2>/dev/null; then
  done_ "Native worker already running (pid $(cat "$PID_FILE"))."
else
  step "Starting the native worker (this one can see your Chrome)..."
  mkdir -p "$AI17Z_STORAGE_DIR"
  # Only browser work. The containerised worker takes everything else, and two
  # workers claiming the same jobs is just contention.
  #
  # The id matters as much: two native workers sharing one is two processes
  # with a single identity, and both the job lease and the account lease stop
  # separating them.
  #
  # Every assignment on one line, deliberately. A backslash continuation
  # followed by a *comment* ends the command -- the next line is then read as a
  # command of its own -- so the comments that used to sit between these lines
  # meant `AI17Z_WORKER_ROLE=browser` was a standalone assignment that never
  # reached the worker. The native worker was claiming every kind of job.
  AI17Z_WORKER_ROLE=browser AI17Z_WORKER_ID="native-$(hostname)-$$" \
    nohup npm run dev:worker >"$LOG_FILE" 2>"${LOG_FILE}.err" &
  echo $! > "$PID_FILE"
  sleep 2
  if kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    done_ "Native worker running (pid $(cat "$PID_FILE")). Log: $LOG_FILE"
  else
    warn "The native worker exited immediately. See ${LOG_FILE}.err"
  fi
fi

echo
echo "  ${GREEN}AI17Z is up.${OFF}"
echo "    ${GREY}http://localhost:${web_port}${OFF}"
echo
echo "    ${GREY}./doctor-ai17z.sh    check everything${OFF}"
echo "    ${GREY}./stop-ai17z.sh      stop it${OFF}"
echo
