import { describe, expect, it } from 'vitest';
import {
  accounts as accountsRepo,
  relationships as relationshipsRepo,
  xAccountObservations,
} from '@xbam/database';
import { bridgesFor } from '@xbam/runtime';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { uniqueSuffix } from '../support/db';

installHarness();

/**
 * What a read of somebody's account is worth once it reaches a score.
 *
 * `scoreBridge` has been able to weigh reach and reciprocity since it was
 * written, and neither input was ever supplied. The comment on `bridgesFor`
 * said why: filling them would have meant reading a profile per card, and the
 * browser is one signed-in session the agent needs for its own work.
 *
 * So the evidence now comes from reads an owner already asked for. These tests
 * are about that hand-off -- that an observation changes a score, that an
 * account nobody looked at still reports its gaps honestly, and that "X did not
 * say" never turns into "no".
 */

async function agentWithAccount() {
  const fixture = await createFixture();
  const account = await accountsRepo.createAccount({
    ownerId: fixture.ownerId,
    channel: 'x',
    handle: `self${uniqueSuffix()}`.slice(0, 15),
    displayName: 'The agent',
  });
  await accountsRepo.linkAgentAccount({ agentId: fixture.agentId, accountId: account.id });
  return { ...fixture, accountId: account.id };
}

async function somebodyKnown(agentId: string, handle: string) {
  await relationshipsRepo.recordInteraction({ agentId, channel: 'x', handle, direction: 'INBOUND' });
}

describe('a read account, reaching a bridge score', () => {
  it('reports reach as a gap when nobody has looked at them', async () => {
    const { agentId, accountId, ownerId } = await agentWithAccount();
    await somebodyKnown(agentId, 'unread_person');

    const [score] = await bridgesFor(agentId, accountId, { ownerUserId: ownerId, ourFollowerCount: 500 });
    expect(score!.gaps.join(' ')).toContain('How many people follow them was not visible');
    expect(score!.factors.map((f) => f.name)).not.toContain('reach');
  });

  it('measures reach once somebody has been read', async () => {
    const { agentId, accountId, ownerId } = await agentWithAccount();
    await somebodyKnown(agentId, 'read_person');
    await xAccountObservations.record({
      ownerUserId: ownerId,
      userId: '900',
      handle: 'read_person',
      followers: 50_000,
      outcome: 'OK',
    });

    const [score] = await bridgesFor(agentId, accountId, { ownerUserId: ownerId, ourFollowerCount: 500 });
    const reach = score!.factors.find((f) => f.name === 'reach');
    expect(reach, 'the observation should have supplied a follower count').toBeDefined();
    expect(reach!.detail).toContain('50,000');
    expect(score!.gaps.join(' ')).not.toContain('How many people follow them was not visible');
  });

  it('measures reciprocity from what X said about the follow', async () => {
    const { agentId, accountId, ownerId } = await agentWithAccount();
    await somebodyKnown(agentId, 'mutual_person');
    await xAccountObservations.record({
      ownerUserId: ownerId,
      userId: '901',
      handle: 'mutual_person',
      weFollow: true,
      followsUs: true,
      outcome: 'OK',
    });

    const [score] = await bridgesFor(agentId, accountId, { ownerUserId: ownerId, ourFollowerCount: 500 });
    expect(score!.factors.map((f) => f.name)).toContain('mutual');
  });

  it('keeps "X did not say" out of the score rather than reading it as no', async () => {
    const { agentId, accountId, ownerId } = await agentWithAccount();
    await somebodyKnown(agentId, 'unknown_follow');
    // Read, but the reader could not see the follow relationship -- which is
    // exactly what the rendered-page backend returns.
    await xAccountObservations.record({
      ownerUserId: ownerId,
      userId: '902',
      handle: 'unknown_follow',
      followers: 1_000,
      weFollow: null,
      followsUs: null,
      outcome: 'OK',
    });

    const [score] = await bridgesFor(agentId, accountId, { ownerUserId: ownerId, ourFollowerCount: 500 });
    // "Neither of you follows the other" is a measurement. Nothing measured it.
    expect(score!.factors.map((f) => f.name)).not.toContain('strangers');
    expect(score!.gaps.join(' ')).toContain('Whether either account follows the other was not visible');
  });

  it('does not reach for observations when no owner was given', async () => {
    const { agentId, accountId, ownerId } = await agentWithAccount();
    await somebodyKnown(agentId, 'read_person');
    await xAccountObservations.record({
      ownerUserId: ownerId,
      userId: '903',
      handle: 'read_person',
      followers: 50_000,
      outcome: 'OK',
    });

    // Callers that do not say who is asking get the old answer, which is the
    // safe direction: one owner's reads must not leak into another's scores.
    const [score] = await bridgesFor(agentId, accountId, { ourFollowerCount: 500 });
    expect(score!.gaps.join(' ')).toContain('How many people follow them was not visible');
  });

  it('will not use another owner’s reads', async () => {
    const { agentId, accountId, ownerId } = await agentWithAccount();
    const stranger = await createFixture();
    await somebodyKnown(agentId, 'read_person');
    // Somebody else on this installation looked them up. That is their record
    // of having been curious, not evidence this agent's owner has.
    await xAccountObservations.record({
      ownerUserId: stranger.ownerId,
      userId: '904',
      handle: 'read_person',
      followers: 50_000,
      outcome: 'OK',
    });

    const [score] = await bridgesFor(agentId, accountId, { ownerUserId: ownerId, ourFollowerCount: 500 });
    expect(score!.factors.map((f) => f.name)).not.toContain('reach');
    expect(score!.gaps.join(' ')).toContain('How many people follow them was not visible');
  });
});
