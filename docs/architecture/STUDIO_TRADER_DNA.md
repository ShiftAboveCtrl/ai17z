# Studio Trader DNA voice

What an AI17Z agent may say about a published Trader DNA study on AI17Z Studio,
and the one Studio endpoint it reads to say it. The agent explains the study. It
never follows it.

A Trader DNA study is research about other people's wallets: which behaviours
survived the luck filters (multiple-testing correction, contamination checks) and
which are only reconstructed from the chain. This installation holds no study
engine and computes nothing about a wallet. The client is `readTraderDnaStudy` in
`packages/runtime/src/studioTraderDna.ts`, the allowlist is
`packages/shared/src/contracts/studioTraderDna.ts`, and the owner chat capability
is `studio.trader_dna` in `studioTraderDnaCapabilities.ts`.

Studio has not shipped this surface yet. This document is the contract the client
is written against, so Studio can implement it, and the tests stand in for Studio
at `studioInstallationRequest`.

## The refusal is structural

The line between explaining and copying is not a sentence in a prompt.

* The only capability is one READ. There is no capability to follow or watch a
  wallet, import one as a setup, create a mandate or place an order, and none is
  registered beside it. `tests/unit/noWalletCapabilities.test.ts` pins the exact
  set of `studio.` capabilities and the absence of those verbs.
* `tests/unit/studioTraderDna.test.ts` reads the imports of both modules and fails
  if either reaches a wallet, trading, mandate, radar, watch or league module, and
  fails if either exports a name with a follow, watch, mandate, order, copy,
  mirror, buy, sell, swap, submit or import-wallet verb.
* Wallet addresses in an answer are the ones the study published, passed through.
  This installation ranks, scores and chooses none.

## Two surfaces, two switches

| Surface | Switch | Default |
| --- | --- | --- |
| Owner chat: "what did the Trader DNA study find" | the `studio.trader_dna` capability, in the Studio pack | DISABLED |
| A public post about one study | `policy.studio.postTraderDna` and `policy.studio.traderDnaStudyId` | off, none |

The capability is effect READ, risk LOW, `audience: 'OWNER'`, `unsetPermission:
'DISABLED'`: never offered in a public conversation and refused if one names it.
A public post is not a capability. It is a policy field the posting engine reads,
so a model cannot choose it. The relevance shortlist offers the capability for
"trader dna", "dna study", "wallet study", "smart wallet", "smart money" and "which
wallets", and for nothing in banter.

## The request

```
GET {studio origin}/api/v1/installation/trader-dna/studies/{study_id}
Authorization: DPoP <access token>
DPoP: <proof>
```

* `study_id` matches `^[a-z0-9][a-z0-9_-]{2,63}$`, checked before it reaches a
  path. Nothing else is ever put in the address, and there is no second address
  for a draft or an operator run.
* The request goes through `studioInstallationRequest`, the same DPoP bound
  request every installation call uses. There is no stored bearer secret.
* Studio answers 404 for a study that does not exist **and** for one that is not
  published. The client says only "Studio has no published study with that id".

## The answer

`200 application/json`, one strict object. An unknown field refuses the whole
study.

```json
{
  "protocol": 1,
  "source": "ai17z-studio",
  "kind": "TRADER_DNA_STUDY",
  "visibility": "PUBLISHED",
  "study_id": "early-entry-study",
  "title": "Early entries on new pools",
  "generated_at": "2026-11-10T10:00:00.000Z",
  "published_at": "2026-11-08T10:00:00.000Z",
  "window": { "start": "2026-09-08T00:00:00.000Z", "end": "2026-11-07T00:00:00.000Z" },
  "evidence_level": "SURVIVED_FILTERS",
  "sample": { "wallets": 41, "trades": 1530 },
  "costs": { "fee_bps": 30, "slippage_bps": 80, "note": "Fees and slippage as Studio assumes them." },
  "luck_filters": { "method": "BONFERRONI", "tests": 24, "alpha": "0.05", "survivors": 2 },
  "contamination_flags": [{ "code": "WASH_TRADING", "note": "Three wallets traded with each other and were removed." }],
  "behaviours": [
    { "id": "b1", "summary": "Wallets that sold half within an hour of entry kept more of their gains", "evidence_level": "SURVIVED_FILTERS", "sample_size": 412, "adjusted_p": "0.012" }
  ],
  "wallets": [{ "address": "0x...", "label": "Cohort A, as published" }]
}
```

| Field | Rule |
| --- | --- |
| `visibility` | the literal `PUBLISHED`. A draft or operator run is refused by the schema even if a server sent it |
| `kind` | the literal `TRADER_DNA_STUDY` |
| `study_id` | must equal the id asked for |
| `generated_at` | when Studio produced this answer. Older than 15 minutes, or more than 5 in the future, is refused as not current |
| `evidence_level` | `SURVIVED_FILTERS`, `RECONSTRUCTED` or `CANDIDATE`. A candidate is something nobody traded |
| `luck_filters` | Bonferroni, the number of hypotheses tested, alpha, and how many survived. Survivors cannot exceed tests |
| `behaviours[].adjusted_p` | required for a behaviour that says it survived |
| `wallets` | only what the study itself published. Addresses are EVM or Solana shaped |
| decimals | strings, never floats |

Consistency rules, enforced by the schema: the window cannot end before it starts,
a study that says its findings survived names at least one that did, and two
behaviours cannot share an id.

### What it must never carry

An operator note, an account identity, an email, a live balance, a holding, a price
target, a follow list or anything that reads as an instruction. These are absent
from the schema, so their presence is a refusal.

## What the agent says

Every answer, in owner chat or in a post, carries the evidence level, the sample
size, the cost assumption, the window, and the sentence that nothing was traded.

* **Unavailable, never a headline number.** A study with no sample (zero wallets or
  zero trades) or whose window ended more than 120 days ago, an unpublished id, an
  unreachable Studio and a malformed answer all produce `UNAVAILABLE` with a
  sentence. No figure, no behaviour and no wallet leaves the capability then.
* **Nothing is kept.** An unreachable Studio is not answered from the last study.
* **Survived, reconstructed, candidate** are said separately. A reconstructed
  behaviour is introduced as not shown to survive the filters, and a candidate as
  never traded.
* Wallet addresses appear in the capability output only, as published, with the
  sentence that listing one says nothing about whether to follow it.

## A public post

Off by default, and it needs a chosen study. The owner switches it on in the
Policies screen under **Trader DNA study on Studio**.

1. The posting engine asks `proposeTraderDnaPost` when it comes due. It needs the
   opt-in, a study id, the capability not switched off for this agent, and a
   published study that makes an idea.
2. `traderDnaIdeaFrom` makes an idea only from a study whose findings survived the
   filters, with a sample, in date. It uses only behaviours that survived, and
   drops any whose own text names an address or already praises a wallet. It
   carries no address.
3. The idea goes through reticence (`unpromptedSubject`), the backlog's similarity
   check and the posting schedule and cadence like any post the agent starts. One
   study is proposed once.
4. The finished text is checked again by `checkTraderDnaAtSend` at the moment of
   sending, with the policy as it is now, including text an owner edited in the
   review queue. It must say it is a study, attribute it to Studio and say nothing
   was traded. It is sent to the owner, not to X, if it contains a wallet address,
   if it calls a wallet or trader smart, sharp, an insider or worth copying,
   following or watching, if it tells anybody to copy or follow a wallet, or if it
   reads as a promise, a signal, advice, or a live position. The check does not
   understand negation on purpose: a sentence that has to say "do not follow" is
   better rewritten.

## Not in this slice

* Showing a playbook CANDIDATE as "never traded" beside a study. A study's own
  `CANDIDATE` level is said that way; linking the two waits for Studio to put both
  in one surface.
* A Studio panel for choosing a study from a list. The owner types an id.
