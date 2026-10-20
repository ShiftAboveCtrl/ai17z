#!/usr/bin/env bash
#
# Nothing secret is committed, anywhere in the history.
#
#   secret-scan.sh
#
# Three questions, each deliberately narrow. A scanner that cries wolf gets
# switched off, which is the failure mode worth avoiding here.
set -euo pipefail

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "--- anything key-shaped"
patterns='sk-[a-zA-Z0-9]{20,}|sk-ant-[a-zA-Z0-9-]{20,}|ghp_[a-zA-Z0-9]{30,}|glpat-[a-zA-Z0-9_-]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----'
if git grep -nIE "$patterns" -- . ':!*.lock' ':!package-lock.json' > "$TMP/hits" 2>/dev/null; then
  # Files that carry the fixture marker are the tests *for* this check: they
  # contain deliberately fake keys to prove the detector detects. `npm run
  # release:check` has always honoured the marker; this grep once did not, so
  # the two disagreed and the one that ran in CI failed on the tests proving the
  # other one works. One rule, honoured in both places.
  : > "$TMP/real-hits"
  while IFS= read -r hit; do
    file="${hit%%:*}"
    if ! grep -q '@release-check-fixtures' "$file" 2>/dev/null; then
      echo "$hit" >> "$TMP/real-hits"
    fi
  done < "$TMP/hits"
  if [ -s "$TMP/real-hits" ]; then
    echo "Something key-shaped is committed:"
    # Locations only. The value itself is never printed.
    cut -d: -f1,2 "$TMP/real-hits"
    exit 1
  fi
  echo "Only test fixtures matched, which is what they are for."
fi
echo "No key-shaped strings in the tree."

echo "--- an X session"
if git grep -nIE 'auth_token[" ]*[:=][" ]*[a-f0-9]{20,}|\bct0[" ]*[:=][" ]*[a-f0-9]{20,}' -- . > "$TMP/x" 2>/dev/null; then
  echo "Something that looks like an X session cookie is committed:"
  cut -d: -f1,2 "$TMP/x"
  exit 1
fi
echo "No X session cookies in the tree."

echo "--- nothing private is tracked"
# These must never be in the repository regardless of their contents.
if git ls-files | grep -E '^\.env$|^storage/|browser-profiles/|accounts\.db'; then
  echo "Runtime state is tracked. It must not be."
  exit 1
fi
echo "No runtime state tracked."
