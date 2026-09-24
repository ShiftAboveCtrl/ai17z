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
        await this.pollWithinItsClaim(source);
      }
    } catch (error) {
      log.warn('radar tick failed', { message: errorMessage(error) });
    } finally {
      this.running = false;
    }
  }

  /**
   * One poll, which is never allowed to outlive the claim it was given.
   *
   * `running` is a mutex with no owner but this loop, so a `pollOne` that never
   * settles does not slow the radar down -- it ends it. Every later tick returns
   * at the first line, no source is ever claimed again, and because nothing
   * failed, every source keeps its last status. The account goes on reporting
   * seven healthy monitors while nothing has been read for hours.
   *
   * Observed on two installations at once, on different versions, which is what
   * proved it was not a regression in either: both radars stopped claiming
   * within ten seconds of each other and stayed stopped for ninety-five
   * minutes, HEALTHY throughout, while the channel poller went on using the
   * same browser every two minutes. Reproduced deliberately afterwards by
   * restarting one of them: it claimed its three direct sources, opened the
   * notifications tab, and never came back.
   *
   * The thing that hangs is below this and varies -- an evaluation against a
   * renderer that has stopped answering is the one this codebase has already
   * paid for once. Bounding each of those is worth doing and is not enough on
   * its own, because the guarantee has to hold for the next one nobody has
   * found yet. This is the floor: whatever happens underneath, the loop lives.
   *
   * The deadline is the claim hold, because that is already the moment this
   * source becomes claimable by anybody else. A poll still running then has
   * outlived its own lease by definition, and needs no second number to say so.
   *
   * The hung promise is not cancellable and is left to settle or not. What
   * changes is that it no longer holds the radar: the source is recorded as
   * degraded, in words, and the loop moves on.
   */
  private async pollWithinItsClaim(source: RadarSourceRow): Promise<void> {
    const deadlineMs = this.claimHoldSeconds * 1_000;
    let timer: NodeJS.Timeout | undefined;
    const overdue = new Promise<'overdue'>((resolve) => {
      timer = setTimeout(() => resolve('overdue'), deadlineMs);
    });

    try {
      const outcome = await Promise.race([this.pollOne(source).then(() => 'done' as const), overdue]);
      if (outcome !== 'overdue') return;

      log.warn('a radar source outlived its claim and was left behind', {
        kind: source.kind,
        target: source.target,
        afterSeconds: this.claimHoldSeconds,
      });
      await radarRepo
        .recordPoll({
          sourceId: source.id,
          nextPollAt: new Date(Date.now() + this.backoff(source, deadlineMs)),
          found: 0,
          error:
            `This source stopped answering part-way through and was given up on after ` +
            `${this.claimHoldSeconds} seconds. Nothing was read, which is not the same as nothing being there.`,
        })
        .catch(() => undefined);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Protected rather than private so the guarantee above can be tested.
   *
   * What has to be proved is that the loop survives a poll that never settles,
   * and there is no way to make a real poll hang on demand. A test that stands
   * in for this one by checking a timer in isolation proves the timer, not the
   * radar.
   */
  protected async pollOne(source: RadarSourceRow): Promise<void> {
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
      if (this.dueForAccountReading(source)) {
        const read = await this.observeOwnAccount(source.accountId).catch((error) => errorMessage(error));
        await radarRepo.recordPoll({
          sourceId: source.id,
          nextPollAt: new Date(Date.now() + interval),
          found: 0,
          // The attempt is what moves the cadence on, never the outcome. See
          // `dueForAccountReading` for the eight days this cost.
          sideWork: true,
          idleReason:
            read === null
              ? 'spent this cycle reading the account itself; the next one checks a thread'
              : `spent this cycle trying to read the account and could not: ${read}`,
        });
        return;
      }

      const [next] = await radarRepo.ownPostsToCheck(source.accountId, 1);
      if (!next) {
        // Nothing posted recently is not a failure; there is simply nothing to
        // check, and saying so beats recording a spurious success.
        //
        // Said in words, because a healthy source with no results and no error
        // is ambiguous, and the ambiguity is what let this source look fine
        // while it had not read a thread in over a week.
        await radarRepo.recordPoll({
          sourceId: source.id,
          nextPollAt: new Date(Date.now() + interval),
          found: 0,
          idleReason: 'nothing posted in the last 72 hours, so there is no thread to check for replies',
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
            // Under the name X used. The count group says "views", and calling
            // that impressions stores a figure X never gave. Impressions come
            // only from X's own analytics view, which this path never reads.
            views: poll.targetCounts.views ?? null,
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
  private dueForAccountReading(source: RadarSourceRow): boolean {
    /*
      Asked of the attempt, never of the result.

      This used to ask `post_analytics` when the last reading was *stored*. A
      reading that fails stores nothing, so the first failure made the source
      permanently due: every poll took this branch, tried the profile, failed,
      recorded a healthy zero, and returned before looking at a single thread.

      Measured on a live installation: the last stored reading was 09-15 17:47,
      the last thread checked was 09-15 23:44, and the source then polled every
      three minutes for eight days reporting HEALTHY the whole time. Roughly
      three thousand eight hundred polls that read nothing, found nothing, and
      said nothing was wrong.

      A failure now costs exactly one cycle, the same as a success, and says so
      on the source. That is also why the reason is written down rather than
      merely logged: a source with no error and no results is ambiguous, and
      that ambiguity is the whole of what hid this.
    */
    if (!source.lastSideWorkAt) return true;
    return Date.now() - new Date(source.lastSideWorkAt).getTime() >= ACCOUNT_READING_INTERVAL_MS;
  }

  /** Reads the account's own profile. Returns null on success, or what stopped it. */
  private async observeOwnAccount(accountId: string): Promise<string | null> {
    const account = await accountsRepo.getAccount(accountId);
    if (!account?.handle) return 'this account has no handle';
    const [link] = await accountsRepo.listAccountAgents(accountId);
    if (!link) return 'no agent is linked to this account';

    const ctx = await buildChannelContext(account, null);
    // The profile only. This wants two numbers, and asking for a timeline it
    // would discard is a second request to X for nothing.
    const profile = await readProfile(ctx, account.handle, { posts: 0 });
    if (profile.followerCount === undefined && profile.followingCount === undefined) {
      // X showed neither number. Absent is not zero, and a row of nulls is not
      // a reading -- it would occupy the minute the real one needs.
      return 'X showed neither a follower nor a following count';
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
    return null;
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
