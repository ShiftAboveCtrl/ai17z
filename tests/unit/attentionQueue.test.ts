import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KIND_LABELS, PER_CATEGORY_LIMIT, VISIBLE_LIMIT, attentionWindow, type PendingRequest } from '@xbam/runtime';

/**
 * Seventy-one decisions is not a decision queue.
 *
 * Measured on a live installation: seventy-one jobs were waiting for the
 * owner, every one of them an unprompted approach to a stranger found by a
 * keyword search, and not one of them a message from a person. The list was
 * doing the opposite of its job -- anything that actually needed judgement
 * would have been below seventy-one things that did not.
 */

const iso = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

let n = 0;
function request(over: Partial<PendingRequest> = {}): PendingRequest {
  n += 1;
  return {
    jobId: `job-${n}`,
    agentId: 'agent-1',
    eventType: 'KEYWORD_MATCH',
    actionType: 'REPLY',
    authorHandle: `stranger${n}`,
    conversationRef: `thread-${n}`,
    createdAt: iso(n),
    value: 70,
    ...over,
  };
}

describe('the owner is never shown more than fifteen', () => {
  it('caps the visible list and keeps the rest', () => {
    // Seventy-one of one kind. The per-kind cap binds before the window does,
    // which is the point: six of these and a count is a better answer than
    // fifteen rows that are all the same decision.
    const many = Array.from({ length: 71 }, () => request());
    const window = attentionWindow(many);

    expect(window.visible.length).toBeLessThanOrEqual(VISIBLE_LIMIT);
    expect(window.visible).toHaveLength(PER_CATEGORY_LIMIT);
    // Kept, counted, and described. This is an attention window, not a delete.
    expect(window.backlogCount).toBe(71 - PER_CATEGORY_LIMIT);
    expect(window.backlogByKind.ROUTINE_GROWTH).toBe(71 - PER_CATEGORY_LIMIT);
    expect(window.visible.length + window.backlogCount + window.staleCount + window.groupedCount).toBe(71);
  });

  it('does not let one repetitive kind take every slot', () => {
    /*
      The live shape, exactly: seventy-one routine growth suggestions and one
      person who wrote in. Under a plain cap of fifteen the person is item
      seventy-two and is never seen.
    */
    const growth = Array.from({ length: 71 }, () => request());
    const person = request({ eventType: 'MENTION', authorHandle: 'a_real_person', value: 40, createdAt: iso(0) });

    const window = attentionWindow([...growth, person]);

    expect(window.visible[0]!.jobId).toBe(person.jobId);
    expect(window.visible[0]!.kind).toBe('DIRECT_INBOUND');
    const routine = window.visible.filter((r) => r.kind === 'ROUTINE_GROWTH');
    expect(routine.length).toBeLessThanOrEqual(PER_CATEGORY_LIMIT);
  });

  it('uses the whole window when there is a mixture to show', () => {
    // The cap is per kind, not overall. Three kinds with plenty of each fill
    // the window properly, so the ceiling only ever bites on repetition.
    const window = attentionWindow([
      ...Array.from({ length: 10 }, () => request({ eventType: 'MENTION' })),
      ...Array.from({ length: 10 }, () => request({ actionType: 'POST' })),
      ...Array.from({ length: 10 }, () => request()),
    ]);
    expect(window.visible).toHaveLength(VISIBLE_LIMIT);
  });
});

describe('the order is about what the decision is, not what it scored', () => {
  it('puts a person above a high-scoring growth suggestion', () => {
    const brilliant = request({ value: 99 });
    const person = request({ eventType: 'REPLY', value: 30, authorHandle: 'someone' });

    const window = attentionWindow([brilliant, person]);
    expect(window.visible.map((r) => r.jobId)).toEqual([person.jobId, brilliant.jobId]);
  });

  it('puts a security hold above everything', () => {
    const person = request({ eventType: 'MENTION', value: 90 });
    const hold = request({ eventType: 'SECURITY_HOLD', value: null });

    expect(attentionWindow([person, hold]).visible[0]!.jobId).toBe(hold.jobId);
  });

  it('puts something that cannot be taken back above a reply', () => {
    const post = request({ actionType: 'POST', value: 10 });
    const approach = request({ value: 95 });
    expect(attentionWindow([post, approach]).visible[0]!.jobId).toBe(post.jobId);
  });

  it('orders within a kind by strength, then by age', () => {
    const weak = request({ value: 66 });
    const strong = request({ value: 79 });
    const window = attentionWindow([weak, strong]);
    expect(window.visible.map((r) => r.jobId)).toEqual([strong.jobId, weak.jobId]);
  });
});

describe('one question is asked once', () => {
  it('folds three suggestions about the same person into one', () => {
    /*
      An approach is a decision about a person, not about a thread. On the live
      installation one stranger held two of twelve places for two posts they
      happened to have written, and the per-author cooldown would have refused
      the second approach anyway.
    */
    const three = Array.from({ length: 3 }, (_, i) =>
      request({ conversationRef: `thread-${i}`, authorHandle: 'same_person' }),
    );

    const window = attentionWindow(three);
    expect(window.visible).toHaveLength(1);
    expect(window.groupedCount).toBe(2);
    // The oldest survives, because that is the one the owner may already have
    // seen sitting in the list.
    expect(window.visible[0]!.jobId).toBe(three[2]!.jobId);
  });

  it('never folds two people together', () => {
    const a = request({ eventType: 'MENTION', authorHandle: 'alice', conversationRef: 'same' });
    const b = request({ eventType: 'MENTION', authorHandle: 'bob', conversationRef: 'same' });
    expect(attentionWindow([a, b]).visible).toHaveLength(2);
  });

  it('never folds two irreversible actions together for tidiness', () => {
    // Two posts are two decisions however alike they look. Grouping a
    // high-impact request into another one is answering it by accident.
    const a = request({ actionType: 'POST', conversationRef: null, authorHandle: null });
    const b = request({ actionType: 'POST', conversationRef: null, authorHandle: null });
    expect(attentionWindow([a, b]).visible).toHaveLength(2);
  });
});

describe('a request whose subject is gone stops taking a slot', () => {
  it('drops an expired request out of the window without deleting it', () => {
    const old = request({ createdAt: iso(60 * 24 * 10) });
    const live = request();

    const window = attentionWindow([old, live]);
    expect(window.visible.map((r) => r.jobId)).toEqual([live.jobId]);
    expect(window.staleCount).toBe(1);
  });

  it('treats a deleted source post as expired rather than failed', () => {
    const gone = request({ sourceGone: true });
    const window = attentionWindow([gone]);
    expect(window.visible).toHaveLength(0);
    expect(window.staleCount).toBe(1);
  });

  it('treats a superseded request as superseded, not rejected', () => {
    const replaced = request({ supersededBy: 'job-later' });
    const window = attentionWindow([replaced]);
    expect(window.visible).toHaveLength(0);
    expect(window.staleCount).toBe(1);
  });

  it('gives the freed slot to something live', () => {
    // A stale request must not be what pushes a live one out of the window.
    const live = Array.from({ length: 6 }, () => request());
    const stale = request({ sourceGone: true, value: 100 });
    const window = attentionWindow([stale, ...live], { limit: 15 });
    expect(window.visible).toHaveLength(PER_CATEGORY_LIMIT);
    expect(window.visible.some((r) => r.jobId === stale.jobId)).toBe(false);
    expect(window.backlogCount).toBe(0);
    expect(window.staleCount).toBe(1);
  });
});

describe('the screen and the ranking agree about what the kinds are', () => {
  it('spells the same six on both sides', () => {
    /*
      The browser cannot import the runtime, so the labels are written twice.
      That is one implementation more than the rule allows, and the failure is
      silent: a kind added here would render on the screen as a raw enum name
      with no label at all, or worse, would carry the wrong sentence.

      Held against each other rather than trusted, the same way the installer's
      release-name grammar is held against `releaseName()`.
    */
    const page = readFileSync(join(process.cwd(), 'apps/web/src/routes/ActivityPage.tsx'), 'utf8');
    const block = page.match(/const KIND_LABELS: Record<string, string> = \{([\s\S]*?)\n\};/)?.[1];
    expect(block, 'ActivityPage no longer declares KIND_LABELS').toBeTruthy();

    const onScreen = [...block!.matchAll(/^\s{2}([A-Z_]+):\s*'([^']+)'/gm)].map((m) => [m[1]!, m[2]!] as const);
    expect(Object.fromEntries(onScreen)).toEqual(KIND_LABELS);
  });
});
