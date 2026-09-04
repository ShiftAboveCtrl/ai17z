import { createLogger, envInt, errorMessage } from '@xbam/shared';
import { runDueFollowUps, runDuePosts } from '@xbam/runtime';
import { startLoop } from './loop';

const log = createLogger('posting');

/**
 * Gives agents that post of their own accord their chance to.
 *
 * The schedule says when an agent may look, never what it must say. Coming due
 * means checking the idea backlog; an empty backlog means nothing is posted and
 * the reason is recorded. A timer firing is not a reason to speak.
 *
 * Runs on every worker, browser-capable or not: deciding to post needs a
 * database and a model, and only the execution needs a browser. The job queue
 * routes that part to a worker that has one.
 */
export class PostScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  /**
   * A minute is far finer than any posting interval, and coarse enough that a
   * worker doing nothing else costs one indexed query a minute.
   */
  private readonly tickMs = envInt('AI17Z_POSTING_TICK_MS', 60_000);
  private readonly perTick = envInt('AI17Z_POSTING_PER_TICK', 5);

  start(): void {
    if (this.timer) return;
    log.info('post scheduler starting', { tickMs: this.tickMs, perTick: this.perTick });
    this.timer = startLoop('posting', this.tickMs, () => this.tick());
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      // A promise that has come due, on the same tick as a post that has.
      // Both are the same shape of thing -- something the agent decided to say
      // that nobody prompted -- and both go through the ordinary pipeline.
      for (const result of await runDueFollowUps(this.perTick)) {
        log.info('followed up on a promise', { commitmentId: result.commitmentId, reason: result.reason, jobId: result.jobId });
      }

      for (const result of await runDuePosts(this.perTick)) {
        // Logged either way. "Nothing in the backlog was worth posting" is the
        // answer to "why has it not posted", and it should not take a database
        // query to find out.
        log.info(result.posted ? 'post queued' : 'nothing to post', { reason: result.reason, jobId: result.jobId });
      }
    } catch (error) {
      log.warn('post scheduler tick failed', { message: errorMessage(error) });
    } finally {
      this.running = false;
    }
  }
}
