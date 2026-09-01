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

PID_FILE="storage/native-worker.pid"
LOG_FILE="storage/native-worker.log"

echo
echo "AI17Z"
echo

command -v docker >/dev/null 2>&1 || stop_with_reason \
  "Docker is not installed." "Run ./install-ai17z.sh first."
docker info >/dev/null 2>&1 || stop_with_reason \
  "Docker is installed but not running." "Start it with 'sudo systemctl start docker', then run this again."

[ -f .env ] || stop_with_reason \
  "No .env file." "Run ./install-ai17z.sh first -- it creates one with a fresh master key."

# -- The stack ---------------------------------------------------------------
step "Starting the containers..."
docker compose up -d
done_ "Containers up."

api_port="$(sed -n 's/^[[:space:]]*AI17Z_API_PORT[[:space:]]*=[[:space:]]*//p' .env | head -1)"
api_port="${api_port:-8787}"
web_port="$(sed -n 's/^[[:space:]]*AI17Z_WEB_PORT[[:space:]]*=[[:space:]]*//p' .env | head -1)"
web_port="${web_port:-8080}"

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
  warn "Check it with: docker compose logs api"
fi

# -- The native worker -------------------------------------------------------
if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE" 2>/dev/null)" 2>/dev/null; then
  done_ "Native worker already running (pid $(cat "$PID_FILE"))."
else
  step "Starting the native worker (this one can see your Chrome)..."
  mkdir -p storage
  # Only browser work. The containerised worker takes everything else, and two
  # workers claiming the same jobs is just contention.
  AI17Z_WORKER_ROLE=browser \
  AI17Z_WORKER_ID="native-$(hostname)" \
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
