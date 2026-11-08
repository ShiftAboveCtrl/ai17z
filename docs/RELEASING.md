# Releasing AI17Z

Releases are built by [GitHub Actions](https://github.com/ShiftAboveCtrl/ai17z/actions/workflows/release.yml).
The shared scripts live in `ci/scripts/`. AI17Z Code receives code through its
pull mirror and release files through the [backup sync](operations/FORGEJO_BACKUP.md).

## Before tagging

Use an unused strict semver tag. The tag and `package.json` version must agree,
including both lockfile version entries. Keep release notes in
`docs/release-notes/<version>.md`. `v1.0.0-beta.89` is titled **Beta 0.89**;
`v1.0.0-beta.100` is **Beta 1.00**. The app and installer may prefix AI17Z.
RC and stable naming are unchanged. Betas and release candidates are marked
prerelease on GitHub, so use the releases list to find them, not `/latest`.

Run, on the exact candidate tree, with Git Bash first on PATH on Windows:

```bash
npm run lint
npm run typecheck
npx vitest run tests/unit
npx vitest run tests/integration
npm run release:check
npm run verify:install -- --twice --upgrade
```

Integration tests require disposable Postgres databases. Stage all new source
files before `release:check`. Scan the complete candidate history with the
maintainer's privacy scanner. Never bypass a hook or publish a candidate that
failed a gate. Back up and compare Windows registration state around installation
verification. The harness must only target its own temporary installations.

## GitHub setup

The `release` environment holds `COSIGN_PRIVATE_KEY`, `COSIGN_PASSWORD` and
`PRIVATE_IDENTIFIERS`. Only the publish step names these secrets. The workflow
uses its short-lived GitHub token with `contents: write` in the publish job;
all other jobs have read access. Configure the release environment to permit
protected `v*` and rehearsal tags. PR CI never names a secret.

For a rehearsal, push `rehearsal-v<version>` on the candidate. It takes the same
checks, five native packages, privacy scans and cosign signing steps and stores
the result as a workflow artifact without publishing a release.
Inspect that artifact and remove the rehearsal tag when finished.

## Publish and verify

1. Merge the gated candidate to main and push an annotated `v<version>` tag.
   Never move an existing release tag.
2. Watch the Release workflow. It checks the tag/version agreement, runs full CI
   with Postgres, builds Windows x64, Ubuntu amd64/arm64 and macOS arm64/x64 on
   native hosted runners, scans history and every attachment with the private
   list, creates `SHA256SUMS.txt`, and signs every installable artifact, manifest,
   audit and checksum list with cosign.
3. Publication creates a draft, attaches the complete file set, downloads every
   attachment to compare names, sizes and SHA-256 hashes, then publishes. An
   existing release is refused, and a failed comparison leaves an unpublished
   draft for inspection. A published immutable release is never repaired in place.
4. The read-only qualification job verifies the published manifest, hashes and
   cosign bundles. Exercise the platform installer scripts against those public
   bytes as documented in the platform checklists. Platform signatures and
   notarization are not supplied by cosign.
5. Confirm the backup timer copied the release. Run its `--check` mode, compare
   refs, and run `verify-published-release.sh` with `AI17Z_RELEASE_SOURCE=aicode`.

A native runner label, quota, missing secret, unsupported Inno extraction format,
or failed signature can block publication. Resolve the failure and rerun the
unpublished candidate. If an immutable release was published, use a new version.
