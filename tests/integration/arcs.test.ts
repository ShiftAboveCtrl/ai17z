import { describe, expect, it } from 'vitest';
import { arcs } from '@xbam/database';
import { observeEntities, recordNarratives } from '@xbam/runtime';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';

installHarness();

describe('thread state', () => {
  it('counts turns and remembers who is in the conversation', async () => {
    const fixture = await createFixture();
    await arcs.touchThread({ agentId: fixture.agentId, remoteConversationId: 't1', participant: 'alice' });
    await arcs.touchThread({ agentId: fixture.agentId, remoteConversationId: 't1', participant: 'bob' });
    await arcs.touchThread({ agentId: fixture.agentId, remoteConversationId: 't1', participant: 'alice' });

    const state = await arcs.getThreadState(fixture.agentId, 't1');
    expect(state!.turnCount).toBe(3);
    // Alice appearing twice is one participant, not two.
    expect(state!.participants.sort()).toEqual(['alice', 'bob']);
  });

  it('keeps what was settled separate from what is still open', async () => {
    const fixture = await createFixture();
    const state = await arcs.touchThread({ agentId: fixture.agentId, remoteConversationId: 't2' });
    await arcs.saveThreadSummary({
      id: state.id,
      summary: 'Alice challenged the launch thesis and the agent conceded distribution risk.',
      mainTopic: 'the launch',
      openQuestion: 'whether early traction offsets supply pressure',
      resolvedPoints: ['distribution risk is real'],
      atTurn: 3,
    });

    const after = await arcs.getThreadState(fixture.agentId, 't2');
    expect(after!.resolvedPoints).toEqual(['distribution risk is real']);
    expect(after!.openQuestion).toMatch(/early traction/);
    expect(after!.summarisedAtTurn).toBe(3);
  });

  it('keeps threads on different conversations apart', async () => {
    const fixture = await createFixture();
    await arcs.touchThread({ agentId: fixture.agentId, remoteConversationId: 'a' });
    await arcs.touchThread({ agentId: fixture.agentId, remoteConversationId: 'b' });
    expect((await arcs.getThreadState(fixture.agentId, 'a'))!.turnCount).toBe(1);
  });
});

describe('narratives', () => {
  it('counts the arguments the agent keeps making', async () => {
    const fixture = await createFixture();
    await recordNarratives(fixture.agentId, 'Project Q got the distribution wrong.');
    await recordNarratives(fixture.agentId, 'Project Q still has the same problem.');

    const narratives = await arcs.listNarratives(fixture.agentId);
    const projectQ = narratives.find((n) => n.label === 'project q');
    expect(projectQ?.useCount).toBe(2);
  });

  it('reports one used too recently, so it is not made again immediately', async () => {
    const fixture = await createFixture();
    await recordNarratives(fixture.agentId, 'Project Q got the distribution wrong.');
    await recordNarratives(fixture.agentId, 'Project Q again.');

    const overused = await arcs.overusedNarratives(fixture.agentId, 48, 2);
    expect(overused.map((n) => n.label)).toContain('project q');
  });

  it('leaves something used once alone', async () => {
    const fixture = await createFixture();
    await recordNarratives(fixture.agentId, 'Acme Labs shipped something.');
    expect(await arcs.overusedNarratives(fixture.agentId, 48, 2)).toHaveLength(0);
  });
});

describe('the entity graph', () => {
  it('records what a post mentioned and that they came up together', async () => {
    const fixture = await createFixture();
    await observeEntities(fixture.agentId, 'Project Q and Acme Labs are both working on this.');

    const entities = await arcs.listEntities(fixture.agentId);
    const names = entities.map((e) => e.name);
    expect(names).toContain('Project Q');
    expect(names).toContain('Acme Labs');

    const projectQ = entities.find((e) => e.name === 'Project Q')!;
    const related = await arcs.relatedEntities(projectQ.id);
    expect(related.map((r) => r.name)).toContain('Acme Labs');
    // The only claim being made is co-occurrence.
    expect(related[0]!.relation).toBe('mentioned_with');
  });

  it('counts repeated observations rather than duplicating them', async () => {
    const fixture = await createFixture();
    await observeEntities(fixture.agentId, 'Project Q and Acme Labs.');
    await observeEntities(fixture.agentId, 'Project Q and Acme Labs again.');

    const entities = await arcs.listEntities(fixture.agentId);
    expect(entities.filter((e) => e.name === 'Project Q')).toHaveLength(1);
    const projectQ = entities.find((e) => e.name === 'Project Q')!;
    expect(projectQ.mentionCount).toBe(2);
    expect((await arcs.relatedEntities(projectQ.id))[0]!.observations).toBe(2);
  });

  it('never links a thing to itself', async () => {
    const fixture = await createFixture();
    await observeEntities(fixture.agentId, 'Project Q. Project Q. Project Q.');
    const entities = await arcs.listEntities(fixture.agentId);
    const projectQ = entities.find((e) => e.name === 'Project Q');
    if (projectQ) expect(await arcs.relatedEntities(projectQ.id)).toHaveLength(0);
  });
});
