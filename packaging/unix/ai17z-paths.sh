# shellcheck shell=bash
#
# Where this installation's data is, resolved the same way by every Unix script.
#
# Sourced, never executed. Every shipped `.sh` begins by sourcing this, exactly
# as every shipped `.ps1` calls `Set-Ai17zDataPaths`, and for the same reason:
# before that existed on Windows the diagnostics told a healthy installation it
# was not configured, and "Stop AI17Z" resolved to a project belonging to
# somebody else's checkout.
#
# The order is the one Windows already uses, and the one `installEnv.ts` walks
# from inside Node:
#
#   1. AI17Z_ENV_FILE          what a packaged launcher sets
#   2. data-location.txt       the pointer beside the program, written by every
#                              installer since the file existed
#   3. .env beside the script  a developer's checkout, unchanged
#
# The third is why a clone keeps working exactly as before: it finds neither of
# the first two and lands on the file it has always used.
#
# Nothing here echoes a value out of the environment file. These scripts are run
# in terminals people paste into issues.

# The directory the calling script lives in. Resolved through symlinks, because
# /usr/bin/ai17z is one and `dirname $0` on it answers /usr/bin.
ai17z_script_dir() {
  local source="${BASH_SOURCE[1]:-$0}" dir
  while [ -L "$source" ]; do
    dir="$(cd -P "$(dirname "$source")" && pwd)"
    source="$(readlink "$source")"
    [[ $source != /* ]] && source="$dir/$source"
  done
  cd -P "$(dirname "$source")" && pwd
}

ai17z_resolve_paths() {
  # The application directory: where the scripts and package.json are. A
  # packaged launcher says so outright; a checkout is wherever this file is.
  AI17Z_APP_DIR="${AI17Z_APP_ROOT:-${1:-$PWD}}"

  # ---- the environment file ------------------------------------------------
  if [ -n "${AI17Z_ENV_FILE:-}" ]; then
    :
  elif [ -f "$AI17Z_APP_DIR/data-location.txt" ]; then
    local pointer
    pointer="$(head -n1 "$AI17Z_APP_DIR/data-location.txt" | tr -d '\r' | sed 's/[[:space:]]*$//')"
    if [ -n "$pointer" ]; then
      # A relative pointer resolves against the program directory that holds it,
      # never against wherever a shell happened to be standing.
      case "$pointer" in
        /*) AI17Z_ENV_FILE="$pointer/.env" ;;
        *)  AI17Z_ENV_FILE="$AI17Z_APP_DIR/$pointer/.env" ;;
      esac
    fi
  fi
  : "${AI17Z_ENV_FILE:=$AI17Z_APP_DIR/.env}"

  # ---- everything derived from it -----------------------------------------
  AI17Z_DATA_DIR="$(dirname "$AI17Z_ENV_FILE")"

  # In a checkout the data directory *is* the script directory, and `./storage`
  # is what a developer already has. In a packaged install it is somewhere else
  # entirely, and the program directory is replaced on every update -- so
  # anything written beside the program would be destroyed by the next one.
  : "${AI17Z_STORAGE_DIR:=$AI17Z_DATA_DIR/storage}"
  : "${AI17Z_BROWSER_PROFILES:=$AI17Z_DATA_DIR/browser-profiles}"
  : "${AI17Z_STATE_DIR:=$AI17Z_DATA_DIR}"

  export AI17Z_APP_DIR AI17Z_ENV_FILE AI17Z_DATA_DIR AI17Z_STORAGE_DIR
  export AI17Z_BROWSER_PROFILES AI17Z_STATE_DIR
}

# The Node this installation runs.
#
# A packaged install has its own, verified against nodejs.org at build time and
# never consulted from PATH: an installation must not change behaviour because
# somebody installed, removed or switched a global Node. A checkout uses
# whatever the developer has, which is the whole point of a checkout.
ai17z_node() {
  if [ -n "${AI17Z_RUNTIME_NODE:-}" ] && [ -x "${AI17Z_RUNTIME_NODE}" ]; then
    printf '%s' "$AI17Z_RUNTIME_NODE"
  else
    printf 'node'
  fi
}

ai17z_npm() {
  local node; node="$(ai17z_node)"
  if [ "$node" != "node" ]; then
    # npm ships beside the bundled node. Running it *through* that node rather
    # than by its shebang is what stops a system node being picked up halfway.
    printf '%s %s' "$node" "$(dirname "$node")/../lib/node_modules/npm/bin/npm-cli.js"
  else
    printf 'npm'
  fi
}

# docker compose, pointed at this installation and no other.
#
# `--env-file` because the environment file is not beside the compose file in a
# packaged install, and `--project-directory` because compose otherwise derives
# the project name from wherever the file is -- which is how an installed copy
# and a developer's checkout ended up as the same project, adopting each other's
# containers and running both against one database volume.
ai17z_compose() {
  local args=(--project-directory "$AI17Z_APP_DIR" -f "$AI17Z_APP_DIR/docker-compose.yml")
  [ -f "$AI17Z_ENV_FILE" ] && args+=(--env-file "$AI17Z_ENV_FILE")
  docker compose "${args[@]}" "$@"
}

# Is one version newer than another?
#
# Asked of the application, never of the shell. Both updaters had their own
# comparison and both were wrong in the same place: `sort -V` on macOS and
# `dpkg --compare-versions` on Ubuntu each rank `1.0.0` *below* `1.0.0-beta.19`,
# because neither implements semver's rule that a release outranks its own
# prereleases. So the finished 1.0.0 would have been refused as "not newer" on
# both platforms. Run against that pair to check, rather than reasoned about.
#
# `compareVersions` in @xbam/shared is the one implementation, reached through
# the same bridge the compatibility gate already uses. This prints `NEWER`,
# `NOT-NEWER`, or nothing at all -- the last meaning the bridge could not
# answer, which is a third outcome and not a synonym for no. The caller decides
# what to do about it, and both callers refuse: guessing with a comparator known
# to be wrong about the most important upgrade there is would be worse than
# stopping.
ai17z_version_is_newer() { # candidate installed
  local root="$AI17Z_APP_DIR"
  [ -f "$root/node_modules/tsx/dist/cli.mjs" ] || return 0
  [ -f "$root/packaging/preflight.mts" ] || return 0
  (cd "$root" && "$(ai17z_node)" "$root/node_modules/tsx/dist/cli.mjs" \
    "$root/packaging/preflight.mts" --newer "$1" "$2" 2>/dev/null) || printf ''
}

# The newest published release tag, found without spending the REST budget.
#
# Reads the releases feed on github.com rather than asking api.github.com. The
# unauthenticated REST allowance is sixty requests an hour per address, and an
# AI17Z installation already spends it elsewhere: an agent told to watch a
# repository polls it through REST, several endpoints at a time. Two
# installations on one connection exhaust sixty an hour between them, and what
# breaks is the updater, which then cannot see a release that is published and
# downloadable. Measured on Windows, where the same coupling exists: the budget
# read 0 of 60 and the updater reported it could not reach GitHub.
#
# The feed is not charged against that allowance (measured: 56 before three
# fetches, 56 after) and it lists prereleases, which `/releases/latest` does
# not and which is every AI17Z release so far.
#
# Prints the tag, or nothing. Nothing is a refusal for the caller to report; it
# is never a reason to guess a version.
ai17z_latest_release_tag() { # repository
  local repository="$1"
  curl -fsSL --proto '=https' --tlsv1.2 --retry 3 \
    "https://github.com/${repository}/releases.atom" 2>/dev/null \
    | grep -o 'releases/tag/[^"]*' | head -1 | sed 's|releases/tag/||'
}

# Where one published file of one release lives, addressed by its own tag.
#
# Exact tag rather than "latest", so what is fetched is decided before the
# request. No API call, which is what keeps an update independent of the
# allowance above.
ai17z_release_asset_url() { # repository tag asset
  printf 'https://github.com/%s/releases/download/%s/%s' "$1" "$2" "$3"
}

# One value out of the environment file.
#
# `tail`, not `head`: a duplicated key resolves last-wins, which is what compose
# itself does, and disagreeing with compose about which port to use produces a
# conflict nobody can see.
ai17z_env_value() {
  local key="$1" fallback="${2:-}" value=""
  if [ -f "$AI17Z_ENV_FILE" ]; then
    value="$(sed -n "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*//p" "$AI17Z_ENV_FILE" \
      | tail -1 | tr -d '"' | tr -d "'" | sed 's/[[:space:]]*$//')"
  fi
  printf '%s' "${value:-$fallback}"
}
