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
| 98 | Owner inbox | TODO | |
| 99 | Conversation view | TODO | |
| 100 | Live agent status | DONE | `liveStatus.test.ts`. Eight states, each derived from work that exists. Verified in the running app: the dev agent reads NEEDS YOU with the reason beside it. |
| 101 | Content queue | PARTIAL | §59-70 built Ideas end to end with a screen, ageing, provenance and per-idea failure reasons. Drafts, Scheduled and Posted are not yet separate views, and the actions are set-aside and put-back rather than edit / approve / schedule / post-now. |

## Gaps left open deliberately

These are the parts of a VERIFIED row that are genuinely missing. They are small
and named rather than folded into a claim that the section is finished.

- **§94** Websites are not a knowledge source kind. `PATH`, `UPLOAD` and `TEXT`
  are. Fetching a site means deciding about robots, rate, revisit and what
  counts as the same page, and none of that is decided.
- **§94** PDFs are not read. `DOCUMENT_EXTENSIONS` is Markdown and text only.
- **§95** No tool shows when it was last used successfully. The data exists in
  traces; the tools screen does not read it.
- **§95** Required capabilities are not shown per tool, because no built-in tool
  currently requires one beyond the policy allowlist.
