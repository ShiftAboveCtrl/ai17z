# Ultimate agent features: §92-113

One row per section. `DONE` means the requirement is satisfied and something
proves it. `VERIFIED` means earlier work already satisfied it and that was
checked rather than assumed -- the check is named, because "it looked like it
was already there" is not a check.

Sections §102-113 are not in this ledger: the brief that reached this session
ended at §101. They are outstanding as scope, not as work.

| § | Feature | State | What proves it |
|---|---|---|---|
| 92 | Agent self-diagnostics | DONE | `selfDiagnostics.test.ts` plants a real-looking key on a credential and walks every string in the document for it, then for anything else key-shaped. `diagnosticsSummary.test.ts` covers the answer it produces. Reachable: a new agent is permitted the tool at creation. |
| 93 | Support mode | DONE | `supportMode.test.ts`. Off by default; runtime description is a second switch; the subject is configurable so this is not AI17Z-only; the block forbids generalising one installation to everybody. |
| 94 | General knowledge sources | VERIFIED | §20-29 built this generally: `knowledge_sources` takes UPLOAD, PATH and TEXT for any agent, with identity, status, revision, indexing state and error state, and a screen. Not AI17Z-specific -- AI17Z's own documentation is one built-in source among any the owner adds. Gap left open below. |
| 95 | Skills / tools page | VERIFIED | §37-40 built name, state, policy verdict, configuration, an actionable fix and a one-click grant, in `ToolsSection.tsx` over `toolReadiness`. Gap left open below. |
| 96 | Tool router | VERIFIED | `toolRouting.test.ts` runs the brief's own four examples through the real router and all four route as specified. §4-19 built it: `whatToResearch` routes each question separately -- vision for the picture, Brave for what changes daily, DexScreener for a contract -- and `planLookups` lets a classifier model choose the plan while the deterministic rules remain the floor. The ordinary reply calls nothing, which is the requirement's own emphasis. |
| 97 | Answer evidence classification | DONE | `evidenceClass.test.ts` and `evidenceNote.test.ts`. A category rather than a score; the conversation does not count as corroboration; the prompt says nothing unless there is nothing behind the answer. |
| 98 | Owner inbox | DONE | `inboxBuckets.test.ts` pins the ordering: anything waiting on a person outranks the kind of message, an answered question stops being a question, and every item lands in exactly one bucket. Verified on real rows across the six buckets, with the counts on the chips coming from the same query as the list. |
| 99 | Conversation view | DONE | `conversationView.test.ts` pins the order root -> ancestors -> incoming -> reply, that what was used is shown (looked up, remembered, who this is, whether to answer), that a failed lookup is shown as well as a successful one, and that no chain-of-thought is rendered. |
| 100 | Live agent status | DONE | `liveStatus.test.ts`. Eight states, each derived from work that exists. Verified in the running app: the dev agent reads NEEDS YOU with the reason beside it. |
| 101 | Content queue | DONE | Four stages -- Ideas, Drafts, Scheduled, Posted -- verified in the running app: each renders its own list and its own empty state, with counts from the same request. Drafts and Posted are read from jobs and actions rather than a second table, because a post already runs the ten pipeline steps and the job is the record. |

| 102 | Follow-up / commitment memory | DONE | `commitments.test.ts` covers the lifecycle the brief names -- created, survives a restart, becomes due, produces a job, completes -- plus cancellation, a duplicate producing one follow-up rather than two, and giving up after three attempts instead of retrying for ever. |
| 103 | Observation / learning review | DONE | Read across memory, relationships, stances, entities and commitments rather than from a store of its own. Verified live: a memory shows with its provenance and confidence, forgetting it removes it, and a kind that is a record rather than an opinion refuses with the reason.
| 104 | Persona playground | DONE | `playground.test.ts`. Runs the real path -- prompt assembly, provider, voice compiler, validator -- and creates no job and no action, which is what makes it safe rather than a flag. Verified live against the mock provider: raw and final both returned, zero jobs, zero actions.
| 105 | Agent duplication | DONE (integrated) | An endpoint already existed and copied persona, policy, pipeline and models. Kept at its own path and given the scope choice, delegating to the portable path so a copy cannot carry anything an export could not. `portableAgent.test.ts`. A copy goes out through the portable document rather than copying rows, so it cannot carry anything an export could not. Three scopes, each saying what it will and will not bring before the button is pressed. Renaming a copy leaves the original alone; memories never travel.
| 106 | Import / export | DONE | `portableAgent.test.ts` plants a real-looking key on a credential and walks every key and string in the document for it, then checks no banned key name appears anywhere. Strict schema, so an unknown field is refused rather than riding along. A newer format version is refused with the version numbers in the message.
| 107 | Community preset foundation | DONE | Deliberately small: a preset is the §106 document with fewer sections filled in, and there is no second format. The boundary is in the shape itself -- `PortableAgent` has no field a credential, cookie or session fits in, and `NEVER_EXPORTED` is a second line under it for the free-form records.
| 108 | Model comparison | DONE | `playground.test.ts`. Same message, several roles, each run independently -- a provider out of credit records a failure rather than blanking the comparison the others answered. No job, no action.
| 109 | Cost controls | DONE | `spending.test.ts`. The USD-a-day limit had been enforced against a number that was always zero, because a cost is recorded only where somebody set what the model charges and there was nowhere to set it. Prices are now settable, every limit is shown with how close it is, and where the spending limit still cannot fire it says so and says what to set. Calls a day and a month always work and are checked first. Lookups per message is applied rather than declared. The playground goes through the same gate.
| 110 | Owner notifications | DONE | `notifications.test.ts`. Deliberately not a second inbox: an account locked out of X produces no job, which is exactly why a screen built out of jobs cannot show it. One row per problem with a count, enforced by a partial unique index; acknowledging lets the same problem be news again; a mute is four hours, never permanent. Conditions are swept from what is true rather than raised from events, so a recovery path added later cannot forget to clear one. Verified live.
| 111 | Global kill switch | DONE | `killSwitch.test.ts`. Enforced immediately before the remote call rather than at the top of the pipeline, and a test reads the source to prove nothing awaitable sits in the gap -- a check at the top leaves a window as long as the pipeline, which is the window somebody presses stop in. Individual agent state is never touched, so releasing does not start an agent that was already paused.
| 112 | Permission profiles | DONE | `permissionProfiles.test.ts`. Four answers instead of nine boxes, derived from the grants rather than stored, so a hand-edited set shows as custom instead of mislabelling itself. The regression the brief names is pinned and proved: planting the naive implementation -- a profile as a bundle of settings applied wholesale -- fails the two market-lookup tests, because switching Replies only to Replies and posts would re-enable a lookup source the owner turned off. Turning a lookup source off is now possible at all: `policy.tools.research` has web and market switches that `research()` honours and reports as a gap.
| 113 | Health scoreboard | DONE | `healthScoreboard.test.ts`. Built entirely out of `/api/agents/:id/status`, which is the same collection the agent reads when asked why it is not replying and the same one the live status word comes from. A test asserts there is no second health system and no invented state. Each part shows when it last *succeeded* rather than when it last ran, because a poller failing every thirty seconds for two hours ran a moment ago. It also gave the notifications from 110 a destination: three of their links pointed at routes that did not exist and silently redirected home, which the same test now catches.

## Gaps left open deliberately

These are the parts of a VERIFIED row that are genuinely missing. They are small
and named rather than folded into a claim that the section is finished.

- **§94** Websites are not a knowledge source kind. `PATH`, `UPLOAD` and `TEXT`
  are. Fetching a site means deciding about robots, rate, revisit and what
  counts as the same page, and none of that is decided.
- **§94** PDFs are not read. `DOCUMENT_EXTENSIONS` is Markdown and text only.
- **§95** *Closed, and the premise was wrong.* No tool shows when it was last
  used successfully because **no tool has ever been used**: there is no
  tool-call loop in AI17Z. Nothing parses a tool call out of a model's answer,
  nothing executes one, nothing feeds a result back. The prompt nevertheless
  carried a block headed `TOOLS AVAILABLE` listing every tool that was switched
  on and permitted, which tells a model it can check things it cannot -- the
  same class of defect as an unread image passing silently.

  Fixed by making the model of a tool honest rather than by building a
  tool-call loop. The runtime looks things up itself and hands over facts, so a
  tool that is on now contributes a **fact** instead of an offer: `time.now`
  becomes the date and time stated in the agent's own timezone, which is a real
  capability it did not have. `memory.search` and `agent.diagnostics` already
  arrive through other layers and contribute nothing here rather than being
  listed twice. `http.fetch` is marked "nothing calls it" on the tools screen
  instead of looking ready. `tests/unit/toolSupply.test.ts`.
- **§95** Required capabilities are not shown per tool, because no built-in tool
  currently requires one beyond the policy allowlist.
