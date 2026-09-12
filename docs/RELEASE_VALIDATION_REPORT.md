# Release validation

What was checked before a release was published, how, and what it found. Every
claim here is something somebody ran; anything taken on trust says so, and the
last section is the list of things this release did not verify.

The release workflow attaches this file to the release.

---

## AI17Z Beta 1.0.0 (14)

Fifty-six new capabilities, grouped so an owner makes one decision instead of
sixty-eight. Which means the question this release has to answer is not "do the
new capabilities work" but "is an owner who wants none of them unaffected".

### Gates

| Gate | Result |
| --- | --- |
| `npm run typecheck` | clean, from a deleted `tsconfig.tsbuildinfo` |
| `npm run lint` | clean |
| `npm test` | 246 files, 3010 tests, 0 failures |
| `npm audit` | 0 vulnerabilities, with and without dev dependencies |
| `npm --workspace @xbam/web run build` | built |
| `npm run release:check` | 879 tracked files, nothing found |
| `npm run verify:install -- --twice --upgrade` | passed |
| Migrations, new database | 71 applied, 0 pending, 0 drifted |
| Migrations, existing database | 71 applied, 0 pending, 0 drifted |

Two of those rows carry a condition, and both are there because the condition
has been got wrong before. The typecheck is from a deleted build info because
`tsc -b` reuses its cache, and a local green over a stale one has hidden errors
CI then found. `release:check` was run after `git add`, because it walks
tracked files and would otherwise skip exactly the new ones worth checking.

The suite was re-run from the final source after the last edit. The first run
was green too and is not the one being reported: it started before three source
files changed, which makes it evidence about something that is no longer what
is being shipped.

### Installing, from nothing, twice, and over the top

`npm run verify:install -- --twice --upgrade`. A new program directory, data
directory, Docker project and volumes each time, an environment scrubbed of
every `AI17Z_*` and `XBAM_*` variable, and every entry point driven rather than
one script run once.

    first:    71 migrations applied; API and interface answering; signed in and
              the agent list drew itself; diagnostics agree; stop stopped it;
              wrote nothing beside the program
    second:   the same, from nothing again
    sbs:      two installations running side by side, each with its own
              program, data, Docker project and volumes
    upgrade:  a row written, installed again over the top, and the row read
              back -- same project, same database, master key intact

"Signed in and the agent list drew itself" is a real headless browser, because
`GET /` returning 200 is nginx handing over an `index.html` with an empty div
in it, and Beta 1.0.0 shipped a black screen past a check that could not tell
the difference.

### The release invariant: an agent with every pack switched off

`tests/integration/packsOff.test.ts`. An owner who never wanted any of this
must be unaffected by all of it. The two halves of that are asserted
separately, and neither is inferred from the other: what the agent still does,
and what leaves the machine.

- With every pack off, a real event goes the whole way to `EXECUTED` — memory
  selected, model called, output validated, action completed, and both sides of
  the exchange remembered.
- The capability loop is asserted to be **on** for that agent first. Without
  that check the case could pass by never running the loop at all, which is the
  one way it could be green and prove nothing.
- No capability invocation is recorded, and nothing reaches the network.
- A model that names a switched-off capability anyway is refused at the
  invocation, and the refusal is recorded rather than swallowed. Leaving
  something off the menu saves a wasted step; it is not the guard.
- One pack switched on is offered, chosen, invoked and answered. Switched off
  again, the agent goes on working.

Nothing on the wire is proved by replacing `net.connect` and `tls.connect` for
the duration of each case, recording and refusing every connection that is not
the database. Deliberately at the socket rather than at `ask()` or
`safeFetch`: those are seams a future call site could go around without anybody
noticing, and the claim is not "no upstream family ran".

A guard that never fires and a system that never calls out look identical from
outside, so one case proves the guard catches a real `safeFetch` — to an
address literal, so it needs no resolver and still reaches the wire from
nowhere.

Mutation-checked. Each of these was applied to the source and the suite failed:

| Mutation | Cases that caught it |
| --- | --- |
| The model menu stops filtering on permission | 2 |
| `DISABLED` no longer refuses at the invocation | 1 |
| A pack switch reaches only its first capability | 2 |

### Toolspace, in the running interface

Driven in the application, not asserted from a fixture.

- Desktop and 375px wide. At 375, `scrollWidth === clientWidth === 375`: no
  horizontal overflow.
- No console errors. (Two 401s in the buffer predate the session and do not
  recur; every request after a reload is 200.)
- A pack switched off writes `DISABLED` for each of its members and survives a
  reload.
- One capability overridden individually shows the pack as `SOME`, counts
  `2 of 3 ready`, and warns that the group switch would replace that choice.
- A capability switched off is absent from what the model is offered — read
  through the production settings loader and the real loop rather than a
  hand-rolled map, which is the mistake that would have made a working switch
  look broken.
- No vendor plumbing in the primary interface: no RPC URLs, no WARC or CDX
  terms, no ABI fragments, no Crossref pools, no Wikidata property ids.

### Portability

Real files written to disk, read back off it, and imported as new agents.

| | SHARE | MOVE |
| --- | --- | --- |
| Checksum | matches | matches |
| Toolspace decisions carried | 4 of 4, identical | 4 of 4, identical |
| One of them switched off | carried | carried |
| Memories | 0 | 1 |
| Imported as a new agent | yes | yes |

The switched-off capability and the memory were written before the export on
purpose. A round trip carrying nothing distinguishing proves nothing.

### Two defects this validation found

**Company Filings could never be switched on.** `useSecContact` was written,
documented, and called by nothing, so the family reported itself unavailable on
every installation while telling owners to configure a contact that had no
configuration point. It now reads `AI17Z_SEC_CONTACT` at bootstrap, is
forwarded to both compose services, is in the environment template, and is
named in the message an owner reads. Unset stays unset and sends nothing.

Proved: unset reports unavailable, a configured address reports available, and
an address with no `@` is treated as unset. **No request was sent to the SEC.**
Declaring a placeholder address to a regulator is the thing this family exists
to refuse.

**The Web & Feeds pack described a screen that does not exist.** Its summary
offered to "follow sites that publish a feed". The watcher underneath is
complete — cursors, backoff, a poll loop in the worker — and nothing can create
a subscription for it: no route, no interface, no capability. The summary now
says what the pack does, which is read a feed on demand.

### Not verified

- **The SEC success path.** The refusal is proven against the live service: an
  honest User-Agent naming the project and its public repository was answered
  403, "Your Request Originates from an Undeclared Automated Tool". Parsing a
  real filing needs a contact address, and this release refuses to invent one,
  so the parser is source-reviewed and written defensively rather than
  observed. An owner who configures a contact exercises it on their first call.
- **Following a feed.** The subscription table, cursor and poll loop are tested
  and reachable from code; nothing an owner can press creates a subscription.
  Reading a feed on demand is what ships.
- **Wayback CDX and GDELT** were evaluated and not adopted. The measurements
  behind both decisions are in `docs/architecture/TOOLSPACE.md`.
