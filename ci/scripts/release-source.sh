#!/usr/bin/env bash
#
# Where a published AI17Z release is read from, for the scripts that check one.
#
#   . ci/scripts/release-source.sh            # GitHub, the primary host
#   AI17Z_RELEASE_SOURCE=aicode . ci/scripts/release-source.sh   # the mirror
#
# Sourced. Sets RELEASE_SOURCE_NAME (what a person is told), RELEASE_PROJECT,
# RELEASE_API (the releases API root for that project) and RELEASE_DOWNLOAD
# (the address a tag's files are served under, without the tag).
#
# GitHub is where releases are built and published, so it is the default.
# AI17Z Code carries a copy made by the release sync on the server
# (tools/forgejo-mirror), and the same checks run against it to prove the copy
# is the release rather than something like it. The two hosts' repositories
# have different names, so the project is chosen here and never read from
# GITHUB_REPOSITORY, which on either host names whichever repository happens to
# be running the job.
#
# The addresses match RELEASE_SOURCES in packages/shared/src/releaseManifest.ts,
# and tests/unit/releaseSources.test.ts holds them together.

case "${AI17Z_RELEASE_SOURCE:-github}" in
  github)
    RELEASE_SOURCE_NAME="GitHub"
    RELEASE_PROJECT="ShiftAboveCtrl/ai17z"
    RELEASE_API="https://api.github.com/repos/$RELEASE_PROJECT"
    RELEASE_DOWNLOAD="https://github.com/$RELEASE_PROJECT/releases/download"
    ;;
  aicode)
    RELEASE_SOURCE_NAME="AI17Z Code"
    RELEASE_PROJECT="AI17Z/ai17z"
    RELEASE_API="https://code.ai17z.io/api/v1/repos/$RELEASE_PROJECT"
    RELEASE_DOWNLOAD="https://code.ai17z.io/$RELEASE_PROJECT/releases/download"
    ;;
  *)
    echo "AI17Z_RELEASE_SOURCE is '${AI17Z_RELEASE_SOURCE}'; it must be github or aicode" >&2
    return 2 2>/dev/null || exit 2
    ;;
esac
export RELEASE_SOURCE_NAME RELEASE_PROJECT RELEASE_API RELEASE_DOWNLOAD
