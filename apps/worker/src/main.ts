import { hostname } from 'node:os';
import { createLogger, envInt, envString, errorMessage, loadEnv } from '@xbam/shared';
import { browserTasks, closePool, pingDatabase, workers as workersRepo } from '@xbam/database';
import { JobWorker, capabilitiesFor, type WorkerRole } from '@xbam/jobs';
import { bootstrapRuntime, runJob } from '@xbam/runtime';
import { closeAllSessions } from '@xbam/browser';
import { ChannelPoller } from './poller';
import { SignInWatcher } from './signIn';
import { SocialRadar } from './radar';
import { BrowserTaskRunner } from './browserTasks';

loadEnv();
const log = createLogger('worker');

async function main(): Promise<void> {
  const ping = await pingDatabase();
  if (!ping.ok) throw new Error(`Database is not reachable: ${ping.detail}`);
  log.info('database connected', { detail: ping.detail });

  await bootstrapRuntime();

  const workerId = envString('AI17Z_WORKER_ID', `${hostname()}-${process.pid}`);

  // A containerised worker has no browser and no display, so it must not claim
  // browser-backed work. Run a second worker natively with role=browser for that.
  const role = (envString('AI17Z_WORKER_ROLE', 'all') as WorkerRole) ?? 'all';
  if (!['jobs', 'browser', 'all'].includes(role)) {
    throw new Error(`AI17Z_WORKER_ROLE must be jobs, browser, or all (got "${role}").`);
  }
  const capabilities = capabilitiesFor(role);
  const worker = new JobWorker(
    {
      workerId,
      concurrency: envInt('AI17Z_WORKER_CONCURRENCY', 2),
      pollIntervalMs: envInt('AI17Z_WORKER_POLL_MS', 750),
      leaseMs: envInt('AI17Z_JOB_LEASE_MS', 120_000),
      role,
    },
    (job) => runJob(job, workerId),
  );

  // Channel polling and browser tasks both drive a browser, so they belong to
  // whichever worker can actually open one.
  // Announce what this worker can do before it starts, so the API can tell
  // somebody "nothing here can open a browser" instead of queueing a task that
  // waits for a worker which does not exist.
  const announce = () =>
    workersRepo
      .heartbeat({ id: workerId, role, ...capabilities, hostname: hostname() })
      .catch((e) => log.warn('heartbeat failed', { message: errorMessage(e) }));
  await announce();
  const heartbeat = setInterval(() => void announce(), 20_000);

  /**
   * Frees browser tasks nothing is going to finish.
   *
   * Runs on every worker, not only browser-capable ones, because the failure
   * that strands an account is a task queued while no browser worker exists —
   * and a sweep that only runs on a browser worker never runs then. Freeing a
   * stuck row needs a database, not a browser.
   */
  const sweep = async () => {
    try {
      const freed = await browserTasks.recoverStaleBrowserTasks();
      if (freed.abandoned > 0 || freed.unclaimed > 0) log.info('freed stuck browser tasks', freed);
    } catch (error) {
      log.warn('browser task sweep failed', { message: errorMessage(error) });
    }
  };
  await sweep();
  const sweeper = setInterval(() => void sweep(), 60_000);

  const poller = new ChannelPoller();
  const browserTaskRunner = new BrowserTaskRunner(workerId);
  const signIns = new SignInWatcher();
  const socialRadar = new SocialRadar();
  await worker.start();
  if (capabilities.browserCapable) {
    poller.start();
    browserTaskRunner.start();
    signIns.start();
    socialRadar.start();
  }
  log.info('worker ready', { workerId, role, ...capabilities });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutting down', { signal });
    clearInterval(heartbeat);
    clearInterval(sweeper);
    // Withdraw immediately rather than waiting for the heartbeat to lapse: a
    // clean shutdown knows it is leaving.
    await workersRepo.goodbye(workerId).catch(() => undefined);
    poller.stop();
    browserTaskRunner.stop();
    signIns.stop();
    socialRadar.stop();
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
