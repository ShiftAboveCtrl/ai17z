import { describe, expect, it } from 'vitest';
import { actions as actionsRepo, jobs as jobsRepo, query } from '@xbam/database';
import { capabilityIdempotencyKey, ingestNormalizedEvent } from '@xbam/runtime';
import { installHarness, mockEvent } from '../support/harness';
import { createFixture, seedCatalogue } from '../support/fixtures';


installHarness();

/**
 * A capability write is claimed, and claiming is what makes it safe.
 *
 * The guarantees a capability write inherits do not live in the code that calls
 * them -- they live in the partial unique index on `actions.idempotency_key`
 * and in the stale-retake rule. So these run against real Postgres: a mock
 * would accept two claims for one key and prove the opposite of the thing being
 * tested.
 *
 * What a crash actually looks like: a worker dies with an action EXECUTING, the
 * row stays behind, and the next attempt retakes it. Retaking is not resending
 * -- the retaken claim is flagged so the caller asks the remote first, which is
 * the difference between recovery and a duplicate-post machine.
 */
async function jobFor() {
  await seedCatalogue();
  const fixture = await createFixture();
  // A real job, through the real ingest path: a capability action belongs to
  // one, and its idempotency key is derived from the job's own.
  const outcome = await ingestNormalizedEvent({
    accountId: null,
    onlyAgentId: fixture.agentId,
    event: mockEvent('Something worth a considered answer about token distribution today'),
  });
  const created = outcome.jobs[0]?.job;
  const [job] = created
    ? [{ id: created.id, idempotency_key: created.idempotencyKey, agent_id: created.agentId, account_id: created.accountId }]
    : await query<{ id: string; idempotency_key: string; agent_id: string; account_id: string | null }>(
        `SELECT id, idempotency_key, agent_id, account_id FROM jobs WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [fixture.agentId],
      );
  // Loudly, not by returning. A guard that skips when the fixture changes is
  // how a suite keeps passing while testing nothing.
  if (!job) throw new Error('the fixture produced no job for a capability action to belong to');
  return { fixture, job };
}

const claim = (input: {
  jobId: string;
  agentId: string;
  accountId: string | null;
  key: string;
  target: string;
}) =>
  actionsRepo.claimAction({
    jobId: input.jobId,
    agentId: input.agentId,
    accountId: input.accountId,
    channel: 'x',
    type: 'LIKE',
    dryRun: false,
    idempotencyKey: input.key,
    payload: { targetRef: input.target, capabilityId: 'x.like' },
    targetRef: input.target,
  });

describe('claiming a capability action', () => {
  it('gives the same claim back rather than a second action', async () => {
    const { fixture, job } = await jobFor();
    const target = 'https://x.com/i/web/status/1234567890123';
    const key = capabilityIdempotencyKey({
      jobIdempotencyKey: job.idempotency_key,
      capabilityId: 'x.like',
      targetRef: target,
    });
    const common = { jobId: job.id, agentId: fixture.agentId, accountId: job.account_id, key, target };

    const first = await claim(common);
    expect(first.outcome).toBe('CLAIMED');

    // A model that asks twice inside one job is the case this exists for.
    const second = await claim(common);
    expect(second.outcome).toBe('IN_PROGRESS');
    if (second.outcome === 'IN_PROGRESS') expect(second.action.id).toBe(first.action.id);

    const rows = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM actions WHERE idempotency_key = $1`,
      [key],
    );
    expect(rows[0]!.n).toBe('1');
  });

  it('will not act again once it has been done', async () => {
    const { fixture, job } = await jobFor();
    const target = 'https://x.com/i/web/status/2234567890123';
    const key = capabilityIdempotencyKey({
      jobIdempotencyKey: job.idempotency_key,
      capabilityId: 'x.like',
      targetRef: target,
    });
    const common = { jobId: job.id, agentId: fixture.agentId, accountId: job.account_id, key, target };

    const first = await claim(common);
    if (first.outcome !== 'CLAIMED') throw new Error('expected a claim');
    await actionsRepo.completeAction(first.action.id, {
      status: 'EXECUTED',
      remoteActionId: '999',
      remoteActionUrl: 'https://x.com/a/status/999',
    });

    const again = await claim(common);
    expect(again.outcome).toBe('ALREADY_EXECUTED');
    if (again.outcome === 'ALREADY_EXECUTED') {
      expect(again.action.remoteActionId).toBe('999');
    }
  });

  it('flags a retake so the remote is asked before acting again', async () => {
    // The crash. A worker died with this EXECUTING; local state cannot tell
    // whether X saw it. The flag is what sends the caller to `wasAlreadyDone`.
    const { fixture, job } = await jobFor();
    const target = 'https://x.com/i/web/status/3234567890123';
    const key = capabilityIdempotencyKey({
      jobIdempotencyKey: job.idempotency_key,
      capabilityId: 'x.like',
      targetRef: target,
    });
    const common = { jobId: job.id, agentId: fixture.agentId, accountId: job.account_id, key, target };

    const first = await claim(common);
    if (first.outcome !== 'CLAIMED') throw new Error('expected a claim');

    // Age it past the point where a live worker is a plausible explanation.
    //
    // The trigger from migration 0046 sets `updated_at = now()` on every update,
    // deliberately -- a row touched by a path that forgot the column would look
    // permanently fresh and never be recovered. Which means the only way to
    // fabricate the passage of time is to suspend it for this one statement.
    await query(`ALTER TABLE actions DISABLE TRIGGER actions_set_updated_at`);
    await query(
      `UPDATE actions SET status = 'EXECUTING', updated_at = now() - interval '30 minutes' WHERE id = $1`,
      [first.action.id],
    );
    await query(`ALTER TABLE actions ENABLE TRIGGER actions_set_updated_at`);

    const retaken = await claim(common);
    expect(retaken.outcome).toBe('CLAIMED');
    if (retaken.outcome === 'CLAIMED') {
      expect(retaken.retakenFromStale).toBe(true);
      expect(retaken.action.id).toBe(first.action.id);
    }
  });

  it('keeps two capabilities in one job apart', async () => {
    const { fixture, job } = await jobFor();
    const target = 'https://x.com/i/web/status/4234567890123';
    const base = { jobIdempotencyKey: job.idempotency_key, targetRef: target };
    const likeKey = capabilityIdempotencyKey({ ...base, capabilityId: 'x.like' });
    const repostKey = capabilityIdempotencyKey({ ...base, capabilityId: 'x.repost' });

    const like = await claim({ jobId: job.id, agentId: fixture.agentId, accountId: job.account_id, key: likeKey, target });
    const repost = await claim({
      jobId: job.id,
      agentId: fixture.agentId,
      accountId: job.account_id,
      key: repostKey,
      target,
    });
    expect(like.outcome).toBe('CLAIMED');
    // Liking something is not reposting it, and one must not suppress the other.
    expect(repost.outcome).toBe('CLAIMED');
  });

  it('does not collide with the job’s own action', async () => {
    // The job's reply and a capability's like live in the same table under keys
    // that must never be the same one.
    const { job } = await jobFor();
    const derived = capabilityIdempotencyKey({
      jobIdempotencyKey: job.idempotency_key,
      capabilityId: 'x.like',
      targetRef: 'https://x.com/i/web/status/5234567890123',
    });
    expect(derived).not.toBe(job.idempotency_key);
    expect(await jobsRepo.getJob(job.id)).toBeTruthy();
  });
});
