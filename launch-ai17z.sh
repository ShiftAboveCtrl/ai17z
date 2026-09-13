#!/usr/bin/env bash
# Starts AI17Z and opens it.
#
# Everything here is available as separate scripts. This one exists because
# somebody who wants to use their agents should not have to know that starting
# the stack and opening a browser are two different things, nor have to find the
# address in console output that has already scrolled.
#
# Starting is idempotent, so running this when AI17Z is already up just opens it.
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


# The port this installation publishes on, which is not necessarily the default:
# a machine running two installations moves one of them, and opening the other
# one's window is worse than opening nothing.
env_value() {
  local name="$1" fallback="$2"
  if [ -f "$AI17Z_ENV_FILE" ]; then
    local found
    found="$(ai17z_env_value "$name" "")"
    [ -n "$found" ] && { printf '%s' "$found"; return; }
  fi
  printf '%s' "$fallback"
}

if ! ./start-ai17z.sh; then
  printf '\n  \033[31mAI17Z did not start, so nothing was opened. The output above says why.\033[0m\n'
  printf '  \033[33mFor a fuller check:  ./doctor-ai17z.sh\033[0m\n\n'
  exit 1
fi

web_port="$(env_value AI17Z_WEB_PORT "$(env_value XBAM_WEB_PORT 8080)")"
url="http://localhost:${web_port}"
printf '\n  \033[36mOpening %s\033[0m\n' "$url"

# Whichever of these exists. None of them existing is not an error: the address
# is printed above and a person can open it.
if command -v xdg-open >/dev/null 2>&1; then xdg-open "$url" >/dev/null 2>&1 &
elif command -v open >/dev/null 2>&1; then open "$url" >/dev/null 2>&1 &
fi
