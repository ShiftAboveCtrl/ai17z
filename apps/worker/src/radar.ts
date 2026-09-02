import { createLogger, envInt, errorMessage } from '@xbam/shared';
import { accounts as accountsRepo, radar as radarRepo, type RadarSourceRow } from '@xbam/database';
import { getChannelAdapter, isChannelImplemented } from '@xbam/channels';
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
    if (source.kind === 'own_threads') {
      const [next] = await radarRepo.ownPostsToCheck(source.accountId, 1);
      if (!next) {
        // Nothing posted recently is not a failure; there is simply nothing to
        // check, and saying so beats recording a spurious success.
        await radarRepo.recordPoll({
          sourceId: source.id,
          nextPollAt: new Date(Date.now() + interval),
          found: 0,
        });
        return;
      }
      target = next.remoteId;
      ownPostId = next.id;
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
   * A failing source backs off rather than hammering a surface that is not
   * answering, but never so far that a recovered source stays quiet for long.
   */
  private backoff(source: RadarSourceRow, baseMs: number): number {
    const failures = Math.min(source.consecutiveFailures + 1, 5);
    return Math.min(baseMs * 2 ** failures, 30 * 60_000);
  }
}
