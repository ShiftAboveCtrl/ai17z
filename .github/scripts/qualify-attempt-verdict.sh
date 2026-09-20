#!/usr/bin/env bash
#
# What one install attempt meant, as a value rather than as prose.
#
# Sourced by the published-release qualifiers so the decision has one
# implementation and can be exercised without a runner, a network or a release.
# Everything here is a pure function of an exit code and the text an attempt
# produced.
#
# The distinction that matters is between a runner that could not ask and a
# release that is wrong. GitHub allows sixty API requests an hour to an address
# that is not signed in, a hosted runner shares its address with whoever else is
# on that machine, and the published installer is unauthenticated by design
# because that is what a stranger runs. So an attempt can fail for a reason that
# says nothing whatever about the package.
#
# Measured across three releases: the macOS arm64 runner was refused twice,
# ninety seconds apart, on two of them, while the Intel Mac beside it installed
# the same release from the same URLs.

# attempt_verdict <exit-code> <output-text>
#
#   OK       the attempt succeeded
#   CEILING  it failed because GitHub would not answer an anonymous caller
#   FAILED   it failed for a reason that belongs to the release or the machine
#
# CEILING is never inferred from the exit code alone: a non-zero exit with
# nothing to say is FAILED, because an empty string is not evidence of a rate
# limit. That mattered, once: a job matched a rate-limit code in output that was
# empty on every run, so the retry it appeared to have could never fire.
attempt_verdict() {
  local code="${1:-1}"
  local text="${2:-}"

  if [ "$code" -eq 0 ]; then
    printf 'OK'
    return 0
  fi

  # The shapes GitHub's refusal actually takes, seen in the logs rather than
  # imagined: curl's own 403 line, a bare 429, the installer's own sentence
  # when it could not resolve a release, and the header GitHub sets when it
  # wants a caller to wait.
  if printf '%s' "$text" | grep -qiE '\(403\)|error: 403|\b403 Forbidden\b|\b429\b|rate.?limit|retry-after|could not be read|could not be reached|API rate limit'; then
    printf 'CEILING'
    return 0
  fi

  printf 'FAILED'
}

# Whether an attempt is worth trying again.
#
# Any failure is, exactly once. The retry turns on the attempt having failed
# rather than on what it managed to print, because the thing that failed is the
# attempt and a transient network error says as little as an empty string does.
should_retry() {
  [ "${1:-1}" -ne 0 ]
}
