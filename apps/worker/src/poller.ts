import { createLogger, envInt, errorMessage } from '@xbam/shared';
import { accounts as accountsRepo, users as usersRepo } from '@xbam/database';
import { getChannelAdapter, isChannelImplemented } from '@xbam/channels';
import { buildChannelContext, ingestNormalizedEvent } from '@xbam/runtime';

const log = createLogger('poller');

/**
 * Pulls new events from channels that have to be polled rather than pushed.
 *
 * Only connected, enabled accounts on implemented channels are polled, and an
 * account that fails is marked rather than retried in a tight loop. Accounts can
 * opt out with `settings.pollingEnabled = false`.
 */
export class ChannelPoller {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly intervalMs = envInt('XBAM_POLL_INTERVAL_MS', 120_000);
  private readonly batchLimit = envInt('XBAM_POLL_BATCH', 10);

  start(): void {
    if (this.timer) return;
    log.info('channel poller starting', { intervalMs: this.intervalMs });
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const owners = await usersRepo.listUsers();
      for (const owner of owners) {
        const all = await accountsRepo.listAccounts(owner.id);
        for (const account of all) {
          if (!account.enabled || account.status !== 'CONNECTED') continue;
          if (!isChannelImplemented(account.channel)) continue;
          if ((account.settings as { pollingEnabled?: boolean }).pollingEnabled === false) continue;
          const adapter = getChannelAdapter(account.channel);
          // Push-style channels return nothing from ingestEvents; skip the work.
          if (account.channel === 'mock') continue;

          try {
            const ctx = await buildChannelContext(account, null);
            const events = await adapter.ingestEvents(ctx, { limit: this.batchLimit });
            let created = 0;
            for (const event of events) {
              const outcome = await ingestNormalizedEvent({ accountId: account.id, event });
              created += outcome.jobs.filter((j) => j.created).length;
            }
            await accountsRepo.updateAccount(account.id, {
              lastHealthStatus: 'polled',
              touchHealthCheck: true,
              lastError: null,
              ...(created > 0 ? { touchActivity: true } : {}),
            });
            if (events.length > 0) {
              log.info('polled channel', { channel: account.channel, handle: account.handle, events: events.length, jobsCreated: created });
            }
          } catch (error) {
            const message = errorMessage(error);
            log.warn('channel poll failed', { channel: account.channel, handle: account.handle, message });
            await accountsRepo
              .updateAccount(account.id, { lastHealthStatus: `poll failed: ${message.slice(0, 200)}`, touchHealthCheck: true, lastError: message.slice(0, 500) })
              .catch(() => undefined);
          }
        }
      }
    } finally {
      this.running = false;
    }
  }
}
