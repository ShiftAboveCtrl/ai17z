# AI17Z Code backup

[GitHub](https://github.com/ShiftAboveCtrl/ai17z) is the primary repository and
release builder. [AI17Z Code](https://code.ai17z.io/AI17Z/ai17z) is a Forgejo
pull mirror with a separate copy of every published release asset. Installers
and updaters try GitHub first and AI17Z Code second. A checksum mismatch stops
installation; it never selects another host to hide that mismatch.

## Configure the code mirror

Run these commands from a trusted checkout on the backup server with Python 3.11+
and Git. `FORGEJO_TOKEN` is supplied by the server's secret store, with access to
the AI17Z organization and repository. Keep its value out of shell history.

```bash
python3 -I tools/forgejo-mirror/configure.py create
python3 -I tools/forgejo-mirror/configure.py status
python3 -I tools/forgejo-mirror/configure.py sync
```

`create` uses Forgejo's `POST /api/v1/repos/migrate` with `mirror: true`, the
public GitHub clone URL and a ten-minute interval, then disables Actions. It
refuses if `AI17Z/ai17z` already exists. An ordinary repository cannot be
converted with that endpoint. Back up the existing repository, releases and
settings first, then have its administrator retire it and free that name.
Remove any old push mirrors or scheduled push jobs before creating the pull
mirror. Do not run GitHub release workflows on the backup.

The mirror must report `mirror: true` and `has_actions: false`. Check its branch
and peeled tag refs against GitHub with `git ls-remote`. The first sync must use
only the approved clean refs. Purge the retired repository's old objects, Actions
runs and attachments through Forgejo administration after backup verification.

## Copy releases

Use a separate trusted checkout at `/opt/ai17z-mirror`. It contains the scripts
and is updated deliberately by the administrator; it never executes code from
downloaded release assets. The pull mirror handles code; this script handles
releases because git mirroring does not copy release metadata or attachments.

```bash
python3 -I tools/forgejo-mirror/sync-releases.py --tag v1.0.0-beta.89
python3 -I tools/forgejo-mirror/sync-releases.py --tag v1.0.0-beta.89 --check
```

The sync downloads every source asset, checks `SHA256SUMS.txt`, confirms the
backup's tag resolves to the manifest commit, creates a draft, uploads every
file, downloads each attachment to compare its SHA-256 and size, then publishes.
It preserves the title, notes and prerelease flag. Existing published releases
are compared without modification. An incomplete draft or differing release
stops the sync for operator inspection. Nothing deletes or replaces a release.
Old releases before Beta 0.89 are refused.

Install the supplied service and timer after creating the unprivileged
`ai17z-mirror` service account and trusted checkout. Put the credential in
`/etc/ai17z-mirror.env`, readable only by root:

| Variable | What it is |
| --- | --- |
| `FORGEJO_TOKEN` | AI17Z Code token with repository write on `AI17Z/ai17z` |
| `GITHUB_READ_TOKEN` | **Optional; leave it unset.** `ShiftAboveCtrl/ai17z` is public, so with no value the sync reads GitHub anonymously. A run spends one API request on the release list plus one per release not yet verified; asset bytes come from each asset's `browser_download_url` on github.com (a release download, which does not count against the sixty anonymous API requests an hour per address). Redirects may only land on GitHub's own hosts. If GitHub answers 403/429 with a rate limit, the run exits non-zero with the reset time, keeps what it verified, and does not retry; the next timer run tries again. A fine-grained read-only Contents token, if ever set, makes the sync use the API with that token as before. |

Anonymous or not, trust is unchanged: `SHA256SUMS.txt` and the cosign check
below stay mandatory. `configure.py` sends an explicit `User-Agent` on every
request, because Cloudflare in front of the forge answers 403 (error 1010) to a
request with none.

The raw pull mirror also carries GitHub's `refs/pull/*`, including closed bot
pull requests; the lead accepted these as refs GitHub itself serves. Bot pull
request commits there can trip a history scan (foreign identity, AI
attribution). The gate is the history scan of heads and tags, which is what
releases are built from; `refs/pull/*` is not part of that gate.

No credential belongs in GitHub's release workflow. The server also needs
`cosign` on `PATH` (or named by `COSIGN`), the version pinned in
`ci/cosign.json`: every asset that has a `.sigstore.json` bundle is verified
against `ci/cosign.pub` before anything is copied, and an asset that does not
verify stops the run before a draft exists.

The service sets `Environment=HOME=/var/lib/ai17z-mirror` so cosign's TUF cache
has a writable home under the service's `StateDirectory`. Keep this setting
when installing or overriding the unit; `ProtectHome=true` blocks an ordinary
service-account home.

```bash
sudo install -m 0644 tools/forgejo-mirror/ai17z-release-sync.service /etc/systemd/system/
sudo install -m 0644 tools/forgejo-mirror/ai17z-release-sync.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ai17z-release-sync.timer
sudo systemctl start ai17z-release-sync.service
sudo journalctl -u ai17z-release-sync.service --no-pager
```

The timer runs an hour after the preceding run ends, so copies do not
overlap. Each release that was copied or verified is recorded in
`/var/lib/ai17z-mirror/verified.json` with what GitHub listed for it (release
id, name, notes, prerelease flag, and every asset's name, size and id). A run
asks GitHub for one list of releases and downloads only a release that is new
or whose listing changed; nothing is recorded for a run that failed. Run
`sync-releases.py --force` (for instance weekly, or after any change on the
server) to download and verify everything again, which also catches a backup
asset changed on AI17Z Code after it was recorded. A missing tag is retried on the next run after the pull mirror catches
up. Alert on service failures and compare the newest release on both hosts.
GitHub publication and backup synchronization are separate operations; a
published release can take one mirror interval to appear on AI17Z Code.

## Operate while GitHub is unavailable

Existing mirrored installers and releases keep working independently. The
README gives direct AI17Z Code installation commands. Clone from AI17Z Code
for development and use its published archives for installation.

There is no automatic Forgejo release workflow. Its former assembled builds
depended on GitHub-hosted reference releases. A workflow depending on an absent
primary would provide no recovery path. To build a new emergency release:

1. Snapshot the mirror, then have the administrator convert it to an ordinary
   repository before enabling writes. Keep Actions disabled.
2. Use trusted native Windows x64, Ubuntu amd64/arm64 and macOS arm64/x64
   machines. Run `ci/scripts/setup-*-job.*` and the matching
   `build-windows-release.ps1`, `package-ubuntu.sh` or `package-macos.sh` on
   each machine. Each package asserts its actual architecture and runs its
   bundled runtime. No old reference download is needed for native builds.
3. Run all gates in [RELEASING.md](../RELEASING.md), choose an unused semver tag
   and place the complete outputs and `release.env` in `dist/` on trusted Linux.
4. Supply the release key, password, private identifier list and a Forgejo
   repository release token from the operator's secret store. Install the
   pinned cosign binary and `python3`, `zstd`, `innoextract`, `jq` and `unzip`.
   Run `bash ci/scripts/private-identifiers.sh history`, then
   `PUBLISH_TO=aicode bash ci/scripts/publish-release.sh dist <version>`.
5. Run `AI17Z_RELEASE_SOURCE=aicode bash ci/scripts/verify-published-release.sh
   <tag>` and the platform installer qualification scripts. Restore GitHub
   primary operation only after reconciling these new commits, tags and releases.

The cosign bootstrap downloads from GitHub. Keep a verified offline copy of the
binary pinned in `ci/cosign.json`, the signing key backup, Node distributions,
Inno compiler and package dependencies with the disaster recovery material.
Native rebuilds still need npm and vendor distribution services unless those
dependencies are cached. Test this recovery procedure on the designated hosts
before treating emergency publishing as an operational capability.
