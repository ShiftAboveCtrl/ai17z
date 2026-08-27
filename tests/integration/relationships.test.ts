import { describe, expect, it } from 'vitest';
import { RelationshipVoice, deriveFamiliarity } from '@xbam/shared/contracts';
import { relationships, query } from '@xbam/database';
import { historyLine, loadRelationshipContext, recordExchange } from '@xbam/runtime';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';

installHarness();

const voice = RelationshipVoice.parse({});

async function exchanges(agentId: string, handle: string, times: number) {
  for (let i = 0; i < times; i += 1) {
    await recordExchange({ agentId, channel: 'x', handle });
  }
}

/** Backdates a relationship so time-based rules can be exercised. */
async function ageRelationship(id: string, days: number) {
  await query(
    `UPDATE relationships SET first_interaction_at = now() - ($2::int * interval '1 day') WHERE id = $1`,
    [id, days],
  );
}

describe('familiarity is earned by conversation, not by volume', () => {
  it('counts exchanges, so somebody who is never answered stays new', () => {
    expect(
      deriveFamiliarity({
        inboundCount: 30,
        outboundCount: 0,
        firstInteractionAt: new Date(Date.now() - 30 * 86_400_000),
        lastInteractionAt: new Date(),
      }),
    ).toBe('NEW');
  });

  it('needs time as well as count to become a regular', () => {
    const many = { inboundCount: 20, outboundCount: 20 };
    // Twenty exchanges in an afternoon is a thread, not a relationship.
    expect(
      deriveFamiliarity({ ...many, firstInteractionAt: new Date(), lastInteractionAt: new Date() }),
    ).toBe('KNOWN');
    expect(
      deriveFamiliarity({
        ...many,
        firstInteractionAt: new Date(Date.now() - 20 * 86_400_000),
        lastInteractionAt: new Date(),
      }),
    ).toBe('REGULAR');
  });

  it('rises as a real conversation accumulates', async () => {
    const fixture = await createFixture();
    await exchanges(fixture.agentId, 'alice', 1);
    let row = await relationships.find({ agentId: fixture.agentId, channel: 'x', handle: 'alice' });
    expect(row!.familiarity).toBe('NEW');

    await exchanges(fixture.agentId, 'alice', 4);
    await ageRelationship(row!.id, 5);
    await exchanges(fixture.agentId, 'alice', 1);

    row = await relationships.find({ agentId: fixture.agentId, channel: 'x', handle: 'alice' });
    expect(row!.familiarity).toBe('FAMILIAR');
  });

  it('never overwrites a level the owner pinned', async () => {
    const fixture = await createFixture();
    await exchanges(fixture.agentId, 'bob', 1);
    const row = (await relationships.find({ agentId: fixture.agentId, channel: 'x', handle: 'bob' }))!;

    await relationships.update(row.id, { familiarity: 'REGULAR' });
    await exchanges(fixture.agentId, 'bob', 6);

    const after = (await relationships.find({ agentId: fixture.agentId, channel: 'x', handle: 'bob' }))!;
    expect(after.familiarity).toBe('REGULAR');
    expect(after.familiarityPinned).toBe(true);
  });
});

describe('identity survives a rename', () => {
  it('matches on the platform id rather than the handle when it has one', async () => {
    const fixture = await createFixture();
    await relationships.recordInteraction({
      agentId: fixture.agentId,
      channel: 'x',
      handle: 'oldname',
      remoteUserId: 'uid-777',
      direction: 'INBOUND',
    });

    const found = await relationships.find({
      agentId: fixture.agentId,
      channel: 'x',
      handle: 'a-completely-different-handle',
      remoteUserId: 'uid-777',
    });
    expect(found?.handle).toBe('oldname');
  });

  it('fills in the platform id once it becomes known', async () => {
    const fixture = await createFixture();
    await relationships.recordInteraction({ agentId: fixture.agentId, channel: 'x', handle: 'carol', direction: 'INBOUND' });
    await relationships.recordInteraction({
      agentId: fixture.agentId,
      channel: 'x',
      handle: 'carol',
      remoteUserId: 'uid-888',
      direction: 'INBOUND',
    });
    const row = await relationships.find({ agentId: fixture.agentId, channel: 'x', handle: 'carol' });
    expect(row?.remoteUserId).toBe('uid-888');
  });
});

describe('what the prompt is told', () => {
  it('says plainly that a stranger is a stranger', async () => {
    const fixture = await createFixture();
    const loaded = await loadRelationshipContext({
      agentId: fixture.agentId,
      channel: 'x',
      handle: 'nobody',
      voice,
    });
    expect(loaded.context.known).toBe(false);
    expect(loaded.context.historyLine).toMatch(/not spoken before/i);
  });

  it('distinguishes somebody who was never answered from a conversation', async () => {
    const fixture = await createFixture();
    for (let i = 0; i < 4; i += 1) {
      await relationships.recordInteraction({ agentId: fixture.agentId, channel: 'x', handle: 'shouty', direction: 'INBOUND' });
    }
    const row = (await relationships.find({ agentId: fixture.agentId, channel: 'x', handle: 'shouty' }))!;
    expect(historyLine(row)).toMatch(/mentioned you 4 times and you have not replied/i);
  });

  it('carries the owner note, which outranks anything derived', async () => {
    const fixture = await createFixture();
    await exchanges(fixture.agentId, 'dave', 2);
    const row = (await relationships.find({ agentId: fixture.agentId, channel: 'x', handle: 'dave' }))!;
    await relationships.update(row.id, { ownerNote: 'Answers best with specifics.' });

    const loaded = await loadRelationshipContext({ agentId: fixture.agentId, channel: 'x', handle: 'dave', voice });
    expect(loaded.context.ownerNote).toBe('Answers best with specifics.');
  });
});

describe('callbacks', () => {
  async function familiarPerson(agentId: string, handle: string) {
    await exchanges(agentId, handle, 1);
    const row = (await relationships.find({ agentId, channel: 'x', handle }))!;
    await ageRelationship(row.id, 10);
    await exchanges(agentId, handle, 5);
    return (await relationships.find({ agentId, channel: 'x', handle }))!;
  }

  it('is not offered to somebody the agent barely knows', async () => {
    const fixture = await createFixture();
    await exchanges(fixture.agentId, 'newish', 1);
    const row = (await relationships.find({ agentId: fixture.agentId, channel: 'x', handle: 'newish' }))!;
    await relationships.addCallback({ relationshipId: row.id, label: 'the toaster argument', detail: 'they disagreed about toasters' });

    const loaded = await loadRelationshipContext({ agentId: fixture.agentId, channel: 'x', handle: 'newish', voice });
    expect(loaded.context.callback).toBeNull();
  });

  it('is offered once the agent knows them', async () => {
    const fixture = await createFixture();
    const row = await familiarPerson(fixture.agentId, 'erin');
    await relationships.addCallback({ relationshipId: row.id, label: 'the toaster argument', detail: 'they disagreed about toasters' });

    const loaded = await loadRelationshipContext({ agentId: fixture.agentId, channel: 'x', handle: 'erin', voice });
    expect(loaded.context.callback?.label).toBe('the toaster argument');
  });

  it('rests after use, so it does not become a catchphrase', async () => {
    const fixture = await createFixture();
    const row = await familiarPerson(fixture.agentId, 'frank');
    const callback = await relationships.addCallback({ relationshipId: row.id, label: 'the toaster argument', detail: 'x' });

    await relationships.markCallbackUsed(callback!.id);
    expect(await relationships.dueCallback(row.id)).toBeNull();
  });

  it('retires after enough uses, however long ago they were', async () => {
    const fixture = await createFixture();
    const row = await familiarPerson(fixture.agentId, 'grace');
    const callback = await relationships.addCallback({ relationshipId: row.id, label: 'worn out', detail: 'x' });

    await query('UPDATE relationship_callbacks SET use_count = 9, last_used_at = now() - interval \'30 days\' WHERE id = $1', [
      callback!.id,
    ]);
    expect(await relationships.dueCallback(row.id)).toBeNull();
  });

  it('will not store the same reference twice', async () => {
    const fixture = await createFixture();
    const row = await familiarPerson(fixture.agentId, 'heidi');
    await relationships.addCallback({ relationshipId: row.id, label: 'same thing', detail: 'a' });
    const second = await relationships.addCallback({ relationshipId: row.id, label: 'same thing', detail: 'b' });
    expect(second).toBeNull();
    expect(await relationships.listCallbacks(row.id)).toHaveLength(1);
  });
});

describe('the owner is in charge', () => {
  it('blocks somebody outright when told to', async () => {
    const fixture = await createFixture();
    await exchanges(fixture.agentId, 'nuisance', 2);
    const row = (await relationships.find({ agentId: fixture.agentId, channel: 'x', handle: 'nuisance' }))!;
    await relationships.update(row.id, { disposition: 'BLOCKED' });

    const loaded = await loadRelationshipContext({ agentId: fixture.agentId, channel: 'x', handle: 'nuisance', voice });
    expect(loaded.context.disposition).toBe('BLOCKED');
  });

  it('keeps topics bounded rather than accumulating forever', async () => {
    const fixture = await createFixture();
    await exchanges(fixture.agentId, 'chatty', 2);
    const row = (await relationships.find({ agentId: fixture.agentId, channel: 'x', handle: 'chatty' }))!;

    await relationships.addTopics(row.id, Array.from({ length: 30 }, (_, i) => `topic-${i}`));
    const after = (await relationships.get(row.id))!;
    expect(after.topics.length).toBeLessThanOrEqual(12);
  });
});
