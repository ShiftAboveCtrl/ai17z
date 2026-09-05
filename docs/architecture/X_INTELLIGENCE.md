# Searching X itself

Asking the model provider to run a search during the call, and refusing to
overstate what came back.

## What this adds that AI17Z did not have

AI17Z already looks things up. `packages/runtime/src/research.ts` decides from
the conversation whether the answer depends on something current, then uses the
browser already running for the open web and DexScreener for a contract address
or a ticker.

None of that reaches **X's own index**. A logged-out browser cannot search it.
A logged-in one can only search as the agent's own account, slowly, through a UI
that changes — and burning the agent's session on search is how the session
that matters gets rate limited.

xAI's Responses API can search X server-side, during a model call, and answer
with citations. That is the gap this fills, and the only one.

## The promise everything here protects

**An agent never says it searched X unless a search actually ran.**

This is harder than it sounds for one uncomfortable reason: a model asked to
search X will write *"posts on X suggest…"* whether or not it searched. It is
not a reliable witness to its own tool use. Its prose is fluent, plausible, and
worth nothing as evidence that a lookup happened.

The provider does supply evidence. `server_side_tool_usage` counts tool
executions that returned something, and it is what xAI bills on:

```
{"SERVER_SIDE_TOOL_X_SEARCH": 3, "SERVER_SIDE_TOOL_WEB_SEARCH": 2}
```

So that count — never the answer — decides whether anything is passed on. A call
that comes back with three paragraphs of confident summary and a usage count of
zero produces **no findings at all**, and a recorded gap saying the search did
not run. The model writing the reply is then told it could not check, and says
so.

`tests/integration/xIntelligence.test.ts` pins this with the exact case: a
fluent answer, zero usage, and an assertion that none of that text survives into
any field of the result.

Failing closed is deliberate elsewhere too. A missing or renamed usage key reads
as *no search*, never as *a search we could not count*.

## Evidence, not knowledge

The same rule as every other lookup. Each finding keeps the name of its source
(`X search (xAI)`) and the moment it was read; the prompt says it was looked up
rather than known; a failure is reported rather than hidden. An agent that
launders a search result into its own voice states a wrong one exactly as
confidently as a right one.

Two smaller decisions follow from it:

**A finding is titled by its host, never by the citation's title.** xAI's
annotation `title` is the citation's *number* — `"1"`, `"2"` — not a headline.
Using it would label every source with a digit.

**Every finding from one call carries the same summary.** The provider does not
say which sentence came from which source. Splitting the text up to give each
citation its own slice would be inventing attribution.

An answer that arrives with no citations at all is kept, because the search did
run, but its source is recorded as `X search (xAI), uncited` so the prompt can
weigh it accordingly.

## Inline citations are stripped

xAI writes sources into the prose as `[[1]](https://…)`. Left in, they reach the
agent's reply and get posted to X, where a footnote marker means nothing. The
markers come out and the URLs are kept separately, which is where they belong.

## Request shapes that are not symmetric

Read off the API docs rather than assumed, because assuming would produce a
request xAI accepts and quietly ignores the filters of — which looks exactly
like a working feature until somebody checks what was searched.

| | `x_search` | `web_search` |
| --- | --- | --- |
| Filters | `allowed_x_handles` / `excluded_x_handles`, at the top level | `filters: { allowed_domains, excluded_domains }`, nested |
| Limit | 20 handles | 5 domains |
| Both lists at once | rejected | rejected |

There is **no query parameter** on either. The model derives what to search for
from the input, which is the thing it is better at than our rules.

Image and video understanding are off unless asked for: both are billed extra
and most questions are about words.

## Configuration

Three things have to line up, and each says so when it does not.

1. **A `research` model role**, set on the Intelligence screen, pointing at a
   provider that can do this. There is no fallback to the primary model —
   sending this to a model that cannot search gets a confident answer and no
   search, which is the exact failure above.
2. **`tools.research.xIntelligence`** in the policy, **off by default**. Unlike
   the browser and the market API, this cannot be tried for free: it spends the
   owner's key on every lookup. Turning it on is a decision about money, made
   once, on purpose.
3. **A provider whose adapter implements the capability.** Only xAI's does. An
   adapter without `searchWithServerSideTools` offers no degraded version.

Capability is a property of the adapter, not a list of model names. A table of
"models that support tools" is wrong within a month and fails in the worst
direction — silently dropping something somebody paid for. Whether a particular
model honours the request is answered by calling it and reading the usage
counter.

When the flag is on and the role is missing, the step records a gap naming what
to fix. A source the owner switched on that never runs is worse than one they
left off, because they think it is working.

## Cost

One call per event, whatever the plan asked for. The lookups are joined into a
single question rather than issued one at a time: a query per lookup would
multiply the bill to answer the same thing, and one question about the
conversation is what this is actually good at.

`budget.maxResearchCallsPerEvent` still caps the ordinary lookups in front of
it. Easy Mode reports the flag as something it cannot change, so somebody whose
provider bill is rising can find out why without reading the policy document.
