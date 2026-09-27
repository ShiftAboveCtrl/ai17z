import type { RadarSourceKind } from './radar';

/**
 * How often AI17Z may ask X for each kind of page, for every account.
 *
 * The one place this is decided, for the reason `resources.ts` gives about
 * memory: a pace chosen beside the code that polls is one nobody can tune or
 * test, and the defaults that shipped disagreed with the account that stayed
 * healthy. Every X account was created polling notifications every 30
 * seconds, its mentions search every 60 and its replies search every 90.
 * Measured on a live installation: the account on those defaults hit X's
 * "something went wrong" on both searches about every two hours and spent a
 * day in and out of cooldown, while an account on 300 and 600 read nearly
 * twice as much in total and was never refused once. Search is what X guards;
 * volume elsewhere was not the problem.
 *
 * `default` is what a new source is created with. `floor` is the fastest any
 * source of that kind will actually poll, whatever its configuration says: an
 * owner may go slower, never faster, because the cost of going faster is paid
 * by the account, for days, in cooldowns that stop it answering people.
 */
export interface XReadPace {
  /** Seconds between polls for a source created without a setting of its own. */
  defaultSeconds: number;
  /** The fastest this kind of source is ever polled. */
  floorSeconds: number;
  /** Whether this kind loads X's search, which is what X refuses first. */
  search: boolean;
}

export const X_READ_PACING: Record<RadarSourceKind, XReadPace> = {
  // X's own notifications page: not a search, and the first place a mention lands.
  notifications: { defaultSeconds: 90, floorSeconds: 60, search: false },
  // The two searches that catch what notifications lost. The measured healthy pace.
  mention_search: { defaultSeconds: 300, floorSeconds: 300, search: true },
  reply_search: { defaultSeconds: 600, floorSeconds: 600, search: true },
  // Status pages of the agent's own posts.
  own_threads: { defaultSeconds: 300, floorSeconds: 180, search: false },
  // A profile timeline the owner asked it to follow.
  tracked_account: { defaultSeconds: 300, floorSeconds: 180, search: false },
  // A search the owner wrote.
  tracked_keyword: { defaultSeconds: 1800, floorSeconds: 900, search: true },
  // Asked for by a growth session; this is only the fallback when none asks.
  persona_discovery: { defaultSeconds: 3600, floorSeconds: 900, search: true },
};

/** The pace a source actually polls at, and whether its own setting was raised. */
export function effectiveXInterval(
  kind: RadarSourceKind,
  configuredSeconds: number | null | undefined,
): { seconds: number; raised: boolean } {
  const pace = X_READ_PACING[kind];
  const wanted = configuredSeconds ?? pace.defaultSeconds;
  if (wanted < pace.floorSeconds) return { seconds: pace.floorSeconds, raised: true };
  return { seconds: wanted, raised: false };
}
