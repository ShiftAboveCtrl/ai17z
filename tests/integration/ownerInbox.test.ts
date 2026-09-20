import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agents as agentsRepo, inbox as inboxRepo, jobs as jobsRepo, query } from '@xbam/database';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { uniqueSuffix } from '../support/db';

installHarness();

/**
 * The badge and the list have to mean the same thing.
 *
 * The defect these exist for, measured on a live installation: "4 messages are
 * waiting for you to decide" beside an **empty inbox**, for over a week, with
 * no way to dismiss it.
 *
 * The count was never wrong. It counts jobs held for a person. The list was
 * incomplete: it was driven by inbound events of four conversational types, and
 * all four waiting jobs were work the agent had started *itself*: an original
 * post and three follow-ups, which arrive on a SCHEDULED_TRIGGER event. Counted
 * by one and shown by neither.
 *
 * Something waiting on a decision has to be reachable, or the decision cannot
 * be made. So the list was completed rather than the count shrunk.
 */

/** A job held for a person, on an event of whatever kind. */
async function heldJob(input: {
  ownerId: string;
  agentId: string;
  eventType: string;
  actionType: string;
  /** A Response Lab rehearsal, which publishes nothing and settles nothing. */
  rehearsal?: boolean;
}) {
  const persona = await agentsRepo.getActivePersona(input.agentId);
  const policy = await agentsRepo.getActivePolicy(input.agentId);
  const suffix = uniqueSuffix();

  const [event] = await query<{ id: string }>(
    `INSERT INTO events (channel, remote_event_id, type, remote_author_handle, text, occurred_at, payload)
     VALUES ('mock', $1, $2, 'someone', 'something worth deciding about', now(), $3::jsonb) RETURNING id`,
    [`inbox-${suffix}`, input.eventType, JSON.stringify(input.rehearsal ? { rehearsal: true } : {})],
  );
  const [job] = await query<{ id: string }>(
    `INSERT INTO jobs (event_id, agent_id, channel, action_type, idempotency_key, dry_run,
       max_attempts, priority, persona_version_id, policy_version_id, status,
       generated_output, validated_output)
     VALUES ($1, $2, 'mock', $3, $4, true, 5, 100, $5, $6, 'REVIEW_REQUIRED', $7, $7)
     RETURNING id`,
    [event!.id, input.agentId, input.actionType, `inbox:${suffix}`, persona!.id, policy!.id, 'a draft'],
  );
  return job!.id;
}

/** The ordinary row: something that arrived and was dealt with. */
async function settledJob(input: { agentId: string; eventType: string; actionType: string }) {
  const persona = await agentsRepo.getActivePersona(input.agentId);
  const policy = await agentsRepo.getActivePolicy(input.agentId);
  const suffix = uniqueSuffix();

  const [event] = await query<{ id: string }>(
    `INSERT INTO events (channel, remote_event_id, type, remote_author_handle, text, occurred_at)
     VALUES ('mock', $1, $2, 'stranger', 'a post mentioning something', now()) RETURNING id`,
    [`noise-${suffix}`, input.eventType],
  );
  const [job] = await query<{ id: string }>(
    `INSERT INTO jobs (event_id, agent_id, channel, action_type, idempotency_key, dry_run,
       max_attempts, priority, persona_version_id, policy_version_id, status)
     VALUES ($1, $2, 'mock', $3, $4, true, 5, 100, $5, $6, 'CANCELLED')
     RETURNING id`,
    [event!.id, input.agentId, input.actionType, `noise:${suffix}`, persona!.id, policy!.id],
  );
  return job!.id;
}

/**
 * Something the radar saw that produced no work at all.
 *
 * The commonest row in a real inbox, and the one with no job on it. Ownership
 * reaches it through the account rather than through an agent, because there is
 * no job in between.
 */
async function unqueuedEvent(input: { accountId: string }) {
  const suffix = uniqueSuffix();
  await query(
    `INSERT INTO events (channel, account_id, remote_event_id, type, remote_author_handle, text, occurred_at)
     VALUES ('mock', $1, $2, 'KEYWORD_MATCH', 'stranger', 'a post mentioning something', now())`,
    [input.accountId, `unqueued-${suffix}`],
  );
}

/**
 * An account for this owner, so an event with no job still belongs to somebody.
 *
 * Ownership reaches a row through its account or through the agent that worked
 * it. A row nothing was queued for has no agent, so without an account it is
 * owned by nobody and never reaches the query at all, and a test built on one
 * passes without proving anything.
 */
async function accountFor(ownerId: string): Promise<string> {
  const suffix = uniqueSuffix();
  const [row] = await query<{ id: string }>(
    `INSERT INTO accounts (owner_id, channel, handle, display_name, status)
     VALUES ($1, 'mock', $2, 'Noise', 'CONNECTED') RETURNING id`,
    [ownerId, `noise_${suffix}`],
  );
  return row!.id;
}

/** What the badge says: jobs held for a person, across everything. */
async function badgeCount(): Promise<number> {
  const counts = await jobsRepo.countJobsByStatus();
  return (counts.REVIEW_REQUIRED ?? 0) + (counts.WAITING_FOR_APPROVAL ?? 0);
}

describe('what the owner can actually see', () => {
  it('shows work the agent started itself, not only what somebody sent it', async () => {
    // The live shape exactly: one original post and three follow-ups, all held.
    const fixture = await createFixture();
    await heldJob({ ...fixture, eventType: 'SCHEDULED_TRIGGER', actionType: 'POST' });
    for (let i = 0; i < 3; i += 1) {
      await heldJob({ ...fixture, eventType: 'SCHEDULED_TRIGGER', actionType: 'REPLY' });
    }

    const items = await inboxRepo.ownerInbox(fixture.ownerId);
    expect(items).toHaveLength(4);
    // And in the bucket somebody would look in.
    expect(inboxRepo.countBuckets(items).NEEDS_REVIEW).toBe(4);
  });

  it('agrees with the badge', async () => {
    const fixture = await createFixture();
    await heldJob({ ...fixture, eventType: 'SCHEDULED_TRIGGER', actionType: 'POST' });
    await heldJob({ ...fixture, eventType: 'MENTION', actionType: 'REPLY' });

    const items = await inboxRepo.ownerInbox(fixture.ownerId);
    const waiting = items.filter((item) => inboxRepo.bucketOf(item) === 'NEEDS_REVIEW');
    expect(waiting).toHaveLength(await badgeCount());
  });

  it('carries the draft, so a decision does not need a second page', async () => {
    const fixture = await createFixture();
    await heldJob({ ...fixture, eventType: 'SCHEDULED_TRIGGER', actionType: 'POST' });
    const [item] = await inboxRepo.ownerInbox(fixture.ownerId);
    expect(item?.draftText).toBe('a draft');
  });
});

describe('deciding makes it go away', () => {
  it('drops out of the list and the count once it is settled', async () => {
    const fixture = await createFixture();
    const jobId = await heldJob({ ...fixture, eventType: 'SCHEDULED_TRIGGER', actionType: 'POST' });
    expect(await inboxRepo.ownerInbox(fixture.ownerId)).toHaveLength(1);
    expect(await badgeCount()).toBe(1);

    await jobsRepo.updateJob(jobId, { status: 'CANCELLED' });

    // Gone from both, because both are asking the same question now.
    const after = await inboxRepo.ownerInbox(fixture.ownerId);
    expect(after.filter((item) => inboxRepo.bucketOf(item) === 'NEEDS_REVIEW')).toHaveLength(0);
    expect(await badgeCount()).toBe(0);
  });

  it('stays gone when the list is read again', async () => {
    // The live failure survived restarts for a week. Reading twice is the
    // cheapest proof that nothing is being held in memory.
    const fixture = await createFixture();
    const jobId = await heldJob({ ...fixture, eventType: 'SCHEDULED_TRIGGER', actionType: 'REPLY' });
    await jobsRepo.updateJob(jobId, { status: 'CANCELLED' });

    for (let i = 0; i < 2; i += 1) {
      const items = await inboxRepo.ownerInbox(fixture.ownerId);
      expect(items.filter((item) => inboxRepo.bucketOf(item) === 'NEEDS_REVIEW')).toHaveLength(0);
      expect(await badgeCount()).toBe(0);
    }
  });
});

describe('a busy account cannot bury a decision', () => {
  it('keeps what needs a person inside the window however much arrives after it', async () => {
    /*
      The same defect as the one this file was written for, arriving by a
      different route.

      The list is capped and the cap is applied after ordering by arrival, so a
      busy account fills the window with things nobody has to decide anything
      about. Measured on ai17z-test: the screen said "Needs you 0" and "Nothing
      is waiting on you" while a job from eight days earlier sat in
      REVIEW_REQUIRED. Outreach showed exactly 200, which is the whole cap, and
      the thing needing a decision was behind all of it.

      The counts are taken from the rows the list returns, on purpose, so the
      chips cannot disagree with what is under them. That makes the ordering the
      only place this can be fixed without breaking that property.
    */
    const fixture = await createFixture();
    const held = await heldJob({
      ownerId: fixture.ownerId,
      agentId: fixture.agentId,
      eventType: 'MENTION',
      actionType: 'REPLY',
    });

    /*
      Everything that arrives afterwards, more of it than the window holds, and
      in the shape the live installation actually has.

      Half carry a settled job. Half carry no job at all, which is the ordinary
      case for a keyword match: something was recorded and nothing was queued
      for it. That half is what the first version of this test was missing, and
      missing it hid a real defect. `j.status` is NULL on those rows, `NULL IN
      (...)` is NULL rather than false, and `ORDER BY ... DESC` puts NULLs
      first, so every unqueued row sorted ahead of the decision this exists to
      rescue. The fix shipped, the screen still said nothing was waiting, and
      only the installed runtime showed it.
    */
    const accountId = await accountFor(fixture.ownerId);
    const noise = 12;
    for (let i = 0; i < noise; i += 1) {
      if (i % 2 === 0) {
        await settledJob({ agentId: fixture.agentId, eventType: 'KEYWORD_MATCH', actionType: 'REPLY' });
      } else {
        await unqueuedEvent({ accountId });
      }
    }

    // The unqueued half has to actually be in the answer, or this proves
    // nothing about how it sorts. They are owned through the account.
    const everything = await inboxRepo.ownerInbox(fixture.ownerId, 100);
    expect(everything.filter((item) => item.jobId === null).length).toBeGreaterThan(0);

    // A window smaller than what arrived after it, which is the live case in
    // miniature: two hundred newer rows and the decision behind them.
    const items = await inboxRepo.ownerInbox(fixture.ownerId, 5);
    expect(items.length).toBe(5);

    const counts = inboxRepo.countBuckets(items);
    expect(counts.NEEDS_REVIEW).toBe(1);
    expect(items.some((item) => item.jobId === held)).toBe(true);
    // And it is reachable rather than merely counted, which is the whole point.
    expect(inboxRepo.bucketOf(items[0]!)).toBe('NEEDS_REVIEW');
  });
});

describe('what it still leaves out', () => {
  it('does not show a scheduled trigger that is not waiting on anybody', async () => {
    /*
      Only the ones held for a person.

      An agent posts on a schedule and most of those finish on their own. An
      inbox that listed every one of them would be the activity log again, which
      is the thing this exists instead of.
    */
    const fixture = await createFixture();
    const jobId = await heldJob({ ...fixture, eventType: 'SCHEDULED_TRIGGER', actionType: 'POST' });
    await jobsRepo.updateJob(jobId, { status: 'EXECUTED' });

    expect(await inboxRepo.ownerInbox(fixture.ownerId)).toHaveLength(0);
  });

  it('still shows an ordinary mention whatever its job is doing', async () => {
    const fixture = await createFixture();
    const jobId = await heldJob({ ...fixture, eventType: 'MENTION', actionType: 'REPLY' });
    await jobsRepo.updateJob(jobId, { status: 'EXECUTED' });

    // Somebody said something. That belongs in the inbox whether or not it is
    // still waiting on anybody.
    expect(await inboxRepo.ownerInbox(fixture.ownerId)).toHaveLength(1);
  });
});

/**
 * The number an owner is shown has to be a number they can act on.
 *
 * Measured on ai17z-test: the health screen said "2 messages are waiting for
 * you to decide" while the inbox showed nothing waiting. One of the two was a
 * Response Lab rehearsal. A rehearsal manufactures an event so it runs the
 * ordinary ten steps, which is what makes the lab worth trusting, and it
 * publishes nothing by construction, so there is no decision to make about it.
 *
 * The inbox already knew that. Health and the Telegram status reply each added
 * the two decision statuses together instead, so three surfaces answered one
 * question three ways and the one an owner could actually act from was the one
 * showing the smaller number.
 */
describe('what is waiting for a person', () => {
  it('counts a live decision and not a rehearsal held beside it', async () => {
    const fixture = await createFixture();
    const live = await heldJob({
      ownerId: fixture.ownerId,
      agentId: fixture.agentId,
      eventType: 'MENTION',
      actionType: 'REPLY',
    });
    await heldJob({
      ownerId: fixture.ownerId,
      agentId: fixture.agentId,
      eventType: 'MENTION',
      actionType: 'REPLY',
      rehearsal: true,
    });

    // Both are held in a decision state, so the raw status count sees two.
    const raw = await jobsRepo.countJobsByStatus();
    expect((raw.REVIEW_REQUIRED ?? 0) + (raw.WAITING_FOR_APPROVAL ?? 0)).toBe(2);

    // The number a person is shown is the one they can act on.
    expect(await jobsRepo.countAwaitingAPerson()).toBe(1);

    // And it is the same one the inbox offers them, which is the property that
    // matters: the count and the list have to mean the same thing.
    const items = await inboxRepo.ownerInbox(fixture.ownerId);
    const counts = inboxRepo.countBuckets(items);
    expect(counts.NEEDS_REVIEW).toBe(1);
    expect(items.some((item) => item.jobId === live)).toBe(true);
  });

  it('counts nothing when every held job is a rehearsal', async () => {
    // The live case exactly: a screen saying something waits while nothing does.
    const fixture = await createFixture();
    await heldJob({
      ownerId: fixture.ownerId,
      agentId: fixture.agentId,
      eventType: 'MENTION',
      actionType: 'REPLY',
      rehearsal: true,
    });
    expect(await jobsRepo.countAwaitingAPerson()).toBe(0);
    expect(inboxRepo.countBuckets(await inboxRepo.ownerInbox(fixture.ownerId)).NEEDS_REVIEW).toBe(0);
  });

  it('leaves a settled job out, whatever it settled as', async () => {
    // A decision already made is not a decision waiting to be made.
    const fixture = await createFixture();
    const held = await heldJob({
      ownerId: fixture.ownerId,
      agentId: fixture.agentId,
      eventType: 'MENTION',
      actionType: 'REPLY',
    });
    expect(await jobsRepo.countAwaitingAPerson()).toBe(1);
    await query("UPDATE jobs SET status = 'CANCELLED' WHERE id = $1", [held]);
    expect(await jobsRepo.countAwaitingAPerson()).toBe(0);
  });

  it('scopes to one agent when asked', async () => {
    const mine = await createFixture();
    const theirs = await createFixture();
    await heldJob({ ownerId: mine.ownerId, agentId: mine.agentId, eventType: 'MENTION', actionType: 'REPLY' });
    await heldJob({ ownerId: theirs.ownerId, agentId: theirs.agentId, eventType: 'MENTION', actionType: 'REPLY' });
    expect(await jobsRepo.countAwaitingAPerson()).toBe(2);
    expect(await jobsRepo.countAwaitingAPerson(mine.agentId)).toBe(1);
  });
});

/**
 * One question, one answer, everywhere it is asked.
 *
 * "Waiting for you to decide" was computed in four places. The inbox had it
 * right; health, the Telegram status reply and the activity header each added
 * the two decision statuses together, which counts Response Lab rehearsals.
 *
 * Measured on ai17z-test: the activity header said two were waiting while the
 * filter chip directly beneath it, reading the inbox, said none. The agent card
 * and the health screen agreed with the header. Three surfaces were wrong and
 * the one an owner could actually act from was the one that was right.
 */
describe('there is one definition of what is waiting', () => {
  it('is not spelled out anywhere a fourth time', () => {
    const root = resolve(__dirname, '../..');
    const files = [
      'packages/runtime/src/health.ts',
      'packages/runtime/src/telegramCommands.ts',
      'apps/web/src/routes/ActivityPage.tsx',
      'apps/api/src/routes/jobs.ts',
      // The agent card, which had its own statement rather than a sum and was
      // the fifth place answering this question.
      'apps/api/src/routes/agentConfig.ts',
    ];
    for (const file of files) {
      const source = readFileSync(resolve(root, file), 'utf8');
      /*
        Nobody adds the two statuses together any more. Each of these either
        calls `countAwaitingAPerson` or reads what it returned, so a rehearsal
        cannot be counted as a decision in one place and not another.
      */
      expect(source, `${file} still adds the decision statuses by hand`).not.toMatch(
        /WAITING_FOR_APPROVAL \?\? 0\) \+|REVIEW_REQUIRED \?\? 0\) \+/,
      );
      // And nothing writes the status pair into SQL of its own either, which is
      // how the agent card came to disagree with the inbox beneath it.
      expect(source, `${file} has its own statement for this`).not.toMatch(
        /status IN \('REVIEW_REQUIRED', 'WAITING_FOR_APPROVAL'\)/,
      );
    }
  });

  it('serves it from the API so a screen never has to derive it', async () => {
    const fixture = await createFixture();
    await heldJob({
      ownerId: fixture.ownerId,
      agentId: fixture.agentId,
      eventType: 'MENTION',
      actionType: 'REPLY',
    });
    await heldJob({
      ownerId: fixture.ownerId,
      agentId: fixture.agentId,
      eventType: 'MENTION',
      actionType: 'REPLY',
      rehearsal: true,
    });
    // The raw breakdown still exists, because a queue view needs it.
    const raw = await jobsRepo.countJobsByStatus(fixture.agentId);
    expect((raw.REVIEW_REQUIRED ?? 0) + (raw.WAITING_FOR_APPROVAL ?? 0)).toBe(2);
    // And the number a person is shown is the one they can act on.
    expect(await jobsRepo.countAwaitingAPerson(fixture.agentId)).toBe(1);
  });
});
