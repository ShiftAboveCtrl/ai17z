#!/usr/bin/env bash
#
# Everything a stranger can check about a published AI17Z release, from the
# published bytes alone.
#
#   verify-published-release.sh <tag>
#
# Nothing here reads a build output or a job artifact. It asks AI17Z Code what
# the release has, downloads all of it as somebody who is not signed in, hashes
# every file against the release's own SHA256SUMS.txt, reads
# release-manifest.json back and checks it against the files that actually
# arrived, and verifies each file's Sigstore bundle against AI17Z's release key,
# the public half of which is .forgejo/cosign.pub in this repository.
#
# That last check is here because the equivalent was once wrong. The attestation
# step of the GitHub release named paths belonging to a different job, failed,
# and was made green by `continue-on-error`, so Beta 1.0.0 (16) was published
# claiming build provenance while every one of its assets answered 404. A claim
# nothing checks is a claim that stops being true without anybody noticing.
set -uo pipefail

TAG="${1:?a tag, such as v1.0.0-beta.85}"
VERSION="${TAG#v}"
PROJECT="${GITHUB_REPOSITORY:-AI17Z/ai17z}"
SERVER="https://code.ai17z.io"
API="$SERVER/api/v1/repos/$PROJECT"
DL="$SERVER/$PROJECT/releases/download/$TAG"
# Who may have signed: AI17Z's release key, from this checkout.
SIGNER_PUB="${SIGNER_PUB:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/cosign.pub}"
COSIGN="${COSIGN:-cosign}"

pass=0; fail=0
failures=""
ok()  { printf '  ok      %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  FAIL    %s\n' "$1"; fail=$((fail+1)); failures="$failures
    $1"; }

ROOM="$(mktemp -d)"
cd "$ROOM" || exit 1

echo "### what the release says it is"
curl -fsSL -H 'Accept: application/json' "$API/releases/tags/$TAG" > release.json \
  || { echo "there is no release at $TAG"; exit 1; }

jq -r '
  "  name        \(.name)",
  "  tag         \(.tag_name)",
  "  published   \(.published_at)",
  "  draft       \(.draft)",
  "  prerelease  \(.prerelease)",
  "  files       \(.assets | length)"
' release.json
jq -r '.assets[] | "    \(.name)"' release.json | sort

# A draft is not out, and a release whose tag is not the one asked for is a
# different release.
if [ "$(jq -r '.draft' release.json)" = false ]; then ok "it is published rather than a draft"; else bad "it is still a draft"; fi
if [ "$(jq -r '.tag_name' release.json)" = "$TAG" ]; then ok "the tag is $TAG"; else bad "the tag is not $TAG"; fi
# A release whose name is its tag is one nobody wrote a name for.
name="$(jq -r '.name // empty' release.json)"
if [ -n "$name" ] && [ "$name" != "$TAG" ]; then ok "it has a name of its own: $name"; else bad "it has no name but its tag"; fi
# Every file must be served at the address the installers compose, and a name
# must appear once: Forgejo accepts a second attachment under a name a release
# already has, and two files under one name is two answers to one download.
indirect="$(jq -r --arg tag "$TAG" '.assets[] | select((.browser_download_url // "") | endswith("/releases/download/\($tag)/\(.name)") | not) | .name' release.json)"
if [ -z "$indirect" ]; then ok "every file is served at its own name"; else bad "served somewhere else: $(echo $indirect)"; fi
dupes="$(jq -r '.assets[].name' release.json | sort | uniq -d)"
if [ -z "$dupes" ]; then ok "no name is attached twice"; else bad "attached more than once: $(echo $dupes)"; fi

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
    # narrow. Notes, a manifest, a report and the signature bundles are read,
    # not unpacked, and putting them in that list would say they are something
    # they are not.
    case "$name" in
      SHA256SUMS.txt|release-manifest.json|release-notes.md|RELEASE_VALIDATION_REPORT.md|AI17Z-Setup-Audit-*|*.sigstore.json) continue ;;
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
  # A platform the release deliberately did not build is said so in the
  # manifest, and is reported here as what it is rather than as a fault.
  for platform in windows macos ubuntu; do
    if [ "$(jq -r ".platforms.$platform.supported" assets/release-manifest.json)" = true ]; then
      ok "$platform is supported"
    elif [ "$(jq -r ".platforms.$platform.notBuilt // empty" assets/release-manifest.json)" != "" ]; then
      ok "$platform was not built for this release, and the manifest says why: $(jq -r ".platforms.$platform.notBuilt" assets/release-manifest.json)"
    else
      bad "the manifest says $platform is not supported, and gives no reason"
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
echo "### release provenance, as a stranger would ask for it"
echo "  signer must be the key in $SIGNER_PUB"
for name in "${ASSETS[@]}"; do
  # Published from the checkout rather than built, so it is not a build subject
  # and is not claimed to be one. And a bundle is the signature itself.
  #
  # The lists that decide what a published file owes are held against each
  # other by a test: `release-notes.md` once missed one of them, which cost a
  # second release after the first was spent on missing the checksum list.
  case "$name" in
    RELEASE_VALIDATION_REPORT.md|release-notes.md|*.sigstore.json) continue ;;
  esac
  [ -f "assets/$name" ] || continue
  if [ ! -f "assets/$name.sigstore.json" ]; then
    bad "$name has no signature bundle"
    continue
  fi
  if "$COSIGN" verify-blob "assets/$name" \
       --bundle "assets/$name.sigstore.json" \
       --key "$SIGNER_PUB" > verify.log 2>&1; then
    ok "$name is signed by AI17Z's release key, and is in the transparency log"
  else
    sed 's/^/    /' verify.log
    bad "$name does not verify against AI17Z's release key"
  fi
done

echo
[ "$fail" -eq 0 ] || printf '\n  what failed:%b\n' "$failures"
echo "  published release $TAG: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
