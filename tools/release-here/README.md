# Releasing from this machine

The release workflow in `.forgejo/workflows/release.yml` is the reference. These
scripts run the same steps, from a clean clone of the public tag, on a machine
the owner trusts, for when AI17Z Code's runners cannot. Measured on 2026-10-23:
the runner machines on talha-server keep time at a tenth of real speed, so the
full check cannot finish inside a runner's three hours. v1.0.0-beta.86 was
released this way.

Nothing here is a second pipeline. Each script calls the scripts in
`.forgejo/scripts/` that the workflow calls, in the workflow's order, and the
publishing is done on the server by `ai17z-forge-ops release-import`, which
checks every file against the release's own `SHA256SUMS.txt`, creates a draft,
attaches each file once, compares both ways and only then publishes.

## Order

1. The tag exists on AI17Z Code (push it to GitHub and let `sync-github` bring
   it, or run `sync-github`).
2. `linux-packages.sh <tag>` in `ubuntu:24.04`, with `/out` mounted and the host
   Docker socket: the amd64 `.deb`, then both Macs and arm64 Ubuntu, each
   refused unless its native files are byte for byte the natively built
   reference.
3. Windows, in a short path such as `C:\ai17z-b<n>` (node_modules overflows a
   long one), in Windows PowerShell with
   `PSExecutionPolicyPreference=RemoteSigned`:
   `. .\.forgejo\scripts\setup-windows-job.ps1; . .\.forgejo\scripts\build-windows-release.ps1 -Version <version>`.
4. `check.sh <tag>` in `node:22-bookworm`, beside `postgres:16-alpine` reachable
   as `postgres`, with `DATABASE_URL` set as in the workflow. Alone: never
   beside another heavy suite.
5. Copy the packages, the Windows files and `release.env` into one directory and
   run `publish.sh <tag>` in `ubuntu:24.04` with it at `/in`, the release key at
   `/keys/key` and `/keys/password`, and `/dist-out` for the result. The key is
   decrypted from `%LOCALAPPDATA%\AI17Z\Secrets\ai17z-release-cosign.*.dpapi`
   into a folder only the owner's account can read, and that folder is deleted
   as soon as the run ends.
6. Upload the result as `release-<tag>/` into `/var/lib/ai17z-forge/inbox/`,
   with `release-notes.md` copied to `body.md`, and run
   `sudo -n /usr/local/sbin/ai17z-forge-ops release-import <tag> "<release name>"`.
7. Qualify what was published, as the `qualify` job does:
   `verify-published-release.sh <tag>`, then `qualify-published-ubuntu.sh`
   through `as-stranger.sh`, with a `docker:27-dind` sidecar reached as
   `tcp://docker:2375` (a mounted socket needs the docker group, which a
   stranger does not have).
8. Mirror it to GitHub with `mirror-github.sh <tag>`: the files a person
   downloads, each checked against the release's `SHA256SUMS.txt`, under the
   title `AI17Z beta-vX.Y`, marked Latest.
