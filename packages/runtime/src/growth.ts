import {
  growth as growthRepo,
  postAnalytics as postAnalyticsRepo,
  relationships as relationshipsRepo,
} from '@xbam/database';
import { rankBridges, scoreBridge, type BridgeScore } from './bridge';
import { findOpportunities, type OpportunityCandidate, type OpportunityVerdict } from './opportunity';
import { readNarratives, type NarrativeReading } from './narratives';
import { readContentSignals, type ContentSignals, type PublishedPost } from './contentIntelligence';
import { readLaunchSignals, type LaunchReading } from './launches';

/**
 * The growth screens, answered out of rows that already exist.
 *
 * Everything above this line is pure and everything below it is a query. That
 * split is the point: the judgements are testable without a database and the
 * gathering is testable without inventing judgements.
 *
 * There is no growth table. An owner asking how their agent is doing is asking
 * about events the radar discovered, actions it published and readings taken of
 * them -- all already written by the pipeline. A second store of "what
 * happened" would drift from the first, and the first is the one that is true.
 */

/** How far back the narrative and launch readers look by default. */
const DEFAULT_WINDOW_HOURS = 12;

/** How recently the agent must have spoken to somebody to leave them alone. */
const ENGAGED_RECENTLY_HOURS = 20;

function isoHoursAgo(hours: number, now: Date): string {
  return new Date(now.getTime() - hours * 3_600_000).toISOString();
}

/** What worked, from what was published and what was later observed about it. */
export async function contentSignalsFor(
  agentId: string,
  options: { limit?: number; hourBuckets?: boolean } = {},
): Promise<ContentSignals> {
  const rows = await postAnalyticsRepo.publishedWithReadings(agentId, options.limit ?? 120);
  const posts: PublishedPost[] = rows.map((row) => ({
    statusId: row.remote_post_id,
    text: row.text,
    publishedAt: row.published_at,
    ...(row.impressions === null ? {} : { impressions: row.impressions }),
    ...(row.likes === null ? {} : { likes: row.likes }),
    ...(row.replies === null ? {} : { replies: row.replies }),
    ...(row.reposts === null ? {} : { reposts: row.reposts }),
  }));
  return readContentSignals(posts, { hourBuckets: options.hourBuckets ?? true });
}

/** What a lot of accounts have started talking about, from what was discovered. */
export async function narrativesFor(
  accountId: string,
  options: { windowHours?: number; now?: Date; limit?: number } = {},
): Promise<NarrativeReading> {
  const now = options.now ?? new Date();
  const windowHours = options.windowHours ?? DEFAULT_WINDOW_HOURS;
  // Twice the window, because a rise needs a before to have risen from.
  const rows = await growthRepo.discoveredPosts(accountId, {
    sinceIso: isoHoursAgo(windowHours * 2, now),
    limit: 600,
  });
  return readNarratives(
    rows.map((row) => ({
      statusId: row.remote_event_id,
      handle: row.handle ?? '',
      text: row.text,
      ...(row.occurred_at ? { postedAt: row.occurred_at } : {}),
    })),
    { now, windowHours, ...(options.limit ? { limit: options.limit } : {}) },
  );
}

/** Tickers and addresses being posted, with the posts they were seen in. */
export async function launchesFor(
  accountId: string,
  options: { windowHours?: number; now?: Date } = {},
): Promise<LaunchReading> {
  const now = options.now ?? new Date();
  const rows = await growthRepo.discoveredPosts(accountId, {
    sinceIso: isoHoursAgo(options.windowHours ?? 24, now),
    limit: 600,
  });
  return readLaunchSignals(
    rows.map((row) => ({
      statusId: row.remote_event_id,
      handle: row.handle ?? '',
      text: row.text,
      ...(row.occurred_at ? { postedAt: row.occurred_at } : {}),
    })),
  );
}

/**
 * How much of an audience the agent does not already reach sits behind each
 * account it knows.
 *
 * Built from relationship memory and from who has been seen around whom. The
 * follower counts are usually absent, and that is reported as a gap rather than
 * guessed -- reading a profile to fill one in is a capability an owner invokes,
 * not something a screen does on its own to hundreds of accounts.
 */
export async function bridgesFor(
  agentId: string,
  accountId: string,
  options: { limit?: number; now?: Date; ourFollowerCount?: number } = {},
): Promise<BridgeScore[]> {
  const now = options.now ?? new Date();
  const [known, neighbours] = await Promise.all([
    relationshipsRepo.listForAgent(agentId, { limit: options.limit ?? 100 }),
    growthRepo.neighbourCounts({ agentId, accountId, limit: 400 }),
  ]);
  const byHandle = new Map(neighbours.map((row) => [row.handle, row]));

  return rankBridges(
    known.map((person) => {
      const neighbourhood = byHandle.get(person.handle.toLowerCase());
      return scoreBridge(
        {
          handle: person.handle,
          inboundCount: person.inboundCount,
          outboundCount: person.outboundCount,
          lastInteractionAt: person.lastInteractionAt,
          disposition: person.disposition,
          ...(options.ourFollowerCount === undefined ? {} : { ourFollowerCount: options.ourFollowerCount }),
          ...(neighbourhood
            ? { neighbours: neighbourhood.neighbours, neighboursWeKnow: neighbourhood.neighbours_we_know }
            : {}),
        },
        now,
      );
    }),
  );
}

/**
 * Which of the posts an agent has seen are worth speaking into.
 *
 * The candidates are what the radar already discovered, so this adds no reading
 * of its own -- and the answer is usually that none of them are. That is the
 * design: the declines carry their reasons, and "we looked at forty posts and
 * found nothing" is the useful thing an owner can read.
 */
export async function opportunitiesFor(input: {
  agentId: string;
  accountId: string;
  selfHandles: string[];
  topics: string[];
  now?: Date;
  windowHours?: number;
}): Promise<OpportunityVerdict> {
  const now = input.now ?? new Date();
  const windowHours = input.windowHours ?? DEFAULT_WINDOW_HOURS;
  const [rows, recentlyEngaged, bridges] = await Promise.all([
    growthRepo.discoveredPosts(input.accountId, { sinceIso: isoHoursAgo(windowHours, now), limit: 300 }),
    growthRepo.handlesEngagedSince(input.agentId, isoHoursAgo(ENGAGED_RECENTLY_HOURS, now)),
    bridgesFor(input.agentId, input.accountId, { now }),
  ]);

  const byHandle: Record<string, BridgeScore> = {};
  for (const bridge of bridges) byHandle[bridge.handle.toLowerCase()] = bridge;

  const candidates: OpportunityCandidate[] = rows.map((row) => ({
    statusId: row.remote_event_id,
    handle: row.handle ?? '',
    text: row.text,
    ...(row.occurred_at ? { postedAt: row.occurred_at } : {}),
  }));

  return findOpportunities(candidates, {
    selfHandles: input.selfHandles,
    topics: input.topics,
    recentlyEngaged,
    bridges: byHandle,
    maxAgeHours: windowHours,
    now,
  });
}
