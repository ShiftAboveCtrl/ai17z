import { describe, expect, it } from 'vitest';
import { content, stances } from '@xbam/database';
import { harvestIdeas, nextPost, releaseIdea } from '@xbam/runtime';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';

installHarness();

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

  it('captures a position worth stating on its own', async () => {
    const fixture = await createFixture();
    await stances.assert({
      agentId: fixture.agentId,
      subject: 'Project Q',
      position: 'NEGATIVE',
      summary: 'The distribution schedule is the weak point.',
      confidence: 0.8,
    });

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
