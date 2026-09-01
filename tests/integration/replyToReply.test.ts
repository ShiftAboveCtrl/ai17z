import { describe, expect, it } from 'vitest';
import {
  accounts as accountsRepo,
  conversations as conversationsRepo,
  jobs as jobsRepo,
  withTransaction,
} from '@xbam/database';
import { ingestNormalizedEvent } from '@xbam/runtime';
import { installHarness, mockEvent } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { uniqueSuffix } from '../support/db';

installHarness();

/**
 * An agent that answers a stranger and then ignores their answer.
 *
 * Two of the four radar monitors exist to find replies -- `reply_search` runs
 * `to:@handle -from:@handle`, and `own_threads` reads the threads under the
 * agent's own posts -- and both worked. They found the replies, recorded which
 * monitor saw each one, and handed them to ingest, which dropped every single
 * one with "not triggered by REPLY" because the account link was created with
 * `trigger_event_types = ["MENTION"]` in five separate places.
 *
 * On the installation this was found in, nineteen of twenty-three replies were
 * discarded at that line. Not declined -- the engagement heuristic never saw
 * them, and could not have, because a job was never made.
 */

async function linkedAccount(ownerId: string, agentId: string, triggerEventTypes?: string[]) {
  const account = await accountsRepo.createAccount({
    ownerId,
    channel: 'mock',
    handle: `rr_${uniqueSuffix()}`,
  });
  await accountsRepo.updateAccount(account.id, { status: 'CONNECTED', enabled: true });
  await accountsRepo.linkAgentAccount({ agentId, accountId: account.id, triggerEventTypes });
  return account;
}

describe('a reply to the agent', () => {
  it('is something a new link is triggered by', async () => {
    const fixture = await createFixture();
    const account = await linkedAccount(fixture.ownerId, fixture.agentId);

    const [link] = await accountsRepo.listAccountAgents(account.id);
    expect(link!.triggerEventTypes).toContain('MENTION');
    expect(link!.triggerEventTypes).toContain('REPLY');
  });

  it('creates work, rather than being dropped at the door', async () => {
    const fixture = await createFixture();
    const account = await linkedAccount(fixture.ownerId, fixture.agentId);

    const outcome = await ingestNormalizedEvent({
      accountId: account.id,
      event: mockEvent('so does the fee go up for everyone or only new pairs?', { type: 'REPLY' }),
    });

    expect(outcome.skipped).toEqual([]);
    expect(outcome.jobs).toHaveLength(1);
    expect(outcome.jobs[0]!.created).toBe(true);
  });

  it('is still refused when somebody has deliberately narrowed the link', async () => {
    // Widening the default must not override a decision. An owner who set this
    // link to mentions only meant it.
    const fixture = await createFixture();
    const account = await linkedAccount(fixture.ownerId, fixture.agentId, ['MENTION']);

    const outcome = await ingestNormalizedEvent({
      accountId: account.id,
      event: mockEvent('and one more thing', { type: 'REPLY' }),
    });

    expect(outcome.jobs).toHaveLength(0);
    expect(outcome.skipped[0]!.reason).toContain('REPLY');
  });
});

/**
 * One conversation per thread, not per post.
 *
 * Ingest keys a conversation on the post, because a mention read off a search
 * result carries its own status id and no ancestry. The thread root is only
 * known once the status page has been opened, which happens later -- so without
 * a merge, every message opens a conversation of its own. On the installation
 * this was found in: 345 conversations holding exactly two messages, one from
 * them and one from us, and two holding an actual exchange.
 */
describe('filing a message under its thread', () => {
  it('moves the messages and leaves one conversation', async () => {
    const fixture = await createFixture();
    const account = await linkedAccount(fixture.ownerId, fixture.agentId);
    const root = `thread-${uniqueSuffix()}`;

    // The opening mention, which happens to be the root of its own thread.
    const first = await ingestNormalizedEvent({
      accountId: account.id,
      event: mockEvent('what do you make of the new fee model?', { remoteConversationId: root }),
    });

    // Their reply, discovered by a search that could not see the ancestry.
    const second = await ingestNormalizedEvent({
      accountId: account.id,
      event: mockEvent('right, but what about illiquid pairs?', { type: 'REPLY' }),
    });

    const stray = second.jobs[0]!.job.conversationId!;
    const home = first.jobs[0]!.job.conversationId!;
    expect(stray).not.toBe(home);

    await withTransaction((tx) => conversationsRepo.mergeConversation(tx, stray, home));

    expect(await conversationsRepo.getConversation(stray)).toBeNull();
    const messages = await conversationsRepo.recentMessages(home, 20);
    expect(messages.map((m) => m.text)).toEqual([
      'what do you make of the new fee model?',
      'right, but what about illiquid pairs?',
    ]);
  });

  it('carries the jobs across, so the thread knows what was done in it', async () => {
    const fixture = await createFixture();
    const account = await linkedAccount(fixture.ownerId, fixture.agentId);

    const first = await ingestNormalizedEvent({
      accountId: account.id,
      event: mockEvent('an opening question about governance'),
    });
    const second = await ingestNormalizedEvent({
      accountId: account.id,
      event: mockEvent('a follow-up to it', { type: 'REPLY' }),
    });

    const home = first.jobs[0]!.job.conversationId!;
    const stray = second.jobs[0]!.job.conversationId!;
    await withTransaction((tx) => conversationsRepo.mergeConversation(tx, stray, home));

    const moved = await jobsRepo.getJob(second.jobs[0]!.job.id);
    expect(moved!.conversationId).toBe(home);
  });

  it('does not duplicate a message the thread already has', async () => {
    // Several monitors see one post, and the reconciler merges them on the
    // status id. The same has to hold here, or a thread grows a second copy of
    // every message that arrived twice.
    const fixture = await createFixture();
    const account = await linkedAccount(fixture.ownerId, fixture.agentId);
    const root = `thread-${uniqueSuffix()}`;

    const first = await ingestNormalizedEvent({
      accountId: account.id,
      event: mockEvent('the only message here', { remoteConversationId: root, remoteMessageId: 'msg-shared' }),
    });
    const home = first.jobs[0]!.job.conversationId!;

    const stray = await withTransaction(async (tx) => {
      const conversation = await conversationsRepo.upsertConversation(tx, {
        agentId: fixture.agentId,
        accountId: account.id,
        channel: 'mock',
        remoteConversationId: `stray-${uniqueSuffix()}`,
      });
      await conversationsRepo.recordMessage(tx, {
        conversationId: conversation.id,
        direction: 'INBOUND',
        remoteMessageId: 'msg-shared',
        body: 'the only message here',
      });
      return conversation.id;
    });

    await withTransaction((tx) => conversationsRepo.mergeConversation(tx, stray, home));

    const messages = await conversationsRepo.recentMessages(home, 20);
    expect(messages).toHaveLength(1);
  });
});
