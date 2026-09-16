import { describe, expect, it } from 'vitest';
import { agents as agentsRepo, inbox as inboxRepo, jobs as jobsRepo, query } from '@xbam/database';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { uniqueSuffix } from '../support/db';

installHarness();

/**
 * The badge and the list have to mean the same thing.
 *
 * The defect these exist for, measured on a live installation: "4 messages are
 * waiting for you to decide" beside an **empty inbox**, for over a week, with
 * no way to dismiss it.
 *
 * The count was never wrong. It counts jobs held for a person. The list was
 * incomplete: it was driven by inbound events of four conversational types, and
 * all four waiting jobs were work the agent had started *itself*: an original
 * post and three follow-ups, which arrive on a SCHEDULED_TRIGGER event. Counted
 * by one and shown by neither.
 *
 * Something waiting on a decision has to be reachable, or the decision cannot
 * be made. So the list was completed rather than the count shrunk.
 */

/** A job held for a person, on an event of whatever kind. */
async function heldJob(input: { ownerId: string; agentId: string; eventType: string; actionType: string }) {
  const persona = await agentsRepo.getActivePersona(input.agentId);
  const policy = await agentsRepo.getActivePolicy(input.agentId);
  const suffix = uniqueSuffix();

  const [event] = await query<{ id: string }>(
    `INSERT INTO events (channel, remote_event_id, type, remote_author_handle, text, occurred_at)
     VALUES ('mock', $1, $2, 'someone', 'something worth deciding about', now()) RETURNING id`,
    [`inbox-${suffix}`, input.eventType],
  );
  const [job] = await query<{ id: string }>(
    `INSERT INTO jobs (event_id, agent_id, channel, action_type, idempotency_key, dry_run,
       max_attempts, priority, persona_version_id, policy_version_id, status,
       generated_output, validated_output)
     VALUES ($1, $2, 'mock', $3, $4, true, 5, 100, $5, $6, 'REVIEW_REQUIRED', $7, $7)
     RETURNING id`,
    [event!.id, input.agentId, input.actionType, `inbox:${suffix}`, persona!.id, policy!.id, 'a draft'],
  );
  return job!.id;
}

/** What the badge says: jobs held for a person, across everything. */
async function badgeCount(): Promise<number> {
  const counts = await jobsRepo.countJobsByStatus();
  return (counts.REVIEW_REQUIRED ?? 0) + (counts.WAITING_FOR_APPROVAL ?? 0);
}

describe('what the owner can actually see', () => {
  it('shows work the agent started itself, not only what somebody sent it', async () => {
    // The live shape exactly: one original post and three follow-ups, all held.
    const fixture = await createFixture();
    await heldJob({ ...fixture, eventType: 'SCHEDULED_TRIGGER', actionType: 'POST' });
    for (let i = 0; i < 3; i += 1) {
      await heldJob({ ...fixture, eventType: 'SCHEDULED_TRIGGER', actionType: 'REPLY' });
    }

    const items = await inboxRepo.ownerInbox(fixture.ownerId);
    expect(items).toHaveLength(4);
    // And in the bucket somebody would look in.
    expect(inboxRepo.countBuckets(items).NEEDS_REVIEW).toBe(4);
  });

  it('agrees with the badge', async () => {
    const fixture = await createFixture();
    await heldJob({ ...fixture, eventType: 'SCHEDULED_TRIGGER', actionType: 'POST' });
    await heldJob({ ...fixture, eventType: 'MENTION', actionType: 'REPLY' });

    const items = await inboxRepo.ownerInbox(fixture.ownerId);
    const waiting = items.filter((item) => inboxRepo.bucketOf(item) === 'NEEDS_REVIEW');
    expect(waiting).toHaveLength(await badgeCount());
  });

  it('carries the draft, so a decision does not need a second page', async () => {
    const fixture = await createFixture();
    await heldJob({ ...fixture, eventType: 'SCHEDULED_TRIGGER', actionType: 'POST' });
    const [item] = await inboxRepo.ownerInbox(fixture.ownerId);
    expect(item?.draftText).toBe('a draft');
  });
});

describe('deciding makes it go away', () => {
  it('drops out of the list and the count once it is settled', async () => {
    const fixture = await createFixture();
    const jobId = await heldJob({ ...fixture, eventType: 'SCHEDULED_TRIGGER', actionType: 'POST' });
    expect(await inboxRepo.ownerInbox(fixture.ownerId)).toHaveLength(1);
    expect(await badgeCount()).toBe(1);

    await jobsRepo.updateJob(jobId, { status: 'CANCELLED' });

    // Gone from both, because both are asking the same question now.
    const after = await inboxRepo.ownerInbox(fixture.ownerId);
    expect(after.filter((item) => inboxRepo.bucketOf(item) === 'NEEDS_REVIEW')).toHaveLength(0);
    expect(await badgeCount()).toBe(0);
  });

  it('stays gone when the list is read again', async () => {
    // The live failure survived restarts for a week. Reading twice is the
    // cheapest proof that nothing is being held in memory.
    const fixture = await createFixture();
    const jobId = await heldJob({ ...fixture, eventType: 'SCHEDULED_TRIGGER', actionType: 'REPLY' });
    await jobsRepo.updateJob(jobId, { status: 'CANCELLED' });

    for (let i = 0; i < 2; i += 1) {
      const items = await inboxRepo.ownerInbox(fixture.ownerId);
      expect(items.filter((item) => inboxRepo.bucketOf(item) === 'NEEDS_REVIEW')).toHaveLength(0);
      expect(await badgeCount()).toBe(0);
    }
  });
});

describe('what it still leaves out', () => {
  it('does not show a scheduled trigger that is not waiting on anybody', async () => {
    /*
      Only the ones held for a person.

      An agent posts on a schedule and most of those finish on their own. An
      inbox that listed every one of them would be the activity log again, which
      is the thing this exists instead of.
    */
    const fixture = await createFixture();
    const jobId = await heldJob({ ...fixture, eventType: 'SCHEDULED_TRIGGER', actionType: 'POST' });
    await jobsRepo.updateJob(jobId, { status: 'EXECUTED' });

    expect(await inboxRepo.ownerInbox(fixture.ownerId)).toHaveLength(0);
  });

  it('still shows an ordinary mention whatever its job is doing', async () => {
    const fixture = await createFixture();
    const jobId = await heldJob({ ...fixture, eventType: 'MENTION', actionType: 'REPLY' });
    await jobsRepo.updateJob(jobId, { status: 'EXECUTED' });

    // Somebody said something. That belongs in the inbox whether or not it is
    // still waiting on anybody.
    expect(await inboxRepo.ownerInbox(fixture.ownerId)).toHaveLength(1);
  });
});
