#!/usr/bin/env bash
#
# Everything a stranger can check about a published AI17Z release, from the
# published bytes alone.
#
#   verify-published-release.sh <tag>
#
# Nothing here reads a build output or a workflow artifact. It asks GitHub what
# the release has, downloads all of it, hashes every file against the release's
# own SHA256SUMS.txt, reads release-manifest.json back and checks it against the
# files that actually arrived, and asks the attestations API whether each one
# carries build provenance.
#
# That last check is here because it is the one that was wrong. The attestation
# step in the release workflow named paths belonging to a different job, failed,
# and was made green by `continue-on-error` -- so Beta 1.0.0 (16) was published
# claiming build provenance while every one of its assets answered 404. A claim
# nothing checks is a claim that stops being true without anybody noticing.
set -uo pipefail

TAG="${1:?a tag, such as v1.0.0-beta.17}"
VERSION="${TAG#v}"
REPO="${GITHUB_REPOSITORY:-ShiftAboveCtrl/ai17z}"
API="https://api.github.com/repos/$REPO"
DL="https://github.com/$REPO/releases/download/$TAG"

pass=0; fail=0
failures=""
ok()  { printf '  ok      %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  FAIL    %s\n' "$1"; fail=$((fail+1)); failures="$failures
    $1"; }

# The API calls below are all of public data and work signed out. A token is
# used when one is offered purely for the rate limit: unauthenticated GitHub
# allows sixty requests an hour per address, and a runner shares its address
# with whoever else is on that machine. Being throttled would look exactly like
# a release that has no attestations, which is the one answer this must never
# get wrong by accident.
AUTH=()
[ -n "${GITHUB_TOKEN:-}" ] && AUTH=(-H "Authorization: Bearer $GITHUB_TOKEN")

ROOM="$(mktemp -d)"
cd "$ROOM" || exit 1

echo "### what the release says it is"
curl -fsSL "${AUTH[@]}" -H 'Accept: application/vnd.github+json' "$API/releases/tags/$TAG" > release.json \
  || { echo "::error::there is no release at $TAG"; exit 1; }

jq -r '
  "  name        \(.name)",
  "  tag         \(.tag_name)",
  "  prerelease  \(.prerelease)",
  "  draft       \(.draft)",
  "  published   \(.published_at)",
  "  assets      \(.assets | length)"
' release.json
jq -r '.assets[] | "    \(.name)  \(.size) bytes"' release.json | sort

# A draft is not published, and a release whose tag is not the one asked for is
# a different release.
if [ "$(jq -r '.draft' release.json)" = false ]; then ok "it is published rather than a draft"; else bad "it is still a draft"; fi
if [ "$(jq -r '.tag_name' release.json)" = "$TAG" ]; then ok "the tag is $TAG"; else bad "the tag is not $TAG"; fi
# GitHub renders a title that is only the tag as no title at all, so a release
# whose name is its tag is one nobody wrote a name for.
name="$(jq -r '.name // empty' release.json)"
if [ -n "$name" ] && [ "$name" != "$TAG" ]; then ok "it has a name of its own: $name"; else bad "it has no name but its tag"; fi

echo
echo "### downloading every asset"
mkdir -p assets
mapfile -t ASSETS < <(jq -r '.assets[].name' release.json)
for name in "${ASSETS[@]}"; do
  curl -fsSL -o "assets/$name" "$DL/$name" || bad "could not download $name"
done
echo "  $(find assets -type f | wc -l | tr -d ' ') files"

echo
echo "### every hash the release published"
if [ -f assets/SHA256SUMS.txt ]; then
  if ( cd assets && sha256sum -c SHA256SUMS.txt ) > sums.log 2>&1; then
    sed 's/^/    /' sums.log
    ok "every checksummed asset matches"
  else
    sed 's/^/    /' sums.log
    bad "a checksum does not match"
  fi
  # And the other way round: a package published with no line in the file is one
  # no installer will accept, because none of them will unpack a payload whose
  # hash they cannot establish.
  missing=0
  for name in "${ASSETS[@]}"; do
    # What is published alongside the packages rather than installed from.
    #
    # The checksums are the installable trust chain and nothing else: the
    # command and the setup program both refuse a payload whose hash they
    # cannot establish against this file, which is exactly why the list is
    # narrow. Notes, a manifest and two reports are read, not unpacked, and
    # putting them in that list would say they are something they are not.
    #
    # `release-notes.md` was added to the release before it was added here,
    # and this is the check that caught it.
    case "$name" in
      SHA256SUMS.txt|release-manifest.json|release-notes.md|RELEASE_VALIDATION_REPORT.md|AI17Z-Setup-Audit-*) continue ;;
    esac
    grep -q "  $name\$" assets/SHA256SUMS.txt || { bad "$name is published with no hash"; missing=1; }
  done
  [ "$missing" = 0 ] && ok "every installable asset has a line"
else
  bad "there is no SHA256SUMS.txt"
fi

echo
echo "### the manifest against the files that arrived"
if [ -f assets/release-manifest.json ]; then
  jq -r '
    "  schema \(.schemaVersion)  version \(.version)  tag \(.tag)",
    "  commit \(.commit)",
    "  built  \(.builtBy // "not recorded")",
    (.platforms | to_entries[] |
      "  \(.key): supported=\(.value.supported) arch=\(.value.architectures | join(",")) node=\(.value.requirements.bundledNode)")
  ' assets/release-manifest.json

  [ "$(jq -r '.version' assets/release-manifest.json)" = "$VERSION" ] \
    && ok "the manifest is for $VERSION" || bad "the manifest names another version"
  for platform in windows macos ubuntu; do
    if [ "$(jq -r ".platforms.$platform.supported" assets/release-manifest.json)" = true ]; then
      ok "$platform is supported"
    else
      bad "the manifest says $platform is not supported"
    fi
  done

  wrong=0
  while IFS=$'\t' read -r name digest size; do
    if [ ! -f "assets/$name" ]; then
      bad "the manifest names $name and the release has no such asset"; wrong=1; continue
    fi
    got="$(sha256sum "assets/$name" | awk '{print $1}')"
    actual="$(stat -c '%s' "assets/$name")"
    if [ "$got" != "$digest" ]; then
      bad "$name hashes ${got:0:16} and the manifest says ${digest:0:16}"; wrong=1
    elif [ "$actual" != "$size" ]; then
      bad "$name is $actual bytes and the manifest says $size"; wrong=1
    else
      echo "    ok  $name  ${digest:0:16}  $size bytes"
    fi
  done < <(jq -r '.artifacts[] | [.name, .sha256, .bytes] | @tsv' assets/release-manifest.json)
  [ "$wrong" = 0 ] && ok "the manifest tells the truth about every artifact it names"
else
  bad "there is no release-manifest.json"
fi

echo
echo "### build provenance, as a stranger would ask for it"
for name in "${ASSETS[@]}"; do
  # Published from the checkout rather than built, so it is not a build subject
  # and is not claimed to be one.
  [ "$name" = RELEASE_VALIDATION_REPORT.md ] && continue
  [ -f "assets/$name" ] || continue
  digest="$(sha256sum "assets/$name" | awk '{print $1}')"
  code="$(curl -s -o "att.json" -w '%{http_code}' "${AUTH[@]}" \
    -H 'Accept: application/vnd.github+json' "$API/attestations/sha256:$digest")"
  if [ "$code" = 200 ] && [ "$(jq -r '.attestations | length' att.json 2>/dev/null || echo 0)" -gt 0 ]; then
    ok "$name is attested"
  elif [ "$code" = 403 ] || [ "$code" = 429 ]; then
    # Rate limited. Saying "no attestation" here would be the same mistake in
    # the other direction from the one this whole check exists for.
    bad "the attestations API throttled this run (HTTP $code); $name is unanswered"
  else
    bad "$name has no attestation (HTTP $code)"
  fi
done

echo
[ "$fail" -eq 0 ] || printf '\n  what failed:%b\n' "$failures"
echo "  published release $TAG: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
