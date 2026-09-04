#!/usr/bin/env bash
# Updates this AI17Z installation to the latest published version.
#
# Your data is not touched: the database, stored API keys, browser profiles and
# agents live in named Docker volumes this never removes, and .env is never
# tracked and never overwritten.
#
# It refuses to run over uncommitted changes. If you have edited anything here,
# that edit is yours and this will not throw it away.
set -euo pipefail
cd "$(dirname "$0")"

step() { printf '  \033[36m%s\033[0m\n' "$1"; }
done_() { printf '  \033[32m%s\033[0m\n' "$1"; }
warn() { printf '  \033[33m%s\033[0m\n' "$1"; }
stop_with_reason() {
  printf '\n  \033[31m%s\033[0m\n' "$1"
  [ -n "${2:-}" ] && printf '  \033[33m%s\033[0m\n' "$2"
  printf '\n'
  exit 1
}

CHECK_ONLY=0
SKIP_START=0
for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=1 ;;
    --skip-start) SKIP_START=1 ;;
  esac
done

printf '\nAI17Z update\n\n'

command -v git >/dev/null 2>&1 || stop_with_reason 'Git is not installed, so there is nothing to update from.' 'Install git, or download the new version and copy your .env into it.'
[ -d .git ] || stop_with_reason 'This folder is not a git checkout, so there is nothing to update from.' 'Download the new version and copy your .env and storage folder into it.'

# A pull over local edits either fails halfway or silently discards work.
dirty="$(git status --porcelain --untracked-files=no || true)"
if [ -n "$dirty" ]; then
  printf '\n  \033[33mThese files have been changed here and are not committed:\033[0m\n'
  printf '%s\n' "$dirty" | head -20 | sed 's/^/    /'
  stop_with_reason 'Updating would throw those changes away.' 'Commit them, or move them somewhere else, then run this again. Your .env is not in that list; it is never tracked and never touched.'
fi

branch="$(git rev-parse --abbrev-ref HEAD)"
before="$(git rev-parse --short HEAD)"
step "Checking for a newer version on $branch..."
git fetch --quiet --tags || stop_with_reason 'Could not reach the remote.' 'Check the network and try again.'

behind="$(git rev-list --count "HEAD..origin/$branch" 2>/dev/null || echo 0)"
if [ "$behind" -eq 0 ]; then
  done_ "Already up to date (at $before)."
  printf '\n'
  exit 0
fi

# Whether the update can be applied at all, asked before anything is stopped:
# the merge is fast-forward only, and finding that out after stopping the
# stack leaves somebody down for a reason that was knowable a second earlier.
if ! git merge-base --is-ancestor HEAD "origin/$branch" 2>/dev/null; then
  ahead="$(git rev-list --count "origin/$branch..HEAD" 2>/dev/null || echo some)"
  stop_with_reason "This checkout has $ahead commit(s) the published version does not, so it cannot simply take the update." "Nothing was stopped and nothing was changed. Push or remove those commits, or move this folder aside and install fresh, keeping your .env."
fi

printf '\n  %s change(s) to apply:\n' "$behind"
git --no-pager log --oneline --no-decorate -15 "HEAD..origin/$branch" | sed 's/^/    /'

# Migrations are the part that cannot be undone, so they are named up front.
# Additions only: a plain diff also lists migrations this checkout has and
# the remote does not, so an installation slightly ahead was told three were
# about to be applied when none were coming.
migrations="$(git diff --name-only --diff-filter=A "HEAD..origin/$branch" -- migrations || true)"
if [ -n "$migrations" ]; then
  printf '\n  \033[33m%s database migration(s) will be applied:\033[0m\n' "$(printf '%s\n' "$migrations" | wc -l | tr -d ' ')"
  printf '%s\n' "$migrations" | sed 's|.*/|    |'
  warn 'Migrations only move forward. There is no downgrade.'
fi

if [ "$CHECK_ONLY" -eq 1 ]; then
  printf '\n'
  done_ 'Nothing was changed. Run without --check to apply it.'
  printf '\n'
  exit 0
fi

printf '\n'
step 'Stopping AI17Z...'
./stop-ai17z.sh >/dev/null

step 'Fetching the new version...'
# Fast-forward only: a merge here produces a state that is neither the old
# version nor the new one, in a folder nobody is going to debug.
git merge --ff-only "origin/$branch" || stop_with_reason 'Could not fast-forward to the new version.' 'Your checkout has diverged from the remote.'
after="$(git rev-parse --short HEAD)"
done_ "Now at $after (was $before)."

step 'Installing dependencies...'
npm install --no-audit --no-fund

step 'Rebuilding the containers...'
docker compose build api web worker

if [ "$SKIP_START" -eq 1 ]; then
  printf '\n'
  done_ "Updated to $after and left stopped, as asked."
  warn 'Migrations have NOT been applied yet. Starting will apply them.'
  printf '  Start  ./start-ai17z.sh\n\n'
  exit 0
fi

# start-ai17z.sh runs the migrations itself and waits for the API. One script
# owns starting.
step 'Starting AI17Z again...'
./start-ai17z.sh

printf '\n'
done_ "Updated from $before to $after."
printf '\n'
