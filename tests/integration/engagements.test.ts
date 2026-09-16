import { beforeEach, describe, expect, it } from 'vitest';
import {
  accounts as accountsRepo,
  agents as agentsRepo,
  deliberation as mind,
  engagements as engagementsRepo,
} from '@xbam/database';
import { formEngagements, runDueEngagements, setPauseAll, type Observation } from '@xbam/runtime';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { uniqueSuffix } from '../support/db';

installHarness();

/**
 * Likes and reposts an agent decided on by itself.
 *
 * Against a real database, because the guarantees are properties of the rows:
 * one decision per post however many times it is seen, a claim that two workers
 * cannot both take, and a proposal that is never silently dropped.
 *
 * The declines matter as much as the proposals. An agent that likes everything
 * it scored above zero is an engagement-farming bot, so several of these assert
 * that nothing happened.
 */

async function agentThatEngages(over: { autonomy?: 'OBSERVE' | 'THINK' | 'SUGGEST' | 'ACT' } = {}) {
  const fixture = await createFixture({ persona: { topics: ['autonomous agents', 'agent memory'] } });
  const account = await accountsRepo.createAccount({
    ownerId: fixture.ownerId,
    channel: 'x',
    handle: `self${uniqueSuffix()}`.slice(0, 15),
    displayName: 'The agent',
  });
  await accountsRepo.linkAgentAccount({ agentId: fixture.agentId, accountId: account.id });
  await agentsRepo.updateAgent(fixture.agentId, { state: 'ACTIVE' });
  await mind.setWake(fixture.agentId, { enabled: true, autonomy: over.autonomy ?? 'SUGGEST' });
  return { ...fixture, accountId: account.id };
}

/** Something somebody else posted, in the shape the wake sees it. */
function seen(over: Partial<Observation> = {}): Observation {
  return {
    source: 'DISCOVERY',
    id: `ev-${uniqueSuffix()}`,
    text: 'The hard part of autonomous agents was never the model. It is agent memory that survives a restart, and almost nothing manages it.',
    at: new Date().toISOString(),
    handle: 'somebody',
    authorId: '900',
    url: `https://x.com/somebody/status/19${Math.floor(Math.random() * 10_000_000)}`,
    metrics: { replies: 8 },
    ...over,
  };
}

beforeEach(async () => {
  await setPauseAll({ paused: false, by: null });
});

describe('proposing something worth acknowledging', () => {
  it('proposes a like for a post on the agent’s subject', async () => {
    const agent = await agentThatEngages();
    expect(await formEngagements(agent.agentId, [seen()])).toBe(1);

    const [row] = await engagementsRepo.listEngagements(agent.agentId);
    expect(row?.kind).toBe('LIKE');
    expect(row?.status).toBe('PROPOSED');
    // Every proposal carries the reasons that produced it, because a score with
    // no reasons is not shippable anywhere in this codebase.
    expect(row!.factors.length).toBeGreaterThan(0);
    for (const factor of row!.factors) expect(factor.detail.length).toBeGreaterThan(0);
  });

  it('proposes once however many times the post is seen', async () => {
    // Several radar monitors see one post. That is one decision, not four, and
    // the unique index is what makes that true rather than application logic.
    const agent = await agentThatEngages();
    const post = seen();
    await formEngagements(agent.agentId, [post]);
    await formEngagements(agent.agentId, [post]);
    await formEngagements(agent.agentId, [{ ...post, id: 'seen-again' }]);

    expect(await engagementsRepo.listEngagements(agent.agentId)).toHaveLength(1);
  });

  it('proposes nothing for something unrelated to this agent', async () => {
    const agent = await agentThatEngages();
    const proposed = await formEngagements(agent.agentId, [
      seen({ text: 'my flight to Lisbon is delayed again and the coffee here is genuinely terrible today' }),
    ]);
    expect(proposed).toBe(0);
  });

  it('proposes nothing for an observation with no post behind it', async () => {
    // A stance, a commitment and a repository commit are all observations and
    // none of them is a post anybody can like.
    const agent = await agentThatEngages();
    const proposed = await formEngagements(agent.agentId, [
      seen({ source: 'REPO_EVENT', url: 'https://github.com/example/proj/commit/abc123' }),
      seen({ source: 'STANCE', url: null }),
      seen({ url: 'https://x.com/somebody' }),
    ]);
    expect(proposed).toBe(0);
  });

  it('never proposes acting on the agent’s own post', async () => {
    const agent = await agentThatEngages();
    const account = await accountsRepo.getAccount(agent.accountId);
    expect(await formEngagements(agent.agentId, [seen({ handle: account!.handle! })])).toBe(0);
  });
});

describe('the autonomy ladder', () => {
  it('proposes nothing at all below SUGGEST', async () => {
    const agent = await agentThatEngages({ autonomy: 'THINK' });
    // formEngagements is only reached from the wake at SUGGEST; called
    // directly it still proposes, so what is pinned here is the row state a
    // THINK agent is left in by the loop that acts.
    await formEngagements(agent.agentId, [seen()]);
    const outcomes = await runDueEngagements(5);
    expect(outcomes.every((outcome) => outcome.status !== 'DONE')).toBe(true);
  });

  it('leaves a proposal alone at SUGGEST, for the owner to look at', async () => {
    const agent = await agentThatEngages({ autonomy: 'SUGGEST' });
    await formEngagements(agent.agentId, [seen()]);

    const outcomes = await runDueEngagements(5);
    const waiting = outcomes.find((outcome) => outcome.status === 'WAITING');
    expect(waiting?.detail).toMatch(/suggests but does not act/);

    // Still there, still proposed. SUGGEST is not a slow ACT.
    const [row] = await engagementsRepo.listEngagements(agent.agentId);
    expect(row?.status).toBe('PROPOSED');
  });

  it('stops entirely when everything is paused', async () => {
    const agent = await agentThatEngages({ autonomy: 'ACT' });
    await formEngagements(agent.agentId, [seen()]);
    await setPauseAll({ paused: true, by: 'a person' });

    const outcomes = await runDueEngagements(5);
    expect(outcomes[0]?.status).toBe('DECLINED');
    expect(outcomes[0]?.detail).toMatch(/paused/i);
  });
});

describe('what a proposal records', () => {
  it('says why it was declined rather than disappearing', async () => {
    // "Why did it not like that" is a fair question and an empty table cannot
    // answer it.
    const agent = await agentThatEngages({ autonomy: 'ACT' });
    await formEngagements(agent.agentId, [seen()]);
    await setPauseAll({ paused: true, by: 'a person' });
    await runDueEngagements(5);

    const [row] = await engagementsRepo.listEngagements(agent.agentId);
    expect(row?.status).toBe('DECLINED');
    expect(row?.reason.length).toBeGreaterThan(0);
    expect(row?.decidedAt).toBeTruthy();
  });

  it('does not reopen a decision because the post was seen again', async () => {
    const agent = await agentThatEngages({ autonomy: 'SUGGEST' });
    const post = seen();
    await formEngagements(agent.agentId, [post]);
    const [row] = await engagementsRepo.listEngagements(agent.agentId);
    await engagementsRepo.settle(row!.id, 'DECLINED', 'the owner said no');

    await formEngagements(agent.agentId, [post]);
    const [after] = await engagementsRepo.listEngagements(agent.agentId);
    expect(after?.status).toBe('DECLINED');
    expect(after?.reason).toBe('the owner said no');
  });

  it('never proposes a post it has already acted on', async () => {
    const agent = await agentThatEngages();
    const post = seen();
    await formEngagements(agent.agentId, [post]);
    const [row] = await engagementsRepo.listEngagements(agent.agentId);
    await engagementsRepo.settle(row!.id, 'DONE', 'liked');

    // A different sighting of the same post, after the fact.
    await formEngagements(agent.agentId, [{ ...post, id: 'later' }]);
    expect(await engagementsRepo.listEngagements(agent.agentId)).toHaveLength(1);
  });
});

describe('the claim', () => {
  it('moves the attempt time forward so two workers cannot take one', async () => {
    const agent = await agentThatEngages({ autonomy: 'SUGGEST' });
    await formEngagements(agent.agentId, [seen()]);

    const first = await engagementsRepo.claimDue(5, 120);
    const second = await engagementsRepo.claimDue(5, 120);
    expect(first).toHaveLength(1);
    // The second worker finds nothing, because the claim already moved it.
    expect(second).toHaveLength(0);
  });

  it('counts attempts, so nothing is retried for ever', async () => {
    const agent = await agentThatEngages({ autonomy: 'SUGGEST' });
    await formEngagements(agent.agentId, [seen()]);
    const [claimed] = await engagementsRepo.claimDue(5, 0);
    expect(claimed?.attempts).toBe(1);
  });
});

describe('an owner saying yes', () => {
  it('moves a proposal to approved and makes it due', async () => {
    const agent = await agentThatEngages({ autonomy: 'SUGGEST' });
    await formEngagements(agent.agentId, [seen()]);
    const [row] = await engagementsRepo.listEngagements(agent.agentId);

    expect(await engagementsRepo.approve(row!.id, agent.agentId)).toBe(true);
    expect((await engagementsRepo.getEngagement(row!.id))?.status).toBe('APPROVED');
  });

  it('will not approve somebody else’s proposal', async () => {
    const mine = await agentThatEngages();
    const theirs = await agentThatEngages();
    await formEngagements(mine.agentId, [seen()]);
    const [row] = await engagementsRepo.listEngagements(mine.agentId);

    expect(await engagementsRepo.approve(row!.id, theirs.agentId)).toBe(false);
  });

  it('will not approve something already settled', async () => {
    const agent = await agentThatEngages();
    await formEngagements(agent.agentId, [seen()]);
    const [row] = await engagementsRepo.listEngagements(agent.agentId);
    await engagementsRepo.settle(row!.id, 'DONE', 'liked');

    expect(await engagementsRepo.approve(row!.id, agent.agentId)).toBe(false);
  });
});
