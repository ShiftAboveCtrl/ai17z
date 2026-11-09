# Studio paper record

What an AI17Z agent may say about the simulated paper trading its owner keeps on
AI17Z Studio, and the one Studio endpoint it reads to say it. This document is the
contract for that endpoint. The client is `studioPaperRecord` in
`packages/runtime/src/studioLink.ts`, the allowlist is
`packages/shared/src/contracts/studioPaperRecord.ts`, and the client is proved
against `tests/support/paperStudioServer.ts`, which implements this document.

Studio already holds the owner's paper decisions and results. This adds a read of
a published slice of them and a way for the agent to speak it. It computes no
performance of its own and holds no paper engine.

## Three surfaces, three switches

| Surface | Switch | Default |
| --- | --- | --- |
| Owner chat: "how is your paper trading going" | the `studio.paper_record` capability, in the Studio pack | DISABLED |
| A public post about a finished window | `policy.studio.postPaperRecord` | off |
| That post stating profit, loss, returns or win counts | `policy.studio.postPaperPnl` | off |

The capability is shaped like `wallet.*`: effect READ, risk LOW, `audience: 'OWNER'`,
`unsetPermission: 'DISABLED'`. It is never offered in a public conversation and is
refused if one names it. Posting is not a capability at all. It is a policy field
the posting engine reads, so a model cannot choose it and nothing the agent writes
can turn it on.

## The request

```
GET {studio origin}/api/v1/installation/paper-record?window=7d|30d|90d
Authorization: DPoP <access token>
DPoP: <proof>
```

* Only to the linked Studio origin (`studioOrigin()`), never to an address in an
  answer. A request is refused before it is made if the installation is not linked.
* The access token is the short lived one from `POST /api/v1/token`, and the proof
  is a DPoP JWT (RFC 9449) signed by the installation key, with `htm` `GET`, `htu`
  the origin plus the path **without the query**, `ath` the hash of the token, a
  fresh `iat` and a unique `jti`. This is the same `authed()` every other
  installation request uses. There is no stored bearer secret, and Studio must
  refuse `Authorization: Bearer`.
* Studio answers for the owner the installation is linked to. The request names no
  account, and nothing about the owner is sent.

## The answer

`200 application/json`, one object. Every object is strict: an unknown field makes
the client refuse the whole record, because a field Studio was never meant to
publish is evidence the server changed, not noise to drop.

```json
{
  "protocol": 1,
  "simulated": true,
  "source": "ai17z-studio",
  "generated_at": "2026-11-09T10:00:00.000Z",
  "window": {
    "label": "30d",
    "start": "2026-10-10T10:00:00.000Z",
    "end": "2026-11-09T10:00:00.000Z",
    "complete": true
  },
  "state": "TRADED",
  "reason": null,
  "totals": {
    "trades": 12,
    "closed_trades": 10,
    "winning_trades": 6,
    "losing_trades": 4,
    "net_pnl_usd": "-42.50",
    "return_pct": "-4.25",
    "max_drawdown_pct": "9.10"
  },
  "costs": { "fee_bps": 30, "slippage_bps": 50, "note": "Fees and slippage as Studio assumes them for every paper fill." },
  "open_positions": { "count": 2, "treatment": "MARKED_TO_MARKET", "note": "Marked at the last pool price." },
  "decisions": [
    { "id": "dec_1", "at": "2026-10-11T08:00:00.000Z", "summary": "Opened a simulated long after a liquidity check.", "url": "https://studio.example.invalid/paper/decisions/dec_1" }
  ]
}
```

| Field | Rule |
| --- | --- |
| `protocol` | the literal `1` |
| `simulated` | the literal `true`. A record that says otherwise is refused, not relayed |
| `source` | the literal `ai17z-studio` |
| `generated_at` | when Studio produced this. Older than 15 minutes, or more than 5 in the future, is refused as not current |
| `window.label` | must equal the window asked for |
| `window.complete` | false while the window is running. A running window is never the subject of a post |
| `state` | `TRADED`, `NO_TRADES` or `MISSING` |
| `reason` | a sentence, for `MISSING` |
| `totals` | counts are integers; money and percentages are decimal strings, never floats. `net_pnl_usd` is signed, so a loss is a negative number |
| `costs` | the assumed fee and slippage in basis points, and a sentence |
| `open_positions` | how many were open at the window end and how Studio treated them: `MARKED_TO_MARKET`, `EXCLUDED` or `CLOSED_AT_WINDOW_END` |
| `decisions` | at most 20, each `{id, at, summary, url}`. `summary` is sanitized by Studio. `url` must be on the linked Studio origin; any other host refuses the record |

Consistency rules, enforced by the schema: `MISSING` carries no totals, costs,
open positions or decisions. `TRADED` and `NO_TRADES` carry totals, costs and open
positions, `NO_TRADES` has zero trades and `TRADED` more than zero, wins plus
losses cannot exceed closed trades, closed cannot exceed trades, and a window
cannot end before it starts.

### What it must never carry

Account identity, an email, a handle, a linked wallet or address, a raw prompt,
private guidance or instructions, the persona, a live balance or any holding of a
real wallet. These are absent from the schema, so their presence is a refusal.
Nothing in the record is a live position: every figure is simulated.

### Errors

| Status | Meaning to the client |
| --- | --- |
| 401 | one retry with a fresh token, then the installation is treated as no longer linked |
| 404 | "This Studio does not publish a paper track record yet." |
| other | "Studio answered N" with Studio's description |
| network failure | "Studio could not be reached" |

## Honest states

The agent says exactly what Studio said, and never fills a gap.

| Studio said | The agent says |
| --- | --- |
| `TRADED`, net positive | a net gain, in USD, simulated, with the dates |
| `TRADED`, net negative | a net **loss**, as plainly as it would say a gain |
| `TRADED`, net zero | a net result of zero |
| `NO_TRADES` | that the simulated paper trading made no trades in that window |
| `MISSING` | that Studio has no record for the window, with the reason, and that it will not guess |
| not linked, Studio unreachable, stale, refused, malformed | UNAVAILABLE with a sentence: it cannot check, and it does not guess |

Every statement names Studio as the source and says "simulated" and "paper".
Nothing is kept between calls: `studioPaperRecord` holds no copy, so an
unreachable Studio is UNAVAILABLE and never last week's answer said again. The
capability's readiness is UNAVAILABLE with the reason when the installation is
not linked, and it makes no network call to find out.

## Posting

`proposePaperRecordPost` runs when the posting schedule comes due
(`originatePost`), so the schedule stays what decides when anything is said. It
needs all of: `policy.studio.postPaperRecord`, the capability not DISABLED for the
agent, a linked Studio that answers now, a **complete** window with trades, and a
window end nobody has proposed yet. It checks Studio at most every six hours.

What it does is put an idea in `content_ideas` with source `studio_paper_record`.
It publishes nothing. The post is then an ordinary post:

1. **Reticence.** The idea text is asked of `unpromptedSubject` before it is added,
   as for any subject the agent picks for itself.
2. **Identity and the validator.** The brief is the idea, written in the agent's own
   voice and checked by `validateOutput`, which refuses a disclosure of what runs
   the agent and a denial of being an AI.
3. **Cadence and rate.** The schedule, `checkActionRate`, quiet hours and the
   account lease apply unchanged.
4. **The post quality gate.**
5. **`checkPaperRecordAtSend`**, on the finished text, with the policy read again at
   the moment of sending. It sends the post to the owner, not to X, if the text
   does not say simulated, paper and Studio, reads as a promise, a signal or advice,
   implies a live position or real money, or (with `postPaperPnl` off) states how the
   trades did. A post whose opt-in was switched off since the idea was made is
   stopped for good.

Without `postPaperPnl` the idea carries the trade count, the dates, the assumed
costs and how open positions were treated, and nothing about whether the trades made
money. Silence is common: no record, a running window, a window with no trades and
an unreachable Studio each produce no idea.

## What this does not do

It does not compute, store or rank performance. It sends nothing about the agent to
Studio, signs nothing and holds no wallet key. It does not cache a record. It does
not read the owner's Studio account beyond this one published slice. It does not
make a paper result into advice: public copies outlive revocation, which is why
posting is off, PnL is a second switch, and every surface keeps "simulated", the
dates and the cost assumptions.
