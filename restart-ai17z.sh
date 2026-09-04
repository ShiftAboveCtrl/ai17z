#!/usr/bin/env bash
# Stops AI17Z and starts it again.
#
# Data survives this, and so does a signed-in Chrome: the stop script does not
# touch the browser, and starting again reattaches to the tabs already open
# rather than opening more.
set -euo pipefail
cd "$(dirname "$0")"

printf '\nAI17Z restart\n\n'

if [ "${1:-}" = "--keep-stack" ]; then
  ./stop-ai17z.sh --keep-stack
else
  ./stop-ai17z.sh
fi

# A moment for ports and the browser profile lock to be released.
sleep 2

./start-ai17z.sh
