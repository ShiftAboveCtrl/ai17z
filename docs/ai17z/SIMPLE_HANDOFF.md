# Easy Mode, three tabs, and nested mentions — handoff

Eight commits, 517 tests passing, on `ai17z-overhaul`.

```
91a4a3a  legacy-context-regression: the whole branch, not just one post above
8ea1636  x-three-tab-runtime: reading no longer interrupts posting
13f1af5  your-agents-layout-fix: the descenders were never painted
e8d7ed8  easy-mode-config-layer: one configuration, described twice
61b98a7  easy-agent-setup: connect, describe, choose, start
785939f  verified-only: a switch that does something
60288c5  chrome: find the browser that outlived the worker
5f7dd04  ai17z-simplified-ux-rc: docs and handoff
```

---

## Easy Mode

**The flow.** `/agents/new`, eight steps, one decision each:

```
Agent -> Connect X -> Character -> Connect AI -> Replies -> Posts -> Operation -> Review
```

The agent record is created after step 1, so connecting X has something to
attach to and closing the tab does not lose everything. Step 2 launches the real
Chrome sign-in and follows the account's state on its own. Step 8 runs a
preflight and refuses with a list of blockers rather than activating something
that will fail on its first job.

The old eight-screen configuration wizard is intact at `/agents/new/advanced`.

**The agent page** opens in a simple view — character, AI, replies, posts, what
the three browser tabs are doing, and recent activity in sentences. `Advanced`
is one button away and still has all twelve sections. The choice is remembered
across agents.

## Advanced Mode

Nothing was removed. All twelve sections are reachable and were verified after
the change: identity, voice, accounts, intelligence, relationships, beliefs,
memory, pipeline, tools, policies, behaviour, activity.

## Config mapping

Full table in `docs/architecture/EASY_MODE.md`. The rule:

```
EASY MODE (eleven answers)        ADVANCED MODE (every field)
        \                                /
         the same versioned persona, policy,
         cadence, radar sources, posting schedule
                        |
                  the same runtime
```

There is no `easy_setup` table. `packages/runtime/src/easyMode.ts` is pure and
projects both ways. Two properties are tested: the round trip is a fixed point,
so opening the screen and pressing save does not change an agent; and anything
Advanced set that Easy has no word for is *reported*, never flattened.

Proved live: the `concise` preset landed in the database as
`tone = "Direct and unhurried. Says the thing and stops."`,
`responseLength = TERSE`, `automation.mode = REVIEW_BEFORE_ACTION`,
`engagement.minimumReplyValue = 35`. Setting a threshold of 44 and working hours
in Advanced then produced:

```
exact: False
- The reply threshold is set to 44, between Easy Mode's three settings. The nearest is shown.
- Working hours are set. Easy Mode does not show them and will not change them.
- 1 banned phrase(s) are set.
```

## Three-tab runtime

`ACTION` / `MENTIONS` / `NOTIFICATIONS`, in one real Chrome, tagged by
`window.name`. Roles run concurrently; same-role operations queue. A closed tab
is recreated alone without restarting the browser. The worker publishes health
to `browser_sessions.tabs` every ten seconds because the API owns no browsers.
Details in `docs/architecture/X_RUNTIME.md`.

## AI4CZ findings

Re-read `scrape-notifications-to-inbox.js` (1155 lines), `post-replies-cdp.js`
(1420), `normalizeTargetId.js`, and `inboxService.ts`. Nothing was written to
`../ai4cz`.

- The focal post was found by the article linking to its **own** status id, with
  no positional fallback. That idea is intact and now covered by fixtures.
- Context was `articles[focalIndex - 1]`, one level, with a
  `pt !== mentionText` guard. That is the whole legacy context model.
- **`clickReplyVerified` was written and never called.** It reads the composer's
  "Replying to @handle" and retries on a mismatch — a good idea that was in the
  repository but not in the running system.
- Quote handling was incidental, as the PDF says: no quoted-post selector exists
  anywhere in the scraper.

## PDF findings

`AI4CZ_Nested_Mentions_and_Reply_Context_Handling.pdf` matches the code
everywhere it makes a claim. Its section 10 asks for exactly what was built: keep
the exact-status-ID anchoring, replace the one-parent extractor with a resolver
that understands replies, roots, and quoted posts.

## Nested mentions

`ResolvedContext.targetRef` is the action target. `ResolvedContext.conversation`
is context and may never influence it; the adapter fails permanently if they
disagree. On a status page X has already resolved the reply chain and renders
root-to-focal above it, so ancestors are "the articles before the focal" and
sibling branches are excluded structurally rather than filtered afterwards.

Also new: display name, timestamp, self flag and verified flag per post; the
platform's own "Replying to" line as a branch cross-check; the parent's media
read when the mention leans on it ("@agent thoughts?" under a chart).

## Context regression fixtures

`tests/unit/xConversation.test.ts` — 26 assertions, 11 cases:

| Case | Target | Parent | Ancestors |
| --- | --- | --- | --- |
| direct mention under a root | the mention | the root | root |
| reply to the agent's own post | the reply | agent's post, flagged self | agent's post |
| mention beneath someone's reply | the mention | that reply | A, B |
| A→B→C→D, mention at D | D | C | A, B, C |
| branch plus two sibling replies | focal | on-branch parent | branch only, 2 excluded |
| quoted post | the mention | A | quote structured |
| focal absent | — | — | refuses |
| focal rendered twice | focal | none | duplicate suppressed |
| promoted article, no status id | focal | real parent | promo dropped |
| 20-deep chain, bound of 5 | focal | last ancestor | root + 4 nearest |
| render order vs "replying to" | focal | render order wins | flagged unconfirmed |

Case 4 is the AI4CZ regression: it passes now and would have failed then.

## Your Agents bug

**Root cause, measured, not guessed.** `.monument` gives its text no colour —
every pixel comes from a gradient, and a gradient is painted only inside the
element's background box. Line-height 0.84 makes that box shorter than the
glyphs. On the running page at 204.8px:

```
background box  172.0px
baseline at     158.0px  ->  14.0px beneath it
ink descent      36.0px  ->  22.0px with nowhere to be painted
```

Nothing was clipping it and no margin would have helped. **Fix:** extend the
background box past the descenders and take the extension straight back out of
the layout, in `em`:

```css
padding-block-end: 0.28em;
margin-block-end: -0.28em;
```

Sized for the system fallback (0.24em descenders), not Kanit (0.18em), because a
machine with no network never gets Kanit. Verified at 390 / 834 / 1280 / 1440 /
2200 on the running page, all positive headroom, layout unchanged and no
horizontal scroll. `tests/integration/headingPaint.test.ts` reads the rule out of
`styles.css` and measures it, so deleting the padding fails the test.

## Providers

**Not tested against live APIs.** No real key is configured on this machine. What
was exercised: the Easy Mode provider step creates a credential, calls the real
`POST /api/providers/:id/test`, and writes the `primary` model config — proved
end to end with the `mock` provider, through the same code path OpenRouter,
OpenAI, Anthropic and DeepSeek use. The adapters themselves are covered by
`tests/integration/providers.test.ts` and `providerRegression.test.ts`.

The buttons are wired and the failure path is honest — a bad key surfaces the
provider's own message — but nobody has watched OpenRouter answer.

## Real Chrome

Every claim about browser identity comes from
`tests/integration/realChrome.test.ts`, 18 tests against **Google Chrome
151.0.7922.175**, never Chromium:

```
executable  C:\Program Files\Google\Chrome\Application\chrome.exe
product     Google Chrome 151.0.7922.175
cdpProduct  Chrome/151.0.7922.175
bundledChromiumUsed  false
```

Three-tab acceptance in that file: three roles share one browser and get three
distinct pages; a role reuses its tab; a closed tab recovers without touching
the others; two operations on one tab serialise.

**Live, on the real `@youraccount` account:** attached to the running Chrome
(pid 63168, port 10482), opened `MENTIONS` on
`x.com/search?q=to:youraccount -from:youraccount&f=live` and
`NOTIFICATIONS` on `x.com/notifications/mentions` as separate tabs, and after a
worker reload **adopted** the notifications tab by `window.name` rather than
opening a fourth.

That run also found a real defect and a real mess:

- A restarted worker could not get back to the Chrome it had spawned, so it
  spawned another on the same profile; Chrome handed off and exited, and every
  poll failed. Fixed by recording the port beside the profile.
- That browser had **253 tabs, all `x.com/home`**, leaked one per poll by the
  single-page code the three-tab runtime replaces. A browser in that state
  answers `/json/version` and then times out the CDP handshake. The surplus was
  closed; `existingChrome` now counts pages and refuses with a clear message.

`tests/integration/headingPaint.test.ts` uses Playwright Chromium deliberately —
it measures CSS layout and says nothing about which browser drives X.

## Automated tests

**517 passed, 49 files.** New in this pass:

| File | Tests |
| --- | --- |
| `tests/unit/xConversation.test.ts` | 26 |
| `tests/unit/easyMode.test.ts` | 22 |
| `tests/integration/posting.test.ts` | 13 |
| `tests/unit/verifiedOnly.test.ts` | 5 |
| `tests/integration/easyRoundTrip.test.ts` | 5 |
| `tests/integration/realChrome.test.ts` | +6 (12 → 18) |
| `tests/integration/headingPaint.test.ts` | 2 |

## Live X

| | Status |
| --- | --- |
| Read-only | **Done.** Both monitors ran against the live signed-in account and loaded their X surfaces. |
| Dry run | **Not done against X.** A full dry run was exercised on the mock channel end to end. |
| Approved reply | **Not done.** Never attempted; it needs your say-so. |
| Autonomous | **Not done.** No agent has been left running unattended on X. |

The mock-channel run is real evidence for everything except the X DOM: an
injected mention with a parent produced a job that resolved context, scored
engagement (`engage 65/100: asks a direct question`), assembled 8 prompt layers,
generated, validated, and completed as `DRY_RUN_COMPLETED`. A scheduled post ran
the same ten steps and stopped at `WAITING_FOR_APPROVAL` with the TASK layer
reading *"Write one Mock channel post... Nobody asked you anything"*.

## Remaining limitations

- **No live provider has answered.** See above.
- **No reply or post has gone to X.** The composer path, the read-back, and
  `returnToIdle` have never run against the real site.
- **Verified detection is unproven on live X.** The selector
  `[data-testid="icon-verified"]` is the current one; nothing has confirmed it
  against a real verified account. It fails closed, so the failure mode is
  refusing to reply rather than replying wrongly.
- **The parent's media is exposed, not described.** A mention leaning on its
  parent's image reaches the model as *"That post also carries 1 image. You have
  not seen the attachments, so do not describe them."* Feeding it to a vision
  model would need the media store to record which post an item belongs to.
- **No vision model is configured**, so image understanding is untested here.
- **`@ai4cz_binance` is still `TIMEOUT`** and has never completed a sign-in.
- **Easy Mode has no "learn from X"** step. The persona source machinery exists
  and is reachable from Advanced; §7 of the brief is not built.
- **The 253-tab browser was tidied by hand.** The leak is fixed at the source,
  but any other long-running profile from before this change may need the same.

## Things worth knowing next time

`existingChrome` reads `ai17z-cdp.json` beside the profile. If an account will
not open a browser, look there first: a stale file pointing at a dead port is
handled, but a file pointing at a *wedged* browser now produces a specific
message naming the tab count.

The four enums with database CHECK constraints did not grow in this pass, so
`tests/integration/statusConstraints.test.ts` needed no changes. If you add one,
it must.
