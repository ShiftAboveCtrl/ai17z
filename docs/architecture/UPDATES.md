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
| `BOOTSTRAP` | AI17Z Setup | **Update AI17Z** in the Start Menu, which is `update-ai17z.ps1`, which hands back to the setup script that installed it |
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

The setup script then: stops the native worker only -- the containers hold the
database and an update has no reason to interrupt it -- downloads the release's
package, **checks it against the SHA-256 compiled into the signed setup program
or published in that release's `SHA256SUMS.txt`**, unpacks it beside the
installation, and moves it into place only once it is whole. If the hash does not
match, the file is deleted and nothing is replaced. There is no flag to skip
that.

The data directory is not touched: `.env`, the master key, the database volume,
the browser profile and everything under `storage` survive by construction,
because the only directories removed are the ones the package owns.

### Two executables on a release, and which is which

`AI17Z-Setup-<version>.exe` is the full installer and carries the application.
`Install-AI17Z-<version>.exe` is AI17Z Setup, which carries a script.

`toRelease` picks them **by name**. It used to take "the first asset ending in
`.exe`", which was unambiguous while there was one -- and would now be a coin
toss, handing half of all installations the wrong one. Releases still list the
full installer first, because an installation published before this existed is
still running that old rule and must keep resolving to the installer that
matches the layout it has.

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
