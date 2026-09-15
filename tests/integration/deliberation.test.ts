import { beforeEach, describe, expect, it } from 'vitest';
import {
  accounts as accountsRepo,
  agents as agentsRepo,
  content as contentRepo,
  deliberation as mind,
  memories as memoriesRepo,
  providers as providersRepo,
} from '@xbam/database';
import {
  decayWorkingSet,
  formIntentions,
  lookIntoSomething,
  mindForMessage,
  setPauseAll,
  wakeAgent,
  wakeDueAgents,
} from '@xbam/runtime';
import { installHarness, mockEvent } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { uniqueSuffix } from '../support/db';
import { ingestNormalizedEvent } from '@xbam/runtime';

installHarness();

/**
 * An agent thinking between the things it is asked.
 *
 * Against a real database, because almost everything worth proving here is a
 * property of the rows: that the same observation twice is one item rather than
 * two, that the claim which selects an agent has already moved its due time,
 * that a working set stays bounded, and that a paused installation does not
 * think.
 *
 * The declines matter as much as the conclusions. An agent whose working set
 * fills with everything it saw has no interests, so several of these assert
 * that nothing happened.
 */

async function agentThatThinks(over: { autonomy?: 'OBSERVE' | 'THINK' | 'SUGGEST' | 'ACT'; topics?: string[] } = {}) {
  const fixture = await createFixture({
    persona: { topics: over.topics ?? ['autonomous agents', 'agent memory'] },
  });
  const account = await accountsRepo.createAccount({
    ownerId: fixture.ownerId,
    channel: 'x',
    handle: `self${uniqueSuffix()}`.slice(0, 15),
    displayName: 'The agent',
  });
  await accountsRepo.linkAgentAccount({ agentId: fixture.agentId, accountId: account.id });
  // A DRAFT agent does not think. The fixture creates agents in DRAFT and the
  // claim deliberately joins on ACTIVE, so an agent somebody is still setting
  // up never wakes.
  await agentsRepo.updateAgent(fixture.agentId, { state: 'ACTIVE' });
  await mind.setWake(fixture.agentId, { enabled: true, autonomy: over.autonomy ?? 'THINK' });
  return { ...fixture, accountId: account.id, handle: account.handle! };
}

/** Something somebody said, put where the radar would have put it. */
async function somebodySaid(
  accountId: string,
  text: string,
  over: { handle?: string; id?: string; occurredAt?: string } = {},
) {
  await ingestNormalizedEvent({
    accountId,
    event: mockEvent(text, {
      type: 'MENTION',
      remoteEventId: over.id ?? `ev-${uniqueSuffix()}`,
      remoteAuthorHandle: over.handle ?? 'somebody',
      remoteAuthorId: '900',
      // When it was written, which is not when this installation found out.
      occurredAt: over.occurredAt ?? new Date().toISOString(),
    }),
    recordOnly: true,
  });
}

beforeEach(async () => {
  await setPauseAll({ paused: false, by: null });
});

describe('observing what happened', () => {
  it('puts something relevant on the agent’s mind', async () => {
    const agent = await agentThatThinks();
    await somebodySaid(agent.accountId, 'The hard part of autonomous agents is agent memory that survives a restart.');

    const outcome = await wakeAgent(agent.agentId);
    expect(outcome.observed).toBeGreaterThan(0);
    expect(outcome.attended).toBe(1);

    const items = await mind.onItsMind(agent.agentId);
    expect(items).toHaveLength(1);
    expect(items[0]!.summary).toContain('agent memory');
    // Evidence, not a copy: the item points back at the event it came from.
    expect(items[0]!.evidence.length).toBeGreaterThan(0);
  });

  /*
    The defect that made this whole feature do nothing on a real installation.

    An agent finds out about a post when the radar brings it back, not when
    somebody wrote it. The window used to be on `occurred_at`, which looked
    equivalent and is not: on a real install the median gap between a post
    happening and AI17Z ingesting it is nineteen hours, against a wake interval
    measured in minutes -- so the window almost never contained the moment the
    post was written and almost nothing was ever observed. It passed every test
    because a fixture makes an event that happened just now.
  */
  it('observes a post that arrived since the last wake, however old the post is', async () => {
    const agent = await agentThatThinks();
    await somebodySaid(
      agent.accountId,
      'The hard part of autonomous agents is agent memory that survives a restart.',
      // Written thirty hours ago, which is outside the window a first wake
      // looks back over. Ingested a moment ago, which is when this agent could
      // first have known about it at all.
      { occurredAt: new Date(Date.now() - 30 * 3_600_000).toISOString() },
    );

    const outcome = await wakeAgent(agent.agentId);
    expect(outcome.observed).toBeGreaterThan(0);
    expect(outcome.attended).toBe(1);
  });

  it('still treats a genuinely old post as history rather than news', async () => {
    // When it arrived and how old it is are different facts answered in
    // different layers: the window lets it through, salience declines it.
    const agent = await agentThatThinks();
    await somebodySaid(agent.accountId, 'The hard part of autonomous agents is agent memory that survives a restart.', {
      occurredAt: new Date(Date.now() - 200 * 3_600_000).toISOString(),
    });

    const outcome = await wakeAgent(agent.agentId);
    expect(outcome.observed).toBeGreaterThan(0);
    expect(outcome.attended).toBe(0);
  });

  it('declines noise rather than scoring it low', async () => {
    const agent = await agentThatThinks();
    await somebodySaid(agent.accountId, 'my flight to Lisbon is delayed again and the coffee here is terrible');

    const outcome = await wakeAgent(agent.agentId);
    expect(outcome.observed).toBeGreaterThan(0);
    expect(outcome.attended).toBe(0);
    expect(await mind.countLive(agent.agentId)).toBe(0);
    // And it says so, rather than leaving an owner to infer it from silence.
    expect(outcome.reason).toMatch(/found nothing new/);
  });

  it('ranks what matters above what merely happened', async () => {
    const agent = await agentThatThinks();
    await somebodySaid(agent.accountId, 'Agent memory that survives a restart is the whole problem with autonomous agents.');
    await somebodySaid(agent.accountId, 'Anyone else find browser automation flaky on Mondays, asking for a friend here');
    await wakeAgent(agent.agentId);

    const items = await mind.onItsMind(agent.agentId);
    expect(items.length).toBeGreaterThan(0);
    // The one about two of its subjects should outrank the one about one.
    expect(items[0]!.summary).toContain('Agent memory');
  });
});

describe('not thinking the same thing twice', () => {
  it('reinforces one item rather than creating a second', async () => {
    const agent = await agentThatThinks();
    const text = 'Agent memory that survives a restart is the hard part of autonomous agents.';
    // Two different people, saying the same thing. That is one subject two
    // people raised, and it is the reinforcement that separates it from
    // something one person mentioned once.
    await somebodySaid(agent.accountId, text, { handle: 'first_person' });
    await somebodySaid(agent.accountId, text, { handle: 'second_person' });
    await wakeAgent(agent.agentId);

    const items = await mind.onItsMind(agent.agentId);
    expect(items).toHaveLength(1);
    expect(items[0]!.reinforcements).toBe(2);
  });
});

describe('fading', () => {
  it('retires something nothing has pointed at in a long time', async () => {
    const agent = await agentThatThinks();
    const item = await mind.remember({
      agentId: agent.agentId,
      kind: 'NARRATIVE',
      summary: 'Something people were talking about a month ago.',
      salience: 60,
      fingerprint: 'old-thing',
    });

    // A month later, with nothing having reinforced it.
    const later = new Date(Date.now() + 40 * 24 * 3600_000);
    const faded = await decayWorkingSet(agent.agentId, later);

    expect(faded.retired).toBeGreaterThan(0);
    const still = await mind.getAttention(item.id);
    expect(still?.state).toBe('RETIRED');
    // Retired, not deleted: "what did it used to care about" stays answerable.
    expect(still?.resolution).toBeTruthy();
  });

  it('leaves something still being reinforced alone', async () => {
    const agent = await agentThatThinks();
    const item = await mind.remember({
      agentId: agent.agentId,
      kind: 'LESSON',
      summary: 'Something it worked out that is still true.',
      salience: 70,
      fingerprint: 'durable',
    });
    await decayWorkingSet(agent.agentId, new Date(Date.now() + 2 * 24 * 3600_000));
    expect((await mind.getAttention(item.id))?.state).toBe('ACTIVE');
  });

  it('brings a retired item back when it turns up again', async () => {
    const agent = await agentThatThinks();
    const first = await mind.remember({
      agentId: agent.agentId,
      kind: 'NARRATIVE',
      summary: 'A thing that went quiet.',
      salience: 60,
      fingerprint: 'returns',
    });
    await mind.settle(first.id, 'RETIRED', 'went quiet');

    const again = await mind.remember({
      agentId: agent.agentId,
      kind: 'NARRATIVE',
      summary: 'A thing that went quiet.',
      salience: 60,
      fingerprint: 'returns',
    });
    // Decay is reversible for exactly this reason: a subject coming back is
    // the same subject, not a new one.
    expect(again.id).toBe(first.id);
    expect(again.state).toBe('ACTIVE');
  });
});

describe('changing its mind', () => {
  it('supersedes a belief rather than overwriting it', async () => {
    const agent = await agentThatThinks();
    const wrong = await mind.remember({
      agentId: agent.agentId,
      kind: 'HYPOTHESIS',
      summary: 'The slow part is probably the model.',
      salience: 50,
      confidence: 0.6,
      fingerprint: 'what-is-slow',
    });
    const right = await mind.remember({
      agentId: agent.agentId,
      kind: 'LESSON',
      summary: 'The slow part was the browser, not the model.',
      salience: 70,
      confidence: 0.9,
      fingerprint: 'what-is-slow-answered',
    });
    await mind.settle(wrong.id, 'SUPERSEDED', 'Measured it; it was the browser.', right.id);

    const old = await mind.getAttention(wrong.id);
    expect(old?.state).toBe('SUPERSEDED');
    expect(old?.supersededBy).toBe(right.id);
    // The old row is what lets an agent say it changed its mind, which is the
    // difference between learning and quietly being different.
    expect(old?.resolution).toContain('browser');
  });
});

describe('goals', () => {
  it('holds a goal, advances it, and closes it with a reason', async () => {
    const agent = await agentThatThinks();
    const goal = await mind.addGoal({
      agentId: agent.agentId,
      summary: 'Understand why browser reads go flaky under load.',
      reason: 'Three separate people mentioned it.',
    });
    expect(goal.status).toBe('ACTIVE');

    await mind.updateGoal(goal.id, { progress: 60 });
    await mind.noteGoalEvidence(goal.id, [{ kind: 'RESEARCH', ref: 'note-1', note: 'measured it', at: null }]);
    await mind.updateGoal(goal.id, { status: 'COMPLETED', resolution: 'It was tab contention.' });

    const [after] = await mind.listGoals(agent.agentId, { status: 'COMPLETED' });
    expect(after?.progress).toBe(60);
    expect(after?.resolution).toContain('tab contention');
    expect(after?.resolvedAt).toBeTruthy();
    expect(after?.evidence.length).toBe(1);
  });

  it('records who decided a goal, because an owner’s outranks its own', async () => {
    const agent = await agentThatThinks();
    const mine = await mind.addGoal({ agentId: agent.agentId, summary: 'Owner set this.', origin: 'OWNER', pinned: true });
    expect(mine.origin).toBe('OWNER');
    expect(mine.pinned).toBe(true);
  });
});

describe('turning a thought into something it might say', () => {
  it('offers a strong, reinforced item to the existing backlog', async () => {
    const agent = await agentThatThinks({ autonomy: 'SUGGEST' });
    await mind.remember({
      agentId: agent.agentId,
      kind: 'LESSON',
      summary: 'Reading X through its own JSON gives exact counts that a rendered page cannot.',
      salience: 70,
      confidence: 0.8,
      fingerprint: 'lesson-1',
    });

    const made = await formIntentions(agent.agentId);
    expect(made).toBe(1);

    const ideas = await contentRepo.listIdeas(agent.agentId, 'unused');
    expect(ideas.some((idea) => idea.source === 'deliberation')).toBe(true);
  });

  it('will not offer something it is still unsure about', async () => {
    const agent = await agentThatThinks({ autonomy: 'SUGGEST' });
    await mind.remember({
      agentId: agent.agentId,
      kind: 'HYPOTHESIS',
      summary: 'Something it suspects but has not established at all yet, really.',
      salience: 80,
      // Anything still being investigated is not ready to be said out loud.
      confidence: 0.3,
      fingerprint: 'unsure',
    });
    expect(await formIntentions(agent.agentId)).toBe(0);
  });

  it('will not offer a passing sighting', async () => {
    const agent = await agentThatThinks({ autonomy: 'SUGGEST' });
    await mind.remember({
      agentId: agent.agentId,
      kind: 'INTEREST',
      summary: 'Somebody mentioned a thing once and it scored well enough.',
      salience: 80,
      confidence: 0.9,
      fingerprint: 'once',
    });
    // Seen once. An agent whose every passing interest becomes a draft is the
    // content generator this codebase keeps saying it does not want.
    expect(await formIntentions(agent.agentId)).toBe(0);
  });

  it('does not offer anything at all below SUGGEST', async () => {
    const agent = await agentThatThinks({ autonomy: 'THINK' });
    await mind.remember({
      agentId: agent.agentId,
      kind: 'LESSON',
      summary: 'Something well established and worth saying to other people.',
      salience: 80,
      confidence: 0.9,
      fingerprint: 'good-lesson',
    });
    const outcome = await wakeAgent(agent.agentId);
    expect(outcome.candidates).toBe(0);
  });
});

/*
  The one gate on an agent choosing its own subject.

  Answering about an election when somebody asks is the engagement heuristic's
  decision and the policy's. Raising one is this agent deciding by itself to
  publish a political opinion on somebody's real account, which is what
  origination made possible and nothing stopped.
*/
describe('what it will not raise by itself', () => {
  const politically = {
    kind: 'LESSON' as const,
    summary: 'The election turned on turnout rather than on any of the arguments anybody made.',
    salience: 85,
    confidence: 0.9,
    fingerprint: 'political',
  };

  it('does not offer a political opinion as something to post', async () => {
    const agent = await agentThatThinks({ autonomy: 'SUGGEST' });
    await mind.remember({ agentId: agent.agentId, ...politically });

    expect(await formIntentions(agent.agentId)).toBe(0);
    expect(await contentRepo.listIdeas(agent.agentId, 'unused')).toHaveLength(0);
  });

  it('leaves the item on its mind and says why it was not offered', async () => {
    // Not settled and not hidden: it is still a live interest, and the refusal
    // appears in the same list of factors that explains every other score.
    const agent = await agentThatThinks({ autonomy: 'SUGGEST' });
    await mind.remember({ agentId: agent.agentId, ...politically });
    await formIntentions(agent.agentId);

    const items = await mind.onItsMind(agent.agentId);
    expect(items).toHaveLength(1);
    const factor = items[0]!.factors.find((each) => each.name === 'not-raised-unprompted');
    expect(factor?.detail).toContain('does not start the conversation');
    // Worth no points, so a refusal costs the item nothing.
    expect(factor?.points).toBe(0);
    expect(items[0]!.salience).toBe(85);
  });

  it('keeps it out of an original post, which has no question to be relevant to', async () => {
    const agent = await agentThatThinks({ autonomy: 'SUGGEST' });
    await mind.remember({ agentId: agent.agentId, ...politically });
    expect(await mindForMessage(agent.agentId, '', true)).toHaveLength(0);
  });

  it('still lets it answer when somebody brings the subject up', async () => {
    // The promise is "does not raise it", never "may not discuss it". What an
    // agent says in an answer is the policy's business and the owner's.
    const agent = await agentThatThinks({ autonomy: 'SUGGEST' });
    await mind.remember({ agentId: agent.agentId, ...politically });

    const forReply = await mindForMessage(
      agent.agentId,
      'What did you make of the election turnout argument everyone was having?',
      false,
    );
    expect(forReply).toHaveLength(1);
  });

  it('does not refuse ordinary engineering talk', async () => {
    const agent = await agentThatThinks({ autonomy: 'SUGGEST' });
    await mind.remember({
      agentId: agent.agentId,
      kind: 'LESSON',
      summary: 'A worker that died mid-job resumes from the last settled state rather than starting again.',
      salience: 80,
      confidence: 0.9,
      fingerprint: 'engineering',
    });
    expect(await formIntentions(agent.agentId)).toBe(1);
  });
});

/*
  What a faded thought leaves behind.

  The working set is forgetful on purpose. Without this, an agent could work
  something out, hold it a fortnight and lose it -- a machine that learns and
  then forgets. It writes into the same six memory scopes everything else uses,
  because a second store is a second answer to "what does this agent know".
*/
describe('keeping what was worth learning', () => {
  const later = () => new Date(Date.now() + 400 * 24 * 3600_000);
  const evidence = [{ kind: 'EVENT', ref: 'https://x.com/somebody/status/1', note: 'where it came from', at: null }];

  it('keeps a lesson as persona memory when it fades', async () => {
    const agent = await agentThatThinks();
    await mind.remember({
      agentId: agent.agentId,
      kind: 'LESSON',
      summary: 'Replying to the right post is harder than writing the reply.',
      salience: 70,
      confidence: 0.8,
      evidence,
      fingerprint: 'lesson-kept',
    });

    const faded = await decayWorkingSet(agent.agentId, later());
    expect(faded.retired).toBeGreaterThan(0);
    expect(faded.kept).toBe(1);

    const kept = await memoriesRepo.searchMemories({ agentId: agent.agentId, scopes: ['PERSONA'], limit: 10 });
    expect(kept.items.map((memory) => memory.content)).toContain(
      'Replying to the right post is harder than writing the reply.',
    );
    // The evidence travels, because a memory whose grounds are gone is an
    // assertion. And no reasoning travels with it: a summary is not a
    // transcript.
    const origin = kept.items.find((memory) => memory.content.startsWith('Replying'))?.origin as
      | Record<string, unknown>
      | null;
    expect(origin?.from).toBe('deliberation');
    expect((origin?.evidence as unknown[]).length).toBe(1);
  });

  it('keeps nothing from an interest that simply stopped mattering', async () => {
    const agent = await agentThatThinks();
    await mind.remember({
      agentId: agent.agentId,
      kind: 'INTEREST',
      summary: 'Somebody was briefly excited about a thing and then nobody mentioned it again.',
      salience: 70,
      confidence: 0.9,
      evidence,
      fingerprint: 'interest-dropped',
    });

    const faded = await decayWorkingSet(agent.agentId, later());
    expect(faded.retired).toBeGreaterThan(0);
    // An interest that faded is not a fact. That it faded is already on the
    // retired row.
    expect(faded.kept).toBe(0);
  });

  it('keeps nothing it has no evidence for, whatever it scored', async () => {
    const agent = await agentThatThinks();
    await mind.remember({
      agentId: agent.agentId,
      kind: 'LESSON',
      summary: 'Something it concluded from nothing anybody can check.',
      salience: 95,
      confidence: 1,
      fingerprint: 'unevidenced',
    });

    expect((await decayWorkingSet(agent.agentId, later())).kept).toBe(0);
  });

  it('keeps nothing it is still unsure about', async () => {
    const agent = await agentThatThinks();
    await mind.remember({
      agentId: agent.agentId,
      kind: 'LESSON',
      summary: 'Something it half thinks might be true and has not established.',
      salience: 70,
      confidence: 0.3,
      evidence,
      fingerprint: 'unsure-lesson',
    });

    expect((await decayWorkingSet(agent.agentId, later())).kept).toBe(0);
  });
});

/*
  Going and finding out.

  An agent that keeps a list of things it does not understand and never looks
  any of them up is not curious, it is uncertain -- and uncertainty that never
  resolves is the state an agent is in without any of this. The searching is the
  existing research step; what is proved here is what is done with the answer,
  and the declines that stop a curious agent hammering a search engine.
*/
describe('looking something up', () => {
  const found = async () => [
    {
      kind: 'search' as const,
      query: 'anything',
      source: 'Web search',
      title: 'Agent memory and restarts',
      summary: 'Something that bears on the question.',
      url: 'https://example.invalid/memory',
      retrievedAt: new Date().toISOString(),
    },
  ];

  async function wondering(agent: { agentId: string }, over: { salience?: number; kind?: 'QUESTION' | 'INTEREST' } = {}) {
    return mind.remember({
      agentId: agent.agentId,
      kind: over.kind ?? 'QUESTION',
      summary: 'Whether agent memory that survives a restart needs a database at all.',
      salience: over.salience ?? 60,
      confidence: 0.4,
      fingerprint: 'wondering',
    });
  }

  it('attaches what it found as evidence, and leaves the question open', async () => {
    const agent = await agentThatThinks();
    const before = await wondering(agent);

    const outcome = await lookIntoSomething(agent.agentId, { search: found });
    expect(outcome?.findings).toBe(1);

    const [after] = await mind.onItsMind(agent.agentId);
    // Evidence with a reference somebody can follow.
    expect(after!.evidence.some((each) => each.ref === 'https://example.invalid/memory')).toBe(true);
    // Still open. A search engine returning something is not an agent's
    // question being answered -- that is reflection's decision, and a wrong
    // result reads exactly like a right one.
    expect(after!.state).toBe('ACTIVE');
    expect(after!.summary).toBe(before.summary);
    // Moved a little, not a lot: having found something relevant is not the
    // same as having understood it.
    expect(after!.confidence).toBeGreaterThan(before.confidence);
    expect(after!.confidence).toBeLessThanOrEqual(0.75);
  });

  it('does not look the same thing up again straight away', async () => {
    const agent = await agentThatThinks();
    await wondering(agent);

    expect(await lookIntoSomething(agent.agentId, { search: found })).not.toBeNull();
    // The review clock is the only thing between a curious agent and a search
    // engine it asks the same question of every quarter of an hour.
    expect(await lookIntoSomething(agent.agentId, { search: found })).toBeNull();
  });

  it('records that it looked and found nothing, rather than asking again', async () => {
    const agent = await agentThatThinks();
    await wondering(agent);

    const outcome = await lookIntoSomething(agent.agentId, { search: async () => [] });
    expect(outcome?.findings).toBe(0);
    expect(await lookIntoSomething(agent.agentId, { search: found })).toBeNull();
  });

  it('does not look up a subject, only a question', async () => {
    const agent = await agentThatThinks();
    await wondering(agent, { kind: 'INTEREST' });
    expect(await lookIntoSomething(agent.agentId, { search: found })).toBeNull();
  });

  it('never looks anything up on a wake that was not allowed to', async () => {
    // The API owns no browsers, so its "think now" does everything else and
    // says it looked nothing up rather than quietly failing to.
    const agent = await agentThatThinks();
    await wondering(agent);
    const outcome = await wakeAgent(agent.agentId);
    expect(outcome.lookedInto).toBeNull();
  });
});

describe('the autonomy ladder', () => {
  it('only observes at OBSERVE', async () => {
    const agent = await agentThatThinks({ autonomy: 'OBSERVE' });
    await somebodySaid(agent.accountId, 'Agent memory that survives a restart is the hard part here.');
    const outcome = await wakeAgent(agent.agentId);
    // It notices, and it stops. No reflection, no decay, no candidates.
    expect(outcome.attended).toBe(1);
    expect(outcome.produced).toBe(0);
    expect(outcome.candidates).toBe(0);
  });

  /*
    A reflection that failed and one that correctly found nothing used to be
    the same two zeros on the screen. That is the shape of defect this
    codebase has paid for twice: a failure turned into silence that reads
    exactly like a correct quiet result.
  */
  it('says why reflection did not run, rather than showing the same two zeros', async () => {
    const agent = await agentThatThinks();
    // No classifier configured, which is a reason and not a result.
    await somebodySaid(agent.accountId, 'The hard part of autonomous agents is agent memory that survives a restart.');
    await wakeAgent(agent.agentId);

    const [latest] = await mind.recentReflections(agent.agentId, 1);
    expect(latest?.produced).toBe(0);
    expect(latest?.model).toBeNull();
    expect(latest?.why).toContain('classifier');
  });

  it('says nothing when there was simply nothing to say', async () => {
    // The other half: a correctly quiet wake must not carry a reason, or the
    // screen cries wolf on every quiet agent.
    const agent = await agentThatThinks();
    await wakeAgent(agent.agentId);
    const [latest] = await mind.recentReflections(agent.agentId, 1);
    expect(latest?.why ?? null).toBeNull();
  });

  it('does nothing at all when deliberation is switched off', async () => {
    const agent = await agentThatThinks();
    await mind.setWake(agent.agentId, { enabled: false });
    await somebodySaid(agent.accountId, 'Agent memory that survives a restart is the hard part here.');
    const outcome = await wakeAgent(agent.agentId);
    expect(outcome.skipped).toBe('disabled');
    expect(await mind.countLive(agent.agentId)).toBe(0);
  });
});

describe('pause is supreme', () => {
  it('stops an agent thinking, not just acting', async () => {
    const agent = await agentThatThinks();
    await somebodySaid(agent.accountId, 'Agent memory that survives a restart is the hard part here.');
    await setPauseAll({ paused: true, by: null, reason: 'test' });

    const outcome = await wakeAgent(agent.agentId);
    expect(outcome.skipped).toBe('paused');
    // Thinking costs model calls and changes the agent's own state. An owner
    // who pressed pause did not mean "keep developing opinions".
    expect(await mind.countLive(agent.agentId)).toBe(0);
  });
});

describe('the wake schedule', () => {
  it('claims an agent by moving its due time, so two workers cannot both take it', async () => {
    const agent = await agentThatThinks();
    const before = await mind.getWake(agent.agentId);
    expect(new Date(before!.nextWakeAt).getTime()).toBeLessThanOrEqual(Date.now());

    const first = await mind.claimDueWakes(5, 300);
    const second = await mind.claimDueWakes(5, 300);

    expect(first.map((row) => row.agentId)).toContain(agent.agentId);
    // The claim moved it forward in the statement that selected it. That is
    // what makes the loop restart-safe without any state in the process.
    expect(second.map((row) => row.agentId)).not.toContain(agent.agentId);
  });

  it('backs off when nothing keeps happening', async () => {
    const agent = await agentThatThinks();
    await wakeAgent(agent.agentId);
    const after = await mind.getWake(agent.agentId);
    expect(after!.quietWakes).toBe(1);

    await wakeAgent(agent.agentId);
    const later = await mind.getWake(agent.agentId);
    // A quiet agent must not cost a model call every half hour for ever.
    expect(later!.quietWakes).toBe(2);
    expect(new Date(later!.nextWakeAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('resets the moment something happens', async () => {
    const agent = await agentThatThinks();
    await wakeAgent(agent.agentId);
    expect((await mind.getWake(agent.agentId))!.quietWakes).toBe(1);

    await somebodySaid(agent.accountId, 'Agent memory that survives a restart is the hard part here.');
    await wakeAgent(agent.agentId);
    expect((await mind.getWake(agent.agentId))!.quietWakes).toBe(0);
  });

  it('records that a wake happened even when nobody claimed it', async () => {
    const agent = await agentThatThinks();
    // "Think now" from the owner's screen calls wakeAgent directly and never
    // goes through the claim. Without the stamp at completion the agent said it
    // had never looked however often somebody asked -- and the next wake read
    // the same window again, because the window starts at the last wake.
    await wakeAgent(agent.agentId);
    const after = await mind.getWake(agent.agentId);
    expect(after!.lastWakeAt).toBeTruthy();
  });

  it('records every wake, including the ones that found nothing', async () => {
    const agent = await agentThatThinks();
    await wakeAgent(agent.agentId);
    const [reflection] = await mind.recentReflections(agent.agentId);
    // "Nothing new" is a result and is shown as one. A screen that listed only
    // the productive runs would make a correctly quiet agent look broken.
    expect(reflection).toBeDefined();
    expect(reflection!.summary).toMatch(/found nothing new/);
  });

  it('wakes only agents that are due, through the loop the worker runs', async () => {
    const agent = await agentThatThinks();
    const outcomes = await wakeDueAgents(5);
    expect(outcomes.map((outcome) => outcome.agentId)).toContain(agent.agentId);
    // And nothing is due immediately afterwards.
    expect((await wakeDueAgents(5)).map((o) => o.agentId)).not.toContain(agent.agentId);
  });
});

describe('reflection', () => {
  it('records that it could not run rather than pretending it did', async () => {
    // No classifier role configured, which is the ordinary case for an agent
    // whose owner has not asked for extra model calls.
    const agent = await agentThatThinks();
    await somebodySaid(agent.accountId, 'Agent memory that survives a restart is the hard part here.');
    const outcome = await wakeAgent(agent.agentId);
    expect(outcome.attended).toBe(1);
    expect(outcome.produced).toBe(0);
  });

  it('keeps only conclusions that cite what they came from', async () => {
    const agent = await agentThatThinks();
    // An answer whose items cite nothing. Every one must be dropped: an item
    // with no evidence is an assertion, and this codebase does not keep them.
    await providersRepo.setModelConfig({
      agentId: agent.agentId,
      role: 'classifier',
      providerCredentialId: agent.providerId,
      model: 'mock-fixed:{"items":[{"kind":"LESSON","summary":"Something sweeping and unsourced","detail":"","confidence":0.9,"from":[]}],"resolved":[]}',
      parameters: {},
    });
    await somebodySaid(agent.accountId, 'Agent memory that survives a restart is the hard part here.');

    const outcome = await wakeAgent(agent.agentId);
    expect(outcome.produced).toBe(0);
  });

  it('keeps a conclusion that cites an observation and says something new', async () => {
    const agent = await agentThatThinks();
    await providersRepo.setModelConfig({
      agentId: agent.agentId,
      role: 'classifier',
      providerCredentialId: agent.providerId,
      model:
        'mock-fixed:{"items":[{"kind":"CURIOSITY","summary":"Worth finding out whether restarts are the common failure people hit","detail":"Several people describe the same symptom","confidence":0.6,"from":[0]}],"resolved":[]}',
      parameters: {},
    });
    await somebodySaid(agent.accountId, 'Agent memory that survives a restart is the hard part of autonomous agents.');

    const outcome = await wakeAgent(agent.agentId);
    expect(outcome.produced).toBe(1);

    const curiosity = (await mind.onItsMind(agent.agentId, { kinds: ['CURIOSITY'] }))[0];
    expect(curiosity).toBeDefined();
    // It inherited the evidence of what it was drawn from.
    expect(curiosity!.evidence.length).toBeGreaterThan(0);
    expect(curiosity!.origin).toBe('REFLECT');
  });
});

describe('what reaches a reply', () => {
  it('brings up something relevant that has been on its mind', async () => {
    const agent = await agentThatThinks();
    await mind.remember({
      agentId: agent.agentId,
      kind: 'CONCERN',
      summary: 'Browser reads have been going flaky when several tabs are busy at once.',
      salience: 70,
      confidence: 0.7,
      fingerprint: 'flaky-tabs',
    });

    const chosen = await mindForMessage(
      agent.agentId,
      'why do the browser reads go flaky when tabs are busy?',
      false,
    );
    expect(chosen).toHaveLength(1);
    expect(chosen[0]!.kind).toBe('CONCERN');
  });

  it('keeps internal state out of a conversation it has nothing to do with', async () => {
    const agent = await agentThatThinks();
    await mind.remember({
      agentId: agent.agentId,
      kind: 'CONCERN',
      summary: 'Browser reads have been going flaky when several tabs are busy at once.',
      salience: 90,
      confidence: 0.9,
      fingerprint: 'flaky-tabs',
    });

    // High salience, and still irrelevant. An agent that mentions its concerns
    // because somebody said hello reads as one that cannot tell what it is
    // talking about, which is worse than having no concerns at all.
    const chosen = await mindForMessage(agent.agentId, 'congrats on the launch, looks great', false);
    expect(chosen).toEqual([]);
  });

  it('gives a post the strongest items whatever they are about', async () => {
    const agent = await agentThatThinks();
    await mind.remember({
      agentId: agent.agentId,
      kind: 'LESSON',
      summary: 'Reading X through its own JSON gives exact counts a rendered page cannot.',
      salience: 80,
      confidence: 0.9,
      fingerprint: 'json-counts',
    });

    // No incoming message for anything to be relevant to, and "what has this
    // agent been thinking about" is exactly what an original post answers.
    const chosen = await mindForMessage(agent.agentId, '', true);
    expect(chosen).toHaveLength(1);
  });

  it('renders a thing it suspects as a thing it suspects', async () => {
    const { renderMind } = await import('@xbam/prompts');
    const rendered = renderMind([
      { kind: 'HYPOTHESIS', summary: 'the slow part is the browser', confidence: 0.4 },
      { kind: 'LESSON', summary: 'the slow part was the browser', confidence: 0.9 },
    ]);
    // An agent that states a 0.4 hypothesis as a finding is worse than one that
    // never had it.
    expect(rendered).toContain('though you are not sure');
    expect(rendered.split('\n')[1]).not.toContain('though you are not sure');
  });
});
