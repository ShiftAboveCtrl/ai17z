import { createLogger, envInt, errorMessage } from '@xbam/shared';
import {
  accounts as accountsRepo,
  postAnalytics as postAnalyticsRepo,
  radar as radarRepo,
  type RadarSourceRow,
} from '@xbam/database';
import { getChannelAdapter, isChannelImplemented, readProfile } from '@xbam/channels';
import { buildChannelContext, reconcileCandidates } from '@xbam/runtime';
import { describeBrowserError } from '@xbam/browser';
import { startLoop } from './loop';

const log = createLogger('radar');

/**
 * Drives the Social Radar.
 *
 * Each source is polled on its own schedule and its health is recorded
 * separately, which is the point: a failing notifications scrape used to leave
 * an account looking healthy while nothing was arriving. Now the account keeps
 * working through the other monitors and the failing one says so.
 */
/** How often the own-threads source spends a cycle on the account itself. */
const ACCOUNT_READING_INTERVAL_MS = 6 * 60 * 60_000;

export class SocialRadar {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly tickMs = envInt('AI17Z_RADAR_TICK_MS', 5_000);
  private readonly perTick = envInt('AI17Z_RADAR_SOURCES_PER_TICK', 3);
  /** Long enough for a slow page load, short enough not to strand a source. */
  private readonly claimHoldSeconds = envInt('AI17Z_RADAR_CLAIM_HOLD_S', 180);

  start(): void {
    if (this.timer) return;
    log.info('social radar starting', { tickMs: this.tickMs, perTick: this.perTick });
    this.timer = startLoop('radar', this.tickMs, () => this.tick());
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const source of await radarRepo.claimDueSources(this.perTick, this.claimHoldSeconds)) {
        await this.pollOne(source);
      }
    } catch (error) {
      log.warn('radar tick failed', { message: errorMessage(error) });
    } finally {
      this.running = false;
    }
  }

  private async pollOne(source: RadarSourceRow): Promise<void> {
    const account = await accountsRepo.getAccount(source.accountId);
    if (!account || !isChannelImplemented(account.channel)) return;

    const adapter = getChannelAdapter(account.channel);
    if (!adapter.pollRadarSource) return;

    const config = source.config ?? {};
    // The source's own setting wins; `AI17Z_RADAR_DEFAULT_INTERVAL_S` moves the
    // floor for every source that has none, which is every source created before
    // the interval was written into the config. It was 180 for all of them, so
    // nobody was noticed in under three minutes however the sources were set up.
    const interval = (config.intervalSeconds ?? envInt('AI17Z_RADAR_DEFAULT_INTERVAL_S', 60)) * 1_000;

    // own_threads has no fixed target: it walks whichever of the agent's recent
    // posts is least recently checked, so a busy account cycles through them
    // instead of one thread monopolising the source.
    let target = source.target;
    let ownPostId: string | null = null;
    let ownPostAgentId: string | null = null;
    if (source.kind === 'own_threads') {
      /**
       * Every so often, this cycle looks at the account rather than at a post.
       *
       * This source is the one that looks at the agent's own account, and the
       * follower count is part of that. Giving it a cycle now and then is reuse
       * of a poll that was already due -- `docs/architecture/CADENCE.md` allows
       * one timing engine and no second timer, and this adds none.
       *
       * It has to be a cadence rather than "when there is no post to check".
       * That was the first attempt and it was wrong: an account that posts
       * regularly always has a post to check, so the one case that needed
       * measuring most would never have been measured at all.
       *
       * Nothing is lost by spending the cycle: the post check happens on the
       * next one, a minute or two later.
       */
      if (await this.dueForAccountReading(source.accountId)) {
        await this.observeOwnAccount(source.accountId).catch(() => undefined);
        await radarRepo.recordPoll({
          sourceId: source.id,
          nextPollAt: new Date(Date.now() + interval),
          found: 0,
        });
        return;
      }

      const [next] = await radarRepo.ownPostsToCheck(source.accountId, 1);
      if (!next) {
        // Nothing posted recently is not a failure; there is simply nothing to
        // check, and saying so beats recording a spurious success.
        //
        await radarRepo.recordPoll({
          sourceId: source.id,
          nextPollAt: new Date(Date.now() + interval),
          found: 0,
        });
        return;
      }
      target = next.remoteId;
      ownPostId = next.id;
      ownPostAgentId = next.agentId;
    }

    try {
      const ctx = await buildChannelContext(account, null);
      const poll = await adapter.pollRadarSource(ctx, {
        kind: source.kind,
        target,
        limit: config.limit ?? 20,
        cursor: source.cursor,
      });

      if (poll.error) {
        await radarRepo.recordPoll({
          sourceId: source.id,
          nextPollAt: new Date(Date.now() + this.backoff(source, interval)),
          found: 0,
          error: describeBrowserError(poll.error).slice(0, 500),
        });
        log.warn('radar source failed', { kind: source.kind, target, message: poll.error });
        return;
      }

      const outcome = await reconcileCandidates({
        accountId: source.accountId,
        sourceId: source.id,
        sourceKind: source.kind,
        candidates: poll.candidates,
        mayTrigger: config.mayTrigger ?? true,
      });

      await radarRepo.recordPoll({
        sourceId: source.id,
        nextPollAt: new Date(Date.now() + interval),
        found: poll.candidates.length,
        cursor: poll.cursor,
      });
      if (ownPostId) await radarRepo.markOwnPostChecked(ownPostId, poll.candidates.length);

      // A visit is also a measurement.
      //
      // This poll loaded one of the agent's own posts to look for replies, and
      // the counts underneath it were on the page. Recording them here is what
      // keeps `post_analytics` filling on its own -- otherwise nothing measures
      // an agent's own posts unless somebody asks a capability to, and every
      // comparison built on those numbers stays empty forever.
      //
      // Never allowed to fail the poll: a missing observation is a gap in a
      // series, and a failed poll is a reply nobody sees.
      // An empty label is no reading. X omits a count from the label entirely
      // when it is zero, so a post nobody has touched can render nothing at all.
      if (ownPostId && ownPostAgentId && target && poll.targetCounts && Object.keys(poll.targetCounts).length > 0) {
        await postAnalyticsRepo
          .record({
            agentId: ownPostAgentId,
            accountId: source.accountId,
            remotePostId: target,
            source: 'TIMELINE',
            replies: poll.targetCounts.replies ?? null,
            reposts: poll.targetCounts.reposts ?? null,
            likes: poll.targetCounts.likes ?? null,
            bookmarks: poll.targetCounts.bookmarks ?? null,
            impressions: poll.targetCounts.views ?? null,
          })
          .catch(() => undefined);
      }

      // This source just proved the browser works. Anything else on the account
      // sitting out a backoff earned by the browser being gone should try again
      // now rather than in twenty minutes. The check is on the other sources,
      // not this one: the source that recovers first is usually the one that
      // was never failing.
      const revived = await radarRepo.retryFailingSources(source.accountId, source.id);
      if (revived > 0) {
        log.info('a working source brought the failing ones forward', { accountId: source.accountId, revived });
      }

      if (outcome.created > 0 || outcome.corroborated > 0) {
        log.info('radar source polled', {
          kind: source.kind,
          target,
          seen: poll.candidates.length,
          created: outcome.created,
          corroborated: outcome.corroborated,
        });
      }
    } catch (error) {
      const message = errorMessage(error);
      await radarRepo
        .recordPoll({
          sourceId: source.id,
          nextPollAt: new Date(Date.now() + this.backoff(source, interval)),
          found: 0,
          error: describeBrowserError(message).slice(0, 500),
        })
        .catch(() => undefined);
      log.warn('radar source threw', { kind: source.kind, message });
    }
  }

  /**
   * Reads the agent's own profile and records what the account looked like.
   *
   * Called only from the own-threads slot when there is no post to check, so it
   * costs a page load that was not going to happen otherwise and adds no timer
   * of its own. `post_analytics` answers "how did that post do"; this answers
   * the question an owner asks first, which is whether any of it is adding up.
   *
   * Its own profile only. A follower count for somebody else is read live for a
   * bridge score and not kept, because a series about accounts the agent merely
   * looked at would be a history of people who never asked for one.
   *
   * Never allowed to fail a poll. A missing reading is a gap in a series; a
   * failed poll is a reply nobody sees.
   */
  /**
   * Whether it is time to look at the account rather than at one of its posts.
   *
   * Six hours because a follower count moves slowly and four readings a day is
   * plenty to see a week's shape, while costing four page loads. Shorter would
   * spend cycles that could be finding replies; longer would take days to draw
   * a second point, and one point is not a series.
   */
  private async dueForAccountReading(accountId: string): Promise<boolean> {
    const last = await postAnalyticsRepo.lastAccountReadingAt(accountId).catch(() => null);
    if (!last) return true;
    return Date.now() - new Date(last).getTime() >= ACCOUNT_READING_INTERVAL_MS;
  }

  private async observeOwnAccount(accountId: string): Promise<void> {
    const account = await accountsRepo.getAccount(accountId);
    if (!account?.handle) return;
    const [link] = await accountsRepo.listAccountAgents(accountId);
    if (!link) return;

    const ctx = await buildChannelContext(account, null);
    const profile = await readProfile(ctx, account.handle);
    if (profile.followerCount === undefined && profile.followingCount === undefined) {
      // X showed neither number. Absent is not zero, and a row of nulls is not
      // a reading -- it would occupy the minute the real one needs.
      return;
    }
    await postAnalyticsRepo.recordAccount({
      agentId: link.agentId,
      accountId,
      handle: profile.handle,
      followers: profile.followerCount ?? null,
      following: profile.followingCount ?? null,
    });
    log.info('recorded what the account looked like', {
      accountId,
      handle: profile.handle,
      followers: profile.followerCount ?? null,
    });
  }

  /**
   * A failing source backs off rather than hammering a surface that is not
   * answering, but never so far that a recovered source stays quiet for long.
   */
  private backoff(source: RadarSourceRow, baseMs: number): number {
    const failures = Math.min(source.consecutiveFailures + 1, 5);
    return Math.min(baseMs * 2 ** failures, 30 * 60_000);
  }
}
