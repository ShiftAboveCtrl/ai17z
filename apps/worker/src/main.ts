import { hostname } from 'node:os';
import { createLogger, envInt, envString, errorMessage, loadEnv } from '@xbam/shared';
import { closePool, pingDatabase } from '@xbam/database';
import { JobWorker } from '@xbam/jobs';
import { bootstrapRuntime, runJob } from '@xbam/runtime';
import { closeAllSessions } from '@xbam/browser';
import { ChannelPoller } from './poller';
import { BrowserTaskRunner } from './browserTasks';

loadEnv();
const log = createLogger('worker');

async function main(): Promise<void> {
  const ping = await pingDatabase();
  if (!ping.ok) throw new Error(`Database is not reachable: ${ping.detail}`);
  log.info('database connected', { detail: ping.detail });

  await bootstrapRuntime();

  const workerId = envString('XBAM_WORKER_ID', `${hostname()}-${process.pid}`);
  const worker = new JobWorker(
    {
      workerId,
      concurrency: envInt('XBAM_WORKER_CONCURRENCY', 2),
      pollIntervalMs: envInt('XBAM_WORKER_POLL_MS', 750),
      leaseMs: envInt('XBAM_JOB_LEASE_MS', 120_000),
    },
    (job) => runJob(job, workerId),
  );

  const poller = new ChannelPoller();
  const browserTaskRunner = new BrowserTaskRunner(workerId);
  await worker.start();
  poller.start();
  browserTaskRunner.start();
  log.info('worker ready', { workerId });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutting down', { signal });
    poller.stop();
    browserTaskRunner.stop();
    await worker.stop();
    await closeAllSessions().catch((e) => log.warn('browser cleanup failed', { message: errorMessage(e) }));
    await closePool().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch(async (error) => {
  log.error('worker failed to start', { message: errorMessage(error) });
  await closePool().catch(() => undefined);
  process.exit(1);
});
