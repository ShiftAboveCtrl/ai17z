#!/usr/bin/env bash
#
# Where every Unix script looks for its environment file, run rather than read.
#
#   docker run --rm -v "$PWD:/repo:ro" -w /repo ubuntu:24.04 bash /repo/packaging/unix/test-paths.sh
#
# The three cases are the three kinds of installation that exist, and the
# resolver has to get all of them right from the same code: a packaged install
# told outright where its data is, an installation found through the pointer
# beside its program, and a developer's checkout that has neither.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
REPO="$PWD"

pass=0; fail=0
ok()   { printf '  ok    %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  FAIL  %s\n' "$1"; fail=$((fail+1)); }
is()   { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1"; printf '        expected %s\n        got      %s\n' "$3" "$2"; fi; }

ROOM="$(mktemp -d)"
trap 'rm -rf "$ROOM"' EXIT

resolve() { # app_dir -> prints "envfile|datadir|storage"
  ( set +u
    unset AI17Z_ENV_FILE AI17Z_DATA_DIR AI17Z_STORAGE_DIR AI17Z_BROWSER_PROFILES AI17Z_APP_ROOT AI17Z_STATE_DIR
    [ -n "${OVERRIDE_ENV_FILE:-}" ] && export AI17Z_ENV_FILE="$OVERRIDE_ENV_FILE"
    # shellcheck source=/dev/null
    . "$REPO/packaging/unix/ai17z-paths.sh"
    ai17z_resolve_paths "$1"
    printf '%s|%s|%s' "$AI17Z_ENV_FILE" "$AI17Z_DATA_DIR" "$AI17Z_STORAGE_DIR" )
}

echo "### 1. a packaged install, told outright where its data is"
mkdir -p "$ROOM/pkg/app" "$ROOM/owner-config/ai17z"
got="$(OVERRIDE_ENV_FILE="$ROOM/owner-config/ai17z/.env" resolve "$ROOM/pkg/app")"
is "AI17Z_ENV_FILE wins"        "${got%%|*}"     "$ROOM/owner-config/ai17z/.env"
is "data directory follows it"  "$(echo "$got" | cut -d'|' -f2)" "$ROOM/owner-config/ai17z"
is "storage is beside the data" "$(echo "$got" | cut -d'|' -f3)" "$ROOM/owner-config/ai17z/storage"

echo
echo "### 1b. an explicit env file outranks a pointer that disagrees"
# The case that makes the explicit branch load-bearing. Without it the pointer
# would overwrite what the caller said, and a packaged launcher that knows
# exactly where its data is would be sent somewhere else by a stale file.
mkdir -p "$ROOM/both/program" "$ROOM/both/pointed" "$ROOM/both/explicit"
printf '%s
' "$ROOM/both/pointed" > "$ROOM/both/program/data-location.txt"
got="$(OVERRIDE_ENV_FILE="$ROOM/both/explicit/.env" resolve "$ROOM/both/program")"
is "the caller's file wins over the pointer" "${got%%|*}" "$ROOM/both/explicit/.env"

echo
echo "### 2. an installation found through the pointer beside its program"
mkdir -p "$ROOM/inst/program" "$ROOM/inst/data"
printf '%s\n' "$ROOM/inst/data" > "$ROOM/inst/program/data-location.txt"
got="$(resolve "$ROOM/inst/program")"
is "the pointer is followed"    "${got%%|*}" "$ROOM/inst/data/.env"
is "storage is under the data"  "$(echo "$got" | cut -d'|' -f3)" "$ROOM/inst/data/storage"

echo
echo "### 3. a relative pointer resolves against the program, not the cwd"
mkdir -p "$ROOM/rel/program" "$ROOM/rel/program/mydata"
printf 'mydata\n' > "$ROOM/rel/program/data-location.txt"
got="$(cd /tmp && resolve "$ROOM/rel/program")"
is "relative to the program"    "${got%%|*}" "$ROOM/rel/program/mydata/.env"

echo
echo "### 4. a developer's checkout, which must keep working exactly as before"
mkdir -p "$ROOM/clone"
got="$(resolve "$ROOM/clone")"
is "the .env beside the script" "${got%%|*}" "$ROOM/clone/.env"
is "and ./storage beside it"    "$(echo "$got" | cut -d'|' -f3)" "$ROOM/clone/storage"

echo
echo "### 5. a pointer with nothing in it is a broken install, not a hint"
mkdir -p "$ROOM/empty/program"
: > "$ROOM/empty/program/data-location.txt"
got="$(resolve "$ROOM/empty/program")"
is "falls back rather than guessing" "${got%%|*}" "$ROOM/empty/program/.env"

echo
echo "### 6. values are read from the resolved file, last-wins like compose"
mkdir -p "$ROOM/vals"
printf 'AI17Z_API_PORT=1111\nAI17Z_API_PORT=2222\nAI17Z_WEB_PORT="3333"\n' > "$ROOM/vals/.env"
got="$( set +u
  # shellcheck source=/dev/null
  . "$REPO/packaging/unix/ai17z-paths.sh"
  ai17z_resolve_paths "$ROOM/vals"
  printf '%s %s %s' "$(ai17z_env_value AI17Z_API_PORT 9)" "$(ai17z_env_value AI17Z_WEB_PORT 9)" "$(ai17z_env_value NOPE 7)" )"
is "duplicate resolves last-wins, quotes stripped, default used" "$got" "2222 3333 7"

echo
echo "### 7. the private runtime is used when present, never PATH"
got="$( set +u
  # shellcheck source=/dev/null
  . "$REPO/packaging/unix/ai17z-paths.sh"
  printf '%s' "$(ai17z_node)" )"
is "a checkout uses whatever the developer has" "$got" "node"
mkdir -p "$ROOM/rt/bin"; printf '#!/bin/sh\necho fake\n' > "$ROOM/rt/bin/node"; chmod +x "$ROOM/rt/bin/node"
got="$( set +u
  export AI17Z_RUNTIME_NODE="$ROOM/rt/bin/node"
  # shellcheck source=/dev/null
  . "$REPO/packaging/unix/ai17z-paths.sh"
  printf '%s' "$(ai17z_node)" )"
is "a package uses its own" "$got" "$ROOM/rt/bin/node"

echo
echo "### 8. compose is pointed at this installation and no other"
got="$( set +u
  # shellcheck source=/dev/null
  . "$REPO/packaging/unix/ai17z-paths.sh"
  ai17z_resolve_paths "$ROOM/vals"
  docker() { printf '%s\n' "$*"; }
  export -f docker 2>/dev/null || true
  ai17z_compose ps -q )"
case "$got" in
  *"--project-directory $ROOM/vals"*) ok "compose names the project directory" ;;
  *) bad "compose did not name the project directory: $got" ;;
esac
case "$got" in
  *"--env-file $ROOM/vals/.env"*) ok "compose is given the resolved env file" ;;
  *) bad "compose did not get the env file: $got" ;;
esac

echo
printf '  %s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
