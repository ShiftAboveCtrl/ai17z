import { describe, expect, it } from 'vitest';
import { jobs as jobsRepo, mentions, query } from '@xbam/database';
import { freshnessWindowFor, ingestNormalizedEvent } from '@xbam/runtime';
import { installHarness, mockEvent } from '../support/harness';
import { createFixture } from '../support/fixtures';

installHarness();

/**
 * The inbox has to answer a question about the whole system, not about the
 * newest forty rows.
 *
 * Found on a live installation. The owner reported that Activity showed no
 * replies at all and a handful of unexplained failures, from an agent that was
 * in fact answering people. `listMentions` ordered by arrival, applied the SQL
 * limit, and *then* filtered by state in JavaScript. That is harmless only
 * while the newest rows are a mixture, and they were not: with the radar
 * watching three broad keywords, the most recent two hundred events were every
 * one of them a keyword match. Asking for REPLIED took the newest forty, found
 * no reply among them, and answered with an empty list. The eighty-five
 * replies that had gone out were further back than the window could reach.
 *
 * Both halves are pinned: the filter happens before the limit, and a keyword
 * flood cannot hide somebody who wrote to the agent.
 */

/** A post the radar found, as opposed to somebody writing to the agent. */
const keyword = (n: number) =>
  mockEvent(`somebody talking about agent memory ${n}`, {
    type: 'KEYWORD_MATCH',
    remoteAuthorHandle: `watcher${n}`,
  });

async function flood(agentId: string, howMany: number) {
  for (let i = 0; i < howMany; i += 1) {
    await ingestNormalizedEvent({ accountId: null, onlyAgentId: agentId, event: keyword(i) });
  }
}

describe('the inbox filters before it limits', () => {
  it('finds a reply that a flood of keyword matches has pushed out of the window', async () => {
    const fixture = await createFixture();

    // One person wrote, and the agent answered them.
    const outcome = await ingestNormalizedEvent({
      accountId: null,
      onlyAgentId: fixture.agentId,
      event: mockEvent('what does this actually do?', { remoteAuthorHandle: 'a_real_person' }),
    });
    const jobId = outcome.jobs[0]!.job.id;
    await query(`UPDATE jobs SET status = 'EXECUTED' WHERE id = $1`, [jobId]);
    expect((await jobsRepo.requireJob(jobId)).status).toBe('EXECUTED');

    // Then the radar finds three hundred posts, as it does.
    await flood(fixture.agentId, 300);

    /*
      The old shape took the newest forty rows and filtered those. All forty
      are keyword matches, so the answer was an empty list and the owner
      concluded the agent had stopped answering people.
    */
    const replied = await mentions.listMentions({ agentId: fixture.agentId, state: 'REPLIED', limit: 40 });
    expect(replied.map((row) => row.authorHandle)).toContain('a_real_person');
  });

  it('counts every state rather than the newest two hundred rows', async () => {
    const fixture = await createFixture();
    const outcome = await ingestNormalizedEvent({
      accountId: null,
      onlyAgentId: fixture.agentId,
      event: mockEvent('anyone home?', { remoteAuthorHandle: 'counted_person' }),
    });
    await query(`UPDATE jobs SET status = 'EXECUTED' WHERE id = $1`, [outcome.jobs[0]!.job.id]);
    await flood(fixture.agentId, 250);

    // The count was taken over `listMentions({ limit: 200 })`, which by now is
    // two hundred keyword matches, so the chip read zero above a list that
    // agreed with it and was wrong about the system.
    const counts = await mentions.countMentionStates({ agentId: fixture.agentId });
    expect(counts.REPLIED).toBeGreaterThanOrEqual(1);
  });

  it('can answer "who wrote to me" without the radar drowning it', async () => {
    const fixture = await createFixture();
    await ingestNormalizedEvent({
      accountId: null,
      onlyAgentId: fixture.agentId,
      event: mockEvent('a question for you', { remoteAuthorHandle: 'direct_person' }),
    });
    await flood(fixture.agentId, 100);

    const direct = await mentions.listMentions({ agentId: fixture.agentId, directOnly: true, limit: 40 });
    expect(direct.map((row) => row.authorHandle)).toContain('direct_person');
    expect(direct.every((row) => row.type !== 'KEYWORD_MATCH')).toBe(true);

    const counts = await mentions.countMentionStates({ agentId: fixture.agentId, directOnly: true });
    const total = Object.values(counts).reduce((n, v) => n + v, 0);
    expect(total, 'the radar is being counted as somebody writing in').toBeLessThan(100);
  });

  it('spells every state the same way in SQL as stateOf does', () => {
    /*
      The CASE in the query and `stateOf` are two spellings of one mapping,
      which is the thing this codebase keeps saying it does not want. Held
      against each other so that adding a job status to one and not the other
      fails a test rather than a screen.
    */
    const cases: [string | null, string][] = [
      [null, 'NOT_ACTIONED'],
      ['EXECUTED', 'REPLIED'],
      ['DRY_RUN_COMPLETED', 'DRY_RUN'],
      ['CANCELLED', 'DECLINED'],
      ['WAITING_FOR_APPROVAL', 'NEEDS_REVIEW'],
      ['REVIEW_REQUIRED', 'NEEDS_REVIEW'],
      ['PERMANENT_FAILURE', 'FAILED'],
      ['RETRYABLE_FAILURE', 'FAILED'],
      ['RECEIVED', 'WORKING'],
      ['GENERATED', 'WORKING'],
    ];
    for (const [status, expected] of cases) {
      expect(mentions.stateOf(status), status ?? 'null').toBe(expected);
    }
  });
});

describe('somebody who wrote to the agent is not dropped for being seen late', () => {
  /*
    Measured on a live installation: sixteen mentions and replies from real
    people were recorded and never considered, every one of them because it was
    first seen between three and a hundred and fifty-one hours after it was
    written. The two-hour rule is right about a post the radar found -- joining
    a stranger's old thread uninvited is late -- and wrong about somebody's
    question, where the lateness is the agent's own discovery, not theirs.
  */
  const hours = (n: number) => n * 60 * 60_000;

  it('gives somebody who wrote to the agent a day, not two hours', () => {
    expect(freshnessWindowFor('MENTION')).toBe(hours(24));
    expect(freshnessWindowFor('REPLY')).toBe(hours(24));
    expect(freshnessWindowFor('DIRECT_MESSAGE')).toBe(hours(24));
  });

  it('leaves an uninvited post the radar found at two hours', () => {
    // Widening the window for a question must not widen it for walking into a
    // stranger's conversation.
    expect(freshnessWindowFor('KEYWORD_MATCH')).toBe(hours(2));
    expect(freshnessWindowFor('SCHEDULED_TRIGGER')).toBe(hours(2));
  });

  it('would have kept every one of the mentions that were dropped', () => {
    // The real ages, from the live installation, of the sixteen that were
    // recorded and never considered. Anything inside a day is now answerable.
    const dropped = [3, 3, 6, 8, 8, 10, 11, 20, 25, 39, 44, 44, 49, 49, 73, 151];
    const rescued = dropped.filter((age) => hours(age) <= freshnessWindowFor('MENTION'));
    expect(rescued.length).toBeGreaterThanOrEqual(8);
    // And a week-old question is still refused, because answering it reads as
    // a machine working through a backlog, which is the fault the rule exists
    // to prevent.
    expect(hours(151) > freshnessWindowFor('MENTION')).toBe(true);
  });
});

describe('coming back from downtime does not answer everybody at once', () => {
  /*
    The fault the two-hour window used to prevent by refusing the work.

    Widening it to a day for direct inbound is right -- the lateness is the
    agent's own discovery latency and not the sender's -- but it hands that
    fault somewhere to reappear. Twelve mentions found after a day offline,
    paced only by `minSecondsBetweenActions`, is twelve replies in six minutes
    to day-old posts, which reads as a machine working through a backlog to
    every person who sees it.

    Measured on the installation this came from: after fifty-two hours off, ten
    direct items arrived in one poll.
  */
  const hoursAgo = (n: number) => new Date(Date.now() - n * 60 * 60_000).toISOString();

  it('spaces a backlog out instead of sending it at the rate limit floor', async () => {
    const fixture = await createFixture();

    const runAts: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const outcome = await ingestNormalizedEvent({
        accountId: null,
        onlyAgentId: fixture.agentId,
        event: mockEvent(`a question from person ${i}`, {
          remoteAuthorHandle: `person${i}`,
          occurredAt: hoursAgo(8),
        }),
      });
      expect(outcome.jobs, 'every one of them is still answered').toHaveLength(1);
      const [row] = await query<{ run_at: string }>('SELECT run_at FROM jobs WHERE id = $1', [
        outcome.jobs[0]!.job.id,
      ]);
      runAts.push(new Date(row!.run_at).getTime());
    }

    // Each one waits behind the ones already queued, so the last is well over
    // an hour out rather than three minutes.
    const spread = Math.max(...runAts) - Math.min(...runAts);
    expect(spread).toBeGreaterThan(45 * 60_000);

    // And none of them was dropped to achieve it. Spacing is not refusing.
    expect(runAts).toHaveLength(6);
  }, 120_000);

  it('does not hold back something that just arrived', async () => {
    // The ordinary case, which is almost every mention: a post minutes old runs
    // now. A delay here would be latency added to the thing being fixed.
    const fixture = await createFixture();
    const outcome = await ingestNormalizedEvent({
      accountId: null,
      onlyAgentId: fixture.agentId,
      event: mockEvent('what does this do?', { remoteAuthorHandle: 'someone_now' }),
    });
    const [row] = await query<{ run_at: string }>('SELECT run_at FROM jobs WHERE id = $1', [
      outcome.jobs[0]!.job.id,
    ]);
    expect(new Date(row!.run_at).getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
  }, 60_000);
});
