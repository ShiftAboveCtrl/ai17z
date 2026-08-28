import { createLogger, envInt, errorMessage } from '@xbam/shared';
import { personaSources } from '@xbam/database';
import { syncPersonaSource } from '@xbam/persona';

const log = createLogger('persona-sync');

/**
 * Runs persona syncs where the tools actually are.
 *
 * A source that reads a public account shells out to twscrape, which has its
 * own account database on the machine it was installed on. Starting that in the
 * API container reported "twscrape is not on PATH" while it was installed and
 * working on the host — the same class of mistake as trying to drive a browser
 * from a container with no display.
 */
export class PersonaSyncRunner {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly intervalMs = envInt('AI17Z_PERSONA_SYNC_POLL_MS', 3_000);

  constructor(readonly workerId: string) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const claimed = await personaSources.claimSync(this.workerId);
      if (!claimed) return;

      log.info('running persona sync', { sourceId: claimed.id });
      const report = await syncPersonaSource({
        sourceId: claimed.id,
        text: claimed.request.text,
        limit: claimed.request.limit,
        incremental: claimed.request.incremental,
      });

      // syncPersonaSource records its own status and error; clearing the
      // request is all that is left, and it happens whether or not the sync
      // succeeded so a failing source is not retried in a tight loop.
      await personaSources.clearSyncRequest(claimed.id);
      log.info('persona sync finished', {
        sourceId: claimed.id,
        fetched: report.fetched,
        useful: report.useful,
        error: report.error,
      });
    } catch (error) {
      log.warn('persona sync failed', { message: errorMessage(error) });
    } finally {
      this.running = false;
    }
  }
}
