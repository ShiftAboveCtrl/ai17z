import { describe, expect, it } from 'vitest';
import { accounts as accountsRepo, content, query } from '@xbam/database';
import { originatePost } from '@xbam/runtime';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';

installHarness();

/** Backdates a row, so age-dependent behaviour can be exercised without waiting. */
async function backdate(id: string, days: number): Promise<void> {
  await query(
    `UPDATE content_ideas SET created_at = now() - make_interval(days => $2),
                              updated_at = now() - make_interval(days => $2)
      WHERE id = $1`,
    [id, days],
  );
}

async function statusOf(id: string): Promise<{ status: string; attempts: number; lastError: string; usedAt: string | null }> {
  const rows = await query<{ status: string; attempts: number; last_error: string; used_at: string | null }>(
    'SELECT status, attempts, last_error, used_at FROM content_ideas WHERE id = $1',
    [id],
  );
  const row = rows[0]!;
  return { status: row.status, attempts: row.attempts, lastError: row.last_error, usedAt: row.used_at };
}

/** A job in a chosen terminal state, so the reconciler has something to ask. */
async function jobFor(fixture: Awaited<ReturnType<typeof createFixture>>, status: string, lastError = ''): Promise<string> {
  // The account the fixture linked, so the rows are shaped like real ones
  // rather than relying on the columns being nullable.
  const accounts = await query<{ id: string }>('SELECT account_id AS id FROM agent_accounts WHERE agent_id = $1 LIMIT 1', [
    fixture.agentId,
  ]);
  const accountId = accounts[0]?.id ?? null;
  const events = await query<{ id: string }>(
    `INSERT INTO events (account_id, channel, type, remote_event_id, text, occurred_at)
     VALUES ($1, 'MOCK', 'SCHEDULED_TRIGGER', $2, 'brief', now()) RETURNING id`,
    [accountId, `post-test-${Math.random()}`],
  );
  const jobs = await query<{ id: string }>(
    `INSERT INTO jobs (event_id, agent_id, account_id, channel, action_type, idempotency_key, status, last_error)
     VALUES ($1, $2, $3, 'MOCK', 'POST', $4, $5, $6) RETURNING id`,
    [events[0]!.id, fixture.agentId, accountId, `key-${Math.random()}`, status, lastError],
  );
  return jobs[0]!.id;
}

/**
 * An idea is claimed before a post is drafted, and every way that draft can end
 * without publishing used to leave the idea claimed for ever.
 *
 * `claimBestIdea` set 'drafting' and nothing set anything else: `markIdeaUsed`
 * existed with no callers at all. So a validator refusal, a revoked capability,
 * somebody pressing stop, or a worker dying each silently spent one idea, and
 * an agent whose backlog had drained that way went quiet reporting "nothing in
 * the idea backlog was worth posting" -- which was not true, and gave the owner
 * no way to find out otherwise.
 */
describe('what happens to a claimed idea', () => {
  it('is marked used when the post went out', async () => {
    const fixture = await createFixture();
    const idea = await content.addIdea({ agentId: fixture.agentId, summary: 'Something worth saying out loud.' });
    const claimed = await content.claimBestIdea(fixture.agentId);
    expect(claimed!.id).toBe(idea.id);

    await content.attachJob(fixture.agentId, idea.id, await jobFor(fixture, 'EXECUTED'));
    const result = await content.reconcileDrafting();

    expect(result.used).toBe(1);
    const after = await statusOf(idea.id);
    expect(after.status).toBe('used');
    // Which post came from which thought is the whole point of the record.
    expect(after.usedAt).not.toBeNull();
  });

  it('comes back to the backlog when the post failed, carrying the reason', async () => {
    const fixture = await createFixture();
    const idea = await content.addIdea({ agentId: fixture.agentId, summary: 'A thought that will not publish.' });
    await content.claimBestIdea(fixture.agentId);
    await content.attachJob(fixture.agentId, idea.id, await jobFor(fixture, 'PERMANENT_FAILURE', 'The account lost its posting permission.'));

    expect((await content.reconcileDrafting()).released).toBe(1);
    const after = await statusOf(idea.id);
    expect(after.status).toBe('unused');
    expect(after.attempts).toBe(1);
    expect(after.lastError).toContain('posting permission');
  });

  it('comes back when somebody pressed stop', async () => {
    const fixture = await createFixture();
    const idea = await content.addIdea({ agentId: fixture.agentId, summary: 'A thought somebody stopped.' });
    await content.claimBestIdea(fixture.agentId);
    await content.attachJob(fixture.agentId, idea.id, await jobFor(fixture, 'CANCELLED'));

    await content.reconcileDrafting();
    expect((await statusOf(idea.id)).status).toBe('unused');
  });

  it('costs nothing when the post was only a rehearsal', async () => {
    // A dry run said nothing, so the thing it might have said is still unsaid.
    const fixture = await createFixture();
    const idea = await content.addIdea({ agentId: fixture.agentId, summary: 'A thought that was only rehearsed.' });
    await content.claimBestIdea(fixture.agentId);
    await content.attachJob(fixture.agentId, idea.id, await jobFor(fixture, 'DRY_RUN_COMPLETED'));

    await content.reconcileDrafting();
    const after = await statusOf(idea.id);
    expect(after.status).toBe('unused');
    expect(after.attempts).toBe(0);
  });

  it('comes back when the worker died before it could create a job', async () => {
    // Nothing to ask, so age is the only signal -- and only a crash lands here.
    const fixture = await createFixture();
    const idea = await content.addIdea({ agentId: fixture.agentId, summary: 'A thought a dead worker was holding.' });
    await content.claimBestIdea(fixture.agentId);
    await backdate(idea.id, 1);

    await content.reconcileDrafting();
    expect((await statusOf(idea.id)).status).toBe('unused');
  });

  it('leaves an idea alone while its job is still running', async () => {
    const fixture = await createFixture();
    const idea = await content.addIdea({ agentId: fixture.agentId, summary: 'A thought currently being written.' });
    await content.claimBestIdea(fixture.agentId);
    await content.attachJob(fixture.agentId, idea.id, await jobFor(fixture, 'GENERATING'));

    const result = await content.reconcileDrafting();
    expect(result.released + result.discarded + result.used).toBe(0);
    expect((await statusOf(idea.id)).status).toBe('drafting');
  });

  it('gives up on an idea that keeps failing, rather than blocking the queue behind it', async () => {
    // The scheduler takes the highest score every time, so one permanently
    // unpublishable idea would be picked for ever and nothing else would run.
    const fixture = await createFixture();
    const idea = await content.addIdea({ agentId: fixture.agentId, summary: 'A thought that can never publish.', score: 99 });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const claimed = await content.claimBestIdea(fixture.agentId);
      expect(claimed?.id, `attempt ${attempt + 1} should still reach the idea`).toBe(idea.id);
      await content.attachJob(fixture.agentId, idea.id, await jobFor(fixture, 'PERMANENT_FAILURE', 'Refused again.'));
      await content.reconcileDrafting();
    }

    expect((await statusOf(idea.id)).status).toBe('discarded');
    expect(await content.claimBestIdea(fixture.agentId)).toBeNull();
  });
});

/**
 * An idea comes from something that happened, so it is worth less the further
 * that thing recedes. The old ordering was score DESC, created_at ASC -- oldest
 * first at each score -- so an agent's very first post was the stalest thing it
 * had, and nothing ever expired.
 */
describe('how an idea ages', () => {
  it('prefers the newer of two equally good ideas', async () => {
    const fixture = await createFixture();
    const old = await content.addIdea({ agentId: fixture.agentId, summary: 'The older of two equal thoughts.', score: 60 });
    await backdate(old.id, 3);
    const fresh = await content.addIdea({ agentId: fixture.agentId, summary: 'The newer of two equal thoughts.', score: 60 });

    expect((await content.claimBestIdea(fixture.agentId))!.id).toBe(fresh.id);
  });

  it('lets a fresh idea overtake a better but older one', async () => {
    const fixture = await createFixture();
    const stale = await content.addIdea({ agentId: fixture.agentId, summary: 'A strong thought from a fortnight ago.', score: 90 });
    await backdate(stale.id, 10);
    const fresh = await content.addIdea({ agentId: fixture.agentId, summary: 'An ordinary thought from today.', score: 55 });

    expect((await content.claimBestIdea(fixture.agentId))!.id).toBe(fresh.id);
  });

  it('never decays something the owner typed', async () => {
    // An owner's idea is a decision, not an observation. It waits its turn.
    const fixture = await createFixture();
    const mine = await content.addIdea({ agentId: fixture.agentId, summary: 'The thing I actually want said.', score: 80, source: 'you' });
    await backdate(mine.id, 12);
    await content.addIdea({ agentId: fixture.agentId, summary: 'A harvested thought from today.', score: 70 });

    expect((await content.claimBestIdea(fixture.agentId))!.id).toBe(mine.id);
  });

  it('sets aside a harvested idea nobody used while it was current', async () => {
    const fixture = await createFixture();
    const stale = await content.addIdea({ agentId: fixture.agentId, summary: 'A thought from last month.' });
    await backdate(stale.id, content.IDEA_SHELF_LIFE_DAYS + 1);

    expect((await content.reconcileDrafting()).discarded).toBe(1);
    const after = await statusOf(stale.id);
    expect(after.status).toBe('discarded');
    expect(after.lastError).toContain('current');
  });

  it('never expires an idea the owner typed', async () => {
    const fixture = await createFixture();
    const mine = await content.addIdea({ agentId: fixture.agentId, summary: 'Mine, and still worth saying.', source: 'you' });
    await backdate(mine.id, content.IDEA_SHELF_LIFE_DAYS * 3);

    await content.reconcileDrafting();
    expect((await statusOf(mine.id)).status).toBe('unused');
  });
});

/**
 * One idea nobody can publish must not silence every idea behind it.
 *
 * Measured on a live installation: an owner rejected a post on the 7th, and on
 * the 19th the posting engine was still picking that same idea every six hours
 * and stopping with "A job for this idea already exists". Nothing had been
 * published since the 17th, and a newer idea sat behind it untouched. Read off
 * the runtime, the agent's silence looked like judgement and was a jam.
 *
 * The mechanism: a POST's idempotency key is anchored to the idea and never
 * expires, so once a job exists that branch is permanent for that idea. Putting
 * it straight back made it `unused` again, and the claim takes the highest
 * scoring unused idea every time, so it won for ever. It charged no attempt
 * either, so the reconciler's own guard against an unpublishable idea blocking
 * the queue could never fire: attempts stayed at zero.
 */
describe('an idea whose job already exists does not jam the queue', () => {
  it('lets the next idea through, and honours the rejection durably', async () => {
    const fixture = await createFixture();
    const account = await accountsRepo.createAccount({
      ownerId: fixture.ownerId,
      channel: 'mock',
      handle: `poster_${Date.now().toString(36).slice(-6)}`,
      displayName: 'Poster',
    });
    await accountsRepo.linkAgentAccount({
      agentId: fixture.agentId,
      accountId: account.id,
      triggerEventTypes: ['MENTION'],
      actionType: 'POST',
      enabled: true,
    });
    // The posting engine refuses a draft agent, which is correct and is not
    // what this test is about.
    await query(`UPDATE agents SET state = 'ACTIVE' WHERE id = $1`, [fixture.agentId]);

    // A, scored above B so the claim always prefers it.
    const a = await content.addIdea({ agentId: fixture.agentId, summary: 'The idea an owner turned down.', score: 95 });
    const b = await content.addIdea({ agentId: fixture.agentId, summary: 'The idea waiting behind it.', score: 40 });

    // A is taken, published for real, and the operator rejects it.
    const first = await originatePost({ agentId: fixture.agentId, accountId: account.id });
    expect(first.jobId, `declined: ${first.reason}`).toBeTruthy();
    expect((await statusOf(a.id)).status).not.toBe('unused');
    await query(`UPDATE jobs SET status = 'CANCELLED', last_error = 'Rejected by the operator.' WHERE id = $1`, [
      first.jobId,
    ]);
    await content.reconcileDrafting();

    // Durable: the rejection is recorded against the idea, not thrown away.
    const rejected = await statusOf(a.id);
    expect(rejected.attempts).toBe(1);
    expect(rejected.lastError).toMatch(/Rejected by the operator/);

    /*
      Now the jam. A is `unused` again and still outscores B, so it wins the
      claim, and its job already exists. Three cycles, which is also what it
      takes for the reconciler to set A aside.
    */
    for (let cycle = 0; cycle < 3; cycle += 1) {
      await originatePost({ agentId: fixture.agentId, accountId: account.id });
      await content.reconcileDrafting();
    }

    // B was reachable rather than starved behind A.
    const after = await statusOf(b.id);
    expect(after.status, 'the idea behind it was never even looked at').not.toBe('unused');

    // And A is set aside with its reason kept, never deleted and never retried
    // into a second real post.
    const settled = await statusOf(a.id);
    expect(['discarded', 'used', 'drafting']).toContain(settled.status);
    expect(settled.lastError).toMatch(/Rejected by the operator/);
    const posts = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM jobs WHERE agent_id = $1 AND action_type = 'POST' AND dry_run = false`,
      [fixture.agentId],
    );
    expect(Number(posts[0]!.n), 'one rejected idea must not become several real post jobs').toBeLessThanOrEqual(2);
  });
});
