# What a machine can afford, and what happens when it cannot

AI17Z drives a real Chrome on somebody's own computer, beside their editor and
their own browser and whatever else they were doing. A local-first product that
needs the machine to itself is not local-first, so there is a budget, it is
derived from what the machine actually has, and it always leaves headroom it
will not touch.

This document is the measurements behind that, taken on 2026-09-15 on two live
installations.

## The failure it was written for

An owner reported this Radar state:

```
Mention search          21 failed poll(s) in a row    Last worked 51m ago
Notifications           Polling normally
Replies to own posts     7 failed poll(s) in a row    Last worked 46m ago
Reply search            23 failed poll(s) in a row    Last worked 52m ago
```

and, at the same time, Chrome showing **Aw, Snap! Out of Memory** on an X tab.

Three monitors dead, one perfectly healthy. That asymmetry is the whole
diagnosis: **mention search, reply search and replies to own posts all share the
MENTIONS tab. Notifications has its own.**

Every one of the three failed with the same sentence:

```
The mentions tab was still busy after 120s. Another operation is holding it.
```

## Two faults wearing one symptom

### The renderer ran out of memory

Measured over CDP on the running browser:

| Tab | Heap | DOM nodes | Age |
| --- | --- | --- | --- |
| MENTIONS | **3,754 MB** of a 4,192 MB ceiling | 1,546 | 0 min |
| NOTIFICATIONS | 198 MB | 3,929 | 0 min |
| ACTION | 106 MB | 6,089 | 107 min |
| RESEARCH | 107 MB | 5,698 | 107 min |

Three things follow immediately. It is **not retained DOM**: 1,546 nodes is
nothing, and the tabs with five times the DOM hold a twentieth of the memory.
It is **specific to the MENTIONS role**, which is the one that runs searches. And
at 90% of V8's own ceiling, the next allocation spike is the crash.

Growth was measured at roughly **100 MB per search cycle**, which puts a fresh
tab at the ceiling inside an hour. The live tabs opened at 20:35 and the
mentions tab was dead by 21:19: forty-four minutes.

**It is genuinely retained, not waiting to be collected.** A forced
`HeapProfiler.collectGarbage` on a 3,801 MB heap reclaimed **24 MB**. An
allocation profile over 75 seconds put every significant frame in X's own
bundles (`vendor.*.js`, `main.*.js`), with 5 MB at the CDP boundary.

**So none of it is ours to free.** X's application retains its search results
and we cannot reach inside it. What can be bounded is the renderer's
*lifetime*, and that is what `tabs.ts` now does.

### Then the tab was never given back

`lockTab` had a bound on **waiting** for a tab and none on **holding** one.

An operation took the mentions tab at 21:19:01. Its renderer died underneath it,
the evaluation it was waiting on never settled, and `unlock` was a local
variable nobody else could reach. `state.busy` stayed true. The health snapshot
recorded it faithfully:

```json
{ "role": "MENTIONS", "state": "BUSY", "lastError": null,
  "lastUsedAt": "2026-09-15T21:19:01.299Z" }
```

`BUSY`, for fifty-six minutes, with no error. Busy sounds like progress, so
nothing escalated.

The specific path was `leaseTab`: it took the lock, then called `retagIfLost`,
which evaluates `window.name` in the page, **before** returning the release
function to anybody. On a dead renderer that evaluation never returns, so the
lock was held by code that no longer existed.

## What changed

**A hold is bounded**, at 180s, longer than the 120s wait so a merely slow
holder is never robbed by the waiter it is keeping. The watchdog and the
holder's own release share one flag: without that, the wedged operation's
release runs when it finally returns and clears `busy` out from under whoever
holds the tab now, which is the exact failure the queue exists to prevent. A
test caught that; the first version of the fix had that bug.

**Anything between taking the lock and returning the release unlocks on the way
out.** A lock whose release can be lost is not a lock.

**A tab held past its bound reports FAILED**, not BUSY.

**A renderer is asked, not looked at.** `isDeadPage` reads the URL, and a
renderer killed for memory keeps its URL: the dead tab still read
`https://x.com/notifications/mentions` an hour later. A tab is reused only after
it answers a trivial evaluation within five seconds. Every probe carries its own
deadline, because the thing being probed is exactly the thing that does not
answer.

**Tabs are recycled** on heap fraction, on a wedged renderer, on a browser error
page, and on navigation count as the backstop for engines that do not report
memory. Recreation closes one page and opens another **in the same signed-in
browser**: the profile and the session are never touched.

## The budget

`packages/shared/src/resources.ts` is the one place that says how much AI17Z may
use. A threshold that lives beside the code using it is one nobody can tune and
nobody can test, and four of them disagree within a month.

| Machine | Class | Live tabs | Concurrency | Recycle at |
| --- | --- | --- | --- | --- |
| under 10 GB | LOW | 2 | 1 | 45% of the renderer ceiling |
| 10 to 24 GB | NORMAL | 3 | 2 | 60% |
| 24 GB and up | HIGH | 4 | 3 | 65% |

Three properties hold at every size and each is a test:

- **Chrome never gets more than half the machine.** The other half is the
  operating system, Docker, and whatever the owner is actually doing.
- **The soft budget is always below the hard one**, so there is somewhere to
  recycle before anything has to wait.
- **Generosity stops.** Past a point more headroom buys nothing, because a
  single renderer still dies at V8's own ceiling however much is free.

A machine the platform will not measure gets the **NORMAL** budget, not the
restricted one. Throttling a machine nobody has measured is a product that
mysteriously does less on hardware that was fine.

## Pressure

`freemem` means different things on different platforms, so it carries a
three-state verdict with wide bands and nothing finer. Under pressure AI17Z
**delays** background work; durable jobs are never dropped.

| Free | State | What changes |
| --- | --- | --- |
| over 15% | NORMAL | nothing |
| 6 to 15% | PRESSURED | half the concurrency, background work waits, idle tabs recycled |
| under 6% | CRITICAL | a third of the concurrency, only essential browser work |

## What the owner sees

A **Memory** row on the health screen saying what AI17Z decided and why, in
words rather than raw operating system numbers. And on the browser panel, when a
tab has been replaced:

> Replaced 2 minutes ago: it was holding 2,530 MB, 60% of what this renderer is
> allowed.

Recovery an owner cannot see is indistinguishable from a fault. Without that
line, a renderer running out of memory and being replaced **correctly** shows up
as a run of failed polls and nothing else, which is what made this take a CDP
probe to explain.

## What was not the cause

Worth recording, because each was checked:

- **Not duplicate Chrome roots.** Two browser processes for two installations,
  and two distinct `--user-data-dir` values. Correct.
- **Not leaked tabs.** Exactly four page targets per browser, one per role.
- **Not the worker's heap.** The largest Node process was 190 MB.
- **Not Docker starving Chrome.** Containers were unremarkable.

Of AI17Z's 26 Chrome processes totalling 8.9 GB, **one renderer held 4.8 GB**.
That was the whole problem.

## Rate limiting is a separate thing that looks the same

While the above was being fixed, the two *search* monitors began failing with:

> X asked AI17Z to slow down. It stopped rather than pushing.

That is the read-only boundary working, not a fault, and it affects exactly the
monitors that use X's search. A wedged tab and a rate limit produce the same
"failed poll" count on the same screen and need opposite responses, which is why
they are classified separately and why the sentence an owner reads says which
happened.
