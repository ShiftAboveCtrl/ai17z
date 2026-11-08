# Release validation

This document describes the gates required by the current GitHub release
workflow. It is attached to each release. The workflow run linked from
`release-manifest.json` is the execution record for that specific commit;
this document alone is not evidence that a hosted run passed.

## Required checks

The reusable CI job runs lint, TypeScript checks, the release contract check,
all unit and integration tests with Postgres 16, the public history scanner,
offline publisher tests and the web build. PR jobs name no secrets.

The release workflow builds five native packages:

| Package | Hosted runner |
| --- | --- |
| Windows x64 | `windows-2025` |
| Ubuntu amd64 | `ubuntu-24.04` |
| Ubuntu arm64 | `ubuntu-24.04-arm` |
| macOS arm64 | `macos-15` |
| macOS x64 | `macos-15-intel` |

The native package scripts check the bundled runtime and platform payload.
The Windows job compiles the Inno installer and checks its version resources.
A missing native output blocks publication.

The publish job requires successful CI and all native build jobs. It scans
the complete history with the private maintainer list, unpacks the application
archives, builds the release manifest and setup audit, generates SHA256SUMS,
and creates and verifies cosign bundles. Before any attachment is uploaded it
scans the complete attachment list, including generated documents, signatures
and the extracted Inno installer contents. Missing scanner tools, unreadable
archives, unavailable secrets and signature failures stop the release.

Publication creates a draft, uploads every declared attachment, and downloads
every attachment to compare its name, size and SHA-256 with the local file.
Only a complete match permits publication. The read-only qualification job
then checks the public manifest, checksums and cosign bundles.

## Limits and operator checks

A local test run or workflow syntax check does not establish hosted runner
availability, native packaging success, successful secret provisioning or
compatibility between the selected Inno compiler and innoextract. Run the
rehearsal tag workflow and inspect all five packages before the first release
from this workflow. A rehearsal scans and signs files but creates no release.

Cosign bundles establish release-key provenance. They do not provide Windows
Authenticode signing, Apple signing or notarization, or Debian archive signing.
See the platform trust documents for installation behavior.

Windows installation verification (`npm run verify:install -- --twice --upgrade`)
is a separate maintainer gate. Run the platform installation qualification
scripts against published bytes before updating installed instances. Record
the candidate commit, test counts, commands and remaining limitations in the
maintainer's gate report. GitHub publication and Forgejo synchronization are
separate operations; verify the mirror's refs and release hashes after sync.

See [RELEASING.md](RELEASING.md), [WINDOWS_TRUST.md](WINDOWS_TRUST.md),
[MACOS_TRUST.md](MACOS_TRUST.md) and
[the backup runbook](operations/FORGEJO_BACKUP.md).
