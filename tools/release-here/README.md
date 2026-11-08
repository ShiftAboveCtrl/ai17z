# Emergency release tools

Normal releases run in `.github/workflows/release.yml` on native GitHub runners.
Read [the release guide](../../docs/RELEASING.md) for gates and publication.

These scripts are legacy operator entry points. `check.sh` exercises a clean
public tag. `publish.sh` assembles and signs a rehearsal without uploading.
Use the [backup recovery procedure](../../docs/operations/FORGEJO_BACKUP.md)
for a GitHub outage. Run native packaging on machines of each target platform;
the old `linux-packages.sh` assembles against historical GitHub reference assets
and is unsuitable after those assets have been removed.

`mirror-github.sh` is for deliberately recovering a new, gated emergency release
from AI17Z Code to GitHub after service returns. It must copy the complete asset
set and refuse an existing release. It is never used by the primary workflow.
