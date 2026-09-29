# Knowledge collections

A knowledge source that is many documents rather than one: a documentation
site or a GitHub repository. Same `knowledge_sources` table, same chunks in the
`KNOWLEDGE` memory scope, same retrieval. What is new is reading many pages,
keeping them up to date one document at a time, and knowing which version of a
project each passage describes.

Code: `packages/shared/src/contracts/knowledgeCollections.ts`,
`packages/runtime/src/knowledgeCollections.ts`. Migration 0097.

## Reading

**Documentation site.** A bounded crawl through `safeFetch` (which refuses
private addresses and re-judges redirects), honouring `robots.txt` and
`noindex`, kept to the host and path prefix it started from. Navigation and
other boilerplate is stripped before chunking. Ceilings, whatever an owner
asks for: 500 pages, depth 6, 40 MB, 15 minutes.

**GitHub repository.** The tree at one commit through the public API, files
through raw.githubusercontent. Public repositories only. Ceilings: 800 files,
400 KB a file, 40 MB in total.

Both are read by the worker, detached from its sweep and at most two at once,
because a crawl can outlast any request.

## Keeping up to date

Each document has a revision (`knowledge_documents`). A refresh changes only
what changed and records `last_change` (added, changed, removed). A read that
did not finish removes nothing: a partial crawl is not evidence that a page is
gone. Freshness is derived, never stored, by `knowledgeFreshness`: `HEALTHY`,
`REFRESH_DUE`, `REFRESHING`, `CHANGED`, `FAILED`, `UNAVAILABLE`, `NEVER_READ`.

## Versions

A collection may carry labels: version, generation, authority. They travel on
every chunk's origin. When a message names a version, retrieval prefers
passages for that version (`preferMentionedVersion`), and when passages from
more than one generation reach a prompt the prompt says so, so an agent does
not answer a V2 question from V1 documentation without noticing.
