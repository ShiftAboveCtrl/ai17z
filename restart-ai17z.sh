#!/usr/bin/env bash
# Stops AI17Z and starts it again.
#
# Data survives this, and so does a signed-in Chrome: the stop script does not
# touch the browser, and starting again reattaches to the tabs already open
# rather than opening more.
set -euo pipefail
cd "$(dirname "$0")"

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


printf '\nAI17Z restart\n\n'

if [ "${1:-}" = "--keep-stack" ]; then
  ./stop-ai17z.sh --keep-stack
else
  ./stop-ai17z.sh
fi

# A moment for ports and the browser profile lock to be released.
sleep 2

./start-ai17z.sh
