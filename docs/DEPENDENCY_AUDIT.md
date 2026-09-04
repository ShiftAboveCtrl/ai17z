# Dependency audit

Run before the first public release. Re-run with `npm audit` and update this
when the answers change.

## Licences

367 installed packages:

| Licence | Count |
| --- | --- |
| MIT | 307 |
| ISC | 21 |
| Apache-2.0 | 14 |
| BSD-3-Clause | 7 |
| CC-BY-4.0 | 1 |
| 0BSD | 1 |
| Declares nothing | 16 |

**No copyleft anywhere** — no GPL, AGPL, SSPL or BUSL. Nothing in the dependency
tree constrains which licence this project chooses. The 16 that declare nothing
are small transitive packages; none is vendored or modified here.

Nothing was copied from AI4CZ or AI4YI into this repository. `tools/import-ai4cz`
reads an AI4CZ SQLite database and writes AI17Z rows; it contains no code taken
from that project. twscrape is invoked as an external command line and is not
bundled, so its licence does not attach to this tree.

## Dependencies added deliberately

**`pdfjs-dist` (Apache-2.0, no dependencies).** Documentation lives in PDFs, and
a knowledge source pointed at a folder of them used to index nothing and say
nothing. Chosen over `pdf-parse`, which is the same licence but pulls
`@napi-rs/canvas` -- a native binary, needed only for rendering. Nothing here
renders; reading a text layer does not need a canvas, and a local-first
application already shipping a browser does not need a second one.

It is loaded lazily and its absence is handled: a build without it refuses PDFs
with a sentence rather than failing to start.

## Vulnerabilities

### Fixed

**`@fastify/static` — high.** Four advisories: path traversal in directory
listing, route guard bypass via encoded path separators, authorization bypass
via non-canonical paths, and route guard bypass via traversal.

It was **declared but never imported** — no source file references it. The fix
was to remove the dependency rather than take a breaking major bump for code
that does not run.

The API does serve files, by hand, in `apps/api/src/routes/artifacts.ts`. That
was audited at the same time and is not vulnerable to the same class: artifacts
are addressed by database id and never by a client-supplied path, the resolved
path is re-checked against the storage root with a `root + sep` prefix test, and
the route is behind authentication.

### Accepted, with reasons

**`react-router` / `react-router-dom` — moderate, two advisories.** The fix is
`react-router-dom@7`, a breaking major.

- *Arbitrary constructor injection via `deserializeErrors()` in SSR hydration.*
  **Not reachable.** The web app is a client-only SPA built by Vite. There is no
  `renderToString`, no `hydrateRoot`, no `StaticRouter` — the hydration path the
  advisory describes does not exist here.

- *Open redirect via backslash in `<Link>` and `useNavigate`.* **Low
  relevance.** Every route in this application is constructed internally from
  database ids; no user-supplied string reaches `<Link>` or `navigate()`. It is
  also a local-first, single-owner application served on localhost.

A major router upgrade immediately before a release, to fix one unreachable
issue and one that needs an attacker-controlled URL this application never
produces, trades a real risk of breaking navigation for very little. Revisit it
as ordinary maintenance rather than as a release blocker.

## Pinned versions

Reproducibility matters more here than currency, because a mismatch between
Playwright and its browser image fails at runtime with an error that never
mentions versions.

| What | Constraint | Why |
| --- | --- | --- |
| Node | 20 or newer, checked by the installers | The worker and the toolchain |
| Playwright | Pinned exactly, in three places that must move together | The Docker image ships browser binaries for one release only |
| Postgres | 16 | The migrations are written against it |
| Lockfile | `package-lock.json`, committed | `npm ci` in CI installs exactly this |
