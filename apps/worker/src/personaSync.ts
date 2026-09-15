import { createLogger, envInt, errorMessage } from '@xbam/shared';
import { agents as agentsRepo, personaSources } from '@xbam/database';
import { collectPersonaFromX, readerAccountFor } from './personaFromX';
import { syncPersonaSource } from '@xbam/persona';
import { startLoop } from './loop';

const log = createLogger('persona-sync');

/**
 * Runs persona syncs where the browser is.
 *
 * This used to exist because a source that reads a public account shelled out
 * to twscrape, which had its own account database on the machine it was
 * installed on -- so starting it in the API container reported "twscrape is not
 * on PATH" while it was installed and working on the host.
 *
 * The reason is now a better one. Reading X needs the signed-in browser, and
 * the worker is the process that owns browsers. An `x_public` source therefore
 * goes through the same collector "Learn from this account" uses, rather than
 * through an adapter that no packaged installation could run -- which is what
 * made the advanced screen's "sync now" permanently broken while the button
 * beside it worked.
 */
export class PersonaSyncRunner {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly intervalMs = envInt('AI17Z_PERSONA_SYNC_POLL_MS', 3_000);

  constructor(readonly workerId: string) {}

  start(): void {
    if (this.timer) return;
    this.timer = startLoop('persona-sync', this.intervalMs, () => this.tick());
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

      log.info('running persona sync', { sourceId: claimed.id, kind: claimed.kind });

      // An X source is read through the browser, by the one collector. Anything
      // else -- a corpus somebody pasted -- still goes straight through.
      if (claimed.kind === 'x_public') {
        await this.syncFromX(claimed.id, claimed.handle ?? '', claimed.request.incremental !== false);
        await personaSources.clearSyncRequest(claimed.id);
        return;
      }

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

  /**
   * An X source, read through the browser by the one shared collector.
   *
   * The refresh case is why `sincePostId` is here: a source that has synced
   * before knows the newest post it already holds, so this asks only for what
   * is above it. Re-reading two hundred posts to find the four new ones is the
   * kind of thing that makes a refresh button feel expensive enough not to
   * press.
   */
  private async syncFromX(sourceId: string, handle: string, incremental: boolean): Promise<void> {
    const source = await personaSources.getSource(sourceId);
    if (!source) return;

    // Reading X needs a session, and the session belongs to an account. An
    // agent with no connected X account cannot be refreshed from X, and saying
    // so is better than a sync that quietly does nothing.
    const agent = await agentsRepo.getAgent(source.agentId);
    const reader = agent ? await readerAccountFor(agent.ownerId) : null;
    if (!reader) {
      await personaSources.setSourceStatus(sourceId, 'UNAVAILABLE', {
        lastError:
          'AI17Z reads X through a signed-in browser, so it needs one of your X accounts connected. Connect one, sign in, and refresh again.',
      });
      return;
    }

    const collection = await collectPersonaFromX({
      sourceId,
      handle: handle || (source.handle ?? ''),
      readerAccountId: reader,
      sincePostId: incremental ? source.syncCursor : null,
    });
    log.info('persona sync from X finished', {
      sourceId,
      outcome: collection.outcome,
      collected: collection.collected,
      backend: collection.backend,
    });
  }
}
