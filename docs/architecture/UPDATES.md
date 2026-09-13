# Updates

AI17Z tells you when there is a newer version, shows you what changed, and then
waits. It does not update itself.

That is a decision, not a missing feature. An autonomous agent is a program
somebody left running on purpose: it holds a browser signed in as them, it is
part-way through conversations, and it has a job queue with leases on it.
Replacing that while it runs — at three in the morning, because a version was
published — trades a problem nobody had for one they cannot see coming.

## What actually happens

At most once every six hours, and only when something asks, the API reads
GitHub's public list of releases for this repository, keeps the newest one that
applies, and caches the answer in `app_settings` under `updates.check`. Opening
a screen reads that cache. Pressing **Check now** is the only thing that forces
a request.

The whole of it is `packages/runtime/src/updates.ts`, four routes in
`apps/api/src/routes/settings.ts`, and two components:
`UpdatePanel` on the Settings page and `UpdateBadge` in the top bar.

There is no updater process, no scheduler, and no code that installs anything.
The download is a link.

## Which release counts as newer

Semver precedence, with the rule that catches people out: a prerelease comes
*before* the release it leads to. `0.1.0-rc.4` is older than `0.1.0`. Getting
that backwards offers everybody on a stable build a downgrade to last month's
candidate, which is why `compareVersions` has its own test file.

**Release candidates are shown only to installations already running one.**
Somebody on `0.1.0` is never told about `0.2.0-rc.1`: they did not ask to be on
a candidate build, and "there is an update" reading as "there is a beta" is how
people end up somewhere they did not choose. `/releases/latest` is deliberately
not used, because it hides prereleases from everybody — including the people
running one, who would then have no way to hear about the next.

## Three ways to say no

They are different answers and all three are kept:

| | What it does |
| --- | --- |
| Do nothing | The badge stays. Nothing else happens, ever. |
| **Skip this version** | That version is never mentioned again. A newer one still is. |
| The toggle | No request is made at all. Not a hidden answer — no request. |

## Which version this is

The version comes from, in order: `AI17Z_VERSION` in the environment,
`BUILD_INFO.json` beside the application, then the package version.

The packager stamps `BUILD_INFO.json`; the launcher reads it and passes
`AI17Z_VERSION` through compose, because a container has neither that file nor a
repository to ask. `package.json` used to sit at `0.1.0` through every
candidate, which is how an installation ended up unable to answer "am I newer
than `v0.1.0-rc.4`?" -- it now moves with the tag, but nothing relies on that
being remembered.

## What it is called

`v1.0.0-beta.1` is the version. **AI17Z Beta 1.0.0** is the name, and it is
what the version screen, the update card, the wizard and the Windows uninstall
list all say.

| Tag | Name |
| --- | --- |
| `v1.0.0-beta.1` | AI17Z Beta 1.0.0 |
| `v1.0.0-beta.2` | AI17Z Beta 1.0.0 (2) |
| `v1.0.0-rc.1` | AI17Z Release Candidate 1.0.0 |
| `v1.0.0` | AI17Z 1.0.0 |

`releaseName()` in `packages/shared/src/version.ts` is the implementation. The
first of a cycle drops its number, because "Beta 1.0.0 (1)" is a worse name than
"Beta 1.0.0" and every cycle starts with one.

The name is a rendering and nothing parses it back. Ordering, the prerelease
filter, the tag, the installer filename and `VersionInfoVersion` are all the
number. GitHub defaults a release's title to its tag, so a title that is only
the tag is treated as no title and rendered; one somebody wrote is left alone.

The installer says the same thing and cannot call the same function, so
`packaging/windows/ai17z.iss` reimplements the grammar in ISPP.
`tests/unit/releaseWorkflow.test.ts` checks the two against each other, because
the failure is silent: Add/Remove Programs saying one thing and the app another
looks like two builds installed at once.

## Which button an installation gets

Three layouts, three routes, and offering the wrong one is how somebody ends up
running `git pull` in a directory with no repository in it.

| Channel | How it got here | How it updates |
| --- | --- | --- |
| `BOOTSTRAP` | the install command, or AI17Z Setup run directly | **Update AI17Z** in the Start Menu, which is `update-ai17z.ps1`, which hands back to the setup script that installed it |
| `INSTALLER` | `AI17Z-Setup-<version>.exe` | a newer one of those, run over the existing copy |
| `CHECKOUT` | a clone | `.\update-ai17z.ps1`, which pulls |

Whichever program installed it writes `INSTALL_INFO.json` beside the program
saying which it was, and the launcher passes the channel through compose as
`AI17Z_INSTALL_CHANNEL`, because a container has neither that file nor a
repository to ask. `updateMethodFrom` in `updates.ts` is the whole of it.

**The fallback is what this did before that file existed, and it stays.** An
installation made by an earlier release has no marker, and must keep being
offered the installer rather than suddenly being told it is a checkout: absent a
channel, `AI17Z_INSTALLED` and then `BUILD_INFO.json` decide, exactly as before.
An unrecognised channel is not a third answer either -- it falls through to the
same fallback rather than being guessed at.

Not `buildVersion().source`, which says how the *commit* was found: a
developer's containers are built from a checkout and report `build` there like
any other image, so that test told a developer to go and download an installer.

### What a bootstrap update actually does

`update-ai17z.ps1` does not implement any of it. It reads the marker and runs
`packaging\windows\Setup-AI17Z.ps1 -Update`, naming the program directory, the
data directory and the instance, so nothing discovered on the machine can move
where the update lands. One implementation of "fetch a release, check its hash,
lay it down" serves both installing and updating.

The setup script then: stops the native worker only — the containers hold the
database and an update has no reason to interrupt it — downloads the release's
package, **checks it against the SHA-256 published in that release's
`SHA256SUMS.txt`**, unpacks it beside the installation, and moves it into place
only once it is whole. If the hash does not match, the file is deleted and
nothing is replaced. There is no flag to skip that.

The data directory is not touched: `.env`, the master key, the database volume,
the browser profile and everything under `storage` survive by construction,
because the only directories removed are the ones the package owns.

### One executable on a release, and one command

`AI17Z-Setup-<version>.exe` is the full installer and carries the application.
It is the only `.exe` a release publishes, and it is unsigned — the free
open-source certificate AI17Z applied for was declined for want of a user base,
and shipping an unsigned executable as the recommended route means asking people
to click past a warning that is doing its job.

So the recommended route is a command, and what it fetches are scripts:
`install.ps1` and `Install-AI17Z-<version>.ps1`.

`toRelease` picks assets **by name**, and `setupUrl` is the setup script rather
than an executable. The old rule was "the first asset ending in `.exe`", which
was unambiguous while there was one, ambiguous for the short period there were
two, and unambiguous again now — but installations published under that rule
are still running it, so the full installer stays first in the release's file
list and nothing else in that list may become an executable.

## One machine, several installations

A machine can hold any number of AI17Z installations, and they are not variations
of one thing: each has its own agents, its own database, its own signed-in
browser and its own Docker project. The two operations somebody could mean are
opposites — "update this one" replaces a program directory and keeps everything
else, "install another" makes a new everything — and collapsing them loses an
agent.

**An update updates the installation it was started from, and nothing else.**

- `update-ai17z.ps1` updates `$PSScriptRoot`. It is shipped *inside* each
  installation, so which one it is is not a question anything has to answer.
- The update screen in the application updates the copy serving that screen. It
  is handed `AI17Z_INSTANCE_NAME` and `AI17Z_PROGRAM_DIR` by the launcher, shows
  both, and has no route that enumerates installations.
- `Setup-AI17Z.ps1` run with explicit paths goes exactly there. Run without
  them, `Select-Ai17zTarget` decides: nothing installed → install the default;
  one installed and somebody is there → **ask**; one installed and nobody is
  → update it; several → **refuse**, and say how to name one. It never picks
  between several on its own.

### The rule that stops an update landing somewhere else

`INSTALL_INFO.json` records **how** a copy was installed. It is never
authoritative about **where** one is.

That distinction is the Beta 1.0.0 (14) defect written down. That installer took
an instance name, derived the Add/Remove entry and the Start Menu group from it,
and wrote the files into a different installation's directory — leaving an
installation named one thing, living inside another, with an uninstaller
registered to delete a program directory belonging to something else.

So `Test-Ai17zInstallInfoTrustworthy` compares the `programDir` a record claims
against the directory the record was read from, and a disagreement stops the run
rather than being resolved in either direction. A record that names somewhere
else has been copied or moved, and neither is a reason to start replacing program
files. The folder's *name* is deliberately not part of that check: somebody who
chose their own directory has a folder called whatever they called it, and
refusing to update those would be inventing a rule nobody agreed to.

Nothing from the network is allowed near any of this. A release's metadata never
supplies a path, a filename or a directory; the checked setup script is written
under a fixed name, and the instance name is validated against
`^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$` before it reaches anything that builds a
path.

### Proved rather than argued

`npm run verify:install -- --instances` installs three independent
installations, updates the middle one, and asserts two things about the other
two: that every file under each is byte-for-byte what it was, hashed one by one,
and that asking the updater inside one installation to update another is
refused. `tests/unit/bootstrapDecisions.test.ts` drives the selection and trust
functions out of the shipped script itself.

## What the check sends

A `User-Agent` of `AI17Z`, and nothing else. No identifier, no version, no
account, nothing about any agent. GitHub learns what it learns from anybody
opening the releases page. See `docs/PRIVACY.md`.

## Release notes

Rendered by `ReleaseNotes.tsx`, which is about ninety lines and handles the six
things the notes actually use: headings, bullets, bold, inline code, links and
rules. A Markdown library would be tens of kilobytes in the bundle to read one
document that only we write.

Nothing there builds HTML from the text — every element is a React node, so a
release body cannot inject markup whatever it contains — and link targets are
checked, so only `http` and `https` survive.
