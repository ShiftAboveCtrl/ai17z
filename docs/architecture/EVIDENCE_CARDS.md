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

## Token-2022 extensions

A Solana card carries one more section, read from the mint account itself and
decoded in `packages/runtime/src/tokenExtensions.ts`: one `getAccountInfo` in
base64, then the type-length-value area after byte 165. It is not a source's
opinion and not an index field. `solana.read_mint_extensions` exposes the same
read, and `token.solana_profile` returns it instead of the bare
`token2022: true` it used to.

The lines are `transfer fee: 500 bps (5%)` (with the cap in base units),
`permanent delegate`, `transfer hook`, and `default account state` when set.
A fee extension present at zero reads `0 bps (0%)`; none reads `transfer fee:
none`; the original Token program reads `Token-2022: not applicable (SPL
Token)`. The fee shown is the one in effect at the slot the account was read,
chosen from the two scheduled entries by epoch. Type ids this does not decode
are listed as `additional unparsed extensions present`, never skipped quietly.

**Absent is never zero.** Any failed fetch, wrong owner, short or padded-wrong
buffer, or known extension of the wrong size is one line, `Token-2022:
extensions unread`, with no number in it. A reading older than five minutes
prints the same line. These lines are not `CardReading`s: Studio's card picture
(`studioEvidenceCardImage.ts`) is frozen at five labels and is untouched. Studio's
check page takes the separate answer in `studioTokenExtensions.ts`
(`GET /api/v1/installation/token-extensions`), pinned by
`tests/fixtures/studioTokenExtensions.json`.

The lines are runtime-built, so the address rule exempts exactly those lines at
generation and at approval (a delegate or hook is an address), and the send
check re-reads the mint and sends to review if the fee, delegate or hook changed
since the owner looked. When a card would overrun the length policy these lines
are dropped last, after the link and the deployer lines. They cost one RPC read
inside the same reservation as the rest of the card and spend no X read.

