# Code signing policy

How AI17Z's Windows releases are built, signed and verified, and who is allowed
to approve a signature.

Free code signing provided by [SignPath.io](https://about.signpath.io),
certificate by [SignPath Foundation](https://signpath.org).

---

## What gets signed

One artifact: the Windows installer.

```
AI17Z-Setup-<version>.exe
```

It carries product and version metadata (`AI17Z`, the release version, the
publisher and a description), which SignPath requires and which a person can
read in the file's properties before running it.

Nothing else is signed. AI17Z is otherwise installed from source, and the
installer is the only binary we ask anybody to run.

## Where it is built

On a GitHub-hosted runner, from a tagged commit in the public repository, by
`.github/workflows/release.yml`. Nothing is built on a maintainer's machine and
uploaded, so what is signed is what the public source produces.

The build:

1. checks out the tag
2. installs dependencies from the committed lockfile
3. runs typecheck, the full test suite and the release-cleanliness check
4. stages the application with `npm run package:windows`
5. compiles the installer with Inno Setup
6. uploads it as a GitHub Actions artifact

SignPath then verifies the artifact's origin — repository, branch, commit and
workflow — before any signature is issued. That origin check is the reason the
build has to happen on the hosted runner rather than anywhere convenient.

## Who approves a signature

AI17Z is currently maintained by one person, and this section says so rather
than inventing a team.

| Role | Who |
| --- | --- |
| **Authors** — may write code and open pull requests | [@ShiftAboveCtrl](https://github.com/ShiftAboveCtrl) |
| **Reviewers** — review changes before they reach `main` | [@ShiftAboveCtrl](https://github.com/ShiftAboveCtrl) |
| **Approvers** — may approve a signing request | [@ShiftAboveCtrl](https://github.com/ShiftAboveCtrl) |

Every signing request is **approved manually** in SignPath. There is no policy
that signs automatically on a push, so a compromised workflow cannot produce a
signed artifact without a person approving it.

If more maintainers join, this table changes before they are given a role.

## Multi-factor authentication

Multi-factor authentication is required for every person holding any of the
roles above, on **both** GitHub and SignPath. This is a SignPath Foundation
condition and it is also the only thing standing between a stolen password and a
signed release.

## What we do not sign

- Anything built from a fork, or from a branch that is not the release tag
- Anything a maintainer built locally
- Any artifact whose origin SignPath cannot verify
- Anything containing a component that is not open source

## If signing fails

The release fails. The workflow will not publish an unsigned installer where a
signed one was expected, and it verifies the returned artifact — signature
status, product name and version — before anything is attached to a release.

There is a separate, clearly labelled lane for **unsigned** builds, used while
this application is pending. Those releases say so on the release page and in
the artifact's build information, and they are never published as if they were
signed.

## Reporting a problem

Security issues: see [SECURITY.md](../SECURITY.md).

If you believe an AI17Z installer has been tampered with, do not run it. Open a
security report, and include the SHA-256 of the file you have. Every release
publishes `SHA256SUMS.txt` beside the installer.
