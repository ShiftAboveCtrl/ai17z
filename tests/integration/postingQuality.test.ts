import { describe, expect, it } from 'vitest';
import { accounts, agents, content, deliberation, jobs, providers, query, stances } from '@xbam/database';
import { StancePolicy } from '@xbam/shared/contracts';
import { formIntentions, learnStancesFromOwnPost, originatePost, reviewLearnedState } from '@xbam/runtime';
import { installHarness } from '../support/harness';
import { createFixture, seedCatalogue } from '../support/fixtures';
import { drainJobs } from '../support/runner';
import { uniqueSuffix } from '../support/db';

installHarness();

async function poster(model: string) {
  await seedCatalogue();
  const fixture = await createFixture();
  await agents.updateAgent(fixture.agentId, { state: 'ACTIVE' });
  await providers.setModelConfig({ agentId: fixture.agentId, role: 'primary', providerCredentialId: fixture.providerId, model, parameters: {} });
  const account = await accounts.createAccount({ ownerId: fixture.ownerId, channel: 'mock', handle: `poster_${uniqueSuffix()}`, displayName: 'Poster' });
  await accounts.linkAgentAccount({ agentId: fixture.agentId, accountId: account.id, triggerEventTypes: ['MENTION'], actionType: 'REPLY', enabled: true });
  return { fixture, accountId: account.id };
}

async function publishedPost(agentId: string, text: string) {
  const suffix = uniqueSuffix();
  const [event] = await query<{ id: string }>(`INSERT INTO events (channel, type, remote_event_id, text) VALUES ('mock', 'SCHEDULED_TRIGGER', $1, 'a post') RETURNING id`, [`ev-${suffix}`]);
  const [job] = await query<{ id: string }>(
    `INSERT INTO jobs (event_id, agent_id, channel, action_type, idempotency_key, status) VALUES ($1, $2, 'mock', 'POST', $3, 'EXECUTED') RETURNING id`,
    [event!.id, agentId, `post-${suffix}`],
  );
  await query(
    `INSERT INTO actions (job_id, agent_id, channel, type, status, dry_run, payload, idempotency_key, executed_at)
     VALUES ($1, $2, 'mock', 'POST', 'EXECUTED', false, $3::jsonb, $4, now())`,
    [job!.id, agentId, JSON.stringify({ text }), `act-${suffix}`],
  );
}

describe('an original post has to be worth posting', () => {
  it('stays silent when the draft is another feature announcement, and sets the idea aside', async () => {
    const promo = 'AI17Z runs in a real signed-in browser on your own machine, no API key needed, and the runtime survives a restart.';
    const { fixture, accountId } = await poster(`mock-fixed:${promo}`);
    await publishedPost(fixture.agentId, 'The part of AI17Z worth poking at is the self-hosted Chrome runtime on your own machine.');
    const idea = await content.addIdea({ agentId: fixture.agentId, summary: 'The browser runtime is the interesting part of the product.', score: 90, source: 'deliberation' });

    const started = await originatePost({ agentId: fixture.agentId, accountId });
    expect(started.jobId).not.toBeNull();
    await drainJobs();

    const job = await jobs.requireJob(started.jobId!);
    expect(job.status).toBe('CANCELLED');
    expect(job.lastError).toMatch(/Not worth posting/);
    const published = await query(`SELECT 1 FROM actions WHERE job_id = $1 AND status = 'EXECUTED'`, [job.id]);
    expect(published).toHaveLength(0);

    await content.reconcileDrafting();
    const [row] = await query<{ status: string }>(`SELECT status FROM content_ideas WHERE id = $1`, [idea.id]);
    expect(row!.status).toBe('discarded');
  });

  it('posts a draft with something to say', async () => {
    const { fixture, accountId } = await poster('mock-fixed:Watching two agents argue about gas fees in a thread nobody asked them into is the most 2026 thing I have seen all week.');
    await content.addIdea({ agentId: fixture.agentId, summary: 'Agents arguing with each other in public threads.', score: 90, source: 'deliberation' });
    const started = await originatePost({ agentId: fixture.agentId, accountId });
    await drainJobs();
    const job = await jobs.requireJob(started.jobId!);
    expect(job.status).not.toBe('CANCELLED');
    const verdicts = await query<{ message: string }>(`SELECT message FROM trace_events WHERE job_id = $1 AND type = 'QUALITY_SCORED'`, [job.id]);
    expect(verdicts.map((v) => v.message)).toContain('Worth posting.');
  });
});

describe('stating its own conclusion', () => {
  /*
    Found on ai17z-test: a post that said what reflection had concluded was
    silenced as an echo of its idea. A conclusion the agent reached is the
    point of the post.
  */
  it('is not an echo', async () => {
    const thought = 'Most agents on X go quiet the moment their operator logs off, which says more about the setup than the agent.';
    const { fixture, accountId } = await poster(`mock-fixed:${thought}`);
    await content.addIdea({ agentId: fixture.agentId, summary: thought, score: 95, source: 'deliberation' });
    const started = await originatePost({ agentId: fixture.agentId, accountId });
    await drainJobs();
    const verdicts = await query<{ message: string }>(`SELECT message FROM trace_events WHERE job_id = $1 AND type = 'QUALITY_SCORED'`, [started.jobId]);
    expect(verdicts.map((v) => v.message)).toContain('Worth posting.');
  });
});

describe('where post ideas come from', () => {
  it('never queues something it only observed, only what it concluded', async () => {
    const fixture = await createFixture();
    const common = { agentId: fixture.agentId, salience: 80, confidence: 0.8, detail: '', factors: [], evidence: [] };
    const seen = await deliberation.remember({ ...common, kind: 'INTEREST', summary: 'Keep your X account active with your own agent for free using this tool', origin: 'OBSERVE:DISCOVERY', fingerprint: 'fp-seen' } as never);
    const concluded = await deliberation.remember({ ...common, kind: 'IDEA', summary: 'People only notice an agent is autonomous when it does something its owner would not have', origin: 'REFLECT', fingerprint: 'fp-concluded' } as never);
    for (const id of [seen.id, concluded.id]) await query(`UPDATE agent_attention SET reinforcements = 3 WHERE id = $1`, [id]);

    await formIntentions(fixture.agentId);
    const ideas = await content.listIdeas(fixture.agentId);
    expect(ideas.map((i) => i.summary)).toEqual([expect.stringContaining('People only notice')]);
  });
});

describe('what it learns from its own replies', () => {
  const policy = StancePolicy.parse({ enabled: true, learnFromOwnPosts: true });

  it('learns no position about the person it replied to or about itself, and keeps the sentence, not the reply', async () => {
    const fixture = await createFixture();
    await learnStancesFromOwnPost({
      agentId: fixture.agentId,
      text: '@KoreanApeSKHNX ha, fair. Project Q got the distribution badly wrong, and AI17Z is fine.',
      policy,
      selfNames: ['ai17z', 'AI17Z'],
    });
    const held = await stances.listActive(fixture.agentId, 50);
    expect(held.map((s) => s.subject)).not.toContain('KoreanApeSKHNX');
    expect(held.map((s) => s.subject)).not.toContain('AI17Z');
    const q = held.find((s) => s.subject === 'Project Q');
    expect(q?.summary).toBe('Project Q got the distribution badly wrong, and AI17Z is fine.');
  });

  it('retires learned junk by today’s rules, audits it, and never touches a pinned belief', async () => {
    const fixture = await createFixture();
    const junk = await stances.assert({ agentId: fixture.agentId, subject: 'Better', position: 'POSITIVE', summary: 'Right. Better evidence changes the memory.', confidence: 0.9, evidence: { kind: 'said', excerpt: 'Right. Better evidence changes the memory.' } });
    const pinned = await stances.assert({ agentId: fixture.agentId, subject: 'Good', position: 'POSITIVE', summary: 'Owner wrote this.', confidence: 0.9, pinned: true });

    const dry = await reviewLearnedState({ agentId: fixture.agentId, selfNames: ['ai17z'] });
    expect(dry.stances.retire.map((s) => s.subject)).toEqual(['Better']);
    expect((await stances.get(junk.id))!.status).toBe('ACTIVE');

    await reviewLearnedState({ agentId: fixture.agentId, selfNames: ['ai17z'], apply: true, actorUserId: fixture.ownerId });
    expect((await stances.get(junk.id))!.status).toBe('RETIRED');
    expect((await stances.get(pinned.id))!.status).toBe('ACTIVE');
    const audit = await query(`SELECT 1 FROM audit_events WHERE action = 'agent.stance.retired'`);
    expect(audit).toHaveLength(1);
  });

  it('sets aside a queued idea that is somebody else’s post', async () => {
    const fixture = await createFixture();
    const text = 'To every developer: crypto does not sleep, you do, so keep your account active with an agent.';
    await query(`INSERT INTO events (channel, type, remote_event_id, text) VALUES ('mock', 'KEYWORD_MATCH', $1, $2)`, [`seen-${uniqueSuffix()}`, text]);
    const idea = await content.addIdea({ agentId: fixture.agentId, summary: text, score: 60, source: 'deliberation' });
    const mine = await content.addIdea({ agentId: fixture.agentId, summary: 'A conclusion of its own about agents that go quiet overnight.', score: 60, source: 'deliberation' });
    const review = await reviewLearnedState({ agentId: fixture.agentId, selfNames: ['ai17z'], apply: true });
    expect(review.ideas.discard.map((d) => d.id)).toEqual([idea.id]);
    const [kept] = await query<{ status: string }>(`SELECT status FROM content_ideas WHERE id = $1`, [mine.id]);
    expect(kept!.status).toBe('unused');
  });
});

describe('what it may say about itself', () => {
  it('knows true public facts, and never its goals or health', async () => {
    const { publicSelfFacts } = await import('@xbam/runtime');
    const fixture = await createFixture();
    await deliberation.addGoal({ agentId: fixture.agentId, summary: 'Secret owner plan: grow the Pons launch quietly', reason: 'owner', origin: 'OWNER' } as never);
    const facts = (await publicSelfFacts(fixture.agentId)).join(' ');
    expect(facts).toMatch(/You run on AI17Z/);
    expect(facts).toMatch(/not published anything this week/);
    expect(facts).toMatch(/not enough yet/);
    expect(facts).not.toMatch(/Secret owner plan|Pons|goal|health|fail/i);
  });
});
