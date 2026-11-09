# Beta 0.91 core batch

This integration branch starts from main at `3ce2ce5b`. The accepted commits
were merged in the requested order, using the specified commits rather than
moving branch tips. It does not change the release version or create a tag.

## Conflict resolutions

- Channel registration and context: retain Telegram, Farcaster and Bluesky in
  `channels/src/registry.ts`, `channels/src/index.ts`, `channels/src/contract.ts`,
  `channels/package.json`, `database/src/index.ts`, `runtime/src/bootstrap.ts`,
  `runtime/src/channelContext.ts`, `tools/src/toolpacks.ts` and `packsOff.test.ts`.
  Both new package dependencies remain. Bot tokens, app signers and app passwords
  are opened only by their respective channels.
- Account routes and readiness: retain all channel-specific link, reconnect and
  disconnect paths in `accounts.ts`. Preserve the distinct Bluesky explanations
  and credential-presence check in `agentStart.ts`, and treat every authenticated
  channel as requiring a connection in `health.ts` and the registry helper.
- Polling in `poller.ts`: keep Telegram's offset, Farcaster's versioned cursor
  and Bluesky's notification watermark and page budget. Commit progress after
  ingesting events. Preserve each channel's authentication failures and remote
  retry delay.
- Shared channel declarations: keep both channel values in `contracts/enums.ts`
  and both JWT and signing-key redaction in `logger.ts`.
- Execution in `steps/execute.ts`: keep social-paper receipt integrity, signal
  evidence refusal, Studio paper-record checks and channel-specific reaction
  idempotency keys. Remove the duplicate channel property introduced by merging.
- Paper-record origination in `originate.ts`: propose an opted-in paper-record
  idea before selecting a post, while retaining the signal radar's account scope.
- Policy and public exports: retain peer-review quality policy and Studio paper
  policy in `contracts/policy.ts`. Keep all feature exports in `runtime/index.ts`
  and `shared/contracts/index.ts`, including paper voice and voice publishing.
- Studio capabilities: preserve the paper-record, voice and league registrations,
  relevance hints and separate toolpacks in `bootstrap.ts`,
  `capabilityRelevance.ts`, `toolpacks.ts` and `packsOff.test.ts`. Add activity-tape
  registration alongside them. The automatically merged `studioLink.ts` keeps
  paper-record reads, voice transport, league installation requests and tape batches.
- Wallet boundary tests: keep both paper-record and league assertions and all
  source-boundary checks in `noWalletCapabilities.test.ts`.
- Constraint tests: retain channel coverage from all branches and remove the
  duplicate `CHANNELS` import in `statusConstraints.test.ts`.

## Migrations

The batch adds `0114_bluesky_channel`, `0115_farcaster_channel`,
`0116_telegram_channel`, `0117_social_paper_requests`, `0118_signal_radar`,
`0120_league_bridge` and `0121_capability_permission_changed_at`.
There are no duplicate numbers; 0119 remains unused.

Only `0114_bluesky_channel` rewrites `accounts_channel_check`, widening it to
include Bluesky and Farcaster (Telegram was already listed). `0115` leaves it
alone. No previously released migration was edited.

## Fixes and remaining nits

Required items 1 through 5 are implemented. Voice installation now describes a
failed Studio inspection accurately and retries the same listing. Easy Mode
reports enabled peer review and preserves it on save. An entry POST returning
400 `invalid_dpop_proof` remains pending and retries under its original key.

For item 6, the affordable backlog nits completed here are:

- Refuse a stale-at-start Bluesky sign-in before another session request.
- Keep a Telegram send-claim race loser retryable while the winner is sending.
  Recovery of a pre-existing ambiguous send still requires review.
- Verify a Farcaster cast by its exact FID and hash without fetching display names.
- Keep the X capacity-family marker in warning logs.
- Use a concrete POSIX example path consistently in generated MCP instructions
  and remove the unsupported Claude Code version claim.
- Resolve the voice exports and copy, and report peer review in Easy Mode.

Deferred: a Bluesky poll that loses the notification-state compare-and-set still
spends that poll; deleting Farcaster's `ownSeen` cast can cause another history
walk. Both require cursor/recovery behavior changes beyond this batch's bounded
fixes. Ordinary Farcaster walks already stop at `ownSeen` and retain their tests.

## Verification boundary

Targeted unit and integration tests use a dedicated throwaway Postgres container.
The full unit suite, full integration suite, `release:check` and `verify:install`
are deliberately excluded while the shared release gate is held.

The voice-install outage and retry state was rendered at 1440 by 900 and 390 by
844. Retry inspected the same listing, no horizontal overflow occurred and no
page errors were emitted. Screenshots remain local.
