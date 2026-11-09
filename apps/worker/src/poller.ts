import { createLogger, envInt, errorMessage, PipelineError } from '@xbam/shared';
import { accounts as accountsRepo, cadences as cadencesRepo, telegramChannel, channelState } from '@xbam/database';
import { getChannelAdapter, isChannelImplemented } from '@xbam/channels';
import {
  buildChannelContext,
  checkReadCapacity,
  ingestNormalizedEvent,
  nextPollDelayMs,
  noteXFailure,
  noteXRead,
} from '@xbam/runtime';
import { startLoop } from './loop';

const log = createLogger('poller');

/**
 * Pulls new events from channels that have to be polled rather than pushed.
 *
 * The poller has no schedule of its own. It wakes on a short tick, asks the
 * database which accounts are due, and each account's cadence decides when it
 * comes round again. That is why one busy account and one dormant one no longer
 * share a single interval, and why a worker restart does not stampede every
 * account at once.
 */
export class ChannelPoller {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  /** How often we look for due accounts, not how often any account is polled. */
  private readonly tickMs = envInt('AI17Z_POLL_TICK_MS', 5_000);
  private readonly perTick = envInt('AI17Z_POLL_ACCOUNTS_PER_TICK', 5);
  /**
   * How long a claimed account is held before another worker may take it. Long
   * enough to cover a slow page load; short enough that a crashed worker does
   * not strand an account for long.
   */
  private readonly claimHoldSeconds = envInt('AI17Z_POLL_CLAIM_HOLD_S', 120);

  start(): void {
    if (this.timer) return;
    log.info('channel poller starting', { tickMs: this.tickMs, perTick: this.perTick });
    this.timer = startLoop('poller', this.tickMs, () => this.tick(), 'ESSENTIAL');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const due = await cadencesRepo.claimDueAccounts(this.perTick, this.claimHoldSeconds);
      for (const claimed of due) {
        if (!isChannelImplemented(claimed.channel as never)) continue;
        await this.pollOne(claimed);
      }
    } catch (error) {
      log.warn('poller tick failed', { message: errorMessage(error) });
    } finally {
      this.running = false;
    }
  }

  private async pollOne(claimed: Awaited<ReturnType<typeof cadencesRepo.claimDueAccounts>>[number]): Promise<void> {
    const { config } = claimed;
    const account = await accountsRepo.getAccount(claimed.id);
    if (!account) return;

    // Disabled polling still occupies a schedule slot, so the account is
    // rescheduled far out rather than checked again in five seconds.
    if (!config.polling.enabled) {
      await cadencesRepo.recordPoll(claimed.id, new Date(Date.now() + config.polling.maxIntervalSeconds * 1_000), false);
      return;
    }

    /*
      What people sent is the last thing to stop reading, but it still counts.

      The poller reads the same X the radar does through the same account, so
      it spends from the same budget. It is DIRECT, which means it may use all
      of it and keeps reading through a cooldown; what it cannot do is read
      while the account needs a person, or pretend its reads are free.
    */
    const capacity = await checkReadCapacity(account.id, 'DIRECT').catch(() => null);
    if (capacity && !capacity.allowed) {
      await cadencesRepo.recordPoll(
        claimed.id,
        new Date(Date.now() + Math.max(capacity.retryAfterMs ?? 10 * 60_000, 30_000)),
        false,
      );
      return;
    }

    const adapter = getChannelAdapter(account.channel);
    try {
      const ctx = await buildChannelContext(account, null);
      // A Telegram bot's update offset, committed below and only after the
      // batch it covers was ingested. The version stops a poll that outlived its
      // claim from writing an old offset over a newer one.
      const offsetState = account.channel === 'telegram' ? await telegramChannel.pollState(account.id) : null;
      const state = account.channel === 'farcaster' ? await channelState.pollState(account.id) : null;
      let reported: string | null = null;
      const events = await adapter.ingestEvents(ctx, {
        limit: config.polling.batchLimit,
        ...(offsetState
          ? {
              cursor: offsetState.offset === null ? null : String(offsetState.offset),
              reportCursor: (value: string) => {
                reported = value;
              },
            }
          : state ? { cursor: state.cursor, reportCursor: (value: string) => { reported = value; } } : {}),
      });
      if (account.channel === 'x') await noteXRead(account.id, 'DIRECT');
      let created = 0;
      for (const event of events) {
        const outcome = await ingestNormalizedEvent({ accountId: account.id, event });
        created += outcome.jobs.filter((j) => j.created).length;
      }
      if (offsetState && reported !== null) {
        await telegramChannel.advanceOffset(account.id, offsetState.version, Number(reported));
      }
      if (state && reported !== null) await channelState.advancePoll(account.id, state.version, reported);

      const found = events.length > 0;
      const delay = nextPollDelayMs(config, { emptyStreak: claimed.emptyPollStreak, foundEvents: found });
      await cadencesRepo.recordPoll(claimed.id, new Date(Date.now() + delay), found);
      await accountsRepo.updateAccount(account.id, {
        lastHealthStatus: 'polled',
        touchHealthCheck: true,
        lastError: null,
        ...(created > 0 ? { touchActivity: true } : {}),
      });
      if (found) {
        log.info('polled channel', {
          channel: account.channel,
          handle: account.handle,
          events: events.length,
          jobsCreated: created,
          nextInSeconds: Math.round(delay / 1_000),
        });
      }
    } catch (error) {
      const message = errorMessage(error);
      log.warn('channel poll failed', { channel: account.channel, handle: account.handle, message });
      if (account.channel === 'x') await noteXFailure(account.id, 'DIRECT', message);
      // A failing account backs off like an idle one rather than being retried
      // every tick, but the streak is what grows, not a separate failure counter.
      // A wait the remote named (Telegram's retry_after) is a floor, not a hint.
      const requestedWait =
        error instanceof PipelineError && typeof error.data.retryAfterMs === 'number' ? error.data.retryAfterMs : 0;
      const delay = Math.max(
        requestedWait,
        nextPollDelayMs(config, { emptyStreak: claimed.emptyPollStreak + 1, foundEvents: false }),
      );
      await cadencesRepo.recordPoll(claimed.id, new Date(Date.now() + delay), false).catch(() => undefined);
      await accountsRepo
        .updateAccount(account.id, {
          lastHealthStatus: `poll failed: ${message.slice(0, 200)}`,
          touchHealthCheck: true,
          lastError: message.slice(0, 500),
          // A revoked or shared bot token will not fix itself, and polling it again
          // every few minutes only asks Telegram to keep saying no.
          ...(account.channel === 'telegram' &&
          error instanceof PipelineError &&
          ['telegram_auth_failed', 'telegram_no_token', 'telegram_shared_bot'].includes(error.reason)
            ? { status: 'NEEDS_AUTH' as const }
            : {}),
          ...(account.channel === 'farcaster' && error instanceof PipelineError &&
            (error.reason === 'farcaster_auth_failed' || error.reason === 'farcaster_no_signer')
            ? { status: 'NEEDS_AUTH' as const } : {}),
        })
        .catch(() => undefined);
    }
  }
}
