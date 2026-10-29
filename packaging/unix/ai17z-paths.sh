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

# Where a release is fetched from, in order: GitHub, then AI17Z Code.
#
# GitHub is the copy people know, and every release is mirrored there with
# every file an updater fetches. AI17Z Code, AI17Z's own Forgejo, is the source
# of truth and the fallback: with GitHub unreachable, refusing or behind, every
# update still completes from there. The same list as RELEASE_SOURCES in
# packages/shared/src/releaseManifest.ts, held there by
# tests/unit/releaseSources.test.ts.
AI17Z_SOURCE_NAMES=("GitHub" "AI17Z Code")
AI17Z_SOURCE_LISTS=(
  "https://api.github.com/repos/ShiftAboveCtrl/ai17z/releases?per_page=10"
  "https://code.ai17z.io/api/v1/repos/AI17Z/ai17z/releases?limit=10"
)
AI17Z_SOURCE_DOWNLOADS=(
  "https://github.com/ShiftAboveCtrl/ai17z/releases/download"
  "https://code.ai17z.io/AI17Z/ai17z/releases/download"
)
# Every host a download may start at or be redirected to. GitHub answers a
# release download with a redirect to its own storage host, so the host that
# answered is judged as well as the one asked.
AI17Z_DOWNLOAD_HOSTS="api.github.com github.com release-assets.githubusercontent.com objects.githubusercontent.com code.ai17z.io"

# Whether an address is HTTPS on a host above. Exact names only: no suffix
# match, because github.com.example.net ends in nothing this trusts.
ai17z_url_allowed() { # url
  local host
  case "$1" in
    https://*) host="${1#https://}"; host="${host%%/*}" ;;
    *) return 1 ;;
  esac
  case " $AI17Z_DOWNLOAD_HOSTS " in *" $host "*) return 0 ;; esac
  return 1
}

# One file, refused before the request if the address is not allowed and
# deleted after it if the address that answered is not. `--proto-redir` keeps a
# redirect on HTTPS too.
ai17z_fetch() { # destination url
  local landed
  ai17z_url_allowed "$2" || return 2
  landed="$(curl -fsSL --proto '=https' --proto-redir '=https' --tlsv1.2 --retry 3 --max-redirs 5 \
    -w '%{url_effective}' -o "$1" "$2" 2>/dev/null)" || { rm -f "$1"; return 1; }
  if [ -n "$landed" ] && ! ai17z_url_allowed "$landed"; then rm -f "$1"; return 2; fi
}

# The newest release's tag, from the first source whose list answers.
#
# Not /releases/latest, which is the server choosing; the list is read and the
# first tag taken. It lists prereleases, which every AI17Z release so far is,
# and never a draft to a caller that is not signed in. GitHub's Latest label
# decides nothing.
#
# GitHub's API allows sixty anonymous requests an hour per address, and an
# agent watching a GitHub repository from this machine spends from the same
# allowance. A refusal from GitHub is therefore expected now and then, and it
# is answered by asking AI17Z Code, never by giving up.
#
# Prints the tag, or nothing. Nothing is a refusal for the caller to report; it
# is never a reason to guess a version.
#
# Given an asset name with <version> in it, the newest release that publishes
# that file for its own version. A release can lack one platform's package
# (one that needed a machine nobody had that day) and the newest release is
# then the wrong answer for that platform, not a reason to stop: an updater
# offers the newest it can actually install. Asset names carry the version, so
# matching the name in the list cannot pick up another release's file.
ai17z_latest_release_tag() { # [asset named with <version>]
  local template="${1:-}" json tag asset index
  for index in "${!AI17Z_SOURCE_LISTS[@]}"; do
    json="$(curl -fsSL --proto '=https' --proto-redir '=https' --tlsv1.2 --retry 3 \
      "${AI17Z_SOURCE_LISTS[$index]}" 2>/dev/null)" || continue
    for tag in $(printf '%s' "$json" | grep -o '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"\([^"]*\)"$/\1/'); do
      if [ -z "$template" ]; then printf '%s\n' "$tag"; return 0; fi
      asset="${template//<version>/${tag#v}}"
      if printf '%s' "$json" | grep -qF "\"${asset}\""; then printf '%s\n' "$tag"; return 0; fi
    done
  done
}

# Where one published file of one release lives on one source, by exact tag.
#
# Exact tag rather than "latest", so what is fetched is decided before the
# request.
ai17z_release_asset_url() { # source-index tag asset
  printf '%s/%s/%s' "${AI17Z_SOURCE_DOWNLOADS[$1]}" "$2" "$3"
}

# Several files of one release, all from the first source that has every one.
#
# One source serves them all, so a package is always checked against the
# checksums published beside it, and a failure is never ambiguous about which
# host was wrong. A source missing any file, or breaking off mid-download, is
# cleared out and the next one asked. Prints the name of the source that
# served them; returns 1, having printed nothing, when none could.
ai17z_fetch_release_files() { # directory tag file...
  local directory="$1" tag="$2" index name ok
  shift 2
  for index in "${!AI17Z_SOURCE_DOWNLOADS[@]}"; do
    ok=1
    for name in "$@"; do
      if ! ai17z_fetch "$directory/$name" "$(ai17z_release_asset_url "$index" "$tag" "$name")"; then ok=0; break; fi
    done
    if [ "$ok" = 1 ]; then printf '%s\n' "${AI17Z_SOURCE_NAMES[$index]}"; return 0; fi
    for name in "$@"; do rm -f "$directory/$name"; done
  done
  return 1
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
