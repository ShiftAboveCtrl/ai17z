import { createLogger, errorMessage } from '@xbam/shared';
import { feedSubscriptions } from '@xbam/database';
import { ask, type FeedAnswer, type FeedEntry, type FeedQuery, FEED_FAMILY } from '@xbam/upstream';

const log = createLogger('feed-watcher');

/**
 * Watching a feed, which is not the same as reading one.
 *
 * ### The invariant
 *
 * **A restart must not replay history as new work.** Everything here serves
 * that. A feed republishes its whole visible list every time it is fetched, so
 * the difference between "thirty articles" and "one new article" exists only in
 * what this installation remembers -- and if that memory lives in a process, it
 * is gone the moment the worker restarts, at which point the agent announces a
 * month of old posts as though they had just happened. Nothing errors. The
 * entries are real. The dates are real. It is simply wrong.
 *
 * ### Two ways to make that same mistake
 *
 * A restart is the obvious one. The other is subscribing: the first poll of a
 * new feed sees its entire visible history, all of it new to us and none of it
 * news. `primed` is what separates those, and a first poll records what it saw
 * and emits nothing.
 *
 * ### The model does not drive this
 *
 * There is no `feed.watch` capability. Polling on a schedule, holding a cursor,
 * and backing off a broken source are a background job's work, and asking a
 * model to do them means paying for a reasoning call to discover that nothing
 * changed. The model reads what the watcher found.
 */

/** What one poll of one subscription produced. */
export interface PollOutcome {
  subscriptionId: string;
  url: string;
  /** Nothing was fetched: the source said it had not changed. */
  notModified: boolean;
  /** Entries that had not been seen before. Empty on a priming poll. */
  fresh: FeedEntry[];
  /** True when this was the first poll and its entries were recorded, not emitted. */
  primed: boolean;
  failed: boolean;
  error?: string;
}

/**
 * Decides what is new, given what the feed said and what is remembered.
 *
 * Separated from the polling so it can be tested without a database or a
 * network, because this function is the invariant.
 */
export function freshEntries(entries: readonly FeedEntry[], seen: readonly string[]): FeedEntry[] {
  const known = new Set(seen);
  return entries.filter((entry) => !known.has(entry.id));
}

/**
 * How many feeds one tick may take.
 *
 * Small on purpose. Feeds are polled every fifteen minutes by default, so there
 * is no hurry, and a tick that claims fifty feeds holds fifty leases while it
 * works through them one at a time.
 */
const FEEDS_PER_TICK = 5;

/**
 * How long a claimed feed stays claimed.
 *
 * Long enough that a slow poll finishes, short enough that a worker which died
 * mid-poll does not leave the feed unpolled for its whole interval. It is a
 * lease, not a schedule: finishing the poll sets the real next time.
 */
const CLAIM_HOLD_SECONDS = 120;

/** Reads one subscription and works out what is new. */
export async function pollSubscription(subscription: feedSubscriptions.FeedSubscription): Promise<PollOutcome> {
  const base = { subscriptionId: subscription.id, url: subscription.url };
  try {
    const answer = await ask<FeedQuery, FeedAnswer>(FEED_FAMILY, {
      url: subscription.url,
      // The validators from last time. This is what makes polling cheap: an
      // unchanged feed answers 304 with no body and costs both sides nothing.
      etag: subscription.etag,
      lastModified: subscription.lastModified,
      limit: 100,
    });
    const value = answer.value;

    if (value.notModified) {
      await feedSubscriptions.recordPoll({
        id: subscription.id,
        etag: value.etag,
        lastModified: value.lastModified,
        // Unchanged, so the cursor is unchanged. Writing it back rather than
        // leaving it alone keeps one code path for "a poll succeeded".
        seenEntryIds: subscription.seenEntryIds,
        intervalSeconds: subscription.intervalSeconds,
        status: 'NOT_MODIFIED',
        entriesSeen: 0,
      });
      return { ...base, notModified: true, fresh: [], primed: false, failed: false };
    }

    const fresh = freshEntries(value.entries, subscription.seenEntryIds);
    const merged = feedSubscriptions.mergeSeen(
      value.entries.map((entry) => entry.id),
      subscription.seenEntryIds,
    );

    await feedSubscriptions.recordPoll({
      id: subscription.id,
      etag: value.etag,
      lastModified: value.lastModified,
      seenEntryIds: merged,
      intervalSeconds: subscription.intervalSeconds,
      status: 'OK',
      entriesSeen: value.entries.length,
    });

    // The first poll of a new subscription is not news. Its entries are
    // recorded so they are never announced, and nothing is emitted.
    if (!subscription.primed) {
      log.info('feed primed', { url: subscription.url, recorded: value.entries.length });
      return { ...base, notModified: false, fresh: [], primed: true, failed: false };
    }

    return { ...base, notModified: false, fresh, primed: false, failed: false };
  } catch (error) {
    const message = errorMessage(error);
    await feedSubscriptions
      .recordFailure({ id: subscription.id, error: message, intervalSeconds: subscription.intervalSeconds })
      .catch((writeError) =>
        // A feed that failed and whose failure could not be written is not a
        // reason to take the tick down with it.
        log.warn('could not record a feed failure', { url: subscription.url, message: errorMessage(writeError) }),
      );
    return { ...base, notModified: false, fresh: [], primed: false, failed: true, error: message };
  }
}

/**
 * One tick: claim what is due, poll it, and report what was new.
 *
 * Sequential rather than concurrent. Feeds share the machine's politeness budget
 * and there is no deadline here -- the next tick is a minute away.
 */
export async function pollDueFeeds(): Promise<PollOutcome[]> {
  const due = await feedSubscriptions.claimDueFeeds(FEEDS_PER_TICK, CLAIM_HOLD_SECONDS);
  if (due.length === 0) return [];

  const outcomes: PollOutcome[] = [];
  for (const subscription of due) {
    const outcome = await pollSubscription(subscription);
    outcomes.push(outcome);
    if (outcome.fresh.length > 0) {
      log.info('feed has something new', { url: outcome.url, fresh: outcome.fresh.length });
    }
  }
  return outcomes;
}
