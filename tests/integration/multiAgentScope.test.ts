import { describe, expect, it } from 'vitest';
import { accounts as accountsRepo, inbox as inboxRepo, mentions, query } from '@xbam/database';
import { ingestNormalizedEvent } from '@xbam/runtime';
import { installHarness, mockEvent } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { uniqueSuffix } from '../support/db';

installHarness();

/**
 * Two agents, one installation, and rows that have to stay apart.
 *
 * Reported as Activity and the Inbox being confusing and glitchy once a second
 * agent existed. Part of that only looks wrong: `events` is unique on
 * (channel, account, remote event id), so one X post seen by two connected
 * accounts is legitimately two rows, and without the agent on the row there is
 * no way to tell that from a duplicate.
 *
 * The rest was real. Scoping to an agent kept `OR j.id IS NULL`, so every
 * unactioned event in the installation stayed on screen whichever agent was
 * selected, labelled "Not picked up" as though this agent had ignored it.
 */

async function agentWithAccount(name: string) {
  const fixture = await createFixture();
  const account = await accountsRepo.createAccount({
    ownerId: fixture.ownerId,
    channel: 'mock',
    handle: `${name}_${uniqueSuffix()}`,
  });
  await accountsRepo.updateAccount(account.id, { status: 'CONNECTED', enabled: true });
  await accountsRepo.linkAgentAccount({
    agentId: fixture.agentId,
    accountId: account.id,
    triggerEventTypes: ['MENTION', 'REPLY'],
    actionType: 'REPLY',
  });
  return { ...fixture, accountId: account.id };
}

describe('the inbox is scoped to one agent when asked', () => {
  it('returns only that agent’s rows, and says which agent each is', async () => {
    const one = await agentWithAccount('first');
    const two = await agentWithAccount('second');

    await ingestNormalizedEvent({
      accountId: one.accountId,
      event: mockEvent('a question for the first agent', { remoteAuthorHandle: 'asks_one' }),
    });
    for (let i = 0; i < 3; i += 1) {
      await ingestNormalizedEvent({
        accountId: two.accountId,
        event: mockEvent(`a question for the second agent ${i}`, { remoteAuthorHandle: `asks_two_${i}` }),
      });
    }

    const first = await mentions.listMentions({ agentId: one.agentId, limit: 50 });
    const second = await mentions.listMentions({ agentId: two.agentId, limit: 50 });

    expect(first.map((r) => r.authorHandle)).toEqual(['asks_one']);
    expect(second).toHaveLength(3);
    expect(second.every((r) => r.authorHandle?.startsWith('asks_two'))).toBe(true);

    // And each row can say whose it is, which is what makes a combined list
    // readable rather than a pile.
    expect(first[0]!.agentId).toBe(one.agentId);
    expect(first[0]!.agentName).toBeTruthy();
    expect(second[0]!.agentId).toBe(two.agentId);
  }, 120_000);

  it('does not show one agent the other agent’s unactioned events', async () => {
    /*
      The defect as reported. A radar finding that produced no job has no
      agent on it, and the scope clause used to let exactly those through
      unfiltered. Monitor-only is the cheapest way to make one.
    */
    const quiet = await agentWithAccount('monitor_only');
    const other = await agentWithAccount('watcher');

    await ingestNormalizedEvent({
      accountId: quiet.accountId,
      event: mockEvent('nobody queued anything for this', {
        type: 'KEYWORD_MATCH',
        remoteAuthorHandle: 'a_stranger',
      }),
    });

    const unactioned = await mentions.listMentions({ agentId: quiet.agentId, limit: 50 });
    expect(unactioned.map((r) => r.authorHandle)).toContain('a_stranger');
    expect(unactioned.every((r) => r.jobId === null || r.agentId === quiet.agentId)).toBe(true);

    const elsewhere = await mentions.listMentions({ agentId: other.agentId, limit: 50 });
    expect(elsewhere.map((r) => r.authorHandle), 'another agent’s account is not this agent’s inbox').not.toContain(
      'a_stranger',
    );

    const counts = await mentions.countMentionStates({ agentId: other.agentId });
    expect(counts.NOT_ACTIONED, 'the chip has to agree with the empty list under it').toBe(0);
  }, 120_000);

  it('counts what it lists, per agent', async () => {
    /*
      The failure this prevents is one already paid for once: a count and a
      list that agree because both are wrong in the same direction. Here they
      have to disagree between agents and agree within one.
    */
    const one = await agentWithAccount('counts_one');
    const two = await agentWithAccount('counts_two');

    const replied = async (fixture: { accountId: string }, n: number) => {
      const outcome = await ingestNormalizedEvent({
        accountId: fixture.accountId,
        event: mockEvent(`message ${n}`, { remoteAuthorHandle: `person_${n}` }),
      });
      await query(`UPDATE jobs SET status='EXECUTED' WHERE id=$1`, [outcome.jobs[0]!.job.id]);
    };

    await replied(one, 1);
    for (let i = 2; i <= 4; i += 1) await replied(two, i);

    const firstCounts = await mentions.countMentionStates({ agentId: one.agentId });
    const secondCounts = await mentions.countMentionStates({ agentId: two.agentId });

    expect(firstCounts.REPLIED).toBe(1);
    expect(secondCounts.REPLIED).toBe(3);

    // And the count agrees with the list it sits above, for each separately.
    expect(await mentions.listMentions({ agentId: one.agentId, state: 'REPLIED', limit: 50 })).toHaveLength(
      firstCounts.REPLIED,
    );
    expect(await mentions.listMentions({ agentId: two.agentId, state: 'REPLIED', limit: 50 })).toHaveLength(
      secondCounts.REPLIED,
    );
  }, 120_000);

  it('composes the agent scope with the direct-only filter', async () => {
    const one = await agentWithAccount('compose');
    await ingestNormalizedEvent({
      accountId: one.accountId,
      event: mockEvent('somebody wrote in', { remoteAuthorHandle: 'a_person' }),
    });
    await ingestNormalizedEvent({
      accountId: one.accountId,
      event: mockEvent('a post the radar found about nothing much', {
        type: 'KEYWORD_MATCH',
        remoteAuthorHandle: 'a_stranger',
      }),
    });

    const direct = await mentions.listMentions({ agentId: one.agentId, directOnly: true, limit: 50 });
    expect(direct.map((r) => r.authorHandle)).toEqual(['a_person']);

    const everything = await mentions.listMentions({ agentId: one.agentId, directOnly: false, limit: 50 });
    expect(everything.length).toBeGreaterThan(direct.length);
  }, 120_000);

  it('keeps one post seen by two accounts as two honest rows', async () => {
    /*
      Not a duplicate. The same X post reaching two connected accounts is two
      events by design, and each agent decides about it separately. What was
      missing is the label saying so.
    */
    const one = await agentWithAccount('shared_one');
    const two = await agentWithAccount('shared_two');
    const sharedId = `shared-${uniqueSuffix()}`;

    for (const fixture of [one, two]) {
      await ingestNormalizedEvent({
        accountId: fixture.accountId,
        event: mockEvent('one post, two audiences', {
          remoteEventId: sharedId,
          remoteMessageId: sharedId,
          remoteAuthorHandle: 'writes_to_both',
        }),
      });
    }

    const [row] = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM events WHERE remote_event_id = $1`,
      [sharedId],
    );
    expect(Number(row!.n), 'one per account, by the unique index').toBe(2);

    const first = await mentions.listMentions({ agentId: one.agentId, limit: 50 });
    const second = await mentions.listMentions({ agentId: two.agentId, limit: 50 });
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]!.agentId).toBe(one.agentId);
    expect(second[0]!.agentId).toBe(two.agentId);
    expect(first[0]!.eventId, 'two rows, and they are different rows').not.toBe(second[0]!.eventId);
  }, 120_000);

  it('keeps both agent subjects when one shared-account agent has a job and the other does not', async () => {
    const one = await agentWithAccount('shared_account_owner');
    const two = await agentWithAccount('shared_account_peer');
    await query('UPDATE agents SET owner_id=$1 WHERE id=$2', [one.ownerId, two.agentId]);
    await accountsRepo.linkAgentAccount({
      agentId: two.agentId,
      accountId: one.accountId,
      triggerEventTypes: ['MENTION', 'REPLY'],
      actionType: 'REPLY',
    });

    const outcome = await ingestNormalizedEvent({
      accountId: one.accountId,
      onlyAgentId: one.agentId,
      event: mockEvent('one account, two agent subjects', { remoteAuthorHandle: 'shared_account_person' }),
    });

    const all = (await mentions.listMentions({ limit: 50 })).filter((row) => row.eventId === outcome.eventId);
    expect(all).toHaveLength(2);
    expect(new Set(all.map((row) => row.agentId))).toEqual(new Set([one.agentId, two.agentId]));
    expect(all.find((row) => row.agentId === one.agentId)!.jobId).not.toBeNull();
    expect(all.find((row) => row.agentId === two.agentId)!.jobId).toBeNull();

    const peer = (await inboxRepo.ownerInbox(one.ownerId, 50, two.agentId)).find(
      (row) => row.eventId === outcome.eventId,
    );
    expect(peer?.agentId).toBe(two.agentId);
    expect(peer?.jobId).toBeNull();
  }, 120_000);

  it('filters before the limit, so a busy agent cannot page out a quiet one', async () => {
    // The Replied bug in a new place: a limit applied ahead of the scope means
    // whoever is noisiest decides what everybody else can see.
    const quiet = await agentWithAccount('quiet');
    const busy = await agentWithAccount('busy');

    await ingestNormalizedEvent({
      accountId: quiet.accountId,
      event: mockEvent('the only thing this agent has', { remoteAuthorHandle: 'rare_person' }),
    });
    for (let i = 0; i < 20; i += 1) {
      await ingestNormalizedEvent({
        accountId: busy.accountId,
        event: mockEvent(`busy message ${i}`, { remoteAuthorHandle: `busy_${i}` }),
      });
    }

    const found = await mentions.listMentions({ agentId: quiet.agentId, limit: 5 });
    expect(found.map((r) => r.authorHandle)).toContain('rare_person');
  }, 180_000);

  it('applies the Agent scope before the owner Inbox limit too', async () => {
    const quiet = await agentWithAccount('owner_inbox_quiet');
    const busy = await agentWithAccount('owner_inbox_busy');
    // Put both fixtures under the same owner; the fixture helper normally
    // creates an isolated owner for every agent.
    await query('UPDATE agents SET owner_id=$1 WHERE id=$2', [quiet.ownerId, busy.agentId]);
    await query('UPDATE accounts SET owner_id=$1 WHERE id=$2', [quiet.ownerId, busy.accountId]);

    await ingestNormalizedEvent({
      accountId: quiet.accountId,
      event: mockEvent('the quiet inbox row', { remoteAuthorHandle: 'quiet_inbox_person' }),
    });
    for (let i = 0; i < 10; i += 1) {
      await ingestNormalizedEvent({
        accountId: busy.accountId,
        event: mockEvent(`busy inbox ${i}`, { remoteAuthorHandle: `busy_inbox_${i}` }),
      });
    }

    const scoped = await inboxRepo.ownerInbox(quiet.ownerId, 3, quiet.agentId);
    expect(scoped).toHaveLength(1);
    expect(scoped[0]!.agentId).toBe(quiet.agentId);
    expect(scoped[0]!.authorHandle).toBe('quiet_inbox_person');
  }, 180_000);
});
