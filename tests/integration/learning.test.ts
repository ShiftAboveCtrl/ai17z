import { describe, expect, it } from 'vitest';
import { learning as learningRepo, query, autonomy as autonomyRepo } from '@xbam/database';
import {
  TRIAL_APPLIED,
  TRIAL_CONTROL,
  activePreferences,
  describeLearning,
  heldByOwner,
  learnFromOutcomes,
  resetLearning,
} from '@xbam/runtime';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { uniqueSuffix } from '../support/db';

installHarness();

/**
 * The whole loop, against a real database: what an agent published is
 * measured, credited to the choices behind it, turned into a trial, and the
 * trial kept or undone on what happened next.
 */

async function publish(
  agentId: string,
  input: { text: string; eventPayload?: Record<string, unknown>; learningMeta?: Record<string, unknown>; hoursAgo: number; views: number; likes: number },
) {
  const id = uniqueSuffix();
  const [event] = await query<{ id: string }>(
    `INSERT INTO events (channel, account_id, type, remote_event_id, remote_author_handle, text, payload)
     VALUES ('mock', NULL, 'KEYWORD_MATCH', $1, 'someone', 'a post', $2::jsonb) RETURNING id`,
    [`evt-${id}`, JSON.stringify(input.eventPayload ?? {})],
  );
  const [job] = await query<{ id: string }>(
    `INSERT INTO jobs (event_id, agent_id, channel, action_type, idempotency_key, status, resolved_context)
     VALUES ($1, $2, 'mock', 'REPLY', $3, 'EXECUTED', $4::jsonb) RETURNING id`,
    [
      event!.id,
      agentId,
      `job-${id}`,
      JSON.stringify({ targetRef: 'mock:1', conversationRef: 'mock:1', incomingText: 'a post', thread: [], meta: input.learningMeta ? { learning: input.learningMeta } : {} }),
    ],
  );
  const executedAt = new Date(Date.now() - input.hoursAgo * 3_600_000);
  const [action] = await query<{ id: string }>(
    `INSERT INTO actions (job_id, agent_id, channel, type, status, idempotency_key, remote_action_id, payload, executed_at)
     VALUES ($1, $2, 'mock', 'REPLY', 'EXECUTED', $3, $4, $5::jsonb, $6) RETURNING id`,
    [job!.id, agentId, `act-${id}`, `post-${id}`, JSON.stringify({ text: input.text }), executedAt.toISOString()],
  );
  await query(
    `INSERT INTO post_analytics (agent_id, channel, remote_post_id, action_id, observed_at, views, likes, reposts, replies)
     VALUES ($1, 'mock', $2, $3, $4, $5, $6, 0, 0)`,
    [agentId, `post-${id}`, action!.id, new Date(executedAt.getTime() + 7 * 3_600_000).toISOString(), input.views, input.likes],
  );
}

describe('learning from what happened', () => {
  it('measures only what has had time to be seen, once', async () => {
    const { agentId } = await createFixture();
    await publish(agentId, { text: 'old enough', hoursAgo: 10, views: 100, likes: 3 });
    await publish(agentId, { text: 'too new', hoursAgo: 1, views: 100, likes: 3 });
    expect((await learnFromOutcomes(agentId)).measured).toBe(1);
    expect((await learnFromOutcomes(agentId)).measured).toBe(0);
  });

  it('starts a trial when one option clearly does better, and keeps it when the control does worse', async () => {
    const { agentId } = await createFixture();
    // Short replies travel; long ones do not.
    for (let i = 0; i < 10; i += 1) {
      await publish(agentId, { text: 'short and sharp', hoursAgo: 20, views: 2000, likes: 40 });
      await publish(agentId, { text: 'x'.repeat(200), hoursAgo: 20, views: 20, likes: 0 });
    }
    const first = await learnFromOutcomes(agentId);
    expect(first.started.map((t) => `${t.dimension}:${t.arm}`)).toContain('length:SHORT');
    expect((await activePreferences(agentId)).length).toEqual({ arm: 'SHORT', status: 'RUNNING' });

    // The trial runs: short replies under the change, long ones as the control.
    for (let i = 0; i < TRIAL_APPLIED; i += 1) {
      await publish(agentId, { text: 'short again', hoursAgo: 8, views: 3000, likes: 50, learningMeta: { variants: { length: 'learned' } } });
    }
    for (let i = 0; i < TRIAL_CONTROL; i += 1) {
      await publish(agentId, { text: 'y'.repeat(200), hoursAgo: 8, views: 10, likes: 0, learningMeta: { variants: { length: 'control' } } });
    }
    const second = await learnFromOutcomes(agentId);
    expect(second.decided).toEqual([expect.objectContaining({ dimension: 'length', arm: 'SHORT', kept: true })]);
    expect((await activePreferences(agentId)).length).toEqual({ arm: 'SHORT', status: 'KEPT' });

    // Being right raises how far it trusts its own changes on this choice.
    const [trust] = (await learningRepo.dimensions(agentId)).filter((d) => d.dimension === 'length');
    expect(trust!.confidence).toBeGreaterThan(1);
    expect(trust!.kept).toBe(1);
  });

  it('undoes a change the control beat, and trusts itself less on that choice', async () => {
    const { agentId } = await createFixture();
    await learningRepo.startTrial({ agentId, dimension: 'question', arm: 'ASKS', hypothesis: 'test' });
    for (let i = 0; i < TRIAL_APPLIED; i += 1) {
      await publish(agentId, { text: 'what do you think?', hoursAgo: 8, views: 5, likes: 0, learningMeta: { variants: { question: 'learned' } } });
    }
    for (let i = 0; i < TRIAL_CONTROL; i += 1) {
      await publish(agentId, { text: 'this is the point.', hoursAgo: 8, views: 5000, likes: 80, learningMeta: { variants: { question: 'control' } } });
    }
    const pass = await learnFromOutcomes(agentId);
    expect(pass.decided).toEqual([expect.objectContaining({ dimension: 'question', kept: false })]);
    expect((await activePreferences(agentId)).question).toBeUndefined();
    const [trust] = (await learningRepo.dimensions(agentId)).filter((d) => d.dimension === 'question');
    expect(trust!.confidence).toBeLessThan(1);
  });

  it('shows the owner what it learned, and forgets it on request', async () => {
    const { agentId } = await createFixture();
    for (let i = 0; i < 3; i += 1) await publish(agentId, { text: 'short', hoursAgo: 10, views: 100, likes: 1 });
    await learnFromOutcomes(agentId);
    const view = await describeLearning(agentId);
    expect(view.outcomes).toBe(3);
    expect(view.choices.find((c) => c.dimension === 'length')!.options[0]).toMatchObject({ arm: 'SHORT', evidence: 3 });

    await resetLearning(agentId);
    expect((await describeLearning(agentId)).outcomes).toBe(0);
  });
});

describe('what the owner already said', () => {
  it('holds back an approach to somebody the owner turned down an approach to this week', async () => {
    const { agentId } = await createFixture();
    await autonomyRepo.recordOwnerDecision({ agentId, fingerprint: 'keyword_match:reply:pushy', family: 'keyword_match:reply', accepted: false });
    expect(await heldByOwner({ agentId, eventType: 'KEYWORD_MATCH', actionType: 'REPLY', handle: 'pushy' })).toMatch(/You turned down/);
    expect(await heldByOwner({ agentId, eventType: 'KEYWORD_MATCH', actionType: 'REPLY', handle: 'somebody_else' })).toBeNull();
  });
});
