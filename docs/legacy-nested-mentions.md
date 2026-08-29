# Nested mentions: what AI4CZ did, and what AI17Z does now

Evidence for this document:

- `AI4CZ_Nested_Mentions_and_Reply_Context_Handling.pdf`, supplied by the owner
- `../ai4cz/scripts/scrape-notifications-to-inbox.js` (1155 lines)
- `../ai4cz/scripts/post-replies-cdp.js` (1420 lines)
- `../ai4cz/scripts/normalizeTargetId.js` (31 lines)
- `../ai4cz/custom_plugins/plugin-inbox/src/inboxService.ts` (468 lines)
- `../ai4cz/custom_plugins/plugin-inbox/src/justoin case.js` (354 lines, an earlier copy)

The legacy directory was read and never written to.

---

## 1. The idea worth keeping

AI4CZ separated two problems that look like one:

```
TARGET IDENTITY                  SEMANTIC CONTEXT
status id / permalink            mention text + parent text
-> authoritative                 -> what the conversation is about
-> decides where the reply goes  -> decides what the reply says
```

X renders many posts on one page — a root, a quoted card, an ancestor chain,
neighbouring replies — and their visual order does not identify which one caused
the notification. AI4CZ solved this by never letting context traversal influence
the target.

The PDF states it as: target identity was authoritative, and visual DOM position
such as "the second article" was not trusted.

## 2. How the target was actually found

`extractMentionAndParent` in the scraper, lines 541–590:

```js
const statusId = parseTweetId(page.url());
for (let i = 0; i < Math.min(count, 15); i++) {
  const hasLink = await articles.nth(i).locator(`a[href*="/status/${statusId}"]`).count();
  if (hasLink > 0) { focalIndex = i; break; }
}
if (focalIndex === -1) {
  return { ok: false, reason: "focal_article_not_found", ... };
}
```

The focal post is the article containing a link to **its own** status id. When no
article matches, the run stops. There is no positional fallback anywhere in the
file. This is the single most important line of defence in the whole legacy
system, and it matches the PDF exactly.

The poster reused the same anchor, at line 1252:

```js
const targetTweet = page
  .locator(`article[data-testid="tweet"]:has(a[href*="/status/${statusId}"])`)
  .first();
if (!targetCount) { /* screenshot, drop the item, do not reply */ }
```

followed by reading the author handle **from the anchored article**, not from
`page.first()` — with a comment saying so — and a self-reply guard on that
handle.

## 3. What the context extractor actually did

Also `extractMentionAndParent`, lines 576–581:

```js
let parentText = "";
if (focalIndex - 1 >= 0) {
  const parentArticle = articles.nth(focalIndex - 1);
  const pt = (await extractTweetTextFromArticle(parentArticle))?.trim() || "";
  if (pt && pt !== mentionText) parentText = pt;
}
```

One article. That is the whole context model. The `pt !== mentionText` guard
exists because X sometimes renders the focal post above itself.

That text reached the model through `inboxService.ts` line 386 as two labelled
blocks:

```
PARENT CONTEXT (if any):
<parentText>

MENTION TEXT:
<mentionText>
```

and was stored to SQLite as `@author: mention\n\nPARENT:\nparent`.

### The consequence

For `A -> B -> C -> D` where D mentions the agent, AI4CZ targeted D correctly and
told the model only about C. The PDF says this plainly: *the finished AI4CZ
implementation did not build a complete ancestry graph*.

## 4. Where the PDF and the code disagree

Two discrepancies, both resolved by reading what actually ran.

**`clickReplyVerified` was written and never called.** `post-replies-cdp.js`
defines it at line 326: click reply inside the anchored article, then read the
composer's "Replying to @handle" line, and retry with three escalating click
strategies if it names the wrong person. It is a genuinely good idea. Nothing
calls it. The live path at line 1284 clicks the reply button inside the anchored
article and proceeds. So the third verification layer existed in the repository
but not in the running system.

**Quote handling was not deliberate.** The PDF says quote extraction "was not a
dedicated part of the historical implementation" and the code agrees: there is no
quoted-post selector anywhere in the scraper. Quoted text reached the model only
when it happened to fall inside an article's `innerText`, which depended on which
DOM X served that day.

Everything else in the PDF matches the code line for line.

## 5. What AI17Z does now

`packages/channels/src/x/conversation.ts` — pure, no DOM, covered by fixtures.

| | AI4CZ | AI17Z |
| --- | --- | --- |
| Focal post | article containing its own status id | same |
| No focal found | `focal_article_not_found`, stop | `focal_article_not_found`, stop |
| Ancestors | `articles[focalIndex - 1]`, one level | every article above the focal, oldest first |
| Root | not identified | first ancestor |
| Other branches | not considered | excluded by construction, counted |
| Author | handle only | handle, display name, self flag, timestamp |
| Quoted post | incidental | structured `QuotedPost` |
| Parent media | not read | read when the mention leans on it |
| Parent cross-check | none | X's own "Replying to" line, reported not enforced |
| Duplicate focal guard | `pt !== mentionText` | same, plus status-id dedupe |
| Context bound | one post | 10 ancestors, root always kept |

### Why "everything above the focal" is the branch

When X renders `/user/status/<id>` it has already resolved the reply chain
server-side and renders exactly the path from the root down to that post, in
order, above it. Everything below is a different branch: replies to the focal, or
siblings of it. So sibling branches are excluded structurally rather than
filtered out afterwards, and the ancestor order comes from X's own resolution
rather than from a guess.

### The invariant

`ResolvedContext.targetRef` is derived from the incoming post's own status id.
`ResolvedContext.conversation` is context and only context. The X adapter asserts
they agree before returning:

```ts
if (conversation.incoming.remoteId !== statusId) {
  throw PipelineError.permanent('target_context_mismatch', ...);
}
```

and `tests/unit/xConversation.test.ts` asserts that no ancestor ever carries the
focal status id.

### What was deliberately not adopted

- **`clickReplyVerified`'s retry loop.** AI17Z verifies before opening the
  composer (`verifyAction` anchors and checks the author) and again after
  submitting (read-back finds the sent reply by author and text). A retry loop
  around a mis-anchored click is a symptom fix for a problem the anchor already
  prevents. The composer check itself is worth having and is now on the list.
- **Two browser profiles per account.** AI4CZ ran the poster on `:9222` and the
  scraper on `:9223` so two standalone scripts could not fight over one profile.
  AI17Z serialises browser work per account with a lease, and now separates
  reading from acting with three tab roles inside one browser. See
  `docs/architecture/X_RUNTIME.md`.

## 6. The fixtures

`tests/unit/xConversation.test.ts`, 26 assertions across 11 cases. Each records
the X structure, the expected incoming post, the expected action target, the
expected parent, the expected ancestor order, and what is deliberately excluded.

| Case | Structure | Target | Parent | Ancestors |
| --- | --- | --- | --- | --- |
| 1 | A by alice, B mentions agent | B | A | A |
| 2 | agent posts A, alice replies | alice's reply | A (flagged self) | A |
| 3 | A -> B -> C mentions agent | C | B | A, B |
| 4 | A -> B -> C -> D mentions agent | D | C | A, B, C |
| 5 | branch + two sibling replies below | focal | on-branch parent | branch only, 2 excluded |
| 6 | A quotes another post, C mentions agent | C | A | A, quote structured |
| 7 | focal absent from page | — | — | refuses, `focal_article_not_found` |
| 8 | focal rendered twice | focal | none | duplicate suppressed |
| 9 | promoted article with no status id | focal | real parent | promo dropped |
| 10 | 20-deep chain, bound of 5 | focal | last ancestor | root + 4 nearest |
| 11 | render order disagrees with "replying to" | focal | render order wins | flagged unconfirmed |

Case 4 is the AI4CZ regression: it passes now and would have failed then.
