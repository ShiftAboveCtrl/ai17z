# Token evidence replies

`policy.tools.evidenceCards` defaults off. The same owner switch appears in
Easy Mode reply settings and Advanced policies. An older Easy Mode save that
omits the optional choice preserves the active policy value.

A direct mention or reply naming an exact token enters the research step after
engagement and intent. `parseTokenReference` identifies the reference; a ticker,
multiple identities, a pair URL, an unsupported chain or an EVM address without
a chain receives a single refusal sentence. No resolver chooses a ticker match.
Pitches and DEFLECT requests receive a decline without a token read.

The branch invokes only `token.inspect_risk`. Its Solana extension uses the
existing Jupiter upstream, including its machine quotas. Each typed reading
keeps source, actual fetch time and observation time. Missing, negative,
nonfinite, future-dated or stale readings display unavailable. Solana index
readings expire after five minutes; EVM contract readings after one hour.
EVM mintability does not establish a revoked mint authority, and unsupported
metrics remain unavailable. No upstream narrative enters the fixed template.

Every card carries `not a verdict, reads can be wrong`. A wholly unavailable
read includes `evidence not found`. The normal validator, voice scoring,
quality gate, channel grant, cadence and executor remain in use. Voice rewrites
cannot change the card. Repetition of its fixed layout is recorded as expected
only if the other voice and generic-prose checks passed. The complete text,
reading freshness, current owner opt-in and capability permission are checked
again before execution. A card that cannot fit the output policy is held for
review; it is never cut down to a partial financial observation. The default
280-character ceiling may need an owner adjustment on channels supporting
longer replies.

Migration 0132 persists read reservations. An agent lock makes the ten asks per
asker per hour cap and one card per mint per minute cooldown atomic. Pointers
count toward the asker cap. A pointer links to the existing published action,
or identifies the pending card, without another upstream read. Rehearsals have
separate reservations and cannot suppress a real reply. Existing exchange
limits may stop replies before these limits are reached. Mentions retain the
DIRECT capacity class; token reads do not spend X capacity.

The public offer never creates a watch. In paired Telegram, `/watch <card id>`
explains the owner choices. `/watch <card id> LIQUIDITY_BELOW <amount>` confirms
that condition; `TOP_HOLDERS_ABOVE` and `DEVELOPER_SHARE_ABOVE` accept an owner
chosen percent. The authenticated local owner API also accepts the explicit
condition and threshold at `POST /api/agents/:id/studio-risk-watches/confirm-card`.
Only a published Solana card and an enabled Studio binding qualify. The
request persists its random watch id before outbound transport, so a lost
acknowledgement can be retried without creating a second watch. The Studio
creation contract extends the existing risk-watch bridge, as specified in
STUDIO_RISK_WATCHES.md. Its deployed support is not asserted here.

Acceptance coverage lives in `tests/unit/evidenceCard.test.ts`,
`tests/unit/evidenceCardUi.test.tsx`, `tests/unit/tokenRisk.test.ts`,
`tests/integration/evidenceCard.test.ts` and the reservation case in
`tests/integration/statusConstraints.test.ts`. Pipeline rehearsals and sends
use mock accounts. Studio confirmation tests use the local DPoP contract
server. The shared switch was checked at 1440 by 900 and 390 by 844, including
Space activation, visible keyboard focus and absence of horizontal overflow.
