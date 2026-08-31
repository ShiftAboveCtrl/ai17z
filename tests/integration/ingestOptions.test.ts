import { describe, expect, it } from 'vitest';
import { ingestNormalizedEvent } from '@xbam/runtime';
import { jobs } from '@xbam/database';
import { installHarness } from '../support/harness';
import { createFixture, seedCatalogue } from '../support/fixtures';

installHarness();

/**
 * A mis-shaped call must fail, not fall through to acting for real.
 *
 * This exists because of an actual incident: a test harness passed
 * `{ options: { dryRun: true } }` instead of `{ dryRun: true }`. The unknown key
 * was ignored, `dryRun` fell through to the policy default, the agent was
 * autonomous, and a synthetic test mention published a real reply on a real
 * account before it could be stopped.
 *
 * The lesson is not "be careful with keys". It is that the dangerous option
 * must never be the one you get by getting the call wrong.
 */

const event = {
  channel: 'mock' as const,
  type: 'MENTION' as const,
  remoteEventId: 'shape-check-1',
  remoteMessageId: 'shape-check-1',
  remoteAuthorId: null,
  remoteAuthorHandle: 'someone',
  remoteAuthorDisplayName: null,
  remoteConversationId: null,
  parentRemoteMessageId: null,
  remoteUrl: null,
  text: 'hello there, this is a perfectly ordinary mention',
  occurredAt: new Date().toISOString(),
  raw: {},
};

describe('ingest refuses options it does not understand', () => {
  it('throws on a key it does not know, and queues nothing', async () => {
    await seedCatalogue();
    const fixture = await createFixture();

    await expect(
      ingestNormalizedEvent({
        accountId: null,
        event,
        onlyAgentId: fixture.agentId,
        // The exact mistake: nested instead of flat.
        options: { dryRun: true },
      } as never),
    ).rejects.toThrow(/options it does not accept/i);

    // And nothing was written on the way to failing.
    const listed = await jobs.listJobs({ agentId: fixture.agentId, limit: 5 });
    expect(listed.items).toHaveLength(0);
  });

  it('names the offending key so the mistake is obvious', async () => {
    await seedCatalogue();
    const fixture = await createFixture();
    await expect(
      ingestNormalizedEvent({ accountId: null, event, onlyAgentId: fixture.agentId, dryrun: true } as never),
    ).rejects.toThrow(/dryrun|unrecognized/i);
  });

  it('still accepts the call spelled correctly', async () => {
    await seedCatalogue();
    const fixture = await createFixture();
    const outcome = await ingestNormalizedEvent({
      accountId: null,
      event: { ...event, remoteEventId: 'shape-check-ok' },
      onlyAgentId: fixture.agentId,
      dryRun: true,
    });
    expect(outcome.jobs).toHaveLength(1);
    expect(outcome.jobs[0]!.job.dryRun).toBe(true);
  });

  it('leaves dryRun to the policy when it is genuinely omitted', async () => {
    await seedCatalogue();
    // The fixture policy is autonomous with dryRunDefault false.
    const fixture = await createFixture();
    const outcome = await ingestNormalizedEvent({
      accountId: null,
      event: { ...event, remoteEventId: 'shape-check-default' },
      onlyAgentId: fixture.agentId,
    });
    expect(outcome.jobs[0]!.job.dryRun).toBe(false);
  });
});
