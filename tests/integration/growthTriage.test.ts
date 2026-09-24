import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY } from '@xbam/shared/contracts';
import { accounts as accountsRepo, jobs as jobsRepo, query } from '@xbam/database';
import { cannotPossiblyEngage, ingestNormalizedEvent } from '@xbam/runtime';
import { installHarness, mockEvent } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { uniqueSuffix } from '../support/db';

installHarness();

/**
 * Watching a lot and speaking rarely is the shape this is supposed to have,
 * and it was not the shape it had.
 *
 * Measured on a live installation over seventy-two hours: 2,058 keyword
 * matches produced 1,946 jobs, 1,855 of which were cancelled, and **not one**
 * of the 1,946 published anything. Each of those jobs walked a status page,
 * sent every picture on it to a vision model, assembled a relationship and ran
 * a pipeline, in order to reach a conclusion that the deterministic heuristic
 * at the end could have reached from the text alone. The vision model was
 * called 566 times in that window, for roughly 976,000 tokens.
 *
 * The decision has not changed and must not: `cannotPossiblyEngage` asks
 * `decideEngagement`, the same function the pipeline asks, with every unknown
 * set to whatever would most favour engaging. So it can only decline things
 * the full run would also have declined.
 */

/** An agent that will approach people, but only about what it follows. */
const outreaching = {
  policy: {
    outreach: { ...DEFAULT_POLICY.outreach, enabled: true, mode: 'AUTONOMOUS' as const },
    engagement: { ...DEFAULT_POLICY.engagement, strategy: 'SELECTIVE' as const },
  },
  persona: { topics: ['agent memory', 'browser automation'] },
};

const found = (text: string, n: number) =>
  mockEvent(text, { type: 'KEYWORD_MATCH', remoteAuthorHandle: `stranger${n}` });

/** An agent wired to an account, which is what the radar delivers into. */
async function watching(overrides: Parameters<typeof createFixture>[0]) {
  const fixture = await createFixture(overrides);
  const account = await accountsRepo.createAccount({
    ownerId: fixture.ownerId,
    channel: 'mock',
    handle: `watcher_${uniqueSuffix()}`,
  });
  await accountsRepo.updateAccount(account.id, { status: 'CONNECTED', enabled: true });
  await accountsRepo.linkAgentAccount({
    agentId: fixture.agentId,
    accountId: account.id,
    triggerEventTypes: ['MENTION', 'REPLY'],
    actionType: 'REPLY',
  });
  return { ...fixture, accountId: account.id };
}

describe('a keyword the agent watches does not become a job it has to run', () => {
  it('records two hundred observations without creating two hundred jobs', async () => {
    const fixture = await watching(outreaching);

    for (let i = 0; i < 200; i += 1) {
      await ingestNormalizedEvent({
        accountId: fixture.accountId,
        event: found(`gm everyone, wild day in the markets today number ${i}`, i),
      });
    }

    const [row] = await query<{ events: string; jobs: string }>(
      `SELECT (SELECT count(*) FROM events WHERE type = 'KEYWORD_MATCH')::text AS events,
              (SELECT count(*) FROM jobs j JOIN events e ON e.id = j.event_id
                WHERE e.type = 'KEYWORD_MATCH' AND j.agent_id = $1)::text AS jobs`,
      [fixture.agentId],
    );

    // Everything seen is still on record. That half is not negotiable: the
    // inbox, the narrative reader and the attention set all read these rows.
    expect(Number(row!.events)).toBe(200);
    // And almost none of it costs a pipeline run.
    expect(Number(row!.jobs)).toBeLessThan(20);
  }, 120_000);

  it('still runs the one that is worth running', async () => {
    const fixture = await watching(outreaching);

    // On topic, a real question, and long enough to be a substantial message:
    // this is what the funnel exists to let through.
    const outcome = await ingestNormalizedEvent({
      accountId: fixture.accountId,
      event: found(
        'Has anyone solved agent memory properly? I keep losing context between sessions and every browser automation ' +
          'framework I have tried forgets everything the moment the process restarts. What actually works here?',
        999,
      ),
    });

    expect(outcome.skipped, JSON.stringify(outcome.skipped)).toHaveLength(0);
    expect(outcome.jobs).toHaveLength(1);
    expect((await jobsRepo.requireJob(outcome.jobs[0]!.job.id)).agentId).toBe(fixture.agentId);
  }, 60_000);

  it('never declines something addressed to the agent', async () => {
    const fixture = await watching(outreaching);

    // Somebody asked. Whatever it scores, it gets the whole pipeline: the
    // triage is about the agent speaking first, and this is not that.
    const outcome = await ingestNormalizedEvent({
      accountId: null,
      onlyAgentId: fixture.agentId,
      event: mockEvent('gm', { remoteAuthorHandle: 'a_real_person' }),
    });
    expect(outcome.jobs).toHaveLength(1);
  }, 60_000);

  it('does not treat a thread it is already in as an approach to a stranger', async () => {
    const fixture = await watching(outreaching);

    /*
      The one way this could refuse something the full run would have taken.

      `stepEngagement` holds a conversation the agent is already part of to the
      ordinary reply threshold, not to the much higher outreach one. A keyword
      match landing in such a thread is not an approach, and declining it on
      the outreach bar would break the property the whole design rests on.
    */
    const thread = `thread-${Date.now()}`;
    const weak = () =>
      mockEvent('gm', {
        type: 'KEYWORD_MATCH',
        remoteAuthorHandle: 'someone_we_know',
        remoteConversationId: thread,
      });

    // Nobody has spoken here yet, so it is an approach and it is declined.
    expect((await ingestNormalizedEvent({ accountId: fixture.accountId, event: weak() })).jobs).toHaveLength(0);

    // The agent answers in that thread.
    await query(
      `INSERT INTO messages (conversation_id, direction, body, author_handle)
       SELECT id, 'OUTBOUND', 'we did talk about this', 'agent'
         FROM conversations WHERE remote_conversation_id = $1 LIMIT 1`,
      [thread],
    );

    // The same weak message now gets the full pipeline, because this is a
    // conversation rather than an approach.
    const after = await ingestNormalizedEvent({ accountId: fixture.accountId, event: weak() });
    expect(after.skipped, JSON.stringify(after.skipped)).toHaveLength(0);
    expect(after.jobs).toHaveLength(1);
  }, 60_000);

  it('says why, on the event, rather than dropping it silently', async () => {
    const fixture = await watching(outreaching);

    const outcome = await ingestNormalizedEvent({
      accountId: fixture.accountId,
      event: found('gm', 1),
    });

    expect(outcome.jobs).toHaveLength(0);
    expect(outcome.skipped).toHaveLength(1);
    expect(outcome.skipped[0]!.agentId).toBe(fixture.agentId);
    // A sentence a person can read, not a code. "Why did it not answer that"
    // is a fair question and the answer has to survive to the screen.
    expect(outcome.skipped[0]!.reason.length).toBeGreaterThan(20);

    // And the observation itself is kept, because the radar's other readers
    // work from these rows.
    const [row] = await query<{ n: string }>('SELECT count(*)::text AS n FROM events WHERE id = $1', [
      outcome.eventId,
    ]);
    expect(Number(row!.n)).toBe(1);
  }, 60_000);
});

describe('the bound can only decline what the real run would decline', () => {
  const base = {
    topics: ['agent memory'],
    outreach: { ...DEFAULT_POLICY.outreach, enabled: true, mode: 'AUTONOMOUS' as const },
    policy: DEFAULT_POLICY.engagement,
    relationship: null,
    recentRepliesToPerson: 0,
  };

  it('declines an agent that does not approach people at all', () => {
    expect(
      cannotPossiblyEngage({
        ...base,
        text: 'a long and interesting post about agent memory and how it should work',
        directlyAddressed: false,
        outreach: { ...base.outreach, enabled: false },
      }),
    ).toMatch(/does not approach people unprompted/i);
  });

  it('declines something that is not about anything the agent follows', () => {
    expect(
      cannotPossiblyEngage({ ...base, text: 'the match last night was incredible', directlyAddressed: false }),
    ).toBeTruthy();
  });

  it('lets a genuinely strong candidate through rather than deciding for the pipeline', () => {
    expect(
      cannotPossiblyEngage({
        ...base,
        text:
          'Genuine question about agent memory: how do you keep a working set from turning into a queue of ' +
          'everything the thing has ever seen? Every approach I have tried degrades into a log.',
        directlyAddressed: false,
      }),
    ).toBeNull();
  });

  it('is not made harsher by the thread it has not seen yet', () => {
    /*
      The property the whole design rests on. Every unknown is set to the value
      most favourable to engaging, so a candidate that survives here may still
      be declined later with the real context, and one declined here could
      never have survived it.
    */
    const text =
      'Genuine question about agent memory: how do you keep a working set from turning into a queue of ' +
      'everything the thing has ever seen? Every approach I have tried degrades into a log.';
    expect(cannotPossiblyEngage({ ...base, text, directlyAddressed: false })).toBeNull();
    // The same message from somebody already answered six times this hour is a
    // different matter, and that *is* known at ingest.
    expect(
      cannotPossiblyEngage({ ...base, text, directlyAddressed: false, recentRepliesToPerson: 9 }),
    ).toBeTruthy();
  });
});

describe('a budget that is checked but never runs is not a budget', () => {
  /*
    Found on a live installation twenty minutes after the release that was
    meant to introduce this: 219 unanswered proposals against a limit of five,
    and jobs still being created for more.

    `outreachHeadroom` uses the pooled query. `withTransaction` refuses a
    pooled query taken inside it, precisely because such a query cannot see the
    transaction's own writes and can deadlock the pool. The call site caught
    what it threw and carried on, so the daily budget and the back pressure
    were both dead code that always answered "no reason to stop".

    The guard was written, the comment was right, and nothing was running. So
    this test drives ingest rather than `outreachHeadroom`, because the
    function was never the part that was broken.
  */
  it('stops creating approaches once the owner has a pile of unanswered ones', async () => {
    const fixture = await watching({
      policy: {
        outreach: { ...DEFAULT_POLICY.outreach, enabled: true, mode: 'REVIEW' as const, maxPerDay: 2 },
        engagement: { ...DEFAULT_POLICY.engagement, strategy: 'SELECTIVE' as const },
      },
      persona: { topics: ['agent memory', 'browser automation'] },
    });

    const worthIt = (n: number) =>
      found(
        'Genuine question about agent memory: how do you keep a working set from turning into a queue of ' +
          `everything the thing has ever seen? Everything I try degrades into a log. Attempt ${n}.`,
        n,
      );

    // Two get through, which is the allowance.
    for (let i = 0; i < 2; i += 1) {
      const outcome = await ingestNormalizedEvent({ accountId: fixture.accountId, event: worthIt(i) });
      expect(outcome.jobs, `approach ${i}`).toHaveLength(1);
      await query(`UPDATE jobs SET status = 'REVIEW_REQUIRED' WHERE id = $1`, [outcome.jobs[0]!.job.id]);
    }

    // The third is refused, and says why in a sentence the owner can act on.
    const blocked = await ingestNormalizedEvent({ accountId: fixture.accountId, event: worthIt(99) });
    expect(blocked.jobs, 'the pile is the back pressure').toHaveLength(0);
    expect(blocked.skipped[0]!.reason).toMatch(/waiting for you to decide/i);
    expect(blocked.skipped[0]!.reason).toMatch(/Answering some of those makes room/i);
  }, 120_000);

  it('never counts somebody who wrote in against the approach allowance', async () => {
    // A mention waiting on a judgement is not an approach, and charging it
    // against the outreach budget would let a full inbox silence the agent.
    const fixture = await watching({
      policy: { outreach: { ...DEFAULT_POLICY.outreach, enabled: true, mode: 'REVIEW' as const, maxPerDay: 1 } },
      persona: { topics: ['agent memory'] },
    });

    const mention = await ingestNormalizedEvent({
      accountId: fixture.accountId,
      onlyAgentId: fixture.agentId,
      event: mockEvent('what do you make of this?', { remoteAuthorHandle: 'a_real_person' }),
    });
    expect(mention.jobs).toHaveLength(1);
    await query(`UPDATE jobs SET status = 'REVIEW_REQUIRED' WHERE id = $1`, [mention.jobs[0]!.job.id]);

    // One mention held for review, and the approach allowance is untouched.
    const approach = await ingestNormalizedEvent({
      accountId: fixture.accountId,
      event: found(
        'Genuine question about agent memory: how do you stop a working set becoming a queue of everything it saw?',
        7,
      ),
    });
    expect(approach.jobs, 'an inbox must not silence outreach').toHaveLength(1);
  }, 120_000);
});
