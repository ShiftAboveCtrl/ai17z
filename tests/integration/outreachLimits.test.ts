import { describe, expect, it } from 'vitest';
import { actions as actionsRepo, query } from '@xbam/database';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';

installHarness();

/** An action of a chosen kind, as if the pipeline had produced it. */
async function published(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  options: { eventType: string; handle: string; dryRun?: boolean; status?: string; agoHours?: number },
): Promise<void> {
  const unique = `${Date.now()}${Math.random()}`;
  const accounts = await query<{ id: string }>('SELECT account_id AS id FROM agent_accounts WHERE agent_id = $1 LIMIT 1', [
    fixture.agentId,
  ]);
  const accountId = accounts[0]?.id ?? null;
  const events = await query<{ id: string }>(
    `INSERT INTO events (account_id, channel, type, remote_event_id, remote_author_handle, text, occurred_at)
     VALUES ($1, 'MOCK', $2, $3, $4, 'a post found by watching', now()) RETURNING id`,
    [accountId, options.eventType, `outreach-${unique}`, options.handle],
  );
  const jobs = await query<{ id: string }>(
    `INSERT INTO jobs (event_id, agent_id, account_id, channel, action_type, idempotency_key, status)
     VALUES ($1, $2, $3, 'MOCK', 'REPLY', $4, 'EXECUTED') RETURNING id`,
    [events[0]!.id, fixture.agentId, accountId, `job-${unique}`],
  );
  await query(
    `INSERT INTO actions (job_id, agent_id, account_id, channel, type, status, dry_run, idempotency_key, executed_at)
     VALUES ($1, $2, $3, 'MOCK', 'REPLY', $4, $5, $6, now() - make_interval(hours => $7))`,
    [
      jobs[0]!.id,
      fixture.agentId,
      accountId,
      options.status ?? 'EXECUTED',
      options.dryRun ?? false,
      `action-${unique}`,
      options.agoHours ?? 0,
    ],
  );
}

/**
 * Both outreach limits are counted from what was actually published.
 *
 * The same rule as stances and relationships, and for the same reason: a dry
 * run said nothing to anybody, and a draft nobody sent approached nobody. A cap
 * spent on rehearsals is a cap that silences an agent for something it never
 * did.
 */
describe('counting unprompted approaches', () => {
  it('counts an approach that went out', async () => {
    const fixture = await createFixture();
    await published(fixture, { eventType: 'KEYWORD_MATCH', handle: 'stranger' });
    expect(await actionsRepo.approachesSince(fixture.agentId, new Date(Date.now() - 86_400_000).toISOString())).toBe(1);
  });

  it('does not count a rehearsal', async () => {
    const fixture = await createFixture();
    await published(fixture, { eventType: 'KEYWORD_MATCH', handle: 'stranger', dryRun: true });
    expect(await actionsRepo.approachesSince(fixture.agentId, new Date(Date.now() - 86_400_000).toISOString())).toBe(0);
  });

  it('does not count an answer to somebody who asked', async () => {
    // A reply to a mention is not an approach, and must not spend the cap.
    const fixture = await createFixture();
    await published(fixture, { eventType: 'MENTION', handle: 'asker' });
    await published(fixture, { eventType: 'REPLY', handle: 'asker' });
    expect(await actionsRepo.approachesSince(fixture.agentId, new Date(Date.now() - 86_400_000).toISOString())).toBe(0);
  });

  it('does not count one from yesterday against today', async () => {
    const fixture = await createFixture();
    await published(fixture, { eventType: 'KEYWORD_MATCH', handle: 'stranger', agoHours: 30 });
    expect(await actionsRepo.approachesSince(fixture.agentId, new Date(Date.now() - 86_400_000).toISOString())).toBe(0);
  });

  it('remembers when it last approached one person', async () => {
    const fixture = await createFixture();
    await published(fixture, { eventType: 'KEYWORD_MATCH', handle: 'Stranger', agoHours: 20 });
    // The handle is matched however it was capitalised.
    const last = await actionsRepo.lastApproachTo(fixture.agentId, '@stranger');
    expect(last).toBeTruthy();
    expect(await actionsRepo.lastApproachTo(fixture.agentId, 'somebody_else')).toBeNull();
  });

  it('does not treat a rehearsal as having approached somebody', async () => {
    const fixture = await createFixture();
    await published(fixture, { eventType: 'KEYWORD_MATCH', handle: 'stranger', dryRun: true });
    expect(await actionsRepo.lastApproachTo(fixture.agentId, 'stranger')).toBeNull();
  });
});

/**
 * A proposal the owner has not answered is an approach in waiting.
 *
 * `approachesSince` counts what was published, which is right for "how many
 * approaches has it made today" and wrong for "should it write another one".
 * An agent set to show approaches before sending them publishes nothing, so
 * that count stays at zero and nothing holds the queue back at all.
 *
 * Measured on a live installation: one hundred and five decisions waiting, all
 * of them proposed approaches, growing by roughly seventeen an hour, for an
 * agent whose policy permits five approaches a day.
 */
describe('proposals waiting on the owner are back pressure', () => {
  /** A proposal written and held for a decision, as the REVIEW path leaves it. */
  async function proposed(
    fixture: Awaited<ReturnType<typeof createFixture>>,
    eventType = 'KEYWORD_MATCH',
    status = 'REVIEW_REQUIRED',
  ): Promise<void> {
    const unique = `${Date.now()}${Math.random()}`;
    const events = await query<{ id: string }>(
      `INSERT INTO events (account_id, channel, type, remote_event_id, remote_author_handle, text, occurred_at)
       VALUES (NULL, 'MOCK', $1, $2, 'a_stranger', 'a post found by watching', now()) RETURNING id`,
      [eventType, `pending-${unique}`],
    );
    await query(
      `INSERT INTO jobs (event_id, agent_id, account_id, channel, action_type, idempotency_key, status)
       VALUES ($1, $2, NULL, 'MOCK', 'REPLY', $3, $4)`,
      [events[0]!.id, fixture.agentId, `pjob-${unique}`, status],
    );
  }

  it('counts an unanswered approach even though nothing was published', async () => {
    const fixture = await createFixture();
    expect(await actionsRepo.pendingApproaches(fixture.agentId)).toBe(0);

    for (let i = 0; i < 4; i += 1) await proposed(fixture);
    expect(await actionsRepo.pendingApproaches(fixture.agentId)).toBe(4);

    // And nothing was published, which is exactly why the other count is blind
    // to all of it.
    const since = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
    expect(await actionsRepo.approachesSince(fixture.agentId, since)).toBe(0);
  });

  it('does not count a mention somebody sent, which is not an approach', async () => {
    // Back pressure on approaching strangers must never be applied to somebody
    // who wrote in and is waiting for an answer.
    const fixture = await createFixture();
    await proposed(fixture, 'MENTION');
    await proposed(fixture, 'REPLY');
    expect(await actionsRepo.pendingApproaches(fixture.agentId)).toBe(0);
  });

  it('stops counting one the owner has answered', async () => {
    // Answering makes room immediately: that is what makes this back pressure
    // rather than a ceiling on how many an agent may ever propose.
    const fixture = await createFixture();
    await proposed(fixture);
    expect(await actionsRepo.pendingApproaches(fixture.agentId)).toBe(1);

    await query(`UPDATE jobs SET status = 'CANCELLED' WHERE agent_id = $1`, [fixture.agentId]);
    expect(await actionsRepo.pendingApproaches(fixture.agentId)).toBe(0);
  });

  it('ignores a rehearsal, which settles nothing and publishes nothing', async () => {
    const fixture = await createFixture();
    const unique = `${Date.now()}${Math.random()}`;
    const events = await query<{ id: string }>(
      `INSERT INTO events (account_id, channel, type, remote_event_id, remote_author_handle, text, occurred_at, payload)
       VALUES (NULL, 'MOCK', 'KEYWORD_MATCH', $1, 'a_stranger', 'rehearsed', now(), '{"rehearsal":true}'::jsonb)
       RETURNING id`,
      [`rehearse-${unique}`],
    );
    await query(
      `INSERT INTO jobs (event_id, agent_id, account_id, channel, action_type, idempotency_key, status)
       VALUES ($1, $2, NULL, 'MOCK', 'REPLY', $3, 'REVIEW_REQUIRED')`,
      [events[0]!.id, fixture.agentId, `rjob-${unique}`],
    );
    expect(await actionsRepo.pendingApproaches(fixture.agentId)).toBe(0);
  });
});
