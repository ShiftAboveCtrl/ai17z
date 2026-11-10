# Market and wallet signal radar

An owner adds up to 12 exact mint or address pins in the account Radar panel.
Only Solana is supported. Other chains stay visible as unsupported and never
produce reads. Token names and symbols cannot configure identity and provider
symbols never enter evidence or generation. Publishing candidates is a separate
option, off by default. No signing or money movement is present.

The existing SocialRadar claim loop polls `market_signal`; it branches before
channel adapters, browser context or the X read budget. Reads use `upstream.ask`
and its shared machine quota windows and cache. The minimum interval is five
minutes, the universe has at most 12 predicates, responses are limited to 20
entries, and a cycle stops starting reads after 90 seconds. Upstream failures
are visible coverage gaps. Sampling adds no scheduler.

Supported predicates:

| Predicate | Measurement and coverage |
| --- | --- |
| Liquidity below USD | Median liquidity of at least three fully reported pools for the exact mint, among GeckoTerminal's top 20. It is not total market liquidity. |
| Concentration above percent | The ten largest token accounts divided by supply, using exact integers and finalized Solana reads. Includes pools and programs; no person or developer attribution. |
| New pool | An exact pool first observed after the baseline, whose reported creation time falls between consecutive valid reads. Older pools rotating into coverage are excluded. Missing creation times leave a gap. |
| Address transacting | Latest finalized successful signature mentioning the exact address, among the latest 20. It proves neither a transfer nor its direction, amount or ownership. |

Each observation carries the upstream id, its fetched time and the metric
definition. Compound metrics retain every read's source and time and use the
oldest time for freshness. A first valid read only establishes a baseline. Missing, malformed,
stale or out-of-order reads never clear a condition or become zero. A threshold
must clear before another crossing is offered. Event predicates clear on a valid
read with no new event. This deliberately coalesces uninterrupted bursts.

Migration `0118_signal_radar.sql` retains baselines and candidates. A source-row
lock serializes overlapping polls; baseline, transition and idea writes share
one transaction. A unique source/watch/generation/agent key is the final
duplicate barrier. Threshold edits have a new watch key and baseline. An idea
belongs to the linked agent and the source account. Disabled links cannot
receive candidates.

A transition retains its before/after evidence even when it is refused. With
owner opt-in and READ and POST grants, it creates one `content_ideas` entry.
The existing posting schedule claims that idea through `nextPost` and
`originatePost`. Generation receives evidence, times, limits and explicit
observational constraints. The existing engagement, validation, voice, quality,
cadence, capacity, approval, rate and idempotency gates continue to apply.
Reticence and strong-pitch refusal apply to intake and generated output. Signal
publication restrictions and current READ/POST grants are checked again at
execution, including approved jobs. Removing a watch or its opt-in holds queued
work. No signal poll executes an action.

The Radar read model shows current pins and baselines, candidates, idea/job
status, refusal reasons and posting schedule state. Unavailable fields are
explicit. Exact identities wrap; configuration and paired evidence are tested
at 1440 and 390 pixels using the shipped component and stylesheet.

Verification is in `signalRadar.test.ts` (unit and integration),
`signalRadarUi.test.tsx`, and `signalRadarLayout.test.ts`. Integration uses the
standard per-process Postgres harness and mock accounts. The layout test starts
an isolated local Vite fixture and headless Chromium, intercepts its API writes,
saves screenshots in `.screenshots/`, and closes its server and browser.

Public upstream coverage remains incomplete, baselines accumulate prospectively,
and observations are historical evidence rather than guarantees or advice.
