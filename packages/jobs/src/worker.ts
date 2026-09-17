import type { JobRecord } from '@xbam/shared/contracts';
import { createLogger, errorMessage, settledPressure, sleep, throttleFor } from '@xbam/shared';
import { jobs as jobsRepo } from '@xbam/database';
import { capabilitiesFor, runRecoverySweep, type QueueOptions } from './queue';

const log = createLogger('worker-loop');

export type JobHandler = (job: JobRecord) => Promise<void>;

/**
 * Polling worker over the Postgres queue. Deliberately boring: claim with
 * SKIP LOCKED, renew the lease while working, always release. No Redis, no
 * broker, and a restart loses nothing because state lives in the jobs table.
 */
export class JobWorker {
  private running = false;
  private stopping = false;
  private inFlight = new Set<string>();
  private readonly options: QueueOptions;
  private readonly handler: JobHandler;
  private recoveryTimer: NodeJS.Timeout | null = null;

  constructor(options: QueueOptions, handler: JobHandler) {
    this.options = options;
    this.handler = handler;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    log.info('worker starting', {
      workerId: this.options.workerId,
      concurrency: this.options.concurrency,
      role: this.options.role,
    });

    await runRecoverySweep();
    this.recoveryTimer = setInterval(() => {
      runRecoverySweep().catch((error) => log.error('recovery sweep failed', { message: errorMessage(error) }));
    }, Math.max(15_000, this.options.leaseMs / 2));

    void this.loop();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    // Let in-flight jobs finish so their status is written, rather than leaving
    // them to be recovered by lease expiry on the next boot.
    const deadline = Date.now() + 30_000;
    while (this.inFlight.size > 0 && Date.now() < deadline) await sleep(200);
    this.running = false;
    log.info('worker stopped', { abandoned: this.inFlight.size });
  }

  get busy(): number {
    return this.inFlight.size;
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      try {
        /*
          Less work when the machine is short of memory, and never none.

          The point is to reduce load *before* the operating system starts
          killing things, because what it kills is Chrome: a renderer is the
          largest process AI17Z has and the first thing an out-of-memory killer
          reaches for. Losing a renderer costs a monitor; losing a queued job
          costs nothing, because it stays queued.

          So this delays rather than drops. Claimed jobs are unaffected, nothing
          leaves the queue, and the floor is one: an installation under pressure
          still makes progress, just slowly.

          The verdict is smoothed rather than re-read raw on every tick. It used
          to be raw, and `freemem` moves constantly, so a machine hovering near
          a threshold changed its mind about how much work to allow every few
          seconds. Recovery is still automatic; it is now also steady.
        */
        const allowed = Math.max(1, Math.floor(this.options.concurrency * throttleFor(settledPressure()).concurrencyFactor));
        const capacity = allowed - this.inFlight.size;
        if (capacity <= 0) {
          await sleep(this.options.pollIntervalMs);
          continue;
        }
        const claimed = await jobsRepo.claimJobs(
          this.options.workerId,
          capacity,
          this.options.leaseMs,
          capabilitiesFor(this.options.role),
        );
        if (claimed.length === 0) {
          await sleep(this.options.pollIntervalMs);
          continue;
        }
        for (const job of claimed) void this.run(job);
      } catch (error) {
        log.error('claim loop error', { message: errorMessage(error) });
        await sleep(Math.max(1_000, this.options.pollIntervalMs));
      }
    }
  }

  private async run(job: JobRecord): Promise<void> {
    this.inFlight.add(job.id);
    const renew = setInterval(() => {
      jobsRepo
        .extendLease(job.id, this.options.workerId, this.options.leaseMs)
        .catch((error) => log.warn('lease renewal failed', { jobId: job.id, message: errorMessage(error) }));
    }, Math.max(5_000, Math.floor(this.options.leaseMs / 3)));

    try {
      await this.handler(job);
    } catch (error) {
      // The pipeline is responsible for classifying failures. Reaching here means
      // something escaped it, so release the lease and let recovery re-run the step.
      log.error('unhandled job error', { jobId: job.id, message: errorMessage(error) });
      await jobsRepo
        .updateJob(job.id, { lastError: errorMessage(error), releaseLock: true })
        .catch((e) => log.error('failed to release job', { jobId: job.id, message: errorMessage(e) }));
    } finally {
      clearInterval(renew);
      this.inFlight.delete(job.id);
    }
  }
}
