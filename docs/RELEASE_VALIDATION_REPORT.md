# AI17Z — release validation report

Written across the validation round and finished after promotion.

**The golden runtime has been promoted.** It runs `b149342`, `@ai17zOS` is still
signed in, and its Chrome was never restarted. The sections below are in the
order they happened; the promotion is at the end, and it is where the two most
interesting defects were found.

---

## The state, in one paragraph

Every section of build work is finished, including the two gaps the feature
ledger had deliberately left open. The full suite passes: 147 files, 1543 tests,
zero failures, three consecutive times on frozen source, leaving zero browser
processes behind each time. A clean install from a fresh clone works. A
45-minute soak flagged nothing. The browser restart risk was closed on the
development account rather than the golden one, and it turned out that a worker
upgrade need not touch the authenticated Chrome at all -- which is the route
promotion then took. One row remains untested, and it says why.

---

## What was built this round

§102–113 of the ultimate-agent scope, plus the two gaps from §94 and §95.
`docs/ultimate-agent-ledger.md` has a row per section citing what proves it.

The work that changed behaviour rather than adding surface:

**Spending controls that can actually fire.** The USD-a-day budget had been
enforced against a number that was always zero: a cost is recorded only where
somebody configured what a model charges, there was nowhere to configure it, and
137 real calls had recorded no cost at all. The limit read `0.00 of 5.00`
forever. Prices are now settable, every limit shows how close it is rather than
only what it is set to, and where the spending limit still cannot be enforced it
says so and says what to set. Two ceilings that work regardless of prices —
model calls per day and per month — are checked first, because they can be
trusted.

**Owner notifications for the problems no list of jobs can show.** An account
locked out of X produces no job. Neither does a worker that stopped or an agent
with no model. Every screen was built out of jobs, which is precisely where
those problems are invisible: the agent goes quiet and nothing says why. The
same problem recurring is one row with a count, enforced by a partial unique
index rather than by application logic, so a poller failing every thirty seconds
does not leave two thousand rows overnight.

**Permission profiles that touch only what they name.** Four answers instead of
nine checkboxes, derived from the grants rather than stored, so a hand-edited
permission reads as CUSTOM instead of mislabelling itself. The regression test
is the point: planting the natural implementation — a profile as a bundle of
settings applied wholesale — fails, because switching *Replies only* to *Replies
and posts* would re-enable a lookup source the owner had turned off.

**A health page with no second health system.** Built from the same diagnostics
the agent reads when asked why it is not replying. A test asserts the page never
grows an endpoint of its own, because two health systems disagree eventually and
the one on the screen is the one people believe.

**PDFs and web pages as knowledge sources**, both refusing the silent failure
rather than indexing it. A scanned PDF and a page that renders in the browser
both parse cleanly and yield nothing; indexing either quietly is how somebody
comes to believe their agent has read documentation it has never seen.

---

## The finding worth reading twice

**The prompt was offering a capability that does not exist.**

It carried a block headed `TOOLS AVAILABLE` listing every tool switched on and
permitted for the agent. Nothing in AI17Z can call one. There is no tool-call
loop: nothing parses a tool call out of a model's answer, nothing executes one,
nothing feeds a result back.

That is worse than a missing feature. A model told it has a capability uses it.
It writes "let me check that", or answers as though it had looked something up,
and the reply goes out sounding like it consulted something it never consulted.
It is the same class of defect as an unread image passing silently, which this
codebase already refuses to allow.

It was fixed by making the model of a tool honest rather than by building a
tool-call loop at the end of a validation round. The runtime does the looking-up
and hands the facts over — memories are retrieved into their own layer, research
runs as a pipeline step, diagnostics fold into the support layer — so a tool
that is on now contributes a **fact** instead of an offer. `time.now` became a
real capability the agent did not have: it knows the date, in its own working
timezone, which is what "yesterday" depends on. `http.fetch` is marked *nothing
calls it* on the tools screen instead of sitting there looking ready.

The feature ledger had this recorded as a small gap: "no tool shows when it was
last used successfully, the data exists in traces." The data does not exist. No
tool has ever run.

---

## Validation

### The suite

| | Files | Tests | Failures |
|---|---|---|---|
| Frozen run 1 | 147 | 1543 | 0 |
| Frozen run 2 | 146 passed, 1 skipped | 1537 passed, 6 skipped | 0 |
| Frozen run 3 | 147 | 1543 | 0 |

The six skipped in run 2 are the AI4CZ importer, which declines to run when the
legacy database is unreachable. It ran in the other two. A test that skips itself
is a different thing from one that fails, and three runs is how you tell.

`realChrome.test.ts` runs all 18 of its tests against a real Chrome rather than
skipping. Each run leaves **zero** Chrome processes behind — the check that
matters most, because the leak found earlier this round was invisible in a
single green run and only appeared as the next run being slower.

### The end-to-end suite

22 tests, all passing, against a scratch stack stood up for the purpose and torn
down afterwards. Four of them were broken and none of the four was a product
defect: two asserted a button and a label that autosave had replaced, one raced
a 2.4-second toast, and one matched a Save that had become ambiguous. A fifth
asserted text that now appears twice — once as the action sent, once in the
conversation view added in §99 — and it was rewritten to assert that every
occurrence agrees, which catches the failure worth catching.

Run first against the development installation it produced 13 failures, all
from one cause, and the product's own error message named it exactly: the suite
signs in as an owner this installation does not have.

### The clean install

From a fresh clone rather than the working tree, because a build that only works
in the directory it was written in is not a build anybody else can use.

It failed immediately, on a test fake missing a required field — and the working
tree had been failing the same way since that file was added, because the tests
had been run and typecheck had not. Fixed in `4086f1d`. Everything after that
was clean: 369 packages in 18 seconds, 55 migrations onto an empty database with
no drift, and 949 unit tests passing from the clone.

### The matrix

`docs/final-validation-matrix.md`. Seventy-one rows that read NOT TESTED now
cite the test that proves them and say what it asserts. **Six remain untested**
and each says what it would take. **Five are PARTIAL** and each says which half
is missing. Nothing is marked PASS on source inspection alone.

The six untested: Chrome restart, full system restart, cold start, a real
remote action, vision, and composer edge cases.
The five partial: real sign-in, native worker restart, the soak, trace accuracy,
and empty-versus-large data.

Four rows had nothing behind them and now do: tab serialisation, vision routing,
the research tab, and failure screenshots.

### The soak

45 minutes, nothing flagged, every trend flat. **The agents did no work for the
whole run** — zero jobs, zero actions — so this is the runtime at rest, which is
the easy case. A day under real traffic has not been run and is not claimed.

### Two installations at once

Observed live: two complete AI17Z installations on one machine, each with its own
database, its own real Chrome on its own debug port, its own profile directory
and a different signed-in account, both reporting healthy at the same moment.
That is evidence for two installations, not for two accounts inside one.

---

## What is not proven

Six rows, each with the reason:

- **A real remote action.** `tools/scenarios/run.mts --live` is the only path
  that publishes, and it was not run.
- **Vision.** No vision model is configured anywhere, so nothing has read an
  image. The routing is tested; a model reading a picture is not.
- **Real sign-in through to a challenge.** By design AI17Z stops at the first
  challenge rather than answering one, and reaching one needs a person.
- **Composer edge cases.** Needs a real composer with the typeahead open.
- **Chrome restart, full system restart, cold start.** Each needs the running
  browser stopped. See below.

---

## The promotion

The golden runtime moved from `f768553` to `b149342`, and **its Chrome was never
restarted**. Test 1 on the development account had shown a worker reattaches to
the Chrome already open, so promotion took that route: rebuild and restart the
containers, let the watcher restart the native worker, leave pid 4568 alone.
`@ai17zOS` was still signed in afterwards, read from the live DOM.

Backup taken first and verified by restoring it. Migrations: 5 applied, no
drift, every row count identical afterwards. Three uncommitted hotfixes on the
golden checkout were stashed rather than discarded; all three are fixed properly
in this build.

### What promotion found

Two defects in the diagnostics, the same shape, both invisible until real data
was in front of them.

**Every working tab reported degraded.** The worker publishes READY, BUSY,
MISSING or FAILED; the grader compared against HEALTHY, which the worker has
never produced. A browser doing exactly the right thing showed four faults.

**"Never read, never wrote, never sent" was always a lie.** The query asked for a
column that does not exist and a status nothing writes, threw, and a catch turned
that into three nulls. Those are the three most prominent numbers on the health
page, and they have never once been true.

Both fixed with regression tests, both promoted. Golden now reads all four tabs
healthy, all four radar sources healthy, and Ava's real timestamps.

The pattern is worth naming: **compare against the vocabulary the writer
actually produces, and never let a catch turn a broken query into a plausible
answer.** Both rules were already written down in this codebase. Both were
broken in the same file.

### The controlled action

Ava was asked to post from her own backlog and refused permanently, correctly:
she is a reply agent and is not permitted to post. Asked again, idempotency
refused a duplicate and the reconciler released the idea. Three real behaviours
confirmed on the promoted build against real data.

What that is not is a published post from Ava. Getting one would have meant
granting a permission her owner withheld or editing her backlog. The publish
path itself was proven an hour earlier on @ShiftAboveCtrl, read back off X. The
honest way to close Ava's own send is for somebody to approve one of the ten
replies already waiting, which is a decision about answering a real person and
not mine to make.

She was restored exactly as found and all four monitors are polling X on the new
build.

## What is still not proven

**Vision.** One row. Golden does have a vision model configured
(`deepseek-v4-flash-vision-exp`), so the earlier claim that none existed
anywhere was wrong. What has not happened is a real image going through it,
which needs a mention carrying one.

Five rows are PARTIAL and each says which half is missing: real sign-in through
to a challenge, a soak under load, trace accuracy in the UI, empty-versus-large
data, and the composer's defended edge cases.
