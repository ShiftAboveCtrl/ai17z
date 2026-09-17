import { describe, expect, it } from 'vitest';
import { content, query, stances } from '@xbam/database';
import { harvestIdeas, nextPost, releaseIdea } from '@xbam/runtime';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';

installHarness();

/**
 * A post this agent really published, as the rows `recentPosts` reads.
 *
 * Written directly because what is being tested is the repetition guard, not
 * the pipeline that produces a post: going through the pipeline would need a
 * model, and the guard only ever looks at executed POST actions.
 */
async function publishPost(fixture: { agentId: string }, text: string): Promise<void> {
  const suffix = Math.random().toString(16).slice(2, 10);
  const [event] = await query<{ id: string }>(
    `INSERT INTO events (channel, type, remote_event_id, text)
     VALUES ('mock', 'SCHEDULED_TRIGGER', $1, 'a post') RETURNING id`,
    [`ev-${suffix}`],
  );
  const [job] = await query<{ id: string }>(
    `INSERT INTO jobs (event_id, agent_id, channel, action_type, idempotency_key, status)
     VALUES ($1, $2, 'mock', 'POST', $3, 'EXECUTED') RETURNING id`,
    [event!.id, fixture.agentId, `post-${suffix}`],
  );
  await query(
    `INSERT INTO actions (job_id, agent_id, channel, type, status, dry_run, payload, idempotency_key, executed_at)
     VALUES ($1, $2, 'mock', 'POST', 'EXECUTED', false, $3::jsonb, $4, now())`,
    [job!.id, fixture.agentId, JSON.stringify({ text }), `act-${suffix}`],
  );
}

describe('where ideas come from', () => {
  it('captures a question worth answering in public', async () => {
    const fixture = await createFixture();
    const captured = await harvestIdeas({
      agentId: fixture.agentId,
      jobId: null,
      incoming: 'How do you think about the tradeoff between throughput and finality here?',
      outgoing:
        'Finality is what people actually feel. Throughput is a number that only matters once finality is boring.',
      handle: 'alice',
    });

    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0]!.kind).toBe('educational');
    // Provenance is recorded, because an idea with no source is the thing this
    // exists to prevent.
    expect(captured[0]!.source).toBe('conversation');
    expect(captured[0]!.sourceHandle).toBe('alice');
  });

  it('captures a position the agent keeps coming back to', async () => {
    const fixture = await createFixture();
    const position = {
      agentId: fixture.agentId,
      subject: 'Project Q',
      position: 'NEGATIVE' as const,
      summary: 'The distribution schedule is the weak point.',
      confidence: 0.8,
    };
    // Twice, because a position stated once in passing is an answer rather than
    // something worth saying to everybody.
    await stances.assert({ ...position, evidence: { excerpt: 'The schedule is the weak point.' } });
    await stances.assert({ ...position, evidence: { excerpt: 'Still the schedule, still the weak point.' } });

    const captured = await harvestIdeas({
      agentId: fixture.agentId,
      jobId: null,
      incoming: 'what do you make of it',
      outgoing:
        'Project Q has the same problem it had in March. The distribution schedule is still the weak point and nothing announced changes that.',
      handle: 'bob',
    });
    expect(captured.some((idea) => idea.kind === 'opinion')).toBe(true);
  });

  it('does not broadcast a position it has taken once, in passing', async () => {
    // A real backlog's worst entry was "Say more about No DMs", made from a
    // single operational sentence about not having DMs open. Once is an answer.
    const fixture = await createFixture();
    await stances.assert({
      agentId: fixture.agentId,
      subject: 'Project Q',
      position: 'NEGATIVE',
      summary: 'The distribution schedule is the weak point.',
      confidence: 0.8,
      evidence: { excerpt: 'The schedule is the weak point.' },
    });

    const captured = await harvestIdeas({
      agentId: fixture.agentId,
      jobId: null,
      incoming: 'what do you make of it',
      outgoing:
        'Project Q has the same problem it had in March. The distribution schedule is still the weak point and nothing announced changes that.',
      handle: 'bob',
    });
    expect(captured.some((idea) => idea.kind === 'opinion')).toBe(false);
  });

  it('captures nothing from an ordinary exchange', async () => {
    const fixture = await createFixture();
    const captured = await harvestIdeas({
      agentId: fixture.agentId,
      jobId: null,
      incoming: 'thanks',
      outgoing: 'anytime',
      handle: 'carol',
    });
    expect(captured).toHaveLength(0);
  });

  it('does not capture the same thought twice', async () => {
    const fixture = await createFixture();
    const exchange = {
      agentId: fixture.agentId,
      jobId: null,
      incoming: 'How do you think about the tradeoff between throughput and finality here?',
      outgoing: 'Finality is what people actually feel. Throughput only matters once finality is boring.',
      handle: 'alice',
    };
    await harvestIdeas(exchange);
    expect(await harvestIdeas(exchange)).toHaveLength(0);
  });
});

/*
  The failure an owner actually saw.

  ai17zos posted three near-identical things about one feature between 10:51
  and 02:31, each derived from a reply it had written minutes earlier. The
  evidence gate passed every time, because a single conversation about one
  subject produces evidence quickly, and nothing asked whether the account had
  just said this to everybody.
*/
describe('not saying the same thing to everybody twice', () => {
  const holdAndHarvest = async (fixture: { agentId: string }, outgoing: string) => {
    const position = {
      agentId: fixture.agentId,
      subject: 'Telegram',
      position: 'POSITIVE' as const,
      summary: 'Better evidence changes the memory, and the alert is what makes that visible.',
      confidence: 0.9,
    };
    await stances.assert({ ...position, evidence: { excerpt: 'the alert makes it visible' } });
    await stances.assert({ ...position, evidence: { excerpt: 'you see the update happen' } });
    return harvestIdeas({
      agentId: fixture.agentId,
      jobId: null,
      incoming: 'so what does the alert actually do',
      outgoing,
      handle: 'bob',
    });
  };

  it('offers a subject the account has not just posted about', async () => {
    const fixture = await createFixture();
    const captured = await holdAndHarvest(
      fixture,
      'Memory updating silently is how an agent quietly gets worse. The Telegram alert is the part I like, because better evidence changes the record.',
    );
    expect(captured.some((idea) => idea.kind === 'opinion')).toBe(true);
  });

  it('declines a subject the account posted about an hour ago', async () => {
    const fixture = await createFixture();
    await publishPost(fixture, 'The memory should change when the evidence changes. The Telegram alert is what makes that visible.');

    const captured = await holdAndHarvest(
      fixture,
      'Memory updating silently is how an agent quietly gets worse. The Telegram alert is the part I like, because better evidence changes the record.',
    );
    expect(captured.some((idea) => idea.kind === 'opinion')).toBe(false);
  });
});

describe('posting from the backlog', () => {
  it('says nothing at all when there is nothing to say', async () => {
    const fixture = await createFixture();
    // An agent with an empty backlog posting nothing is the correct outcome,
    // not a gap to be filled by inventing something.
    expect(await nextPost(fixture.agentId)).toBeNull();
  });

  it('picks the most promising idea and claims it', async () => {
    const fixture = await createFixture();
    await content.addIdea({ agentId: fixture.agentId, summary: 'a lesser thought about things', score: 30 });
    await content.addIdea({ agentId: fixture.agentId, summary: 'the better thought about things', score: 90 });

    const post = await nextPost(fixture.agentId);
    expect(post!.idea.summary).toBe('the better thought about things');
    expect(post!.brief).toContain('the better thought about things');
    // Claimed, so a second scheduled post cannot pick up the same thought.
    expect((await nextPost(fixture.agentId))?.idea.summary).toBe('a lesser thought about things');
  });

  it('tells the writer not to address the person it came from', async () => {
    const fixture = await createFixture();
    await content.addIdea({
      agentId: fixture.agentId,
      summary: 'something that came out of talking to somebody',
      source: 'conversation',
      sourceHandle: 'alice',
    });
    const post = await nextPost(fixture.agentId);
    expect(post!.brief).toMatch(/standalone post, not as a reply/i);
    expect(post!.brief).toMatch(/do not name them/i);
  });

  it('puts an idea back when the post did not happen', async () => {
    const fixture = await createFixture();
    await content.addIdea({ agentId: fixture.agentId, summary: 'a thought worth having later' });
    const post = await nextPost(fixture.agentId);
    await releaseIdea(post!.idea.agentId, post!.idea.id);
    expect((await nextPost(fixture.agentId))?.idea.id).toBe(post!.idea.id);
  });
});
