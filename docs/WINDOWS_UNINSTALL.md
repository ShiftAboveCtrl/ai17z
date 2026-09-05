# Uninstalling AI17Z on Windows

There are two separate things you can remove, and AI17Z keeps them separate on
purpose.

| | What goes | What stays |
| --- | --- | --- |
| **Remove the application** | the program, its shortcuts, its Add/Remove Programs entry | everything you made: agents, memories, knowledge, sessions, keys |
| **Remove the application and all data** | all of the above, plus `%LOCALAPPDATA%\AI17Z` | the database, until you remove that too |

## Removing the application

**Settings → Apps → Installed apps → AI17Z → Uninstall**, or run
`unins000.exe` from `%LOCALAPPDATA%\Programs\AI17Z`.

It stops AI17Z first, then removes the program. Before finishing it asks whether
to remove your data as well, and **keeps it unless you say otherwise** — that is
the choice you can still reverse.

Reinstalling afterwards picks up exactly where you left off.

A silent uninstall (`/SILENT`) never asks and always keeps the data, because an
unanswered question should not delete anything.

## Removing your data

`%LOCALAPPDATA%\AI17Z` holds:

- your environment file, including the key your provider credentials are
  encrypted with
- stored files, screenshots and indexed knowledge
- browser profiles, including signed-in X sessions

Say yes when the uninstaller asks, or do it separately at any time:

```powershell
powershell -ExecutionPolicy Bypass -File "%LOCALAPPDATA%\Programs\AI17Z\packaging\windows\Uninstall-Data.ps1"
```

It lists what it is about to delete and asks you to type `REMOVE`.

**Losing the master key is not recoverable.** Sealed provider credentials cannot
be decrypted without it and have to be entered again.

## Removing the database

Your agents live in PostgreSQL, in a Docker volume, which is neither the program
directory nor the data directory. Removing it is a third, separate action:

```powershell
cd "%LOCALAPPDATA%\Programs\AI17Z"
docker compose down -v
```

`-v` is the part that deletes the data. Without it the containers stop and the
database survives.

## Removing it completely

1. Uninstall from Settings, and answer **Yes** when asked about data
2. `docker compose down -v` as above
3. Optionally uninstall Docker Desktop, Node.js and Chrome, if you installed
   them only for AI17Z

## What is never touched

Your ordinary Chrome profile and browsing. AI17Z keeps its own profiles under
its data directory and never uses or removes the one you browse with.
