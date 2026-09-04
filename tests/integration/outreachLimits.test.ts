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
