import { describe, expect, it } from 'vitest';
import { actions as actionsRepo, query } from '@xbam/database';
import { capabilityIdempotencyKey, signatureFor } from '@xbam/runtime';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { uniqueSuffix } from '../support/db';

installHarness();

/**
 * Asking for the same desired state twice, from two different jobs.
 *
 * `x.like` and `x.repost` are desired states rather than toggles: asking twice
 * is meant to be safe, because the second ask reads the page, finds the state
 * already right and touches nothing. That is the whole reason `ensureEngaged`
 * reads before it clicks.
 *
 * The bookkeeping did not agree. `actions_content_signature_key` exists to stop
 * byte-identical *text* reaching one target twice -- migration 0006 says so in
 * as many words -- and a like has no text, so the signature was taken over the
 * target instead. Two likes of one post therefore collided on a unique index,
 * and the second one failed *after* correctly deciding to do nothing:
 *
 *     x.like -> FAILED  duplicate key value violates unique constraint
 *                       "actions_content_signature_key"
 *
 * The post was liked. The model was told the like had failed. Found by driving
 * a second real invocation against real X, which is the only place it could
 * have shown up.
 *
 * Against real Postgres because the guarantee is a partial unique index, and
 * asserting anything about it without one asserts nothing.
 */
describe('the same desired state asked for twice', () => {
  const target = 'https://x.com/i/web/status/2099000000000000001';

  /** One capability write, recorded the way `performCapabilityAction` records it. */
  async function claimAndComplete(agentId: string, jobId: string, jobKey: string, text: string) {
    const claim = await actionsRepo.claimAction({
      jobId,
      agentId,
      accountId: null,
      channel: 'x',
      type: 'LIKE',
      dryRun: false,
      idempotencyKey: capabilityIdempotencyKey({
        jobIdempotencyKey: jobKey,
        capabilityId: 'x.like',
        targetRef: target,
      }),
      payload: { text, targetRef: target, capabilityId: 'x.like' },
      targetRef: target,
    });
    if (claim.outcome !== 'CLAIMED') return claim.outcome;
    await actionsRepo.completeAction(claim.action.id, {
      status: 'EXECUTED',
      remoteActionId: '2099000000000000001',
      // The decision under test, called rather than imitated: a revert of
      // `signatureFor` fails here rather than passing quietly.
      contentSignature: signatureFor({ type: 'LIKE', text, targetRef: target }),
    });
    return 'COMPLETED';
  }

  async function jobFor(agentId: string, text: string): Promise<{ id: string; idempotencyKey: string }> {
    const { ingestNormalizedEvent } = await import('@xbam/runtime');
    const { NormalizedEvent } = await import('@xbam/shared/contracts');
    const outcome = await ingestNormalizedEvent({
      accountId: null,
      onlyAgentId: agentId,
      event: NormalizedEvent.parse({
        channel: 'x',
        type: 'MENTION',
        remoteEventId: `rep-${uniqueSuffix()}`,
        remoteAuthorHandle: 'somebody',
        text,
      }),
    });
    const job = outcome.jobs[0]!.job;
    return { id: job.id, idempotencyKey: job.idempotencyKey };
  }

  it('signs the text, and signs nothing when there is none', () => {
    // The decision itself. Signing the target instead -- which is what it used
    // to do -- makes two likes of one post collide on a unique index whose
    // stated purpose is byte-identical text.
    expect(signatureFor({ type: 'LIKE', text: '', targetRef: target })).toBeNull();
    expect(signatureFor({ type: 'REPOST', text: '', targetRef: target })).toBeNull();
    const signed = signatureFor({ type: 'REPLY', text: 'some words', targetRef: target });
    expect(signed).toMatch(/^[0-9a-f]{64}$/);
    // Different text, different signature; the guard still guards.
    expect(signatureFor({ type: 'REPLY', text: 'other words', targetRef: target })).not.toBe(signed);
    // Same text to a different target is still the same words, which is what
    // the index is about.
    expect(signatureFor({ type: 'REPLY', text: 'some words', targetRef: 'https://x.com/i/web/status/999' })).toBe(signed);
  });

  it('records both, because a like has no text to be duplicated', async () => {
    // The regression. Under the old signature -- target rather than text --
    // the second completion threw on the unique index and the invocation was
    // reported as failed for a post that was liked.
    const fixture = await createFixture();
    const first = await jobFor(fixture.agentId, 'one');
    const second = await jobFor(fixture.agentId, 'two');

    expect(await claimAndComplete(fixture.agentId, first.id, first.idempotencyKey, '')).toBe('COMPLETED');
    expect(await claimAndComplete(fixture.agentId, second.id, second.idempotencyKey, '')).toBe('COMPLETED');

    const rows = await query<{ n: string }>(
      `select count(*)::text as n from actions where agent_id=$1 and type='LIKE' and status='EXECUTED'`,
      [fixture.agentId],
    );
    expect(rows[0]!.n).toBe('2');
  });

  it('still refuses the same text to the same agent twice', async () => {
    // The guard the index is actually for is untouched: a capability that does
    // carry text keeps it, without anybody having to ask.
    const fixture = await createFixture();
    const first = await jobFor(fixture.agentId, 'one');
    const second = await jobFor(fixture.agentId, 'two');

    expect(await claimAndComplete(fixture.agentId, first.id, first.idempotencyKey, 'same words')).toBe('COMPLETED');
    await expect(
      claimAndComplete(fixture.agentId, second.id, second.idempotencyKey, 'same words'),
    ).rejects.toThrow(/content_signature/);
  });

  it('gives the same job the action it already has rather than a second one', async () => {
    // Inside one job the key is identical by construction, which is what stops
    // a model that asks twice acting twice -- and it short-circuits before the
    // browser is touched at all.
    const fixture = await createFixture();
    const job = await jobFor(fixture.agentId, 'one');

    expect(await claimAndComplete(fixture.agentId, job.id, job.idempotencyKey, '')).toBe('COMPLETED');
    expect(await claimAndComplete(fixture.agentId, job.id, job.idempotencyKey, '')).toBe('ALREADY_EXECUTED');
  });
});
