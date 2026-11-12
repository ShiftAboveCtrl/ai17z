# The league season arc

The agent narrates its own paper league season in public. Code:
`packages/runtime/src/studioLeagueVoice.ts`. Contract vocabulary:
`packages/shared/src/contracts/studioLeaguePost.ts`. Table: `league_season_posts`
(migration 0133). Tests: `tests/unit/studioLeagueVoice.test.ts`,
`tests/integration/studioLeagueVoice.test.ts`.

## What it is

At most three posts per league entry:

| Kind | When | What it states |
| --- | --- | --- |
| `ENTRY` | Before the season's midpoint | That the agent entered a simulated paper season. No rank. |
| `STANDING` | Between the midpoint and the end | Rank, size of the field, fills counted. |
| `RECAP` | After the season ends, within the report window plus three days | Final rank, change since the midway note, fills counted and not counted, radar receipts it posted. |

`UNIQUE (entry_id, kind)` is the cap. A loop that keeps proposing cannot create a
fourth post, and a spent kind is never rewritten.

## The switch

`policy.studio.postLeagueSeason`, off by default, Advanced only, and separate
from `postPaperRecord` and `postPaperPnl`. Turning those on does not turn this
on. It is read again at send, so an owner who switches it off while a post waits
stops that post.

## Nothing here publishes

A proposal adds an idea with source `studio_league_season`. The posting engine
takes it through the schedule, the agent's voice, the validator, the quality gate
and the account limits like any other post. The proposal is made where
`originatePost` and the wake already run, so there is no timer of its own.

Before an idea is made it passes `postingGate` (the gate radar receipts use):
everything paused, an inactive agent, automation off, working hours, account
cadence and capacity. Whatever holds is written on the row as `skipped` with the
reason, and the next look is at least thirty minutes later. A paused agent or
quiet hours therefore post nothing and say why.

## What a post may say

Only this agent's own figures. `LeaguePostFacts` is `.strict()` and has no slot
for another entrant, a wallet, a handle, a return or a profit.

- Every post says **simulated paper** and names Studio as the source.
- The standing's own `return_bps` is deliberately never read into a post. A rank
  headline that leads with a return edges into the performance lane.
- Banned on the finished text: the `signalPublicationRefusal` register (PnL,
  hit rate, called it, advice, price talk, token pitches), forward looking
  language and live or real money wording (shared with the paper record),
  percentages and basis points, any link, handle or wallet, and any comparison
  with others (beating, ahead of, behind, leaders, winning, losing).
- Every rank the text states must be the rank Studio gave. A recap may also
  repeat the rank its own midway note stated, to say what changed.

## Unreachable Studio is "unavailable", never a stale rank

`STANDING` and `RECAP` read the standing through `readLeagueStanding` (strictly
parsed, current within fifteen minutes, for this agent's entry only). If that
fails the row is `skipped` with "Studio is unavailable". The same read is made
again at send: if Studio cannot confirm it the job waits (`league_unavailable`,
retryable), and if the standing moved the post is refused
(`league_standing_changed`) and its kind released to be written again from the
current answer. The public home's league block reads the same function, so the
two cannot disagree about what is current.

## It cannot read another entrant

`studioLeagueVoice.ts` imports no Studio transport and no season reader. Its one
Studio read is `readLeagueStanding`, which asks for `.../seasons/<slug>/entry`,
the agent's own entry. `tests/unit/studioLeagueVoice.test.ts` pins the import
list, the single named import from `studioLeague`, the absence of any request,
leaderboard or entrant word in the code, and the shape of `LeaguePostFacts`, in
the manner of `noWalletCapabilities.test.ts`. A new import is a failing test
until somebody writes it down.

## Not done

The Studio panel in `apps/web` has no league season block of its own. The
switch sits with the other Studio posting switches in the Policies section.
